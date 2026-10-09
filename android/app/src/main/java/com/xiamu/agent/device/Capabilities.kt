package com.xiamu.agent.device

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.location.Location
import android.location.LocationManager
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.provider.CalendarContract
import android.provider.Telephony
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import android.content.pm.PackageManager
import com.xiamu.agent.App
import com.xiamu.agent.MainActivity
import com.xiamu.agent.Prefs
import com.xiamu.agent.R
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import kotlin.coroutines.resume

/**
 * One thing this phone can do for the agent. Every capability is registered with its [enabled] state;
 * the agent only sees enabled ones. [sync] capabilities can also be caught up incrementally (read_since).
 */
class Capability(
    val name: String,
    val title: String,
    val description: String,
    val args: String,
    val permissions: List<String>,
    val sync: Boolean = false,
    /** What the user sees in the app; [description] is written for the model. */
    val hint: String,
    val run: suspend (Context, JSONObject) -> Any,
) {
    fun hasPermissions(ctx: Context): Boolean {
        fun has(p: String) = ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED
        return if (name == "location") permissions.any(::has) else permissions.all(::has)
    }

    fun enabled(ctx: Context) = Prefs.granted(name) && hasPermissions(ctx)

    fun toJson(enabled: Boolean): JSONObject = JSONObject()
        .put("name", name)
        .put("title", title)
        .put("description", description)
        .put("args", args)
        .put("sync", sync)
        .put("source", name)
        .put("enabled", enabled)
        .put("hint", hint)
}

