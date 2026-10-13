package com.xiamu.agent

import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject

/** kind = image | file | voice; [path] is relative to the repo root (data/uploads/...). */
data class Attachment(val path: String, val name: String, val kind: String, val transcript: String? = null) {
    fun toJson(): JSONObject = JSONObject().put("path", path).put("name", name).put("kind", kind)

    companion object {
        fun from(j: JSONObject) = Attachment(j.optString("path"), j.optString("name"), j.optString("kind", "file"),
            j.optString("transcript").ifBlank { null })
    }
}

/** The App's live connection to the main thread. All state is Compose-observable. */
object Chat {
    val items = mutableStateListOf<ChatItem>()
    val streaming = mutableStateOf("")
    val busy = mutableStateOf(false)
    val reason = mutableStateOf("")
    val turnClosed = mutableStateOf(true)
    val connected = mutableStateOf(false)
    val toolHint = mutableStateOf("")
    val running = mutableStateListOf<Running>()
    val tasks = mutableStateListOf<BackgroundTask>()
    val error = mutableStateOf("")
    val jobsError = mutableStateOf("")
    val jobsLoading = mutableStateOf(false)
    /** Bumped whenever files under data/ change so screens can refresh. */
    val filesVersion = mutableIntStateOf(0)
    val historyVersion = mutableIntStateOf(0)

    private val main = Handler(Looper.getMainLooper())
    private val io = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val state = Conversation(items)
    private var ws: WebSocket? = null
    private var wanted = false
    private var retry = 0
    private var generation = 0
    private var jobsRevision = 0
    private var historyRevision = 0
    private var tasksRevision = 0

    private fun publish() {
        streaming.value = state.streaming
        busy.value = state.busy
        reason.value = state.reason
        toolHint.value = state.toolHint
        turnClosed.value = state.turnClosed
        val next = state.background.tasks
        if (tasks.toList() != next) { tasks.clear(); tasks.addAll(next) }
    }

    fun connect() {
        if (!Prefs.configured) return
        wanted = true
        if (ws != null) return
        val request = Api.wsRequest("app") ?: return
        ws = Api.http.newWebSocket(request, Listener())
    }

    fun disconnect() {
        wanted = false
        generation++
        ws?.close(1000, null)
        ws = null
        connected.value = false
        state.disconnected()
        publish()
        running.clear()
        jobsLoading.value = false
        toolHint.value = ""
    }

    /** Clear everything on logout. */
    fun reset() {
        disconnect()
        items.clear(); running.clear()
        streaming.value = ""; busy.value = false; toolHint.value = ""; error.value = ""
        jobsError.value = ""; jobsLoading.value = false
    }

    fun send(text: String, attachments: List<Attachment> = emptyList()): Boolean {
        if (!connected.value) { error.value = "还没连上，稍等再发"; return false }
        val msg = JSONObject().put("t", "send").put("text", text)
        if (attachments.isNotEmpty()) msg.put("attachments", JSONArray().apply { attachments.forEach { put(it.toJson()) } })
        val ok = ws?.send(msg.toString()) ?: false
        if (!ok) {
            error.value = "还没连上，稍等再发"
            return false
        }
        state.sent(text, attachments, System.currentTimeMillis())
        historyRevision++
        return true
    }

    fun interrupt() {
        if (ws?.send(JSONObject().put("t", "interrupt").toString()) != true) error.value = "连接断开了，没能停止回复"
    }

    fun unqueue(id: String) = queueRequest("unqueue", id)
    fun editQueued(id: String, text: String) = queueRequest("edit_queued", id, text)
    private fun queueRequest(type: String, id: String, text: String? = null) {
        if (id.isBlank()) return
        val request = JSONObject().put("t", type).put("id", id)
        if (text != null) request.put("text", text)
        if (!connected.value || ws?.send(request.toString()) != true) error.value = "连接断开了，请重新连接后再试"
    }

    fun stopTask(id: String) {
        val previousError = state.background.tasks.firstOrNull { it.id == id }?.error
        if (!state.background.requestStop(id)) return
        if (!previousError.isNullOrBlank() && error.value == previousError) error.value = ""
        if (!connected.value || ws?.send(JSONObject().put("t", "stop_task").put("id", id).toString()) != true) {
            state.background.stopResult(id, false, "连接断开了，请重新连接后再停止任务")
        }
        publish()
    }

    private fun ui(block: () -> Unit) {
        main.post(block)
    }

    /** The server is the source of truth for what's running; called on every (re)connect. */
    fun refreshRunning() {
        refreshTasks()
        val session = generation
        val revision = jobsRevision
        jobsLoading.value = true
        io.launch {
            runCatching { Api.getJson("/api/jobs") }.onSuccess { j ->
                if (session != generation || revision != jobsRevision) return@onSuccess
                val jobs = j.optJSONArray("running").objects().mapNotNull {
                    it.optString("id").takeIf(String::isNotBlank)?.let { id -> Running(id, it.optString("label"), it.optLong("started")) }
                }
                running.clear()
                running.addAll(0, jobs)
                jobsError.value = ""
            }.onFailure {
                if (session == generation) jobsError.value = it.message ?: "任务加载失败"
            }
            if (session == generation) jobsLoading.value = false
        }
    }

    private fun parseTasks(a: JSONArray?) = a.objects().mapNotNull {
        val id = it.optString("id")
        if (id.isBlank()) null else BackgroundTask(id, it.optString("description").ifBlank { "后台任务" }, it.optLong("startedAt"))
    }

    private fun refreshTasks() {
        val session = generation
        val revision = tasksRevision
        io.launch {
            runCatching { Api.getJson("/api/state") }.onSuccess { j ->
                if (session != generation || revision != tasksRevision) return@onSuccess
                state.background.snapshot(parseTasks(j.optJSONArray("tasks")))
                publish()
            }
        }
    }

