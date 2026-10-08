package com.xiamu.agent

import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject

sealed class ChatItem {
    data class User(val text: String) : ChatItem()
    data class Assistant(val text: String) : ChatItem()
    data class Card(val title: String, val path: String?) : ChatItem()
    data class Note(val text: String) : ChatItem()
}

data class Activity(val id: String, val label: String, val detail: String, val done: Boolean)

/** The App's live connection to the main thread. All state is Compose-observable. */
object Chat {
    val items = mutableStateListOf<ChatItem>()
    val streaming = mutableStateOf("")
    val busy = mutableStateOf(false)
    val connected = mutableStateOf(false)
    val toolHint = mutableStateOf("")
    val devices = mutableStateOf<List<String>>(emptyList())
    val activities = mutableStateListOf<Activity>()
    val error = mutableStateOf("")
    /** Bumped whenever files under data/ change so screens can refresh. */
    val filesVersion = mutableStateOf(0)

    private val main = Handler(Looper.getMainLooper())
    private var ws: WebSocket? = null
    private var wanted = false
    private var retry = 0

    fun connect() {
        if (!Prefs.configured) return
        wanted = true
        if (ws != null) return
        ws = Api.http.newWebSocket(Api.wsRequest("app"), Listener())
    }

    fun disconnect() {
        wanted = false
        ws?.close(1000, null)
        ws = null
    }

    fun send(text: String) {
        val ok = ws?.send(JSONObject().put("t", "send").put("text", text).toString()) ?: false
        if (!ok) error.value = "还没连上，稍等再发"
    }

    fun interrupt() {
        ws?.send(JSONObject().put("t", "interrupt").toString())
    }

    private fun ui(block: () -> Unit) {
        main.post(block)
    }

    private fun loadHistory(arr: JSONArray) {
        items.clear()
        for (i in 0 until arr.length()) {
            val h = arr.getJSONObject(i)
            when (h.optString("role")) {
                "user" -> items.add(ChatItem.User(h.optString("text")))
                "assistant" -> items.add(ChatItem.Assistant(h.optString("text")))
                "card" -> items.add(ChatItem.Card(h.optString("title"), h.optJSONArray("outputs")?.optString(0)))
            }
        }
    }

    private fun deviceNames(arr: JSONArray?): List<String> =
        (0 until (arr?.length() ?: 0)).map { arr!!.getJSONObject(it).optString("name") }

    private fun handle(m: JSONObject) {
        when (m.optString("t")) {
            "hello" -> {
                loadHistory(m.optJSONArray("history") ?: JSONArray())
                busy.value = m.optBoolean("busy")
                devices.value = deviceNames(m.optJSONArray("devices"))
            }
            "user" -> {
                // Our own message echoes back; messages from other clients are added here too.
                val text = m.optString("text")
                if ((items.lastOrNull() as? ChatItem.User)?.text != text) items.add(ChatItem.User(text))
            }
            "status" -> busy.value = m.optBoolean("busy")
            "delta" -> {
                streaming.value += m.optString("text")
                toolHint.value = ""
            }
            "tool" -> {
                toolHint.value = toolLabel(m.optString("name"), m.optString("hint"))
                // Text before a tool call is a finished paragraph; keep it visible.
                if (streaming.value.isNotBlank()) streaming.value += "\n\n"
            }
            "turn_end" -> {
                val text = m.optString("text")
                if (text.isNotBlank()) items.add(ChatItem.Assistant(text))
                if (m.has("error")) items.add(ChatItem.Note("这一轮出错了：${m.optString("error")}"))
                streaming.value = ""
                toolHint.value = ""
                busy.value = false
            }
            "memory_updated" -> {
                val last = items.lastOrNull()
                if (!(last is ChatItem.Note && last.text.startsWith("记忆已更新"))) items.add(ChatItem.Note("记忆已更新"))
                filesVersion.value++
            }
            "files_changed" -> filesVersion.value++
            "devices" -> devices.value = deviceNames(m.optJSONArray("devices"))
            "task" -> {
                val id = m.optString("id")
                val phase = m.optString("phase")
                val label = m.optString("description").ifBlank { "子任务" }
                val detail = m.optString("summary").ifBlank { phase }
                activities.removeAll { it.id == id }
                activities.add(0, Activity(id, label, detail, phase == "notification"))
            }
            "job" -> {
                val label = m.optString("label")
                activities.removeAll { it.id == "job:$label" }
                val done = m.optString("phase") == "done"
                activities.add(0, Activity("job:$label", label, if (done) m.optString("title") else "进行中", done))
                if (done) {
                    val out = m.optJSONArray("outputs")
                    if (out != null && out.length() > 0) items.add(ChatItem.Card(m.optString("title"), out.optString(0)))
                    filesVersion.value++
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
            connected.value = true
            error.value = ""
            retry = 0
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val m = runCatching { JSONObject(text) }.getOrNull() ?: return
            ui { handle(m) }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = dropped(webSocket, null)

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) =
            dropped(webSocket, if (response?.code == 401) "token 不对，去设置里改" else t.message)

        private fun dropped(webSocket: WebSocket, why: String?): Unit = ui {
            if (ws === webSocket) ws = null
            connected.value = false
            if (why != null) error.value = why
            if (wanted) {
                val delay = (1000L shl retry.coerceAtMost(5)).coerceAtMost(30_000L)
                retry++
                main.postDelayed({ if (wanted) connect() }, delay)
            }
        }
    }
}
