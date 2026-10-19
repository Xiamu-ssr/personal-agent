package com.xiamu.agent.device

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.accessibilityservice.GestureDescription
import android.app.KeyguardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.util.Base64
import android.util.DisplayMetrics
import android.view.Display
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityManager
import android.view.accessibility.AccessibilityNodeInfo
import com.xiamu.agent.Prefs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.math.max
import kotlin.math.roundToInt

/** The phone's own controller. ADB is only used for development and acceptance. */
@Suppress("DEPRECATION")
class PhoneUseService : AccessibilityService() {
    private data class Frame(val id: String, val screenWidth: Int, val screenHeight: Int) {
        val scale = minOf(1.0, 1440.0 / max(screenWidth, screenHeight))
        val width = (screenWidth * scale).roundToInt()
        val height = (screenHeight * scale).roundToInt()
    }
    private val operations = Mutex()
    private var frame: Frame? = null
    private val epoch = UUID.randomUUID().toString().take(8)
    private var sequence = 0L
    private val refs = linkedMapOf<String, AccessibilityNodeInfo>()
    private var snapshotWindow = -1
    private var activity = ""

    override fun onServiceConnected() {
        instance = this
        DeviceService.capabilitiesChanged(this)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event?.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) activity = event.className?.toString().orEmpty()
    }
    override fun onInterrupt() = Unit
    override fun onUnbind(intent: Intent?): Boolean { disconnected(); return super.onUnbind(intent) }
    override fun onDestroy() { disconnected(); super.onDestroy() }
    private fun disconnected() {
        clearRefs()
        if (instance === this) { instance = null; DeviceService.capabilitiesChanged(this) }
    }
    private fun clearRefs() { refs.values.forEach { it.recycle() }; refs.clear() }

    private fun screenSize(): Pair<Int, Int> {
        val metrics = DisplayMetrics()
        getSystemService(WindowManager::class.java).defaultDisplay.getRealMetrics(metrics)
        return metrics.widthPixels to metrics.heightPixels
    }
    private fun newFrame(width: Int, height: Int): Frame {
        clearRefs()
        return Frame("s$epoch-${++sequence}", width, height).also { frame = it }
    }
    private fun frameJson(f: Frame): JSONObject = JSONObject().put("frame", f.id).put("width", f.width).put("height", f.height)
        .put("screenOn", getSystemService(PowerManager::class.java).isInteractive)
        .put("locked", getSystemService(KeyguardManager::class.java).isKeyguardLocked)

    private fun snapshot(): JSONObject {
        val root = rootInActiveWindow ?: throw IllegalStateException("当前没有可读取的界面；请先点亮手机并解锁")
        if (!root.refresh()) { root.recycle(); throw IllegalStateException("界面正在切换，请重新观察") }
        val (width, height) = screenSize()
        val f = newFrame(width, height)
        val nodes = JSONArray()
        snapshotWindow = root.windowId
        val packageName = root.packageName?.toString().orEmpty()
        var visited = 0
        fun visit(node: AccessibilityNodeInfo, depth: Int) {
            try {
                if (++visited > 500 || depth > 32 || nodes.length() >= 180 || !node.isVisibleToUser) return
                val text = if (node.isPassword) "[密码输入框]" else node.text?.toString().orEmpty().take(300)
                val label = if (node.isPassword) "" else node.contentDescription?.toString().orEmpty().take(200)
                if (text.isNotBlank() || label.isNotBlank() || node.isClickable || node.isEditable || node.isScrollable) {
                    val bounds = Rect(); node.getBoundsInScreen(bounds)
                    val ref = "${f.id}n${nodes.length()}"
                    refs[ref] = AccessibilityNodeInfo.obtain(node)
                    nodes.put(JSONObject().put("ref", ref).put("text", text).put("label", label)
                        .put("class", node.className?.toString()?.substringAfterLast('.') ?: "")
                        .put("enabled", node.isEnabled).put("clickable", node.isClickable).put("editable", node.isEditable)
                        .put("scrollable", node.isScrollable).put("focused", node.isFocused)
                        .put("checkable", node.isCheckable).put("checked", node.isChecked).put("selected", node.isSelected)
                        .put("id", node.viewIdResourceName.orEmpty())
                        .put("bounds", JSONArray(listOf(bounds.left, bounds.top, bounds.right, bounds.bottom).map { (it * f.scale).roundToInt() })))
                }
                for (i in 0 until node.childCount) { node.getChild(i)?.let { visit(it, depth + 1) }; if (visited > 500 || nodes.length() >= 180) break }
            } finally { node.recycle() }
        }
        visit(root, 0)
        return frameJson(f).put("package", packageName).put("activity", activity).put("nodes", nodes)
            .put("truncated", visited > 500 || nodes.length() >= 180)
    }

    private fun node(ref: String): AccessibilityNodeInfo {
        val root = rootInActiveWindow
        val window = root?.windowId; root?.recycle()
        val node = refs[ref]
        check(node != null && window == snapshotWindow && node.refresh() && node.isVisibleToUser) { "界面节点已失效，请重新 snapshot 后操作" }
        check(node.isEnabled) { "这个控件当前不可操作" }
        return node
    }
    private fun point(args: JSONObject, x: Double, y: Double): Pair<Float, Float> {
        val f = frame ?: throw IllegalStateException("坐标操作前先调用 snapshot 或 screenshot")
        check(args.optString("frame") == f.id) { "请使用最近一次 snapshot/screenshot 返回的 frame，界面尺寸变化后重新观察" }
        check(screenSize() == (f.screenWidth to f.screenHeight)) { "屏幕方向或尺寸已变化，请重新观察" }
        require(x.isFinite() && y.isFinite() && x >= 0 && y >= 0 && x < f.width && y < f.height) { "坐标超出当前图片范围" }
        return (x / f.scale).toFloat() to (y / f.scale).toFloat()
    }
    private suspend fun gesture(from: Pair<Float, Float>, to: Pair<Float, Float> = from, duration: Long = 80) {
        val path = Path().apply { moveTo(from.first, from.second); if (to != from) lineTo(to.first, to.second) }
        val description = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, duration)).build()
        withTimeout(6000) {
            suspendCancellableCoroutine { cont ->
                val accepted = dispatchGesture(description, object : GestureResultCallback() {
                    override fun onCompleted(gestureDescription: GestureDescription?) { if (cont.isActive) cont.resume(Unit) }
                    override fun onCancelled(gestureDescription: GestureDescription?) { if (cont.isActive) cont.resumeWithException(IllegalStateException("手机手势被系统取消，请重新观察界面")) }
                }, null)
                if (!accepted && cont.isActive) cont.resumeWithException(IllegalStateException("系统没有接受这个手势"))
            }
        }
    }
    private suspend fun click(args: JSONObject, long: Boolean = false) {
        val ref = args.optString("ref")
        if (ref.isNotBlank()) {
            val target = node(ref)
            if (target.performAction(if (long) AccessibilityNodeInfo.ACTION_LONG_CLICK else AccessibilityNodeInfo.ACTION_CLICK)) return
            val bounds = Rect(); target.getBoundsInScreen(bounds)
            gesture(bounds.exactCenterX() to bounds.exactCenterY(), duration = if (long) 700 else 80)
        } else gesture(point(args, args.getDouble("x"), args.getDouble("y")), duration = if (long) 700 else 80)
    }
    private fun type(args: JSONObject) {
        val explicit = args.optString("ref").takeIf { it.isNotBlank() }
        val root = if (explicit == null) rootInActiveWindow else null
        val target = explicit?.let(::node) ?: root?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        try {
            check(target != null && target.isEditable && target.isEnabled) { "请先 snapshot 找到可输入节点，或点击输入框再输入" }
            val text = args.getString("text")
            require(text.length <= 20000) { "单次输入不能超过 20000 字" }
            check(target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) })) { "该输入框不支持无障碍输入，请改用界面中的键盘操作" }
            if (args.optBoolean("submit")) {
                check(Build.VERSION.SDK_INT >= 30 && target.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)) { "文字已填入，但提交未成功；请观察后点击界面上的搜索/发送按钮" }
            }
        } finally { if (explicit == null) { target?.recycle(); root?.recycle() } }
    }
    private suspend fun scroll(args: JSONObject) {
        val direction = args.optString("direction", "down")
        require(direction in setOf("down", "up", "left", "right")) { "direction 只支持 down/up/left/right" }
        val ref = args.optString("ref")
        if (ref.isNotBlank()) {
            val action = when (direction) { "up" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_UP; "left" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_LEFT; "right" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_RIGHT; else -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_DOWN }
            check(node(ref).performAction(action.id)) { "该节点没有接受滚动，请重新观察后使用带 frame 的坐标滑动" }
            return
        }
        val f = frame ?: throw IllegalStateException("滚动前先 snapshot 或 screenshot")
        val from = when (direction) { "up" -> .5 to .3; "left" -> .3 to .5; "right" -> .75 to .5; else -> .5 to .75 }
        val to = when (direction) { "up" -> .5 to .75; "left" -> .75 to .5; "right" -> .3 to .5; else -> .5 to .3 }
        gesture(point(args, f.width * from.first, f.height * from.second), point(args, f.width * to.first, f.height * to.second), 350)
    }
    private suspend fun screenshot(): JSONObject {
        check(Build.VERSION.SDK_INT >= 30) { "此系统低于 Android 11，不支持无障碍截图；可继续使用 snapshot 和节点操作" }
        val bitmap = withTimeout(10000) {
            suspendCancellableCoroutine<Bitmap> { cont ->
                takeScreenshot(Display.DEFAULT_DISPLAY, mainExecutor, object : TakeScreenshotCallback {
                    override fun onSuccess(result: ScreenshotResult) {
                        val buffer = result.hardwareBuffer
                        try {
                            val hardware = Bitmap.wrapHardwareBuffer(buffer, result.colorSpace) ?: error("系统截图为空")
                            val copy = try { hardware.copy(Bitmap.Config.ARGB_8888, false) ?: error("截图读取失败") } finally { hardware.recycle() }
                            if (cont.isActive) cont.resume(copy) else copy.recycle()
                        } catch (e: Exception) { if (cont.isActive) cont.resumeWithException(e) } finally { buffer.close() }
                    }
                    override fun onFailure(errorCode: Int) {
                        if (cont.isActive) cont.resumeWithException(IllegalStateException(when (errorCode) {
                            ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT -> "截图过于频繁，请稍后再截"
                            ERROR_TAKE_SCREENSHOT_NO_ACCESSIBILITY_ACCESS -> "无障碍权限已关闭，请在这台手机的豆豆中重新开启手机操作"
                            ERROR_TAKE_SCREENSHOT_SECURE_WINDOW -> "当前应用禁止截屏；请使用 snapshot 读取其允许提供的界面节点"
                            else -> "系统截图失败（$errorCode），请确认手机已点亮并解锁"
                        }))
                    }
                })
            }
        }
        try {
            val f = newFrame(bitmap.width, bitmap.height)
            val scaled = Bitmap.createScaledBitmap(bitmap, f.width, f.height, true)
            try {
                val bytes = ByteArrayOutputStream().also { scaled.compress(Bitmap.CompressFormat.JPEG, 85, it) }.toByteArray()
                return frameJson(f).put("image", Base64.encodeToString(bytes, Base64.NO_WRAP)).put("mime", "image/jpeg")
            } finally { if (scaled !== bitmap) scaled.recycle() }
        } finally { bitmap.recycle() }
    }
    private fun apps(args: JSONObject): JSONObject {
        val query = args.optString("query")
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val rows = packageManager.queryIntentActivities(launcher, 0).map { it.loadLabel(packageManager).toString() to it.activityInfo.packageName }
            .distinctBy { it.second }.filter { query.isBlank() || (it.first + it.second).contains(query, true) }.sortedBy { it.first }.take(100)
        return JSONObject().put("apps", JSONArray(rows.map { JSONObject().put("name", it.first).put("package", it.second) }))
    }
    private suspend fun run(args: JSONObject): JSONObject = operations.withLock { withContext(Dispatchers.Main) {
        check(Prefs.granted("phone_use") && instance === this@PhoneUseService) { "手机操作已关闭" }
        val op = args.optString("op")
        when (op) {
            "snapshot" -> return@withContext snapshot()
            "screenshot" -> return@withContext screenshot()
            "apps" -> return@withContext apps(args)
            "launch" -> {
                val target = args.getString("package")
                val intent = packageManager.getLaunchIntentForPackage(target) ?: throw IllegalStateException("没有找到可启动的应用：$target；先用 apps 查看已安装应用")
                startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            "click" -> click(args)
            "long_click" -> click(args, true)
            "type" -> type(args)
            "scroll" -> scroll(args)
            "swipe" -> {
                val from = args.getJSONObject("from"); val to = args.getJSONObject("to")
                gesture(point(args, from.getDouble("x"), from.getDouble("y")), point(args, to.getDouble("x"), to.getDouble("y")), args.optLong("duration", 350).coerceIn(80, 2000))
            }
            "back", "home", "recents", "notifications", "quick_settings" -> {
                val action = when (op) { "back" -> GLOBAL_ACTION_BACK; "home" -> GLOBAL_ACTION_HOME; "recents" -> GLOBAL_ACTION_RECENTS; "notifications" -> GLOBAL_ACTION_NOTIFICATIONS; else -> GLOBAL_ACTION_QUICK_SETTINGS }
                check(performGlobalAction(action)) { "系统没有接受 $op 操作" }
            }
            else -> throw IllegalArgumentException("不支持的手机操作：$op")
        }
        JSONObject().put("ok", true).put("action", op).put("next", "用 snapshot 或 screenshot 观察执行后的界面")
    } }

    companion object {
        @Volatile private var instance: PhoneUseService? = null
        fun ready(): Boolean = instance != null
        fun disable() { instance?.disableSelf() }
        fun systemEnabled(ctx: Context): Boolean = ctx.getSystemService(AccessibilityManager::class.java)
            .getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
            .any { it.resolveInfo.serviceInfo.let { s -> s.packageName == ctx.packageName && s.name == PhoneUseService::class.java.name } }
        fun unavailableReason(ctx: Context): String? = when {
            !Prefs.granted("phone_use") -> "请在这台手机的豆豆 → 设备与权限中开启手机操作"
            !systemEnabled(ctx) -> "手机操作尚未获得无障碍授权，请在这台手机的豆豆 → 设备与权限中打开系统授权"
            !ready() -> "无障碍开关已开启，手机操作服务尚未连接；请稍候，仍未连接时在系统设置中重新开启豆豆手机操作"
            else -> null
        }
        fun openSettings(ctx: Context) {
            val details = Intent("android.settings.ACCESSIBILITY_DETAILS_SETTINGS")
                .putExtra(Intent.EXTRA_COMPONENT_NAME, ComponentName(ctx, PhoneUseService::class.java).flattenToString())
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try { ctx.startActivity(details) } catch (_: Exception) { ctx.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        }
        suspend fun execute(args: JSONObject): JSONObject = (instance ?: throw IllegalStateException("手机操作服务尚未连接，请在这台设备中开启无障碍授权")).run(args)
    }
}
