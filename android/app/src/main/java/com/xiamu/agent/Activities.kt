package com.xiamu.agent

import org.json.JSONObject
import java.time.LocalDate
import java.time.ZoneId

data class RunningActivity(val id: String,val label: String,val started: Long,val chatType: String? = null,val summary: String = "")

data class ActivityRecord(val id: String, val title: String, val status: ActivityStatus, val ts: Long, val outputs: List<String>,val chatType: String? = null,val summary: String = "") {
    companion object {
        fun from(j: JSONObject) = ActivityRecord(j.getString("id"), j.getString("title").ifBlank { j.getString("label") },
            ActivityStatus.from(j.getString("status")), j.getLong("ts"), j.optJSONArray("outputs").strings(),j.optString("chatType").takeIf { it.isNotBlank() },j.optString("summary"))
    }
}
data class ActivitiesPage(val running: List<RunningActivity>, val recent: List<ActivityRecord>, val next: Long?) {
    companion object {
        fun from(j: JSONObject) = ActivitiesPage(j.optJSONArray("running").objects().map {
            RunningActivity(it.getString("id"), it.optString("title").ifBlank { it.getString("label") }, it.getLong("started"),it.optString("chatType").takeIf { t -> t.isNotBlank() },it.optString("summary"))
        }, j.getJSONArray("recent").objects().map(ActivityRecord::from), if (j.isNull("next")) null else j.getLong("next"))
    }
}
enum class ActivityGroup(val label: String) { Today("今天"), Week("近 7 天"), Older("更早") }
fun groupActivities(jobs: List<ActivityRecord>, today: LocalDate = LocalDate.now(), zone: ZoneId = ZoneId.systemDefault()): Map<ActivityGroup, List<ActivityRecord>> {
    val start = today.atStartOfDay(zone).toInstant().toEpochMilli()
    val week = today.minusDays(6).atStartOfDay(zone).toInstant().toEpochMilli()
    val sorted = jobs.distinctBy { it.id }.sortedByDescending { it.ts }
    return ActivityGroup.entries.associateWith { group -> sorted.filter {
        when { it.ts >= start -> ActivityGroup.Today; it.ts >= week -> ActivityGroup.Week; else -> ActivityGroup.Older } == group
    } }.filterValues { it.isNotEmpty() }
}
data class ActivitiesTimeline(val running: List<RunningActivity> = emptyList(), val recent: List<ActivityRecord> = emptyList(), val next: Long? = null) {
    fun apply(page: ActivitiesPage, older: Boolean) = ActivitiesTimeline(if (older) running else page.running,
        (if (older) recent + page.recent else page.recent).distinctBy { it.id }.sortedByDescending { it.ts }, page.next)
    // Presentation updates never add a row, change its status, or move it in the list.
    fun updated(updates: Collection<ActivityTitleUpdate>): ActivitiesTimeline {
        val byId=updates.associateBy { it.id }
        return copy(running=running.map { a -> byId[a.id]?.let { a.copy(label=it.title ?: a.label,summary=it.summary ?: a.summary) } ?: a },
            recent=recent.map { a -> byId[a.id]?.let { a.copy(title=it.title ?: a.title,summary=it.summary ?: a.summary) } ?: a })
    }
}

data class ActivityTitleUpdate(val id: String,val title: String?,val summary: String?) {
    companion object {
        fun from(event: JSONObject): ActivityTitleUpdate? {
            if(event.optString("t")!="activity" || event.optString("phase")!="updated") return null
            val id=event.optString("id").takeIf { it.isNotBlank() } ?: return null
            val title=event.optString("title").takeIf { !event.isNull("title") && it.isNotBlank() }
            val summary=event.optString("summary").takeIf { event.has("summary") && !event.isNull("summary") }
            return ActivityTitleUpdate(id,title,summary)
        }
    }
}
