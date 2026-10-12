package com.xiamu.agent

import okhttp3.*
import okhttp3.mockwebserver.*
import org.json.*
import java.net.InetAddress
import java.time.LocalDate
import java.time.ZoneId
import java.util.concurrent.CopyOnWriteArrayList

/** Every endpoint is loopback-only. No proxy, live credentials, device service or real tasks. */
class V6Fixture(private val css: String) {
    private val server = MockWebServer()
    private var socket: WebSocket? = null
    val day = LocalDate.now()
    val now = System.currentTimeMillis()
    val briefPath = "data/briefs/$day/晨报.html"
    val oldBriefPath = "data/briefs/${day.minusDays(14)}/健康周报.html"
    val requests = CopyOnWriteArrayList<ReviewRequest>()
    val queries = CopyOnWriteArrayList<String>()
    val messages = CopyOnWriteArrayList<JSONObject>()
    val unexpected = CopyOnWriteArrayList<String>()
    @Volatile var failSend = false
    @Volatile var failSync = false
    private var syncs = 0
    private var uploads = 0
    private val uploaded = mutableMapOf<String, ByteArray>()
    private val histories = linkedMapOf("running-purchase" to history("running-purchase", "样品与交期", "running"),
        "done-morning" to history("done-morning", "整理今天的安排", "done"))
    val url get() = "http://127.0.0.1:${server.port}"
    private val chat = chatHistory()
    init {
        server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = synchronized(this@V6Fixture) {
                val path = request.requestUrl!!.encodedPath
                val body = request.body.readUtf8()
                requests.add(ReviewRequest(request.method.orEmpty(), path, body, android.os.SystemClock.uptimeMillis(), System.nanoTime() / 1_000_000))
                queries.add(request.requestUrl!!.encodedQuery.orEmpty())
                val parts = request.requestUrl!!.pathSegments
                when {
                    path == "/ws" -> MockResponse().withWebSocketUpgrade(listener)
                    path == "/api/state" -> json(JSONObject().put("busy", false).put("tasks", running()).put("userCall", "夏木").put("agentName", "豆豆").put("firstChat", now-30*86400000L)
                        .put("schedule", JSONArray("""[{"id":"morning","name":"晨报","kind":"brief","cron":"30 7 * * *","enabled":true}]""")))
                    path == "/api/history" -> json(JSONObject().put("items", chat))
                    path == "/api/profile" -> json(JSONObject("""{"avatar":{"shape":"bean","palette":"mist"}}"""))
                    path == "/api/settings" -> json(V5Fixture.settingsDocument())
                    path == "/api/briefs" -> json(JSONObject().put("items", JSONArray().put(brief(briefPath))))
                    path == "/api/briefs/item" -> if (request.requestUrl!!.queryParameter("path") == oldBriefPath) json(brief(oldBriefPath)) else json(JSONObject().put("error", "没有这份简报"), 404)
                    path == "/api/jobs" -> json(jobs(request.requestUrl!!.queryParameter("before")))
                    path == "/api/health" && request.method == "GET" -> json(health())
                    path == "/api/health/sync" && request.method == "POST" -> {
                        syncs++
                        if (failSync) json(JSONObject().put("error", "同步失败，请重试"), 503)
                        else json(health()).setBodyDelay(250, java.util.concurrent.TimeUnit.MILLISECONDS)
                    }
                    path == "/api/upload" && request.method == "POST" -> {
                        uploads++
                        val name = request.requestUrl!!.queryParameter("name")!!
                        val storedPath = "data/uploads/$day/$uploads-$name"
                        uploaded[storedPath] = body.toByteArray()
                        json(JSONObject().put("path", storedPath).put("name", name).put("size", body.toByteArray().size))
                    }
                    parts.take(2) == listOf("api", "tasks") && parts.size == 4 -> {
                        val id = parts[2]; val record = histories[id]
                        when {
                            record == null -> json(JSONObject().put("error", "任务不存在"), 404)
                            parts[3] == "history" -> json(record)
                            parts[3] == "send" && request.method == "POST" -> {
                                val requestBody = JSONObject(body)
                                val text = requestBody.getString("text")
                                if (failSend) json(JSONObject().put("error", "本地续聊失败，输入已保留"), 503)
                                else if (text.isBlank() && requestBody.optJSONArray("attachments").objects().isEmpty()) json(JSONObject().put("error", "消息不能为空"), 400)
                                else {
                                    record.put("status", "running")
                                    record.getJSONArray("items").put(item("prompt", text).put("from", "user").put("attachments", requestBody.optJSONArray("attachments") ?: JSONArray()))
                                    json(JSONObject().put("ok", true).put("id", id))
                                }
                            }
                            else -> unknown(request)
                        }
                    }
                    path == "/api/tree" -> json(JSONObject().put("entries", tree(request.requestUrl!!.queryParameter("dir").orEmpty())))
                    path.startsWith("/files/data/uploads/") -> MockResponse().setHeader("Content-Type", "image/png").setBody(okio.Buffer().write(android.util.Base64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", 0)))
                    path.startsWith("/files/data/memory/") -> MockResponse().setHeader("Content-Type", "text/plain").setBody("# 健康档案\n\n最近一周睡眠稳定。\n\n保持每天散步，晚上尽量按时休息。")
                    path == "/favicon.ico" -> MockResponse().setResponseCode(204)
                    else -> unknown(request)
                }
            }
        }
        server.start(InetAddress.getByName("127.0.0.1"), 0)
    }
    private fun json(value: JSONObject, code: Int = 200) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(value.toString())
    private fun unknown(request: RecordedRequest): MockResponse {
        unexpected.add("${request.method} ${request.requestUrl!!.encodedPath}")
        return json(JSONObject().put("error", "假服务没有此接口"), 404)
    }
    private fun document(id: String, content: String) = """<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script>window.firstSkin=document.documentElement.dataset.skin</script><style>$css</style></head><body><section class="card" id="$id">$content</section><script>document.addEventListener('click',function(e){var b=e.target.closest('[data-prompt]');if(b){e.preventDefault();location.href='doudou://prompt?text='+encodeURIComponent(b.dataset.prompt)}})</script></body></html>"""
    private fun brief(path: String): JSONObject {
        val weekly = path == oldBriefPath
        val overview = if (weekly) document("weekly", """<span class="chip">健康 · 周报</span><h2 class="title">睡眠稳了，步数还可以多一点</h2><p class="summary">这一周平均睡眠 7 小时 12 分，继续保持现在的节奏。</p><div class="metrics"><div class="metric"><div class="value">7h12m</div><span class="label">平均睡眠</span></div><div class="metric"><div class="value">7,840</div><span class="label">日均步数</span></div></div><div class="note">饭后散步十分钟，就能把步数慢慢补上。</div>""")
        else document("overview", """<span class="chip">${day.monthValue}月${day.dayOfMonth}日 · 今天</span><h2 class="title">先确认样品交期，今天就好安排</h2><p class="summary">上午收尾供应商回复，下午留一点时间给自己。</p><div class="dates">${(0..6).joinToString("") { offset -> val date = day.plusDays(offset.toLong()); "<div class=\"day\" ${if(offset==0) "data-today" else ""}><span class=\"dow\">${listOf("一","二","三","四","五","六","日")[date.dayOfWeek.value-1]}</span><span class=\"d\">${date.dayOfMonth}</span><span class=\"mark\">${if(offset==0) "今天" else ""}</span></div>" }}</div><div class="tiles"><div class="tile" data-tone="ok"><span class="label">已经完成</span><span class="value">2 项</span><span class="desc">资料已整理</span></div><div class="tile" data-tone="warn"><span class="label">等你确认</span><span class="value">1 项</span><span class="desc">样品发货时间</span></div><div class="tile" data-tone="info"><span class="label">下午安排</span><span class="value">留白</span><span class="desc">回访后散散步</span></div></div><div class="buttons"><button id="prompt" data-prompt="帮我把今天的事排个顺序">排一下今天的顺序</button><button class="button" data-kind="ghost" data-prompt="帮我确认样品交期">确认交期</button></div>""")
        val cards = JSONArray().put(JSONObject().put("html", overview))
        if (!weekly) cards.put(JSONObject().put("html", document("long", """<span class="chip">采购 · 跟进</span><h2 class="title">样品到齐，再决定下一步</h2><p class="summary">一个主题放在一张卡里，按顺序往下核对。</p><table class="compare"><tr><th data-pick>方案 A</th><th>方案 B</th><th>方案 C</th></tr><tr><td>现货 2 天</td><td>补货 5 天</td><td>等待回复</td></tr><tr><td>先拿样品</td><td>确认规格</td><td>下午回访</td></tr></table><ol class="steps">${(1..13).joinToString("") { "<li>第 $it 项：核对样品与交期<span class=\"state\" data-state=\"${if(it<4) "done" else "todo"}\">${if(it<4) "已完成" else "待做"}</span></li>" }}</ol><div class="note" id="long-end">等最后一份回复，再合并采购计划。</div>""")))
        val date = if (weekly) day.minusDays(14) else day
        return JSONObject().put("date", date.toString()).put("name", if (weekly) "健康周报" else "晨报")
            .put("time", date.atTime(7, 36).atZone(ZoneId.systemDefault()).toOffsetDateTime().toString()).put("path", path).put("cards", cards)
    }
    private fun item(kind: String, text: String, tool: String? = null) = JSONObject().put("kind", kind).put("text", text).put("time", System.currentTimeMillis())
        .apply { if (kind == "prompt") put("from", "agent"); tool?.let { put("tool", it) } }
    private fun history(id: String, title: String, status: String) = JSONObject().put("id", id).put("title", title).put("status", status).put("items", JSONArray()
        .put(item("prompt", "整理供应商回复，确认样品和交期。"))
        .put(item("tool", "读取供应商资料，核对样品规格与数量。", "Read"))
        .put(item("text", "## 先确认交期\n\n供应商 A 的样品已经准备好，等最后一份回复后合并安排。"))
        .put(item("prompt", "把这份资料也一起看看。\n优先确认现货。") .put("from", "user").put("attachments", JSONArray().put(JSONObject().put("path", "data/uploads/spec.pdf").put("name", "样品规格.pdf").put("kind", "file"))))
        .put(item("tool", "按新资料逐项核对。", "Read"))
        .apply { if (status == "done") put(item("result", "**交期已核对。**\n\n- 先拿样品，再合并采购。\n- 给下午留出回访时间。")) })
    private fun running() = JSONArray(histories.values.filter { it.getString("status") == "running" }.map {
        JSONObject().put("id", it.getString("id")).put("description", it.getString("title")).put("startedAt", now-180000)
    })
    private fun jobs(before: String?): JSONObject {
        fun job(id: String, label: String, days: Long) = JSONObject().put("id", id).put("label", label).put("title", label).put("status", "done").put("ok", true)
            .put("ts", day.minusDays(days).atTime(10, 0).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()).put("outputs", JSONArray())
        val first = before == null
        val recent = if (first) JSONArray().put(job("done-morning", "整理今天的安排", 0)).put(job("week", "核对供应商回复", 3)).put(job("older", "合并上周采购资料", 9))
            else JSONArray((10..44).map { job("old-$it", "历史任务 $it", it.toLong()) })
        return JSONObject().put("running", if (first) JSONArray().put(JSONObject().put("id", "running-purchase").put("label", "样品与交期").put("started", now-180000)) else JSONArray())
            .put("recent", recent).put("next", if (first) recent.getJSONObject(2).getLong("ts") else JSONObject.NULL)
    }
    private fun health(): JSONObject = JSONObject().put("syncedAt", day.atTime(if (syncs == 0) 8 else 9, 18).atZone(ZoneId.systemDefault()).toOffsetDateTime().toString()).put("device", "测试手机")
        .put("note", JSONObject.NULL).put("days", JSONArray((6L downTo 0L).map { offset ->
            JSONObject().put("date", day.minusDays(offset).toString()).put("sleepMinutes", if (offset == 2L) JSONObject.NULL else 410+offset*8)
                .put("restingHr", if (offset == 3L) JSONObject.NULL else 58+offset).put("hrv", if (offset == 0L || offset == 3L) JSONObject.NULL else 42+offset*2)
                .put("steps", if (offset == 2L) JSONObject.NULL else 7800+offset*210)
        })).put("weekly", JSONArray().put(JSONObject().put("name", "健康周报").put("path", oldBriefPath).put("date", day.minusDays(14).toString()).put("range", "${day.minusDays(20).monthValue}月${day.minusDays(20).dayOfMonth}日–${day.minusDays(14).monthValue}月${day.minusDays(14).dayOfMonth}日").put("summary", "睡眠更规律，日均步数还有一点空间。")))
        .put("records", JSONArray().put(JSONObject().put("path", "data/memory/health/baselines.md").put("title", "健康基线").put("updated", day.minusDays(3).toString()).put("preview", "来自日常健康记录\n最近七天睡眠与步数基线"))
            .put(JSONObject().put("path", "data/memory/health/profile.md").put("title", "健康档案").put("updated", day.minusDays(5).toString()).put("preview", "定期体检与日常运动\n每周回顾一次身体状态")))
    private fun tree(dir: String): JSONArray = when (dir) {
        "data/memory" -> JSONArray().put(JSONObject().put("name", "health").put("dir", true).put("mtime", now))
        "data/memory/health" -> JSONArray().put(JSONObject().put("name", "profile.md").put("dir", false).put("mtime", now))
        else -> JSONArray()
    }
    private fun chatHistory(): JSONArray = JSONArray().apply {
        repeat(20) { index ->
            put(JSONObject().put("role", "user").put("id", "history-$index").put("text", "帮我看一下第 ${index+1} 份样品资料，确认交期。" ).put("ts", now-(40-index*2)*60000L))
            put(JSONObject().put("role", "assistant").put("text", "已经核对这份资料。**样品规格一致**，再确认一次现货时间，就可以安排下一步。\n\n- 先拿样品，保留规格记录。\n- 下午回访供应商。" ).put("ts", now-(39-index*2)*60000L))
        }
    }
    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) = synchronized(this@V6Fixture) {
            socket = webSocket
            webSocket.send(JSONObject().put("t", "hello").put("busy", false).put("tasks", running()).put("history", chat).put("queued", JSONArray()).toString())
            Unit
        }
        override fun onMessage(webSocket: WebSocket, text: String) = synchronized(this@V6Fixture) {
            val message = JSONObject(text); messages.add(message)
            if (message.optString("t") == "send") {
                val user = JSONObject().put("role", "user").put("id", "local-${messages.size}").put("text", message.getString("text")).put("attachments", message.optJSONArray("attachments") ?: JSONArray()).put("ts", System.currentTimeMillis())
                chat.put(user)
                webSocket.send(JSONObject(user.toString()).put("t", "user").put("source", "app").toString())
            } else unexpected.add("WS:${message.optString("t")}")
            Unit
        }
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(1000, null) }
    }
    fun reply(text: String) = synchronized(this) {
        chat.put(JSONObject().put("role", "assistant").put("text", text).put("ts", System.currentTimeMillis()))
        socket?.send(JSONObject().put("t", "status").put("busy", true).put("reason", "background").toString())
        socket?.send(JSONObject().put("t", "delta").put("text", text).toString())
        socket?.send(JSONObject().put("t", "turn_end").put("text", text).toString())
        socket?.send(JSONObject().put("t", "status").put("busy", false).toString())
        Unit
    }
    fun complete(id: String) = synchronized(this) { histories.getValue(id).put("status", "done").getJSONArray("items").put(item("result", "**已补充完成。**")); Unit }
    fun close() { socket?.close(1000, null); server.shutdown() }
}
