package com.xiamu.agent

import org.json.JSONObject
import java.time.LocalDate
import java.time.ZoneId

data class JobRecord(val id: String, val title: String, val status: TaskStatus, val ts: Long, val outputs: List<String>, val path: String?) {
    companion object {
        fun from(j: JSONObject) = JobRecord(j.getString("id"), j.getString("title").ifBlank { j.getString("label") },
            TaskStatus.from(j.getString("status")), j.getLong("ts"), j.optJSONArray("outputs").strings(),
            j.optString("path").takeIf(::isBriefPath))
    }
}
data class JobsPage(val running: List<Running>, val recent: List<JobRecord>, val next: Long?) {
    companion object {
        fun from(j: JSONObject) = JobsPage(j.optJSONArray("running").objects().map {
            Running(it.getString("id"), it.getString("label"), it.getLong("started"))
        }, j.getJSONArray("recent").objects().map(JobRecord::from), if (j.isNull("next")) null else j.getLong("next"))
    }
}
enum class JobGroup(val label: String) { Today("今天"), Week("近 7 天"), Older("更早") }
fun groupJobs(jobs: List<JobRecord>, today: LocalDate = LocalDate.now(), zone: ZoneId = ZoneId.systemDefault()): Map<JobGroup, List<JobRecord>> {
    val start = today.atStartOfDay(zone).toInstant().toEpochMilli()
    val week = today.minusDays(6).atStartOfDay(zone).toInstant().toEpochMilli()
    val sorted = jobs.distinctBy { it.id }.sortedByDescending { it.ts }
    return JobGroup.entries.associateWith { group -> sorted.filter {
        when { it.ts >= start -> JobGroup.Today; it.ts >= week -> JobGroup.Week; else -> JobGroup.Older } == group
    } }.filterValues { it.isNotEmpty() }
}
data class JobsTimeline(val running: List<Running> = emptyList(), val recent: List<JobRecord> = emptyList(), val next: Long? = null) {
    fun apply(page: JobsPage, older: Boolean) = JobsTimeline(if (older) running else page.running,
        (if (older) recent + page.recent else page.recent).distinctBy { it.id }.sortedByDescending { it.ts }, page.next)
}
