package com.xiamu.agent.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.util.Base64
import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.*
import androidx.lifecycle.*
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.xiamu.agent.*
import kotlinx.coroutines.*
import okhttp3.*
import org.json.*

private class BrowserConnection {
    var state by mutableStateOf(JSONObject())
    var frame by mutableStateOf<Bitmap?>(null)
    var info by mutableStateOf<BrowserFrameInfo?>(null)
    var error by mutableStateOf("")
    private var ws: WebSocket?=null
    private val handler=Handler(Looper.getMainLooper())
    private var wanted=false
    private var retry=0
    private var generation=0
    fun connect() {
        wanted=true
        if(ws!=null) return
        val request=Api.socketRequest("/ws/browser") ?: return
        ws=Api.http.newWebSocket(request,object : WebSocketListener() {
            override fun onOpen(socket: WebSocket,response: Response) { handler.post { if(ws===socket) { retry=0; error=""; socket.send("{\"t\":\"browser_watch\",\"watch\":true}") } } }
            override fun onMessage(socket: WebSocket,text: String) {
                val j=runCatching { JSONObject(text) }.getOrNull() ?: return
                if(j.optString("t")=="browser_frame") {
                    val bitmap=runCatching { val data=Base64.decode(j.getString("data"),Base64.DEFAULT); BitmapFactory.decodeByteArray(data,0,data.size) }.getOrNull() ?: return
                    val next=BrowserFrameInfo(j.optLong("frameId"),j.optInt("width"),j.optInt("height"))
                    handler.post { if(ws===socket && wanted && (info?.id ?: -1)<next.id) { frame=bitmap; info=next } }
                } else if(j.optString("t")=="browser_state") handler.post { if(ws===socket) { state=j; if(j.optString("state")=="closed") { frame=null; info=null } } }
            }
            override fun onClosing(socket: WebSocket,code: Int,reason: String) { socket.close(1000,null); drop(socket) }
            override fun onFailure(socket: WebSocket,t: Throwable,response: Response?)=drop(socket)
            override fun onClosed(socket: WebSocket,code: Int,reason: String)=drop(socket)
            private fun drop(socket: WebSocket) { handler.post {
                if(ws!==socket) return@post
                ws=null; frame=null; info=null; error="画面已断开，正在重连"
                val current=++generation
                if(wanted) handler.postDelayed({ if(wanted && generation==current) connect() },(1000L shl retry++.coerceAtMost(4)))
            } }
        })
    }
    fun disconnect() { wanted=false; generation++; ws?.send("{\"t\":\"browser_watch\",\"watch\":false}"); ws?.close(1000,null); ws=null; frame=null; info=null }
    suspend fun action(name: String) {
        state=Api.postJson("/api/browser/$name",JSONObject()); error=""
        if(name=="close") { frame=null; info=null }
    }
    suspend fun input(value: JSONObject) { Api.postJson("/api/browser/input",value) }
}
@Composable
private fun rememberBrowser(active: Boolean): BrowserConnection {
    val connection=remember { BrowserConnection() }
    val lifecycle=LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle,active) {
        val observer=LifecycleEventObserver { _,event -> if(event==Lifecycle.Event.ON_START && active) connection.connect(); if(event==Lifecycle.Event.ON_STOP) connection.disconnect() }
        lifecycle.addObserver(observer)
        if(active && lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) connection.connect()
        onDispose { lifecycle.removeObserver(observer); connection.disconnect() }
    }
    return connection
}
@Composable
fun BrowserPreview(active: Boolean) {
    val browser=rememberBrowser(active)
    Column(Modifier.fillMaxWidth().padding(top=12.dp).clip(RoundedCornerShape(18.dp)).background(Pal.Card).tap { Nav.open(Route.Browser) }) {
        Box(Modifier.fillMaxWidth().aspectRatio(1.6f),contentAlignment=Alignment.Center) {
            val frame=browser.frame
            if(frame!=null) Image(frame.asImageBitmap(),"云端浏览器实时画面",Modifier.fillMaxSize())
            else Column(horizontalAlignment=Alignment.CenterHorizontally) { Icon(Icons.Outlined.Language,null,tint=Pal.Muted,modifier=Modifier.size(32.dp)); Text("打开云端浏览器",style=Type.body(13),color=Pal.Ink,modifier=Modifier.padding(top=8.dp)) }
        }
        Text(if(browser.state.optString("control")=="user") "你正在接管 · 点开全屏" else "云端浏览器 · 点开查看与接管",style=Type.body(12),color=Pal.Muted,modifier=Modifier.padding(12.dp))
        if(browser.error.isNotBlank()) Text(browser.error,style=Type.body(11),color=Pal.Muted,modifier=Modifier.padding(horizontal=12.dp))
    }
}
@Composable
fun BrowserScreen() {
    val browser=rememberBrowser(true)
    val scope=rememberCoroutineScope()
    var input by remember { mutableStateOf("") }
    var dragMode by remember { mutableStateOf(false) }
    var waiting by remember { mutableStateOf(false) }
    fun run(block: suspend () -> Unit) { scope.launch { try { block() } catch(e: CancellationException) { throw e } catch(e: Exception) { browser.error=e.message ?: "操作失败，请重试" } } }
    LaunchedEffect(Unit) { try { browser.action("open") } catch(e: CancellationException) { throw e } catch(e: Exception) { browser.error=e.message ?: "浏览器暂不可用" } }
    val control=browser.state.optString("control")=="user"
    val dialog=browser.state.optJSONObject("dialog")
    var promptText by remember(dialog?.toString()) { mutableStateOf(dialog?.optString("defaultValue").orEmpty()) }
    Screen { Column(Modifier.fillMaxSize().navigationBarsPadding().imePadding()) {
        SubHeader("云端浏览器",Nav::back)
        Text(browser.state.optString("title").ifBlank { "浏览器" },style=Type.title(15),color=Pal.Ink,maxLines=1,modifier=Modifier.padding(horizontal=20.dp,vertical=4.dp))
        Text(if(control) "你正在接管" else "豆豆控制中",style=Type.body(12),color=Pal.Muted,modifier=Modifier.padding(horizontal=20.dp))
        Box(Modifier.fillMaxWidth().weight(1f).padding(vertical=12.dp),contentAlignment=Alignment.Center) {
            BrowserCanvas(browser,control,dragMode) { value -> run { browser.input(value) } }
        }
        if(browser.error.isNotBlank()) ErrorNote(browser.error)
        if(control) Column(Modifier.padding(horizontal=16.dp)) {
            Row(verticalAlignment=Alignment.CenterVertically) {
                OutlinedTextField(input,{input=it},placeholder={Text("在网页中输入")},singleLine=true,modifier=Modifier.weight(1f))
                IconButton(onClick={ val text=input; if(text.isNotBlank()) run { browser.input(JSONObject().put("type","text").put("text",text)); input="" } }) { Icon(Icons.Outlined.ArrowUpward,"输入到网页") }
            }
            Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween) {
                listOf("Tab","Enter","Backspace").forEach { key -> TextButton(onClick={run { browser.input(JSONObject().put("type","key").put("key",key)) }}) { Text(key,style=Type.body(12)) } }
                TextButton(onClick={dragMode=!dragMode}) { Text(if(dragMode) "拖动" else "滚动",style=Type.body(12)) }
            }
        }
        Row(Modifier.fillMaxWidth().padding(16.dp),horizontalArrangement=Arrangement.spacedBy(10.dp)) {
            GoldButton(if(control) "交还豆豆" else "我来接管",Modifier.weight(1f),!waiting) {
                waiting=true; run { try { browser.action(if(control) "return" else "takeover") } finally { waiting=false } }
            }
            SilverButton("关闭浏览器",Modifier.weight(1f)) { run { browser.action("close") } }
        }
    } }
    if(dialog!=null && control) AlertDialog(onDismissRequest={},title={Text("网页请求确认")},text={Column { Text(dialog.optString("message")); if(dialog.optString("type")=="prompt") OutlinedTextField(promptText,{promptText=it}) }},confirmButton={TextButton(onClick={run { browser.input(JSONObject().put("type","dialog").put("accept",true).put("promptText",promptText)) }}) { Text("确认") }},dismissButton={TextButton(onClick={run { browser.input(JSONObject().put("type","dialog").put("accept",false)) }}) { Text("取消") }})
}
@Composable
private fun BrowserCanvas(browser: BrowserConnection,control: Boolean,dragMode: Boolean,onInput: (JSONObject) -> Unit) {
    val frame=browser.frame
    val current by rememberUpdatedState(browser.info)
    var size by remember { mutableStateOf(IntSize.Zero) }
    if(frame==null) { EmptyNote(if(browser.state.optString("state")=="closed") "浏览器已关闭" else "等待实时画面…"); return }
    var start by remember { mutableStateOf(Offset.Zero) }
    var total by remember { mutableStateOf(Offset.Zero) }
    val points=remember { mutableListOf<Offset>() }
    Image(frame.asImageBitmap(),"浏览器画面",Modifier.fillMaxWidth().aspectRatio(frame.width.toFloat()/frame.height).onSizeChanged { size=it }
        .pointerInput(control) { if(control) detectTapGestures { p -> current?.let { onInput(it.pointer("click",p.x,p.y,size.width,size.height)) } } }
        .pointerInput(control,dragMode) { if(control) detectDragGestures(onDragStart={p->start=p; total=Offset.Zero; points.clear(); points.add(p)},onDragCancel={points.clear()},onDragEnd={
            current?.let { info ->
                val p=start
                if(dragMode && points.size>=2) onInput(JSONObject().put("type","drag").put("frameId",info.id).put("width",size.width).put("height",size.height).put("points",JSONArray(points.take(64).map { JSONObject().put("x",it.x.coerceIn(0f,size.width.toFloat())).put("y",it.y.coerceIn(0f,size.height.toFloat())) })))
                else if(!dragMode) onInput(info.pointer("scroll",p.x.coerceIn(0f,size.width.toFloat()),p.y.coerceIn(0f,size.height.toFloat()),size.width,size.height).put("deltaX",-total.x).put("deltaY",-total.y))
            }
        }) { change,delta -> change.consume(); total+=delta; if(points.size<64) points.add(change.position) } })
}
