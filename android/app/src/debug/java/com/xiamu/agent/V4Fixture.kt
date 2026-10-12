package com.xiamu.agent

import android.content.Context
import okhttp3.*
import okhttp3.mockwebserver.*
import okio.Buffer
import org.json.*
import java.net.InetAddress
import java.time.*
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

/** Local regression fixture using the current brief/settings/history contract. No forwarding, live accounts, external chat, upload or task execution. */
class V4Fixture(private val context: Context,val scenario: String) {
    private val server=MockWebServer()
    private var socket: WebSocket?=null
    private val day=LocalDate.now()
    private val now=System.currentTimeMillis()
    private val history=JSONArray()
    private val queue=linkedMapOf<String,String>()
    private var profile=JSONObject("""{"avatar":{"shape":"bean","palette":"mist"}}""")
    private var connectors=JSONObject(context.assets.open("connectors-v4.json").bufferedReader().use { it.readText() })
    val messages=CopyOnWriteArrayList<JSONObject>()
    val requests=CopyOnWriteArrayList<String>()
    val unexpected=CopyOnWriteArrayList<String>()
    val iconRequests=AtomicInteger()
    var tooLate=false
    var failSave=false
    var verifying=false
    val briefPath="data/briefs/$day/晨报.html"
    val secondPath="data/briefs/$day/采购.html"
    val url get()="http://127.0.0.1:${server.port}"