    private fun refreshHistory() {
        val session = generation
        val revision = historyRevision
        io.launch {
            runCatching { Api.getJson("/api/history?n=200") }.onSuccess { j ->
                if (session != generation || revision != historyRevision) return@onSuccess
                state.replaceHistory(j.optJSONArray("items").objects().mapNotNull(::historyItem))
                historyVersion.intValue++
            }
        }
    }

    private fun handle(m: JSONObject) {
        when (m.optString("t")) {
            "hello" -> {
                generation++
                tasksRevision++
                historyRevision++
                state.hello(m.optJSONArray("history").objects().mapNotNull(::historyItem), m.optBoolean("busy"), m.optString("reason"), parseTasks(m.optJSONArray("tasks")),
                    m.optJSONArray("queued").objects().map { incomingUser(it.optString("text"),it.optString("source"),it.optJSONArray("attachments").objects().map(Attachment::from),it.optLong("ts"),it.optString("id")) })
                connected.value = true
                historyVersion.intValue++
                running.clear()
                refreshRunning()
                refreshHistory()
                filesVersion.intValue++
                io.launch { runCatching { Api.profile() }.onSuccess { com.xiamu.agent.ui.Appearance.choice.value = it } }
            }
            "user" -> {
                state.user(m.optString("text"), m.optString("source"), m.optJSONArray("attachments").objects().map(Attachment::from), m.optLong("ts", System.currentTimeMillis()), m.optString("id"))
                historyRevision++
            }
            "queue_update" -> {
                val notice = state.queueUpdate(m.optString("id"), m.optString("state"), m.opt("text") as? String)
                if (notice.isNotBlank()) error.value = notice
                historyRevision++
            }
            "status" -> {
                if (state.status(m.optBoolean("busy"), m.opt("reason") as? String)) {
                    error.value = ""
                    historyRevision++
                }
            }
            "delta" -> state.delta(m.optString("text"))
            "tool" -> state.tool(toolLabel(m.optString("name"), m.optString("hint")))
            "turn_end" -> {
                state.endTurn(m, System.currentTimeMillis())
                historyRevision++
            }
            "memory_updated" -> {
                val last = items.lastOrNull()
                if (!(last is ChatItem.Note && last.text == "记忆已更新")) items.add(ChatItem.Note("记忆已更新"))
                filesVersion.intValue++
                historyRevision++
            }
            "files_changed" -> filesVersion.intValue++
            "task" -> {
                tasksRevision++
                val id = m.optString("id")
                val background = state.background
                if (m.optString("phase") == "snapshot") background.snapshot(parseTasks(m.optJSONArray("tasks")))
                else if (m.optBoolean("background")) when (m.optString("phase")) {
                    "started" -> background.started(BackgroundTask(id, m.optString("description"), m.optLong("startedAt", System.currentTimeMillis())))
                    "progress" -> background.update(id, m.opt("description") as? String)
                    "updated" -> m.optJSONObject("patch")?.let { background.update(id, it.opt("description") as? String, it.opt("status") as? String) }
                    "notification" -> background.notification(id, m.optString("status"))
                }
            }
            "task_stop" -> {
                val ok = m.optBoolean("ok")
                val why = if (ok) "" else taskStopError(m.optString("code"), m.optString("error"))
                state.background.stopResult(m.optString("id"), ok, why)
                if (!ok) error.value = why
            }
            "job" -> {
                jobsRevision++
                val label = m.optString("label")
                val id = m.optString("id")
                running.removeAll { it.id == id }
                if (m.optString("phase") == "done") {
                    val out = listOf(m.optString("path")).filter { it.isNotBlank() } + m.optJSONArray("outputs").strings()
                    if (out.isNotEmpty()) items.add(ChatItem.Card(m.optString("title"), label, out.first(), m.optLong("ts", System.currentTimeMillis())))
                    filesVersion.intValue++
                    historyRevision++
                } else if (id.isNotBlank()) {
                    running.add(0, Running(id, label, m.optLong("started", System.currentTimeMillis())))
                }
            }
        }
        publish()
    }

    private fun toolLabel(name: String, hint: String): String = when {
        name == "Read" && hint.contains("总档") -> "在翻总档"
        name == "Read" || name == "Grep" || name == "Glob" -> "在翻资料"
        name == "Write" || name == "Edit" -> if (hint.contains("memory")) "在记下来" else "在写文件"
        name == "Bash" -> "在跑命令"
        name == "WebSearch" || name == "WebFetch" -> "在查网上的"
        name == "Agent" || name == "Task" -> "派了个子任务"
        name.startsWith("mcp__devices__") -> "在用你的设备"
        name.startsWith("mcp__") -> "在用连接器"
        else -> "在忙"
    }

    private class Listener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) = ui {
            if (ws !== webSocket || !wanted) return@ui
            error.value = ""
            retry = 0
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val m = runCatching { JSONObject(text) }.getOrNull() ?: return
            ui { if (ws === webSocket && wanted) handle(m) }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
            dropped(webSocket, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = dropped(webSocket, null)

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) =
            dropped(webSocket, if (response?.code == 401) "密码失效了，去设置里退出重新登录" else null)

        private fun dropped(webSocket: WebSocket, why: String?): Unit = ui {
            if (ws !== webSocket) return@ui
            ws = null
            connected.value = false
            generation++
            state.disconnected()
            publish()
            running.clear()
            jobsLoading.value = false
            toolHint.value = ""
            if (why != null) error.value = why
            if (wanted) {
                val delay = (1000L shl retry.coerceAtMost(5)).coerceAtMost(30_000L)
                retry++
                main.postDelayed({ if (wanted) connect() }, delay)
            }
        }
    }
}
