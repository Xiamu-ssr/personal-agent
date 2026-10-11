package com.xiamu.agent.device

import android.Manifest
import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.SystemClock
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.*
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import com.xiamu.agent.App
import com.xiamu.agent.Prefs
import kotlinx.coroutines.*
import org.json.JSONObject
import org.json.JSONArray
import java.time.LocalDate
import java.time.ZoneId
import kotlin.reflect.KClass

/** Only the four requested read types, plus optional background reads for device RPC. */
object HealthAccess {
    val readPermissions = setOf(HealthPermission.getReadPermission(StepsRecord::class), HealthPermission.getReadPermission(SleepSessionRecord::class),
        HealthPermission.getReadPermission(HeartRateRecord::class), HealthPermission.getReadPermission(HeartRateVariabilityRmssdRecord::class))
    val permissionContract get() = PermissionController.createRequestPermissionResultContract()
    @Volatile private var granted = emptySet<String>()
    fun available(context: Context) = HealthConnectClient.getSdkStatus(context) == HealthConnectClient.SDK_AVAILABLE
    fun sensorPermission(context: Context) = Build.VERSION.SDK_INT < 29 || ContextCompat.checkSelfPermission(context, Manifest.permission.ACTIVITY_RECOGNITION) == PackageManager.PERMISSION_GRANTED
    fun hasPermissions(context: Context) = sensorPermission(context) || readPermissions.any { it in granted } ||
        (Build.VERSION.SDK_INT >= 34 && readPermissions.any { ContextCompat.checkSelfPermission(context,it) == PackageManager.PERMISSION_GRANTED })
    fun permissions(context: Context): Set<String> {
        if(!available(context)) return emptySet()
        val client = HealthConnectClient.getOrCreate(context)
        val background = client.features.getFeatureStatus(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND) == HealthConnectFeatures.FEATURE_STATUS_AVAILABLE
        return readPermissions + if(background) setOf(HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND) else emptySet()
    }
    fun updateGranted(permissions: Set<String>) { granted = permissions }
    suspend fun refresh(context: Context) {
        granted = if(available(context)) HealthConnectClient.getOrCreate(context).permissionController.getGrantedPermissions() else emptySet()
    }

    suspend fun read(context: Context, args: JSONObject): JSONObject {
        val from = args.optString("from").ifBlank { LocalDate.now().toString() }
        val date = runCatching { LocalDate.parse(from) }.getOrElse { throw IllegalArgumentException("from 要 YYYY-MM-DD") }
        val days = if(args.has("days")) args.optString("days").toIntOrNull()?.takeIf { it in 1..31 } ?: throw IllegalArgumentException("days 要 1–31") else 1
        var reason = "Health Connect 不可用"
        if(available(context)) {
            try {
                refresh(context)
                if(readPermissions.none { it in granted }) reason = "Health Connect 还没有授权"
                else if(!App.foreground && HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND !in granted) reason = "Health Connect 暂不能在后台读取"
                else {
                    val result = readConnect(HealthConnectClient.getOrCreate(context), date, days, granted)
                    if(result.getJSONArray("items").length() > 0) return result
                    reason = "Health Connect 没有数据"
                }
            } catch(e: CancellationException) { throw e }
            catch(e: SecurityException) { reason = "Health Connect 读取权限已收回" }
            catch(e: Exception) { reason = "Health Connect 暂不可读" }
        }
        return StepCounter.read(context,date,days).put("note",reason + "；" + StepCounter.note(context))
    }

