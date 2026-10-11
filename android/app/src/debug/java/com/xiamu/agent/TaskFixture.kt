package com.xiamu.agent

import android.content.Context
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONArray
import org.json.JSONObject
import java.net.InetAddress
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Debug-only loopback server. No account, upload, device registration or external endpoint. */
class TaskFixture(context: Context, val scenario: String) {
    private val fixtures = JSONObject(context.assets.open("chat-tasks.json").bufferedReader().use { it.readText() })
    private val frames = fixtures.getJSONArray(scenario).objects()
    private val book = TaskBook()
    private val history = JSONArray()
    private val lock = Any()
    private val server = MockWebServer()
    @Volatile private var socket: WebSocket? = null
    @Volatile private var busy = false
    @Volatile var failStop = false
    @Volatile var delayState = false
    @Volatile var reconnectHello: JSONObject? = null
    val received = CopyOnWriteArrayList<JSONObject>()
    val unexpected = CopyOnWriteArrayList<String>()
    val stateRequests = AtomicInteger()
    val connections = AtomicInteger()

    init {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl?.encodedPath.orEmpty()
                if (request.method != "GET") { unexpected.add(path); return json("{}", 405) }
                return when (path) {
                    "/ws" -> MockResponse().withWebSocketUpgrade(listener)
                    "/api/jobs" -> json("""{"running":[],"recent":[]}""")
                    "/api/profile" -> json("""{"avatar":{"shape":"bean","palette":"mist"}}""")
                    "/api/briefs" -> json("""{"items":[]}""")
                    "/api/history" -> synchronized(lock) { json(JSONObject().put("items", history).toString()) }
                    "/api/state" -> synchronized(lock) {
                        stateRequests.incrementAndGet()
                        val response = json(JSONObject().put("busy", busy).put("tasks", tasksJson()).put("schedule", JSONArray()).toString())
                        if (delayState) response.setBodyDelay(1200, TimeUnit.MILLISECONDS) else response
                    }
                    else -> { unexpected.add(path); json("{}", 404) }
                }
            }
        }
        server.start(InetAddress.getByName("127.0.0.1"), 0)
    }

    val url: String get() = "http://127.0.0.1:${server.port}"

    private fun json(body: String, status: Int = 200) = MockResponse().setResponseCode(status).addHeader("Content-Type", "application/json").setBody(body)
    private fun tasksJson() = JSONArray().apply { book.tasks.forEach { put(JSONObject().put("id", it.id).put("description", it.description).put("startedAt", it.startedAt)) } }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            socket = webSocket
            val again = connections.incrementAndGet() > 1
            val restored = reconnectHello
            if (again && restored != null) emit(JSONObject(restored.toString()))
            else frames.forEach { emit(JSONObject(it.toString())) }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val message = JSONObject(text)
            received.add(message)
            when (message.optString("t")) {
                "send" -> emit(JSONObject().put("t", "user").put("source", "app").put("text", message.optString("text"))
                    .put("attachments", message.optJSONArray("attachments") ?: JSONArray()))
                "stop_task" -> {
                    val result = JSONObject().put("t", "task_stop").put("id", message.optString("id")).put("ok", !failStop)
                    if (failStop) result.put("code", "task_stop_failed").put("error", "停止任务失败，请稍后再试")
                    emit(result)
                }
                "interrupt" -> emit(JSONObject().put("t", "status").put("busy", false))
                else -> unexpected.add("WS:" + message.optString("t"))
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(1000, null) }
    }

    fun emit(message: JSONObject) = synchronized(lock) {
        when (message.optString("t")) {
            "hello" -> {
                busy = message.optBoolean("busy")
                while (history.length() > 0) history.remove(0)
                message.optJSONArray("history").objects().forEach { history.put(it) }
                val tasks = message.optJSONArray("tasks").objects().map {
                    if (it.optLong("startedAt") == 0L) it.put("startedAt", System.currentTimeMillis() - if (it.optString("id") == "quote") 182_000 else 62_000)
                    BackgroundTask(it.optString("id"), it.optString("description"), it.optLong("startedAt"))
                }
                book.snapshot(tasks, reconnect = true)
            }
            "status" -> busy = message.optBoolean("busy")
            "user" -> history.put(JSONObject(message.toString()).put("role", "user"))
            "turn_end" -> if (message.optString("text").isNotBlank()) history.put(JSONObject().put("role", "assistant").put("text", message.optString("text")))
            "task" -> {
                val id = message.optString("id")
                when (message.optString("phase")) {
                    "snapshot" -> book.snapshot(message.optJSONArray("tasks").objects().map { BackgroundTask(it.optString("id"), it.optString("description"), it.optLong("startedAt")) })
                    "started" -> if (message.optBoolean("background")) book.started(BackgroundTask(id, message.optString("description"), message.optLong("startedAt")))
                    "progress" -> if (message.optBoolean("background")) book.update(id, message.optString("description"))
                    "updated" -> if (message.optBoolean("background")) message.optJSONObject("patch")?.let { book.update(id, it.opt("description") as? String, it.opt("status") as? String) }
                    "notification" -> if (message.optBoolean("background")) book.notification(id, message.optString("status"))
                }
            }
        }
        socket?.send(message.toString())
    }

    fun drop() { socket?.close(1012, "fixture restart") }
    fun close() { socket?.close(1000, "fixture end"); server.shutdown() }
}
