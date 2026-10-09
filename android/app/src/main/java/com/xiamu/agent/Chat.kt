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

sealed class ChatItem {
    /** [pending]: sent from here, waiting for the server's echo (which carries voice transcripts). */
    data class User(val text: String, val attachments: List<Attachment> = emptyList(), val pending: Boolean = false, val ts: Long = 0) : ChatItem()
    data class Assistant(val text: String, val ts: Long = 0) : ChatItem()
    data class Card(val title: String, val label: String, val path: String?, val ts: Long = 0) : ChatItem()
    data class Note(val text: String) : ChatItem()
}

/** Something running on the server: a scheduled/isolated job or a sub-task of the main thread. */
data class Running(val id: String, val label: String, val started: Long)

/** The App's live connection to the main thread. All state is Compose-observable. */
object Chat {
    val items = mutableStateListOf<ChatItem>()
    val streaming = mutableStateOf("")
    val busy = mutableStateOf(false)
    val connected = mutableStateOf(false)
    val toolHint = mutableStateOf("")
    val running = mutableStateListOf<Running>()
    val error = mutableStateOf("")
    val jobsError = mutableStateOf("")
    val jobsLoading = mutableStateOf(false)
    /** Bumped whenever files under data/ change so screens can refresh. */
    val filesVersion = mutableIntStateOf(0)
    val historyVersion = mutableIntStateOf(0)

    private val main = Handler(Looper.getMainLooper())
    private val io = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var ws: WebSocket? = null
    private var wanted = false
    private var retry = 0
    private var generation = 0
    private var jobsRevision = 0
    private var historyRevision = 0

    fun connect() {
        if (!Prefs.configured) return
        wanted = true
        if (ws != null) return
        ws = Api.http.newWebSocket(Api.wsRequest("app"), Listener())
    }

    fun disconnect() {
        wanted = false
        generation++
        ws?.close(1000, null)
        ws = null
        connected.value = false
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
        items.add(ChatItem.User(text, attachments, pending = true, ts = System.currentTimeMillis()))
        historyRevision++
        return true
    }

    fun interrupt() {
        ws?.send(JSONObject().put("t", "interrupt").toString())
    }

    private fun ui(block: () -> Unit) {
        main.post(block)
    }

    private fun parseItem(h: JSONObject): ChatItem? = when (h.optString("role")) {
        "user" -> ChatItem.User(h.optString("text"), h.optJSONArray("attachments").objects().map(Attachment::from), ts = h.optLong("ts"))
        "assistant" -> ChatItem.Assistant(h.optString("text"), h.optLong("ts"))
        "card" -> ChatItem.Card(h.optString("title"), h.optString("label"), h.optJSONArray("outputs").strings().firstOrNull(), h.optLong("ts"))
        else -> null
    }

    /** The server is the source of truth for what's running; called on every (re)connect. */
    fun refreshRunning() {
        val session = generation
        val revision = jobsRevision
        jobsLoading.value = true
        io.launch {
            runCatching { Api.getJson("/api/jobs") }.onSuccess { j ->
                if (session != generation || revision != jobsRevision) return@onSuccess
                val jobs = j.optJSONArray("running").objects().map { Running("job:" + it.optString("label"), it.optString("label"), it.optLong("started")) }
                running.removeAll { it.id.startsWith("job:") }
                running.addAll(0, jobs)
                jobsError.value = ""
            }.onFailure {
                if (session == generation) jobsError.value = it.message ?: "任务加载失败"
            }
            if (session == generation) jobsLoading.value = false
        }
    }

    private fun refreshHistory() {
        val session = generation
        val revision = historyRevision
        io.launch {
            runCatching { Api.getJson("/api/history?n=200") }.onSuccess { j ->
                if (session != generation || revision != historyRevision) return@onSuccess
                items.clear()
                j.optJSONArray("items").objects().mapNotNullTo(items, ::parseItem)
                historyVersion.intValue++
            }
        }
    }

    private fun handle(m: JSONObject) {
        when (m.optString("t")) {
            "hello" -> {
                items.clear()
                m.optJSONArray("history").objects().mapNotNullTo(items, ::parseItem)
                historyVersion.intValue++
                busy.value = m.optBoolean("busy")
                streaming.value = ""
                toolHint.value = ""
                // Sub-tasks can't be queried after a reconnect; drop them rather than show stale ones.
                running.removeAll { !it.id.startsWith("job:") }
                refreshRunning()
                refreshHistory()
                filesVersion.intValue++
            }
            "user" -> {
                val echo = ChatItem.User(m.optString("text"), m.optJSONArray("attachments").objects().map(Attachment::from), ts = System.currentTimeMillis())
                val i = items.indexOfLast { it is ChatItem.User && it.pending && it.text == echo.text && it.attachments.map { a -> a.path } == echo.attachments.map { a -> a.path } }
                if (i >= 0) items[i] = echo else items.add(echo)
                historyRevision++
            }
            "status" -> busy.value = m.optBoolean("busy")
            "delta" -> {
                streaming.value += m.optString("text")
                toolHint.value = ""
            }
            "tool" -> {
                toolHint.value = toolLabel(m.optString("name"), m.optString("hint"))
                // Text before a tool call is a finished paragraph; keep it visible.
                if (streaming.value.isNotBlank() && !streaming.value.endsWith("\n\n")) streaming.value += "\n\n"
            }
            "turn_end" -> {
                val text = m.optString("text")
                if (text.isNotBlank()) items.add(ChatItem.Assistant(text, System.currentTimeMillis()))
                if (m.has("error")) items.add(ChatItem.Note("这一轮出错了：${m.optString("error")}"))
                streaming.value = ""
                toolHint.value = ""
                busy.value = false
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
                val id = "task:" + m.optString("id")
                val started = running.firstOrNull { it.id == id }?.started ?: System.currentTimeMillis()
                running.removeAll { it.id == id }
                val status = m.optString("status")
                val finished = m.optString("phase") in setOf("notification", "done", "completed", "failed", "stopped") || status in setOf("completed", "failed", "stopped")
                if (!finished) running.add(Running(id, m.optString("description").ifBlank { "子任务" }, started))
            }
            "job" -> {
                jobsRevision++
                val label = m.optString("label")
                running.removeAll { it.id == "job:$label" }
                if (m.optString("phase") == "done") {
                    val out = m.optJSONArray("outputs").strings()
                    if (out.isNotEmpty()) items.add(ChatItem.Card(m.optString("title"), label, out.first(), System.currentTimeMillis()))
                    filesVersion.intValue++
                    historyRevision++
                } else {
                    running.add(0, Running("job:$label", label, System.currentTimeMillis()))
                }
            }
        }
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
            connected.value = true
            error.value = ""
            retry = 0
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val m = runCatching { JSONObject(text) }.getOrNull() ?: return
            ui { if (ws === webSocket && wanted) handle(m) }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = dropped(webSocket, null)

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) =
            dropped(webSocket, if (response?.code == 401) "密码失效了，去设置里退出重新登录" else null)

        private fun dropped(webSocket: WebSocket, why: String?): Unit = ui {
            if (ws !== webSocket) return@ui
            ws = null
            connected.value = false
            running.clear()
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
