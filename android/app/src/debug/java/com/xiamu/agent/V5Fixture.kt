package com.xiamu.agent

import okhttp3.*
import okhttp3.mockwebserver.*
import org.json.*
import java.net.InetAddress
import java.time.LocalDate
import java.time.ZoneId
import java.util.concurrent.CopyOnWriteArrayList

/** Sample HTML includes the same injected data-prompt script the cloud contract specifies. */
object ReviewBriefs {
    fun document(id: String, content: String, background: String = "#fbfcfe") = """<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
        *{box-sizing:border-box}html,body{margin:0;padding:0;background:$background;color:#252e38;font-family:system-ui,sans-serif;font-size:15px}section{padding:22px}h2{font-size:22px;line-height:1.45;margin:10px 0}p{color:#728093;line-height:1.65;margin:8px 0}.chip{font-size:11px;color:#6c4a25;letter-spacing:1px}.tiles{display:flex;gap:10px}.tile{flex:1;background:#eaf0f5;border-radius:14px;padding:14px}.number{font-size:28px;font-weight:700}button{margin-top:16px;width:100%;border:0;border-radius:14px;padding:13px;color:#6c4a25;background:linear-gradient(130deg,#fffbed,#ead299);font-size:14px}li{padding:14px 0;border-bottom:1px solid #dfe6ed;line-height:1.65}ul{list-style:none;margin:0;padding:0}.hint{margin-top:16px;border-radius:12px;padding:12px;background:#e9edf1;font-size:12px;color:#728093}
        </style></head><body><section id="$id" class="card">$content</section><script>document.addEventListener('click',function(e){var b=e.target.closest('[data-prompt]');if(b){e.preventDefault();location.href='doudou://prompt?text='+encodeURIComponent(b.dataset.prompt);}});</script></body></html>"""

    fun items(day: LocalDate): JSONArray {
        val cards = JSONArray()
            .put(JSONObject().put("html", document("overview", """<span class="chip">今日总览</span><h2>今天先收尾，再留出下午</h2><p>先完成周报，再确认采购交期。</p><button id="prompt" data-prompt="帮我把今天的事排个顺序">排一下今天的顺序</button>""")))
            .put(JSONObject().put("html", document("focus", """<span class="chip">保持节奏</span><h2>给自己留一点余地</h2><div class="tiles"><div class="tile">睡眠<div class="number">7.2</div>小时</div><div class="tile">步数<div class="number">6840</div>步</div></div>""", "#eff5f3")))
            .put(JSONObject().put("html", document("long", """<span class="chip">采购 · 长卡片</span><h2>逐项核对交期和样品</h2><p>这张卡片很长，可以在卡片里继续向下看。</p><ul>${(1..20).joinToString("") { "<li>第 $it 项 · 核对样品与交期<p>先确认库存，再约定下一次回访。</p></li>" }}</ul><div id="long-end" class="hint">全部 20 项已经看完</div>""")))
        val time = day.atTime(7,36).atZone(ZoneId.systemDefault()).toOffsetDateTime().toString()
        val yesterday = day.minusDays(1)
        return JSONArray().put(JSONObject().put("date",day.toString()).put("name","晨报").put("time",time).put("path","data/briefs/$day/晨报.html").put("cards",cards))
            .put(JSONObject().put("date",yesterday.toString()).put("name","晚报").put("time",yesterday.atTime(21,0).atZone(ZoneId.systemDefault()).toOffsetDateTime().toString()).put("path","data/briefs/$yesterday/晚报.html")
                .put("cards",JSONArray().put(JSONObject().put("html",document("evening","""<span class="chip">昨日晚报</span><h2>该收尾的已经收好了</h2><p>明天先看样品有没有到。</p>""","#f5f0e8")))
                    .put(JSONObject().put("html",document("evening-notes","""<span class="chip">回顾</span><h2>把已经完成的事放下</h2><ul>${(1..10).joinToString("") { "<li>记录 $it · 今天已经确认的事<p>明天只处理还没有收尾的部分。</p></li>" }}</ul>""")))))
    }
}

data class ReviewRequest(val method: String, val path: String, val body: String, val at: Long, val nanoMs: Long)

