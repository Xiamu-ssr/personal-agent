package com.xiamu.agent

import org.json.JSONObject
import java.time.OffsetDateTime

enum class ActivityStatus(val wire: String, val label: String) {
    Running("running", "进行中"), Done("done", "已完成"), Error("error", "出错"), Stopped("stopped", "已停止");
    companion object { fun from(value: String) = entries.firstOrNull { it.wire == value } ?: error("活动状态无法识别") }
}
enum class ActivityItemKind(val wire: String) {
    Prompt("prompt"), Text("text"), Tool("tool"), Result("result");
    companion object { fun from(value: String) = entries.firstOrNull { it.wire == value } ?: error("活动记录无法识别") }
}
data class ActivityHistoryItem(val kind: ActivityItemKind, val text: String, val tool: String?, val time: Long,
    val from: String? = null, val attachments: List<Attachment> = emptyList(), val media: List<ReplyMedia> = emptyList()) {
    val isUser: Boolean get() = kind == ActivityItemKind.Prompt && from == "user"
    val isInstruction: Boolean get() = kind == ActivityItemKind.Prompt && from == "agent"
    companion object {
        fun from(j: JSONObject, allowMedia: Boolean = true) = ActivityHistoryItem(ActivityItemKind.from(j.getString("kind")), j.getString("text"),
            if (j.isNull("tool")) null else j.getString("tool"),
            when (val time = j.get("time")) {
                is Number -> time.toLong()
                is String -> OffsetDateTime.parse(time).toInstant().toEpochMilli()
                else -> error("活动时间无法识别")
            }, if (j.isNull("from")) null else j.getString("from"),
            j.optJSONArray("attachments").objects().map(Attachment::from),
            if (allowMedia && j.getString("kind") == ActivityItemKind.Result.wire) replyMedia(j) else emptyList()).also {
                require(it.kind != ActivityItemKind.Prompt || it.from in setOf("agent", "user")) { "活动消息缺少来源" }
            }
    }
}
data class ActivityHistory(val id: String, val title: String, val status: ActivityStatus, val items: List<ActivityHistoryItem>) {
    val prompts: List<ActivityHistoryItem> get() = items.filter { it.kind == ActivityItemKind.Prompt }
    val steps: List<ActivityHistoryItem> get() = items.filter { it.kind == ActivityItemKind.Tool || it.kind == ActivityItemKind.Text }
    val results: List<ActivityHistoryItem> get() = items.filter { it.kind == ActivityItemKind.Result }

    companion object {
        fun from(j: JSONObject): ActivityHistory {
            val status = ActivityStatus.from(j.getString("status"))
            return ActivityHistory(j.getString("id"), j.getString("title"), status,
                j.getJSONArray("items").objects().map { ActivityHistoryItem.from(it, allowMedia = status == ActivityStatus.Done) })
                .also { require(it.id.isNotBlank()) { "活动缺少 id" } }
        }
    }
}
