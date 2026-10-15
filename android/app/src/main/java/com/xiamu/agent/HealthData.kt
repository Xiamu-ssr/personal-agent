package com.xiamu.agent

import org.json.JSONObject
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

data class HealthDay(val date: LocalDate, val sleepMinutes: Double?, val restingHr: Double?, val hrv: Double?, val steps: Double?)
data class HealthRecord(val path: String, val title: String, val updated: String?, val preview: String)
data class HealthData(val syncedAt: String?, val device: String?, val note: String?, val days: List<HealthDay>,
    val records: List<HealthRecord>) {
    val today: HealthDay get() = days.last()
    fun syncLabel(zone: ZoneId = ZoneId.systemDefault()): String = note?.takeIf { it.isNotBlank() } ?: syncedAt?.let {
        runCatching { "上次同步 " + OffsetDateTime.parse(it).atZoneSameInstant(zone).format(DateTimeFormatter.ofPattern("HH:mm")) +
            (device?.let { d -> " · $d" } ?: "") }.getOrDefault("还没有同步")
    } ?: "还没有同步"
    companion object {
        fun from(j: JSONObject, today: LocalDate = LocalDate.now()): HealthData {
            fun JSONObject.number(key: String) = if (isNull(key)) null else getDouble(key).takeIf { it.isFinite() }
            fun JSONObject.text(key: String) = if (isNull(key)) null else getString(key)
            val byDate = j.getJSONArray("days").objects().associate {
                val date = LocalDate.parse(it.getString("date"))
                date to HealthDay(date, it.number("sleepMinutes"), it.number("restingHr"), it.number("hrv"), it.number("steps"))
            }
            return HealthData(j.text("syncedAt"), j.text("device"), j.text("note"), (6L downTo 0L).map {
                val date = today.minusDays(it); byDate[date] ?: HealthDay(date, null, null, null, null)
            }, j.getJSONArray("records").objects().map { HealthRecord(it.getString("path"), it.getString("title"), it.text("updated"), it.getString("preview")) })
        }
    }
}
fun healthNumber(value: Double?): String = value?.let { if (it % 1 == 0.0) it.toLong().toString() else String.format(Locale.CHINA, "%.1f", it) } ?: "--"
fun sleepLabel(minutes: Double?): String = minutes?.toInt()?.let { "${it / 60} 小时 ${it % 60} 分" } ?: "--"

fun healthEntryIsNew(updated: String?, seenAt: Long, zone: ZoneId = ZoneId.systemDefault()): Boolean =
    updated?.let { runCatching { LocalDate.parse(it).atStartOfDay(zone).toInstant().toEpochMilli() > seenAt }.getOrDefault(false) } ?: false