    init {
        if(scenario=="queue") { queue["q-remove"]="这条消息准备撤回"; queue["q-edit"]="这条消息准备修改" }
        history.put(JSONObject().put("role","assistant").put("text","上午先把周报收尾，采购资料我在后台整理。"))
        history.put(JSONObject().put("role","card").put("label","晨报").put("title","今天先收尾，再留出下午").put("path",briefPath).put("ts",now))
        server.dispatcher=object: okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = synchronized(this@V4Fixture) {
                val path=request.requestUrl?.encodedPath.orEmpty()
                requests.add("${request.method} $path")
                when {
                    path=="/favicon.ico" -> MockResponse().setResponseCode(204)
                    path=="/ws" -> MockResponse().withWebSocketUpgrade(listener)
                    path=="/api/state" -> json(JSONObject().put("busy",scenario=="queue").put("reason","task_result").put("tasks",tasks())
                        .put("firstChat",LocalDate.of(2026,9,24).atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli()).put("userCall","夏木").put("agentName","豆豆")
                        .put("schedule",JSONArray("""[{"id":"morning","name":"晨报","kind":"brief","cron":"30 7 * * *","enabled":true},{"id":"night","name":"晚间日记","cron":"30 22 * * *","enabled":true},{"id":"compact","name":"记忆整理","kind":"compact","cron":"0 3 * * *","enabled":true}]""")))
                    path=="/api/history" -> json(JSONObject().put("items",history))
                    path=="/api/profile" && request.method=="GET" -> json(profile)
                    path=="/api/profile" && request.method=="PUT" -> { profile=JSONObject(request.body.readUtf8()); json(profile) }
                    path=="/api/briefs" -> json(JSONObject().put("items",if(scenario=="today-empty") JSONArray() else briefs()))
                    path=="/api/jobs" -> json(JSONObject().put("running",JSONArray()).put("recent",JSONArray().put(job("晨报已生成",briefPath,now,true)).put(job("采购资料已整理","data/sites/purchase/index.html",now-86400000,true)).put(job("上周核对未完成","",now-10*86400000,false))).put("next",JSONObject.NULL))
                    path=="/api/health" -> json(JSONObject().put("syncedAt",JSONObject.NULL).put("device",JSONObject.NULL).put("note",JSONObject.NULL).put("days",JSONArray()).put("weekly",JSONArray()).put("records",JSONArray()))
                    path=="/api/settings" -> json(V5Fixture.settingsDocument())
                    path.startsWith("/api/tasks/") && path.endsWith("/history") -> {
                        val id=request.requestUrl!!.pathSegments[2]
                        json(JSONObject().put("id",id).put("title",id).put("status",if(id=="purchase") "running" else "done")
                            .put("items",JSONArray().put(JSONObject().put("kind","prompt").put("from","agent").put("text","整理今天的安排").put("time",now))
                                .put(JSONObject().put("kind","result").put("text","已整理完成。 [晨报]($briefPath)").put("time",now))))
                    }
                    path=="/api/tree" -> tree(request.requestUrl?.queryParameter("dir").orEmpty())
                    path=="/api/connectors" -> json(connectors)
                    path.matches(Regex("/api/connectors/[^/]+/icon")) -> {
                        iconRequests.incrementAndGet()
                        val name=path.split('/')[3]
                        val bytes=runCatching { context.assets.open("connector-icons/$name.png").use { it.readBytes() } }.getOrNull()
                        if(bytes==null) json(JSONObject(),404) else MockResponse().setHeader("Content-Type","image/png").setHeader("Cache-Control","public, max-age=31536000").setBody(Buffer().write(bytes))
                    }
                    path.startsWith("/api/connectors/") -> account(request,path)
                    path.startsWith("/api/devices/") && request.method=="DELETE" -> {
                        val id=path.substringAfterLast('/')
                        val device=connectors.getJSONArray("devices").objects().firstOrNull { it.optString("id")==id }
                        if(device?.optBoolean("online")==true) json(JSONObject().put("error","设备在线，不能移除"),409)
                        else { connectors.put("devices",JSONArray(connectors.getJSONArray("devices").objects().filter { it.optString("id")!=id })); json(JSONObject()) }
                    }
                    path.startsWith("/files/") -> file(request.requestUrl!!.pathSegments.drop(1).joinToString("/"))
                    path=="/api/run" && request.method=="POST" -> json(JSONObject().put("ok",true).put("mode","alarm"),202)
                    else -> { unexpected.add("${request.method} $path"); json(JSONObject().put("error","本地假服务没有此接口"),404) }
                }
            }
        }
        server.start(InetAddress.getByName("127.0.0.1"),0)
    }
    private fun json(j: JSONObject,status: Int=200)=MockResponse().setResponseCode(status).setHeader("Content-Type","application/json").setBody(j.toString())
    private fun tasks()=if(scenario=="today-empty") JSONArray() else JSONArray().put(JSONObject().put("id","purchase").put("description","整理采购资料").put("startedAt",now-180000))
    private fun job(title: String,path: String,time: Long,ok: Boolean)=JSONObject().put("id",title).put("title",title).put("label",title).put("path",path).put("ts",time).put("ok",ok).put("status",if(ok) "done" else "error").put("outputs",JSONArray())

    fun briefs(): JSONArray = ReviewBriefs.items(day)
    private fun entry(name: String,dir: Boolean)=JSONObject().put("name",name).put("dir",dir).put("mtime",now).put("size",100)
    private fun tree(dir: String): MockResponse {
        val entries=when(dir) {
            "data/sites" -> listOf(entry("purchase",true),entry("missing",true))
            "data/memory" -> listOf("profile","work","preferences","health","voice-notes","role").map { entry(it,true) }
            "data/memory/work" -> listOf(entry("采购交期.md",false),entry("周报.md",false))
            "data/memory/preferences" -> listOf(entry("沟通方式.md",false))
            "data/memory/health" -> if(scenario=="memory-empty") emptyList() else listOf(entry("latest.json",false))
            "data/memory/voice-notes" -> if(scenario=="memory-empty") emptyList() else listOf(entry("仓库随记.md",false),entry("周报提纲.md",false))
            "data/memory/role" -> listOf(entry("角色.md",false))
            "data/diary" -> (0..4).map { entry("${day.minusDays(it.toLong())}.md",false) }
            else -> emptyList()
        }
        return json(JSONObject().put("entries",JSONArray(entries)))
    }
    private fun file(path: String): MockResponse = when {
        path=="data/memory/profile/总档.md" -> text("# 我对夏木的了解\n\n- 你在做跨设备的个人助手，重视持续记忆。\n- 最近在收尾采购周报。 → work/采购交期.md\n- 喜欢把重要的事先排清楚。 → preferences/沟通方式.md\n- 日常安排需要留出独处的时间。\n- 沟通希望简明直接。")
        path=="data/memory/health/latest.json" -> if(scenario=="memory-empty") json(JSONObject(),404) else json(JSONObject("""{"updated":"$day","metrics":[{"key":"sleep","label":"睡眠","value":"7.2","unit":"小时"},{"key":"resting_heart_rate","label":"静息心率","value":"61","unit":"次/分"},{"key":"steps","label":"步数","value":"6840","unit":"步"},{"key":"hrv","label":"心率变异性","value":"42","unit":"毫秒"}]}"""))
        path.startsWith("data/diary/") -> text("# 今天把事情排清楚了\n\n上午完成了周报，下午确认采购交期。忙的时候，把同一件事拆成清楚的小步，反而更容易留出时间。明天先看看样品有没有到。")
        path=="data/sites/purchase/index.html" -> MockResponse().setHeader("Content-Type","text/html; charset=utf-8").setBody("""<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>采购进度</title><meta name="description" content="样品、报价与交期，一眼看清"></head><body style="margin:0;background:#e8eff6;font-family:sans-serif;color:#243343"><div style="padding:30px"><small>DOUDOU WORKSPACE</small><h1>采购进度</h1><p>样品 · 报价 · 交期</p><div style="background:white;border-radius:16px;padding:20px"><h3>样品确认</h3><p>两项已完成 · 一项待核对</p><div style="height:90px;background:linear-gradient(120deg,#a5c5db,#d9e7f1)"></div></div></div></body></html>""")
        path.startsWith("data/sites/missing/") -> json(JSONObject(),404)
        path.endsWith(".md") -> text("# 本地记忆\n\n内容由假服务提供，仅用于页面验收。")
        else -> json(JSONObject(),404)
    }
    private fun text(body: String)=MockResponse().setHeader("Content-Type","text/plain; charset=utf-8").setBody(body)
    private fun account(request: RecordedRequest,path: String): MockResponse {
        val parts=path.split('/'); val name=parts.getOrNull(3).orEmpty()
        val cloud=connectors.getJSONObject("cloud")
        val connector=(cloud.getJSONArray("installed").objects()+cloud.getJSONArray("catalog").objects()).firstOrNull { it.optString("name")==name } ?: return json(JSONObject(),404)
        val accounts=connector.optJSONArray("accounts") ?: JSONArray()
        val id=parts.getOrNull(5)
        if(request.method=="POST" && parts.last()=="test") { accounts.objects().first { it.optString("id")==id }.put("status","ok").put("error",JSONObject.NULL); return json(JSONObject().put("ok",true)) }
        if(request.method=="DELETE") { connector.put("accounts",JSONArray(accounts.objects().filter { it.optString("id")!=id })); recategorize(connector); return json(JSONObject()) }
        if(request.method in setOf("POST","PUT")) {
            if(verifying) return json(JSONObject().put("error","本地延迟验证"),400).setBodyDelay(2,java.util.concurrent.TimeUnit.SECONDS)
            if(failSave) return json(JSONObject().put("error","授权码不对，请重新生成后再试"),400)
            val values=JSONObject(request.body.readUtf8()).getJSONObject("values")
            val address=values.optString("address")
            val existing=accounts.objects().firstOrNull { it.optString("id")==id }
            if(existing==null && connector.getJSONArray("fields").objects().any { it.optString("type")!="select" && values.optString(it.optString("key")).isBlank() }) return json(JSONObject().put("error","请填写必填项"),400)
            val saved=JSONObject(existing?.optJSONObject("values")?.toString() ?: "{}")
            values.keys().forEach { key -> if(values.get(key)!="••••") saved.put(key,values.get(key)) }
            connector.getJSONArray("fields").objects().filter { it.optString("type")=="secret" }.forEach { saved.put(it.optString("key"),"••••") }
            val result=JSONObject().put("id",id ?: "local-${accounts.length()+1}").put("label",address.ifBlank { connector.optString("title")+"账号" }).put("status","ok").put("error",JSONObject.NULL).put("checkedAt",now).put("values",saved)
            connector.put("accounts",JSONArray(accounts.objects().filter { it.optString("id")!=id }).put(result)); recategorize(connector)
            return json(result)
        }
        unexpected.add("${request.method} $path"); return json(JSONObject(),405)
    }
    private fun recategorize(connector: JSONObject) {
        val cloud=connectors.getJSONObject("cloud"); val name=connector.optString("name")
        val installed=cloud.getJSONArray("installed").objects().filter { it.optString("name")!=name }; val catalog=cloud.getJSONArray("catalog").objects().filter { it.optString("name")!=name }
        if(connector.optJSONArray("accounts")?.length() ?: 0 > 0) { cloud.put("installed",JSONArray(installed).put(connector)); cloud.put("catalog",JSONArray(catalog)) }
        else { cloud.put("installed",JSONArray(installed)); cloud.put("catalog",JSONArray(catalog).put(connector)) }
    }
    private val listener=object: WebSocketListener() {
        override fun onOpen(webSocket: WebSocket,response: Response) {
            socket=webSocket
            val queued=JSONArray(queue.map { (id,text) -> JSONObject().put("id",id).put("text",text).put("source","app").put("ts",now) })
            webSocket.send(JSONObject().put("t","hello").put("busy",scenario=="queue").put("reason","task_result").put("history",history).put("tasks",tasks()).put("queued",queued).toString())
            if(scenario=="queue") {
                // Repeated echoes exercise id deduplication after the authoritative hello snapshot.
                queue.forEach { (id,text) -> webSocket.send(JSONObject().put("t","user").put("id",id).put("text",text).put("source","app").toString()) }
            }
        }
        override fun onMessage(webSocket: WebSocket,text: String): Unit = synchronized(this@V4Fixture) {
            val message=JSONObject(text); messages.add(message)
            val id=message.optString("id")
            when(message.optString("t")) {
                "unqueue","edit_queued" -> {
                    val state=if(tooLate || id !in queue) "too_late" else if(message.optString("t")=="unqueue") "removed" else "edited"
                    val update=JSONObject().put("t","queue_update").put("id",id).put("state",state)
                    if(state=="removed") queue.remove(id)
                    if(state=="edited") { queue[id]=message.optString("text"); update.put("text",message.optString("text")) }
                    webSocket.send(update.toString())
                }
                "send" -> { val accepted=JSONObject(message.toString()).put("t","user").put("id","sent-${messages.size}").put("source","app"); webSocket.send(accepted.toString()) }
                "stop_task" -> { webSocket.send(JSONObject().put("t","task_stop").put("id",id).put("ok",true).toString()) }
                "interrupt" -> webSocket.send("""{"t":"status","busy":false}""")
                else -> unexpected.add("WS:"+message.optString("t"))
            }
            Unit
        }
        override fun onClosing(webSocket: WebSocket,code: Int,reason: String) { webSocket.close(1000,null) }
    }
    fun beginQueued(id: String) = synchronized(this) {
        val text=queue.remove(id) ?: return@synchronized
        history.put(JSONObject().put("role","user").put("id",id).put("text",text))
        socket?.send("""{"t":"status","busy":false}""")
        socket?.send("""{"t":"status","busy":true,"reason":"user"}""")
    }
    fun close() { socket?.close(1000,null); server.shutdown() }
}
