package com.xiamu.agent.ui

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Apps
import androidx.compose.material.icons.outlined.BatteryChargingFull
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.Cloud
import androidx.compose.material.icons.outlined.ContentPaste
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.Extension
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.LaptopMac
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.Memory
import androidx.compose.material.icons.outlined.NotificationsNone
import androidx.compose.material.icons.outlined.PhoneAndroid
import androidx.compose.material.icons.outlined.Place
import androidx.compose.material.icons.outlined.Sms
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import android.webkit.CookieManager
import com.xiamu.agent.Api
import com.xiamu.agent.BuildConfigInfo
import com.xiamu.agent.Chat
import com.xiamu.agent.Prefs
import com.xiamu.agent.device.Capabilities
import com.xiamu.agent.device.Capability
import com.xiamu.agent.device.DeviceService
import kotlinx.coroutines.launch

/** Whether we hold a token; flipping it swaps the whole UI between login and the app. */
object Session {
    val loggedIn = mutableStateOf(Prefs.configured)
    val onboarded = mutableStateOf(Prefs.onboarded)

    fun logout(ctx: android.content.Context) {
        Prefs.token = ""
        Chat.reset()
        Voice.cancel()
        Draft.reset()
        com.xiamu.agent.media.Images.clear()
        com.xiamu.agent.media.VoicePlayer.stop()
        CookieManager.getInstance().removeAllCookies(null)
        DeviceService.stop(ctx)
        clearCache()
        Nav.home(0)
        loggedIn.value = false
    }
}

fun capIcon(name: String): ImageVector = when (name) {
    "battery" -> Icons.Outlined.BatteryChargingFull
    "notify" -> Icons.Outlined.NotificationsNone
    "location" -> Icons.Outlined.Place
    "calendar_events" -> Icons.Outlined.CalendarMonth
    "sms" -> Icons.Outlined.Sms
    "clipboard_write", "clipboard_read" -> Icons.Outlined.ContentPaste
    "open_url" -> Icons.Outlined.Link
    "frontmost_app" -> Icons.Outlined.Apps
    "shortcuts" -> Icons.Outlined.Bolt
    "folder" -> Icons.Outlined.Folder
    else -> Icons.Outlined.Extension
}

fun deviceIcon(kind: String): ImageVector = when (kind) {
    "mac" -> Icons.Outlined.LaptopMac
    "cloud" -> Icons.Outlined.Cloud
    else -> Icons.Outlined.PhoneAndroid
}

// ---------- 登录 ----------

@Composable
fun LoginScreen() {
    val scope = rememberCoroutineScope()
    var server by remember { mutableStateOf(Prefs.server) }
    var password by remember { mutableStateOf("") }
    var shown by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val ready = server.isNotBlank() && password.isNotBlank() && !busy
    fun login() {
        if (!ready) return
        busy = true
        error = ""
        scope.launch {
            runCatching { Api.login(server.trim(), password) }
                .onSuccess { Session.loggedIn.value = true }
                .onFailure { error = it.message ?: "登录失败" }
            busy = false
        }
    }
    Screen {
        Column(
            Modifier.fillMaxSize().statusBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp),
        ) {
            Spacer(Modifier.height(56.dp))
            Avatar(76.dp)
            Text("登录豆豆", fontSize = 30.sp, fontWeight = FontWeight.Bold, color = Pal.Ink, modifier = Modifier.padding(top = 26.dp))
            Text("你的个人 agent，住在你自己的云主机上", fontSize = 14.sp, color = Pal.Muted, modifier = Modifier.padding(top = 8.dp))
            Column(Modifier.padding(top = 32.dp).fillMaxWidth().card(radius = 24.dp).padding(horizontal = 20.dp)) {
                LoginField("账号", server, { server = it }, "云端地址", KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next))
                Hairline()
                LoginField(
                    "密码", password, { password = it }, "6 位配对码或口令",
                    KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                    KeyboardActions(onDone = { login() }),
                    if (shown) VisualTransformation.None else PasswordVisualTransformation(),
                ) {
                    Icon(
                        if (shown) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility, if (shown) "隐藏" else "显示",
                        tint = Pal.Faint, modifier = Modifier.size(20.dp).tap { shown = !shown },
                    )
                }
            }
            if (error.isNotBlank()) ErrorNote(error)
            GoldButton(if (busy) "正在登录…" else "登录", Modifier.fillMaxWidth().padding(top = if (error.isBlank()) 24.dp else 4.dp), ready) { login() }
            Text("没有密码？在已登录的设备上：设置 → 生成配对码", fontSize = 12.sp, color = Pal.Faint,
                modifier = Modifier.fillMaxWidth().padding(top = 16.dp, bottom = 32.dp), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        }
    }
}