    internal suspend fun readConnect(client: HealthConnectClient, date: LocalDate, days: Int, permissions: Set<String>): JSONObject {
        val zone = ZoneId.systemDefault()
        val items = JSONArray()
        for(i in 0 until days) {
            val day = date.plusDays(i.toLong())
            val start = day.atStartOfDay(zone).toInstant(); val end = day.plusDays(1).atStartOfDay(zone).toInstant()
            val filter = TimeRangeFilter.between(start,end)
            val item = JSONObject().put("date",day.toString())
            if(HealthPermission.getReadPermission(StepsRecord::class) in permissions) {
                client.aggregate(AggregateRequest(setOf(StepsRecord.COUNT_TOTAL),filter))[StepsRecord.COUNT_TOTAL]?.let { item.put("steps",it) }
            }
            if(HealthPermission.getReadPermission(SleepSessionRecord::class) in permissions) {
                client.aggregate(AggregateRequest(setOf(SleepSessionRecord.SLEEP_DURATION_TOTAL),filter))[SleepSessionRecord.SLEEP_DURATION_TOTAL]?.let { item.put("sleep_minutes",it.toMinutes()) }
            }
            if(HealthPermission.getReadPermission(HeartRateRecord::class) in permissions) {
                val samples = readPages(client,HeartRateRecord::class,filter).flatMap { it.samples }.filter { it.time >= start && it.time < end }
                if(samples.isNotEmpty()) item.put("heart_rate_bpm",samples.map { it.beatsPerMinute }.average())
            }
            if(HealthPermission.getReadPermission(RestingHeartRateRecord::class) in permissions) {
                val resting = readPages(client,RestingHeartRateRecord::class,filter)
                if(resting.isNotEmpty()) item.put("resting_heart_rate_bpm",resting.map { it.beatsPerMinute }.average())
            }
            if(HealthPermission.getReadPermission(HeartRateVariabilityRmssdRecord::class) in permissions) {
                val hrv = readPages(client,HeartRateVariabilityRmssdRecord::class,filter)
                if(hrv.isNotEmpty()) item.put("hrv_ms",hrv.map { it.heartRateVariabilityMillis }.average())
            }
            if(item.length() > 1) items.put(item)
        }
        return JSONObject().put("source","health_connect").put("from",date.toString()).put("days",days).put("items",items)
    }

    private suspend fun <T: Record> readPages(client: HealthConnectClient, type: KClass<T>, filter: TimeRangeFilter): List<T> {
        val out = mutableListOf<T>(); var token: String? = null
        do {
            val response = client.readRecords(ReadRecordsRequest(type,filter,pageToken=token))
            out.addAll(response.records); token=response.pageToken?.takeIf { it.isNotBlank() }
        } while(token != null)
        return out
    }
}

/** Persist observed steps per calendar day. Historical days outside observation stay missing. */
object StepCounter : SensorEventListener {
    private var manager: SensorManager? = null
    private var context: Context? = null
    private val scope = CoroutineScope(SupervisorJob()+Dispatchers.IO.limitedParallelism(1))
    fun start(context: Context) {
        stop()
        if(!Prefs.granted("health") || !HealthAccess.sensorPermission(context)) return
        val manager = context.getSystemService(SensorManager::class.java)
        val sensor = manager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER) ?: return
        this.manager=manager; this.context=context.applicationContext
        manager.registerListener(this,sensor,SensorManager.SENSOR_DELAY_NORMAL)
    }
    fun stop() { manager?.unregisterListener(this); manager=null; context=null }
    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
    override fun onSensorChanged(event: SensorEvent) {
        val c = context ?: return
        val sample = StepBaseline(event.values[0].toLong(),LocalDate.now().toString(),SystemClock.elapsedRealtime())
        scope.launch { observe(c,sample) }
    }
    @Synchronized internal fun observe(context: Context, next: StepBaseline) {
        val prefs = context.getSharedPreferences("observed-steps",Context.MODE_PRIVATE)
        val previous = if(prefs.contains("last-count")) StepBaseline(prefs.getLong("last-count",0),prefs.getString("last-date","").orEmpty(),prefs.getLong("last-uptime",0)) else null
        val key = "day:${next.date}"
        val total = prefs.getLong(key,0)+stepDelta(previous,next)
        val edit = prefs.edit().putLong(key,total).putLong("last-count",next.count).putString("last-date",next.date).putLong("last-uptime",next.uptime)
        if(!prefs.contains("since:${next.date}")) edit.putLong("since:${next.date}",System.currentTimeMillis())
        edit.apply()
    }
    fun note(context: Context) = when {
        !HealthAccess.sensorPermission(context) -> "计步权限还没有开启"
        context.getSystemService(SensorManager::class.java).getDefaultSensor(Sensor.TYPE_STEP_COUNTER) == null -> "这台设备没有计步传感器"
        else -> "计步传感器只提供开启后的步数"
    }
    internal fun read(context: Context, from: LocalDate, days: Int): JSONObject {
        val prefs = context.getSharedPreferences("observed-steps",Context.MODE_PRIVATE)
        val items = JSONArray()
        if(HealthAccess.sensorPermission(context)) for(i in 0 until days) {
            val day=from.plusDays(i.toLong()).toString(); val key="day:$day"
            if(prefs.contains(key)) items.put(JSONObject().put("date",day).put("steps",prefs.getLong(key,0)).put("partial",true).put("observedSince",prefs.getLong("since:$day",0)))
        }
        return JSONObject().put("source","step_counter").put("from",from.toString()).put("days",days).put("items",items)
    }
}
