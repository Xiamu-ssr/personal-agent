package com.xiamu.agent

import org.json.JSONObject
import java.net.URLDecoder
import java.time.OffsetDateTime

enum class TaskStatus(val wire: String, val label: String) {
    Running("running", "进行中"), Done("done", "已完成"), Error("error", "出错"), Stopped("stopped", "已停止");
    companion object { fun from(value: String) = entries.firstOrNull { it.wire == value } ?: error("任务状态无法识别") }
}
enum class TaskItemKind(val wire: String) {
    Prompt("prompt"), Text("text"), Tool("tool"), Result("result");
    companion object { fun from(value: String) = entries.firstOrNull { it.wire == value } ?: error("任务记录无法识别") }
}
data class TaskHistoryItem(val kind: TaskItemKind, val text: String, val tool: String?, val time: Long,
    val from: String? = null, val attachments: List<Attachment> = emptyList(), val media: List<ReplyMedia> = emptyList()) {
    val isUser: Boolean get() = kind == TaskItemKind.Prompt && from == "user"
    val isInstruction: Boolean get() = kind == TaskItemKind.Prompt && from == "agent"
    companion object {
        fun from(j: JSONObject, allowMedia: Boolean = true) = TaskHistoryItem(TaskItemKind.from(j.getString("kind")), j.getString("text"),
            if (j.isNull("tool")) null else j.getString("tool"),
            when (val time = j.get("time")) {
                is Number -> time.toLong()
                is String -> OffsetDateTime.parse(time).toInstant().toEpochMilli()
                else -> error("任务时间无法识别")
            }, if (j.isNull("from")) null else j.getString("from"),
            j.optJSONArray("attachments").objects().map(Attachment::from),
            if (allowMedia && j.getString("kind") == TaskItemKind.Result.wire) replyMedia(j) else emptyList()).also {
                require(it.kind != TaskItemKind.Prompt || it.from in setOf("agent", "user")) { "任务消息缺少来源" }
            }
    }
}
data class TaskHistory(val id: String, val title: String, val status: TaskStatus, val items: List<TaskHistoryItem>) {
    val prompts: List<TaskHistoryItem> get() = items.filter { it.kind == TaskItemKind.Prompt }
    val steps: List<TaskHistoryItem> get() = items.filter { it.kind == TaskItemKind.Tool || it.kind == TaskItemKind.Text }
    val results: List<TaskHistoryItem> get() = items.filter { it.kind == TaskItemKind.Result }
    val briefPath: String? get() = results.firstNotNullOfOrNull { briefPathInText(it.text) }

    companion object {
        fun from(j: JSONObject): TaskHistory {
            val status = TaskStatus.from(j.getString("status"))
            return TaskHistory(j.getString("id"), j.getString("title"), status,
                j.getJSONArray("items").objects().map { TaskHistoryItem.from(it, allowMedia = status == TaskStatus.Done) })
                .also { require(it.id.isNotBlank()) { "任务缺少 id" } }
        }
    }
}

fun briefPathInText(text: String): String? {
    val markdownPath = Regex("\\]\\((data/briefs/[^)\\r\\n]+\\.html)\\)").find(text)?.groupValues?.get(1)
    val path = markdownPath ?: Regex("data/briefs/[^\\s`<>\\\"()]+\\.html").find(text)?.value ?: return null
    return runCatching { URLDecoder.decode(path.replace("+", "%2B"), "UTF-8") }.getOrNull()?.takeIf(::isBriefPath)
}