object Capabilities {
    private val day get() = SimpleDateFormat("yyyy-MM-dd", Locale.CHINA).apply { isLenient = false }
    private val stamp get() = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.CHINA)

    private val notifyPerm = if (Build.VERSION.SDK_INT >= 33) listOf(Manifest.permission.POST_NOTIFICATIONS) else emptyList()

    val all: List<Capability> = listOf(
        Capability(
            "battery", "电量", "手机电量和是否在充电", "{}", emptyList(), hint = "豆豆能看手机还剩多少电",
        ) { ctx, _ ->
            val i = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val level = i?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val scale = i?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
            val status = i?.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
            JSONObject().put("percent", if (level >= 0 && scale > 0) level * 100 / scale else JSONObject.NULL)
                .put("charging", status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL)
        },
        Capability(
            "notify", "发通知", "在手机上弹一条通知提醒用户", """{"title":"标题","text":"正文"}""", notifyPerm,
            hint = "豆豆可以在手机上弹通知提醒你",
        ) { ctx, a ->
            notify(ctx, a.optString("title").ifBlank { "豆豆" }, a.optString("text"), openApp(ctx))
            "已通知"
        },
        Capability(
            "location", "位置", "手机当前位置（经纬度和精度，米）", "{}",
            listOf(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION),
            hint = "豆豆能知道你大概在哪，用来查天气、算路程",
        ) { ctx, _ -> location(ctx) },
        Capability(
            "calendar_events", "日历", "读手机日历里的日程", """{"from":"YYYY-MM-DD，默认今天","days":"天数，默认1"}""",
            listOf(Manifest.permission.READ_CALENDAR), hint = "豆豆能看你手机日历里的日程",
        ) { ctx, a -> calendar(ctx, a) },
        Capability(
            "sms", "短信",
            "读短信，按 id 从新到旧。一次最多 500 条，要更早的就把返回的 next_before 作为 before 继续翻；" +
                "可按内容/号码（query）和日期范围过滤，total_in_range 是范围内的总条数。补读时按游标增量取",
            """{"limit":"条数，默认50，最多500","before":"可选，取这个短信 id 之前的（翻更早的）","query":"可选，按内容或号码过滤","from_date":"可选 YYYY-MM-DD","to_date":"可选 YYYY-MM-DD"}""",
            listOf(Manifest.permission.READ_SMS), sync = true,
            hint = "豆豆能查你的短信，每天补读一次新短信记下要紧的事",
        ) { ctx, a -> sms(ctx, a) },
        Capability(
            "clipboard_write", "写剪贴板", "把一段文字放进手机剪贴板，用户可以直接粘贴", """{"text":"要复制的文字"}""", emptyList(),
            hint = "豆豆可以把文字放进剪贴板，你直接粘贴",
        ) { ctx, a ->
            val text = a.optString("text")
            if (text.isEmpty()) throw IllegalArgumentException("text 不能为空")
            withContext(Dispatchers.Main) {
                ctx.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("豆豆", text))
            }
            "已复制到剪贴板"
        },
        Capability(
            "open_url", "打开网页",
            "在手机上发一条通知，用户点开就用浏览器打开这个网址（手机后台不能直接拉起页面）", """{"url":"http(s) 网址","title":"可选，通知标题"}""",
            notifyPerm, hint = "豆豆发来的链接会出现在通知里，点开就是浏览器",
        ) { ctx, a ->
            val url = a.optString("url").trim()
            if (!url.startsWith("http://") && !url.startsWith("https://")) throw IllegalArgumentException("只支持 http(s) 网址")
            val view = PendingIntent.getActivity(
                ctx, url.hashCode(), Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            notify(ctx, a.optString("title").ifBlank { "豆豆发来一个链接" }, url, view)
            "已发到通知栏，用户点开就会打开"
        },
    )

    private fun openApp(ctx: Context): PendingIntent = PendingIntent.getActivity(
        ctx, 0, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE,
    )

    fun notify(ctx: Context, title: String, text: String, tap: PendingIntent? = openApp(ctx)) {
        val n = NotificationCompat.Builder(ctx, App.CH_AGENT)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(tap)
            .setAutoCancel(true)
            .build()
        ctx.getSystemService(NotificationManager::class.java).notify((System.nanoTime() % 1_000_000).toInt(), n)
    }

    fun byName(name: String) = all.firstOrNull { it.name == name }

    @SuppressLint("MissingPermission")
    private suspend fun location(ctx: Context): Any {
        val lm = ctx.getSystemService(LocationManager::class.java)
        val providers = if (Build.VERSION.SDK_INT >= 31) listOf(LocationManager.FUSED_PROVIDER, LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
            else listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
        val provider = providers
            .firstOrNull { runCatching { lm.isProviderEnabled(it) }.getOrDefault(false) }
            ?: return JSONObject().put("error", "定位服务没开")
        val fresh: Location? = if (Build.VERSION.SDK_INT >= 30) {
            withTimeoutOrNull(15_000) {
                suspendCancellableCoroutine { cont ->
                    val signal = android.os.CancellationSignal()
                    cont.invokeOnCancellation { signal.cancel() }
                    lm.getCurrentLocation(provider, signal, ctx.mainExecutor) { if (cont.isActive) cont.resume(it) }
                }
            }
        } else null
        val loc = fresh ?: lm.getLastKnownLocation(provider) ?: return JSONObject().put("error", "暂时拿不到位置")
        return JSONObject().put("lat", loc.latitude).put("lng", loc.longitude).put("accuracy_m", loc.accuracy.toInt())
            .put("time", stamp.format(Date(loc.time)))
    }

    private fun calendar(ctx: Context, a: JSONObject): Any {
        val start = Calendar.getInstance().apply {
            val from = a.optString("from")
            if (from.isNotBlank()) runCatching { time = day.parse(from)!! }
            set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0)
        }
        val days = a.optString("days").toIntOrNull()?.coerceIn(1, 31) ?: 1
        val end = start.timeInMillis + days * 86_400_000L
        val uri = CalendarContract.Instances.CONTENT_URI.buildUpon().also {
            android.content.ContentUris.appendId(it, start.timeInMillis)
            android.content.ContentUris.appendId(it, end)
        }.build()
        val out = JSONArray()
        ctx.contentResolver.query(
            uri,
            arrayOf(CalendarContract.Instances.TITLE, CalendarContract.Instances.BEGIN, CalendarContract.Instances.END,
                CalendarContract.Instances.ALL_DAY, CalendarContract.Instances.EVENT_LOCATION),
            null, null, CalendarContract.Instances.BEGIN + " ASC",
        )?.use { c ->
            while (c.moveToNext()) {
                out.put(JSONObject().put("title", c.getString(0)).put("begin", stamp.format(Date(c.getLong(1))))
                    .put("end", stamp.format(Date(c.getLong(2)))).put("all_day", c.getInt(3) == 1)
                    .put("location", c.getString(4) ?: ""))
            }
        }
        return out
    }

    private fun smsRow(c: android.database.Cursor) = JSONObject()
        .put("id", c.getLong(0))
        .put("from", c.getString(1))
        .put("text", c.getString(2))
        .put("time", stamp.format(Date(c.getLong(3))))
        .put("box", if (c.getInt(4) == Telephony.Sms.MESSAGE_TYPE_SENT) "sent" else "inbox")

    private val smsCols = arrayOf(Telephony.Sms._ID, Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE, Telephony.Sms.TYPE)

    private fun dayStart(d: String): Long? = if (d.matches(Regex("\\d{4}-\\d{2}-\\d{2}"))) runCatching { day.parse(d)!!.time }.getOrNull() else null

    /** Newest first by _id; [before] pages backwards. total_in_range ignores [before]. */
    private fun sms(ctx: Context, a: JSONObject): Any {
        val limit = a.optString("limit").toIntOrNull()?.coerceIn(1, 500) ?: 50
        val sel = mutableListOf<String>()
        val args = mutableListOf<String>()
        a.optString("query").takeIf { it.isNotBlank() }?.let {
            sel += "(${Telephony.Sms.BODY} LIKE ? OR ${Telephony.Sms.ADDRESS} LIKE ?)"; args += "%$it%"; args += "%$it%"
        }
        a.optString("from_date").takeIf { it.isNotBlank() }?.let { d ->
            sel += "${Telephony.Sms.DATE} >= ?"; args += (dayStart(d) ?: throw IllegalArgumentException("from_date 要 YYYY-MM-DD")).toString()
        }
        a.optString("to_date").takeIf { it.isNotBlank() }?.let { d ->
            sel += "${Telephony.Sms.DATE} < ?"; args += ((dayStart(d) ?: throw IllegalArgumentException("to_date 要 YYYY-MM-DD")) + 86_400_000L).toString()
        }
        val cr = ctx.contentResolver
        val total = cr.query(Telephony.Sms.CONTENT_URI, arrayOf(Telephony.Sms._ID), sel.joinToString(" AND ").ifBlank { null },
            args.toTypedArray(), null)?.use { it.count } ?: 0
        a.optString("before").takeIf { it.isNotBlank() && it != "null" }?.let {
            val id = it.toLongOrNull() ?: throw IllegalArgumentException("before 要短信 id")
            sel += "${Telephony.Sms._ID} < ?"; args += id.toString()
        }
        val items = JSONArray()
        var more = false
        cr.query(Telephony.Sms.CONTENT_URI, smsCols, sel.joinToString(" AND ").ifBlank { null }, args.toTypedArray(),
            "${Telephony.Sms._ID} DESC")?.use { c ->
            while (c.moveToNext()) {
                if (items.length() == limit) { more = true; break }
                items.put(smsRow(c))
            }
        }
        val nextBefore: Any = if (more) items.getJSONObject(items.length() - 1).getLong("id") else JSONObject.NULL
        return JSONObject().put("items", items).put("next_before", nextBefore).put("total_in_range", total)
    }

    /** Incremental read for catch-up. Cursor = last SMS _id handed out; first run starts from the last 3 days. */
    fun readSince(ctx: Context, source: String, cursor: String?, limit: Int): JSONObject {
        if (source != "sms") throw IllegalArgumentException("不支持补读：$source")
        val n = limit.coerceIn(1, 500)
        if (!cursor.isNullOrBlank() && cursor.toLongOrNull() == null) throw IllegalArgumentException("cursor 要短信 id")
        val (sel, args) = if (cursor.isNullOrBlank()) {
            "${Telephony.Sms.DATE} > ?" to arrayOf((System.currentTimeMillis() - 3 * 86_400_000L).toString())
        } else "${Telephony.Sms._ID} > ?" to arrayOf(cursor)
        val items = JSONArray()
        var last = cursor
        var more = false
        ctx.contentResolver.query(Telephony.Sms.CONTENT_URI, smsCols, sel, args, "${Telephony.Sms._ID} ASC")?.use { c ->
            while (c.moveToNext()) {
                if (items.length() == n) { more = true; break }
                val row = smsRow(c)
                items.put(row)
                last = row.getLong("id").toString()
            }
        }
        return JSONObject().put("items", items).put("next_cursor", last ?: JSONObject.NULL).put("more", more)
    }
}