/** Debug only. Binds loopback and never forwards any HTTP, task or chat request. */
class V5Fixture {
    private val server = MockWebServer()
    private var socket: WebSocket? = null
    val day: LocalDate = LocalDate.now()
    val briefPath = "data/briefs/$day/晨报.html"
    private val now = System.currentTimeMillis()
    val requests = CopyOnWriteArrayList<ReviewRequest>()
    val messages = CopyOnWriteArrayList<JSONObject>()
    val unexpected = CopyOnWriteArrayList<String>()
    @Volatile var failSettings = false
    @Volatile var failSend = false
    private var settings = settingsDocument()
    private val histories = linkedMapOf(
        "running-purchase" to history("running-purchase", "整理采购资料", "running"),
        "done-morning" to history("done-morning", "晨报已生成", "done"),
        "error-check" to history("error-check", "交期核对未完成", "error"),
        "stopped-notes" to history("stopped-notes", "笔记整理已停止", "stopped"),
    )
    val url: String get() = "http://127.0.0.1:${server.port}"

    init {
        server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = synchronized(this@V5Fixture) {
                val path = request.requestUrl!!.encodedPath
                val body = request.body.readUtf8()
                requests.add(ReviewRequest(request.method.orEmpty(), path, body, android.os.SystemClock.uptimeMillis(), System.nanoTime()/1_000_000))
                val parts = request.requestUrl!!.pathSegments
                when {
                    path == "/ws" -> MockResponse().withWebSocketUpgrade(listener)
                    path == "/api/state" -> json(JSONObject().put("busy",false).put("tasks",running()).put("userCall","夏木").put("agentName","豆豆").put("firstChat",now-17*86400000L)
                        .put("schedule",JSONArray("""[{"id":"morning","name":"晨报","kind":"brief","cron":"30 7 * * *","enabled":true}]""")))
                    path == "/api/history" -> json(JSONObject().put("items",chatHistory()))
                    path == "/api/tree" -> json(JSONObject().put("entries",JSONArray()))
                    path == "/api/profile" -> json(JSONObject("""{"avatar":{"shape":"bean","palette":"mist"}}"""))
                    path == "/api/briefs" -> json(JSONObject().put("items",ReviewBriefs.items(day)))
                    path == "/api/settings" && request.method == "GET" -> json(settings)
                    path == "/api/settings" && request.method == "PUT" -> {
                        val patch = JSONObject(body)
                        if (failSettings) json(JSONObject().put("error","本地保存失败，请重试"),503)
                        else if (patch.keys().asSequence().any { it !in setOf("model","permissionMode") } ||
                            (patch.has("model") && settings.getJSONArray("models").objects().none { it.getString("id") == patch.getString("model") }) ||
                            (patch.has("permissionMode") && settings.getJSONArray("permissionModes").objects().none { it.getString("id") == patch.getString("permissionMode") })) json(JSONObject().put("error","选项无效"),400)
                        else { patch.keys().forEach { settings.put(it,patch.get(it)) }; json(settings) }
                    }
                    path == "/api/jobs" -> json(JSONObject().put("running",JSONArray(histories.values.filter { it.getString("status") == "running" }.map {
                        JSONObject().put("id",it.getString("id")).put("label",it.getString("title")).put("started",now-180000)
                    })).put("recent",JSONArray(histories.values.filter { it.getString("status") != "running" }.map {
                        JSONObject().put("id",it.getString("id")).put("title",it.getString("title")).put("label",it.getString("title")).put("ts",now)
                            .put("ok",it.getString("status") == "done").put("path",if (it.getString("id") == "done-morning") briefPath else "")
                    })))
                    parts.take(2) == listOf("api","tasks") && parts.size == 4 -> {
                        val id = parts[2]
                        val record = histories[id]
                        when {
                            record == null -> json(JSONObject().put("error","任务不存在"),404)
                            parts[3] == "history" && request.method == "GET" -> json(record)
                            parts[3] == "send" && request.method == "POST" -> {
                                val text = JSONObject(body).getString("text")
                                if (failSend) json(JSONObject().put("error","本地续聊失败，输入已保留"),503)
                                else if (text.isBlank()) json(JSONObject().put("error","请输入消息"),400)
                                else {
                                    record.put("status","running")
                                    record.getJSONArray("items").put(item("prompt",text)).put(item("tool","核对新增要求","Read"))
                                    socket?.send(JSONObject().put("t","task").put("phase","snapshot").put("tasks",running()).toString())
                                    json(JSONObject().put("ok",true).put("id",id))
                                }
                            }
                            else -> unknown(request)
                        }
                    }
                    path == "/favicon.ico" -> MockResponse().setResponseCode(204)
                    else -> unknown(request)
                }
            }
        }
        server.start(InetAddress.getByName("127.0.0.1"),0)
    }
    private fun json(value: JSONObject, code: Int = 200) = MockResponse().setResponseCode(code).setHeader("Content-Type","application/json").setBody(value.toString())
    private fun unknown(request: RecordedRequest): MockResponse { unexpected.add("${request.method} ${request.requestUrl!!.encodedPath}"); return json(JSONObject().put("error","本地假服务没有此接口"),404) }
    private fun item(kind: String, text: String, tool: String? = null) = JSONObject().put("kind",kind).put("text",text).put("time",System.currentTimeMillis()).apply { tool?.let { put("tool",it) } }
    private fun history(id: String, title: String, status: String) = JSONObject().put("id",id).put("title",title).put("status",status).put("items",JSONArray()
        .put(item("prompt",if (id == "done-morning") "整理今天的安排，写一份晨报。" else "整理供应商回复，列出样品和交期的待核对项。"))
        .put(item("text","先核对已有记录，再整理今天的变化。"))
        .put(item("tool","读取 data/memory/总档.md","Read"))
        .put(item("tool","核对供应商回复","Read"))
        .apply { if (status != "running") put(item("result",when (status) {
            "done" -> "## 晨报已整理\n\n- **先完成周报**，再确认采购交期。\n- 给下午留出回访的时间。\n\n[晨报]($briefPath)"
            "error" -> "## 还有一项待核对\n\n暂时没有收到交期回复，可以继续补充资料。"
            else -> "已停止整理，现有笔记已保留。"
        })) })
    private fun running() = JSONArray(histories.values.filter { it.getString("status") == "running" }.map {
        JSONObject().put("id",it.getString("id")).put("description",it.getString("title")).put("startedAt",now-180000)
    })
    private fun chatHistory() = JSONArray().put(JSONObject().put("role","assistant").put("text","晨报已经准备好了。"))
        .put(JSONObject().put("role","card").put("title","晨报").put("label","晨报").put("path",briefPath).put("ts",now))
    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) = synchronized(this@V5Fixture) {
            socket = webSocket
            webSocket.send(JSONObject().put("t","hello").put("busy",false).put("tasks",running()).put("history",chatHistory()).put("queued",JSONArray()).toString())
            Unit
        }
        override fun onMessage(webSocket: WebSocket, text: String) = synchronized(this@V5Fixture) {
            val message = JSONObject(text); messages.add(message)
            if (message.getString("t") == "send") webSocket.send(JSONObject().put("t","user").put("id","local-${messages.size}").put("text",message.getString("text")).put("source","app").put("ts",System.currentTimeMillis()).toString())
            else unexpected.add("WS:${message.optString("t")}")
            Unit
        }
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(1000,null) }
    }
    fun complete(id: String) = synchronized(this) {
        val record = histories.getValue(id)
        record.put("status","done").getJSONArray("items").put(item("result","## 已补充完成\n\n**优先确认交期**，再安排样品回访。"))
        socket?.send(JSONObject().put("t","task").put("phase","notification").put("id",id).put("status","completed").put("background",true).toString())
        socket?.send(JSONObject().put("t","files_changed").put("path",briefPath).toString())
        Unit
    }
    fun snapshotSettings(): JSONObject = synchronized(this) { JSONObject(settings.toString()) }
    fun close() { socket?.close(1000,null); server.shutdown() }

    companion object {
        fun settingsDocument() = JSONObject("""{"model":"anthropic/claude-haiku-5.5","permissionMode":"auto","models":[{"id":"anthropic/claude-haiku-5.5","label":"Claude Haiku 5.5","note":"消耗约 1×"},{"id":"xiaomi/mimo-v2.6-pro","label":"MiMo V2.6 Pro","note":"消耗约 2×"},{"id":"z-ai/glm-5.3-flashx","label":"GLM 5.3 FlashX","note":"消耗约 3×"}],"permissionModes":[{"id":"auto","label":"自动","note":"危险操作由豆豆判断并拦下"},{"id":"bypassPermissions","label":"完全放行","note":"什么都不拦"}]}""")
    }
}
