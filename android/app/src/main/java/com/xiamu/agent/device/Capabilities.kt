package com.xiamu.agent.device

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.location.Location
import android.location.LocationManager
import android.os.BatteryManager
import android.os.Build
import android.provider.CalendarContract
import android.provider.Telephony
import androidx.core.app.NotificationCompat
import com.xiamu.agent.App
import com.xiamu.agent.R
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import kotlin.coroutines.resume

/**
 * One thing this phone can do for the agent. Only capabilities the user switched on are registered.
 * [sync] capabilities can also be caught up incrementally (read_since) after the phone reconnects.
 */
class Capability(
    val name: String,
    val title: String,
    val description: String,
    val args: String,
    val permissions: List<String>,
    val sync: Boolean = false,
    /** What the user sees in settings; [description] is written for the model. */
    val hint: String? = null,
    val run: suspend (Context, JSONObject) -> Any,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("name", name)
        .put("description", description)
        .put("args", args)
        .put("sync", sync)
        .put("source", name)
}

object Capabilities {
    private val day = SimpleDateFormat("yyyy-MM-dd", Locale.CHINA)
    private val stamp = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.CHINA)

    val all: List<Capability> = listOfNotNull(
        Capability(
            "battery", "电量", "手机电量和是否在充电", "{}", emptyList(),
        ) { ctx, _ ->
            val i = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val level = i?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val scale = i?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
            val status = i?.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
            JSONObject().put("percent", level * 100 / scale)
                .put("charging", status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL)
        },
        Capability(
            "notify", "发通知", "在手机上弹一条通知提醒用户", """{"title":"标题","text":"正文"}""",
            if (Build.VERSION.SDK_INT >= 33) listOf(Manifest.permission.POST_NOTIFICATIONS) else emptyList(),
        ) { ctx, a ->
            val n = NotificationCompat.Builder(ctx, App.CH_AGENT)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(a.optString("title", "豆豆"))
                .setContentText(a.optString("text"))
                .setStyle(NotificationCompat.BigTextStyle().bigText(a.optString("text")))
                .setAutoCancel(true)
                .build()
            ctx.getSystemService(NotificationManager::class.java).notify((System.currentTimeMillis() % 100000).toInt(), n)
            "已通知"
        },
        Capability(
            "location", "位置", "手机当前位置（经纬度和精度，米）", "{}",
            listOf(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION),
        ) { ctx, _ -> location(ctx) },
        Capability(
            "calendar_events", "日历", "读手机日历里的日程", """{"from":"YYYY-MM-DD，默认今天","days":"天数，默认1"}""",
            listOf(Manifest.permission.READ_CALENDAR),
        ) { ctx, a -> calendar(ctx, a) },
        Capability(
            "sms", "短信", "读短信。call_device 时按条件查最近的短信；补读时按游标增量取",
            """{"limit":"条数，默认20","query":"可选，按内容或号码过滤"}""",
            listOf(Manifest.permission.READ_SMS), sync = true,
            hint = "豆豆能查你的短信，每天补读一次新短信记下要紧的事",
        ) { ctx, a -> sms(ctx, a) },
    )

    fun byName(name: String) = all.firstOrNull { it.name == name }

    @SuppressLint("MissingPermission")
    private suspend fun location(ctx: Context): Any {
        val lm = ctx.getSystemService(LocationManager::class.java)
        val provider = listOf(LocationManager.FUSED_PROVIDER, LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
            .firstOrNull { runCatching { lm.isProviderEnabled(it) }.getOrDefault(false) }
            ?: return JSONObject().put("error", "定位服务没开")
        val fresh: Location? = if (Build.VERSION.SDK_INT >= 30) {
            withTimeoutOrNull(15_000) {
                suspendCancellableCoroutine { cont ->
                    lm.getCurrentLocation(provider, null, ctx.mainExecutor) { cont.resume(it) }
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

    private fun sms(ctx: Context, a: JSONObject): Any {
        val limit = a.optString("limit").toIntOrNull()?.coerceIn(1, 100) ?: 20
        val q = a.optString("query")
        val (sel, selArgs) = if (q.isNotBlank()) {
            "${Telephony.Sms.BODY} LIKE ? OR ${Telephony.Sms.ADDRESS} LIKE ?" to arrayOf("%$q%", "%$q%")
        } else null to null
        val out = JSONArray()
        ctx.contentResolver.query(Telephony.Sms.CONTENT_URI, smsCols, sel, selArgs, "${Telephony.Sms.DATE} DESC")?.use { c ->
            while (c.moveToNext() && out.length() < limit) out.put(smsRow(c))
        }
        return out
    }

    /** Incremental read for catch-up. Cursor = last SMS _id handed out; first run starts from the last 3 days. */
    fun readSince(ctx: Context, source: String, cursor: String?, limit: Int): JSONObject {
        if (source != "sms") throw IllegalArgumentException("不支持补读：$source")
        val (sel, args) = if (cursor.isNullOrBlank()) {
            "${Telephony.Sms.DATE} > ?" to arrayOf((System.currentTimeMillis() - 3 * 86_400_000L).toString())
        } else "${Telephony.Sms._ID} > ?" to arrayOf(cursor)
        val items = JSONArray()
        var last = cursor
        ctx.contentResolver.query(Telephony.Sms.CONTENT_URI, smsCols, sel, args, "${Telephony.Sms._ID} ASC")?.use { c ->
            while (c.moveToNext() && items.length() < limit) {
                val row = smsRow(c)
                items.put(row)
                last = row.getLong("id").toString()
            }
        }
        return JSONObject().put("items", items).put("next_cursor", last).put("more", items.length() >= limit)
    }
}
