package com.xiamu.agent

sealed class ChatItem {
    /** pending waits for the echo; queued waits for a user turn. They are independent. */
    data class User(val text: String, val attachments: List<Attachment> = emptyList(), val pending: Boolean = false, val ts: Long = 0, val queued: Boolean = false, val queueOrder: Long = 0) : ChatItem()
    data class Assistant(val text: String, val ts: Long = 0) : ChatItem()
    data class Alarm(val text: String, val ts: Long = 0) : ChatItem()
    data class Card(val title: String, val label: String, val path: String?, val ts: Long = 0) : ChatItem()
    data class Note(val text: String) : ChatItem()
}

/** Scheduled/isolated jobs are separate from the main query's background tasks. */
data class Running(val id: String, val label: String, val started: Long)
data class BackgroundTask(val id: String, val description: String, val startedAt: Long, val stopping: Boolean = false, val error: String = "")

class TaskBook {
    private val live = linkedMapOf<String, BackgroundTask>()
    private val ended = linkedSetOf<String>()
    val tasks: List<BackgroundTask> get() = live.values.toList()

    fun snapshot(tasks: List<BackgroundTask>, reconnect: Boolean = false) {
        val old = if (reconnect) emptyMap() else live.toMap()
        if (reconnect) ended.clear()
        else (old.keys - tasks.map { it.id }.toSet()).forEach(::finish)
        live.clear()
        tasks.filter { it.id.isNotBlank() }.forEach { task ->
            val previous = old[task.id]
            live[task.id] = task.copy(stopping = previous?.stopping ?: false, error = previous?.error.orEmpty())
            ended.remove(task.id)
        }
    }

    fun started(task: BackgroundTask) {
        if (task.id.isBlank() || task.id in ended) return
        val old = live[task.id]
        live[task.id] = task.copy(description = task.description.ifBlank { old?.description ?: "后台任务" },
            startedAt = task.startedAt.takeIf { it > 0 } ?: old?.startedAt ?: 0, stopping = old?.stopping ?: false, error = old?.error.orEmpty())
    }

    fun update(id: String, description: String? = null, status: String? = null) {
        if (status in setOf("completed", "failed", "killed", "stopped")) return finish(id)
        val old = live[id] ?: return
        live[id] = old.copy(description = description?.takeIf { it.isNotBlank() } ?: old.description)
    }

    fun notification(id: String, status: String) {
        if (status in setOf("completed", "failed", "stopped", "killed")) finish(id)
    }

    private fun finish(id: String) {
        if (id.isBlank()) return
        live.remove(id)
        ended.add(id)
        while (ended.size > 256) ended.remove(ended.first())
    }

    fun requestStop(id: String): Boolean {
        val task = live[id] ?: return false
        if (task.stopping) return false
        live[id] = task.copy(stopping = true, error = "")
        return true
    }

    fun stopResult(id: String, ok: Boolean, error: String = "") {
        val task = live[id] ?: return
        if (!ok) live[id] = task.copy(stopping = false, error = error.ifBlank { "停止任务失败，请稍后再试" })
    }

    fun clear() { live.clear(); ended.clear() }
}

fun incomingUser(text: String, source: String, attachments: List<Attachment> = emptyList(), ts: Long = 0): ChatItem =
    if (source == "schedule") ChatItem.Alarm(alarmLabel(text), ts) else ChatItem.User(text, attachments, ts = ts)

fun alarmLabel(text: String): String {
    val name = Regex("该出「([^」\\r\\n]+)」了").find(text)?.groupValues?.get(1)?.trim()
    return if (!name.isNullOrBlank()) "${name}时间到了"
        else text.lineSequence().firstOrNull().orEmpty().removePrefix("[定时]").trim().ifBlank { "定时任务时间到了" }
}

fun replyLabel(reason: String): String = when (reason) {
    "task_result" -> "豆豆正在处理子任务结果…"
    "schedule" -> "豆豆正在安排定时任务…"
    else -> "豆豆正在回复…"
}

fun taskStopError(code: String, error: String = ""): String {
    if (error.any { it in '\u4e00'..'\u9fff' }) return error
    return when (code) {
        "invalid_task_id" -> "任务编号无效，请刷新后重试"
        "task_not_found" -> "找不到这个运行中的任务"
        "task_ended" -> "任务已经结束"
        "task_stopping" -> "任务已经在停止中"
        "session_unavailable" -> "主会话暂时不可用，请稍后再试"
        else -> "停止任务失败，请稍后再试"
    }
}

/** Protocol state, with no Android dependencies; the socket publishes changes to Compose. */
class Conversation(val items: MutableList<ChatItem> = mutableListOf()) {
    val background = TaskBook()
    private var echoOrder = 0L
    var busy = false
        private set
    var reason = ""
        private set
    var streaming = ""
        private set
    var toolHint = ""
        private set
    var turnClosed = true
        private set

    fun hello(history: List<ChatItem>, busy: Boolean, reason: String, tasks: List<BackgroundTask>) {
        items.clear(); items.addAll(history)
        echoOrder = 0
        this.busy = busy
        this.reason = if (busy) reason else ""
        streaming = ""; toolHint = ""; turnClosed = !busy
        background.snapshot(tasks, reconnect = true)
    }

    fun status(busy: Boolean, reason: String? = null): Boolean {
        val nextReason = reason ?: if (this.busy) this.reason else ""
        val newTurn = busy && (!this.busy || turnClosed || (reason != null && nextReason != this.reason))
        if (newTurn) {
            streaming = ""; toolHint = ""; turnClosed = false
            if (nextReason == "user") {
                val next = items.filterIsInstance<ChatItem.User>().filter { it.queued && !it.pending }.minByOrNull { it.queueOrder }
                val i = if (next == null) -1 else items.indexOf(next)
                if (i >= 0) items[i] = (items[i] as ChatItem.User).copy(queued = false)
            }
        }
        this.busy = busy
        this.reason = if (busy) nextReason else ""
        if (!busy) toolHint = ""
        return newTurn
    }

    fun sent(text: String, attachments: List<Attachment>, ts: Long) {
        items.add(ChatItem.User(text, attachments, pending = true, ts = ts, queued = busy))
    }

    fun user(text: String, source: String, attachments: List<Attachment>, ts: Long) {
        val echo = incomingUser(text, source, attachments, ts)
        if (echo !is ChatItem.User) { items.add(echo); return }
        val i = items.indexOfFirst { it is ChatItem.User && it.pending && it.text == text && it.attachments.map { a -> a.path } == attachments.map { a -> a.path } }
        val queued = busy || (i >= 0 && (items[i] as ChatItem.User).queued)
        val accepted = echo.copy(queued = queued, queueOrder = if (queued) ++echoOrder else 0)
        if (i >= 0) items[i] = accepted else items.add(accepted)
    }

    fun delta(text: String) { streaming += text; toolHint = ""; turnClosed = false }

    fun tool(hint: String) {
        toolHint = hint
        if (streaming.isNotBlank() && !streaming.endsWith("\n\n")) streaming += "\n\n"
    }

    fun endTurn(text: String?, error: String, ts: Long) {
        val reply = text ?: streaming
        if (reply.isNotBlank()) items.add(ChatItem.Assistant(reply, ts))
        if (error.isNotBlank()) items.add(ChatItem.Note("这一轮出错了：$error"))
        streaming = ""; toolHint = ""; turnClosed = true
        // Only status/hello change busy; a result can arrive before native idle.
    }

    fun disconnected() {
        busy = false; reason = ""; streaming = ""; toolHint = ""; turnClosed = true
        background.clear()
    }
}