@Composable
private fun LoginField(
    label: String, value: String, onChange: (String) -> Unit, hint: String,
    keyboard: KeyboardOptions, actions: KeyboardActions = KeyboardActions.Default,
    visual: VisualTransformation = VisualTransformation.None, trailing: @Composable (() -> Unit)? = null,
) {
    Column(Modifier.fillMaxWidth().padding(vertical = 14.dp)) {
        Text(label, fontSize = 12.sp, color = Pal.Muted)
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 6.dp)) {
            BasicTextField(
                value, onChange, singleLine = true, keyboardOptions = keyboard, keyboardActions = actions, visualTransformation = visual,
                textStyle = TextStyle(fontSize = 16.sp, color = Pal.Ink), cursorBrush = SolidColor(Pal.Gold),
                modifier = Modifier.weight(1f),
                decorationBox = { inner -> Box { if (value.isEmpty()) Text(hint, fontSize = 16.sp, color = Pal.Faint); inner() } },
            )
            trailing?.invoke()
        }
    }
}

// ---------- 本机能力 ----------

@Composable
fun CapabilityRow(cap: Capability) {
    val c = ctx()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var on by remember { mutableStateOf(cap.enabled(c)) }
    var denied by remember { mutableStateOf(false) }
    fun set(v: Boolean) {
        on = v
        Prefs.setGranted(cap.name, v)
        DeviceService.start(c, reregister = true)
    }
    DisposableEffect(lifecycle, cap) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                on = cap.enabled(c)
                if (on) denied = false
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        val ok = cap.hasPermissions(c)
        denied = !ok
        set(ok)
    }
    ListRow(
        cap.title,
        if (denied) "系统权限被拒绝 · 点这里去系统设置打开" else cap.hint,
        capIcon(cap.name), Color(0xFF4A77A0),
        subColor = if (denied) Pal.Danger else Pal.Muted, subLines = 2,
        onClick = if (denied) {
            { c.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", c.packageName, null))) }
        } else null,
        trailing = {
            GoldSwitch(on) { want ->
                if (!want) return@GoldSwitch set(false)
                val missing = cap.permissions.filter { ContextCompat.checkSelfPermission(c, it) != PackageManager.PERMISSION_GRANTED }
                if (missing.isEmpty()) set(true) else launcher.launch(missing.toTypedArray())
            }
        },
    )
}

@Composable
fun LocalCapabilities() {
    CardList {
        Capabilities.all.forEachIndexed { i, cap ->
            if (i > 0) Hairline()
            CapabilityRow(cap)
        }
    }
}

@Composable
fun OnboardingScreen() {
    val c = ctx()
    fun finish() { Prefs.onboarded = true; Session.onboarded.value = true }
    val notifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        Prefs.notifyMessages = ok
        finish()
    }
    Screen {
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp)) {
            Spacer(Modifier.height(40.dp))
            Text("开通本机能力", fontSize = 28.sp, fontWeight = FontWeight.Bold, color = Pal.Ink, modifier = Modifier.padding(start = 4.dp))
            Text(
                "打开的，豆豆可以随时用；没打开的，它碰不到。之后在「连接应用 → 本机」里随时改。",
                fontSize = 14.sp, lineHeight = 22.sp, color = Pal.Muted, modifier = Modifier.padding(start = 4.dp, top = 10.dp, bottom = 22.dp),
            )
            LocalCapabilities()
            GoldButton("开始使用", Modifier.fillMaxWidth().padding(top = 28.dp, bottom = 24.dp)) {
                if (android.os.Build.VERSION.SDK_INT >= 33 && Prefs.notifyMessages &&
                    ContextCompat.checkSelfPermission(c, android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    notifications.launch(android.Manifest.permission.POST_NOTIFICATIONS)
                } else finish()
            }
        }
    }
}

// ---------- 设置 ----------

/** Issue a fresh one-time code for another device. */
@Composable
fun PairCode() {
    val scope = rememberCoroutineScope()
    var code by remember { mutableStateOf("") }
    var error by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(vertical = 14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconTile(Icons.Outlined.Key, Color(0xFF96734F))
            Text("生成配对码", fontSize = 15.sp, fontWeight = FontWeight.Medium, color = Pal.Ink, modifier = Modifier.padding(start = 14.dp).weight(1f))
            QuietButton(if (busy) "生成中…" else if (code.isBlank()) "生成" else "换一个") {
                if (busy) return@QuietButton
                busy = true
                scope.launch {
                    runCatching { Api.postJson("/api/pair/new").getString("code") }
                        .onSuccess { code = it; error = "" }.onFailure { error = it.message ?: "失败" }
                    busy = false
                }
            }
        }
        if (code.isNotBlank()) {
            Text(
                code.chunked(3).joinToString(" "), fontSize = 30.sp, fontWeight = FontWeight.SemiBold, color = Pal.GoldInk, letterSpacing = 4.sp,
                modifier = Modifier.padding(top = 14.dp, start = 50.dp),
            )
        }
        if (error.isNotBlank()) Text(error, fontSize = 12.sp, color = Pal.Danger, modifier = Modifier.padding(top = 8.dp, start = 50.dp))
        Text("24 小时内有效，只能用一次，会顶掉之前没用的码", fontSize = 12.sp, color = Pal.Muted, modifier = Modifier.padding(top = 8.dp, start = 50.dp))
    }
}

@Composable
fun SettingsScreen() {
    val c = ctx()
    val (state, _) = load("state") { Api.getJson("/api/state") }
    var notify by remember { mutableStateOf(Prefs.notifyMessages && NotificationManagerCompat.from(c).areNotificationsEnabled()) }
    var notifyDenied by remember { mutableStateOf(false) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                val allowed = NotificationManagerCompat.from(c).areNotificationsEnabled()
                notify = Prefs.notifyMessages && allowed
                notifyDenied = Prefs.notifyMessages && !allowed
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    val notifyPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        notify = ok
        Prefs.notifyMessages = ok
        notifyDenied = !ok
    }
    SubPage("设置") {
        item {
            Column(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 10.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Avatar(72.dp)
                Text("豆豆 · Personal Agent", fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = Pal.Ink, modifier = Modifier.padding(top = 14.dp))
                Text(if (Chat.connected.value) "已连接云端" else "连接中…", fontSize = 12.sp, color = Pal.Muted, modifier = Modifier.padding(top = 4.dp))
            }
        }
        item { SectionTitle("模型") }
        item {
            CardList {
                ListRow(state?.optString("model")?.removePrefix("anthropic/")?.ifBlank { null } ?: "…", "在云端配置，这里只读", Icons.Outlined.Memory, Color(0xFF677CA3))
            }
        }
        item { SectionTitle("能力与连接") }
        item {
            CardList {
                ListRow("连接应用", "本机、云端和其他设备的能力", Icons.Outlined.Hub, Color(0xFF4A77A0)) { Nav.open(Route.Connectors()) }
                Hairline()
                ListRow("设备", "豆豆能用的手机、电脑和云电脑", Icons.Outlined.Devices, Color(0xFF478AA8)) { Nav.open(Route.Devices) }
                Hairline()
                ListRow("技能", "豆豆整理好的常用做法", Icons.Outlined.Extension, Color(0xFF776AA3)) { Nav.open(Route.Skills) }
            }
        }
        item { SectionTitle("通知") }
        item {
            CardList {
                ListRow("接收消息通知", if (notifyDenied) "系统通知权限被拒绝 · 点这里去系统设置打开" else "App 不在前台时，豆豆的回复和任务结果弹通知", Icons.Outlined.NotificationsNone,
                    Color(0xFF96734F), subColor = if (notifyDenied) Pal.Danger else Pal.Muted, subLines = 2,
                    onClick = if (notifyDenied) { { c.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", c.packageName, null))) } } else null,
                    trailing = {
                    GoldSwitch(notify) { want ->
                        val needPerm = android.os.Build.VERSION.SDK_INT >= 33 &&
                            ContextCompat.checkSelfPermission(c, android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                        if (want && needPerm) notifyPerm.launch(android.Manifest.permission.POST_NOTIFICATIONS)
                        else { notify = want; Prefs.notifyMessages = want; notifyDenied = false }
                    }
                })
            }
        }
        item { SectionTitle("账号") }
        item {
            CardList {
                ListRow("云端地址", Prefs.server, Icons.Outlined.Cloud, Color(0xFF4E79A3))
                Hairline()
                PairCode()
                Hairline()
                ListRow("退出登录", "清除这台手机上的口令，回到登录页", Icons.AutoMirrored.Outlined.Logout, Pal.Danger) { Session.logout(c) }
            }
        }
        item { FooterNote("版本 ${BuildConfigInfo.version(c)}") }
    }
}

@Composable
fun PillLink(text: String, onClick: () -> Unit) {
    Text(text, fontSize = 13.sp, color = Pal.Link, modifier = Modifier.clip(CircleShape).tap(onClick = onClick).padding(vertical = 6.dp))
}
