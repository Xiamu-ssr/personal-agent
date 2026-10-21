package com.xiamu.agent

import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.*
import kotlinx.coroutines.*
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

object Chat {
    val items=mutableStateListOf<ChatItem>()
    val connected=mutableStateOf(false)
    val busy=mutableStateOf(false)
    val avatar=mutableStateOf(AvatarStatus())
    val agentName=mutableStateOf("豆豆")
    val error=mutableStateOf("")
    val filesVersion=mutableIntStateOf(0)
    val libraryVersion=mutableIntStateOf(0)
    val activityVersion=mutableIntStateOf(0)
    val settingsVersion=mutableIntStateOf(0)
    val activityUpdates=mutableStateMapOf<String,ActivityTitleUpdate>()
    val feedVersion=mutableIntStateOf(0)
    val feedSettingsVersion=mutableIntStateOf(0)
    val feedUnread=mutableStateOf(false)
    val background=mutableStateListOf<BackgroundActivity>()
    private var inbox=FeedInbox()
    private var feedVisible=false
    private val state=Conversation(items)
    private val main=Handler(Looper.getMainLooper())
    private val scope=CoroutineScope(SupervisorJob()+Dispatchers.Main.immediate)
    private var socket: WebSocket?=null
    private var wanted=false
    private var generation=0
    private var revision=0
    private var retry=0
    private fun publish() { busy.value=state.busy; avatar.value=state.avatar }
    fun connect() {
        if(!Prefs.configured) return
        wanted=true
        if(socket!=null) return
        inbox=FeedInbox(Prefs.feedUnread,Prefs.feedKnownPaths); if(feedVisible) inbox.enter(); feedUnread.value=inbox.unread
        socket=Api.http.newWebSocket(Api.wsRequest("app") ?: return,Listener())
    }
    fun disconnect() {
        wanted=false; generation++; socket?.close(1000,null); socket=null; connected.value=false
        state.disconnected(); SideChats.disconnected(); background.clear(); publish()
    }
    fun reset() { disconnect(); SideChats.reset(); state.clear(); activityUpdates.clear(); error.value=""; agentName.value="豆豆"; inbox=FeedInbox(); feedUnread.value=false }
    suspend fun send(message: OutgoingMessage): Boolean {
        val result=Api.postMessage(message.path,message.json())
        val id=result.optString("id")
        check(result.optBoolean("ok") && id.isNotBlank()) { "消息尚未确认，请重试" }
        // Display only server messages. A receipt lost on WS is recovered from history.
        if(items.none { it is ChatItem.User && it.id==id }) {
            val session=generation
            scope.launch {
                runCatching { Api.getJson("/api/history?n=200") }.onSuccess { history ->
                    if(session==generation) { state.replaceHistory(history.optJSONArray("items").objects().mapNotNull(::historyItem));publish() }
                }
            }
        }
        revision++; error.value=""; return true
    }
    fun interrupt() { if(socket?.send("{\"t\":\"interrupt\"}")!=true) error.value="连接断开，未能停止" }
    fun choose(messageId: String,optionId: String) {
        if(!state.choose(messageId,optionId)) return
        scope.launch {
            try { Api.postJson("/api/options/choose",JSONObject().put("messageId",messageId).put("optionId",optionId)); state.optionsUsed(messageId) }
            catch(e: CancellationException) { throw e }
            catch(e: Exception) { if(e is Api.ApiError && e.code==409) state.optionsUsed(messageId) else state.choiceFailed(messageId); error.value=e.message ?: "选项未发出，请重试" }
        }
    }
    fun enterFeed() { feedVisible=true; inbox.enter(); persistFeed() }
    fun leaveFeed() { feedVisible=false; inbox.leave() }
    private fun persistFeed() { feedUnread.value=inbox.unread; Prefs.feedUnread=inbox.unread; Prefs.feedKnownPaths=inbox.knownPaths }
    private fun refresh() {
        val session=generation; val before=revision
        scope.launch {
            try {
                val s=Api.getJson("/api/state")
                if(session!=generation) return@launch
                agentName.value=s.optString("agentName").ifBlank { "豆豆" }
                if(before==revision) { state.status(s.optBoolean("busy")); state.avatar(AvatarStatus.from(s.optJSONObject("avatar"))); publish() }
                // Check the actual server state, never infer onboarding from a local preference.
                if(s.optBoolean("chatEmpty")) Api.postJson("/api/first-chat",JSONObject().put("device","android"))
                val history=Api.getJson("/api/history?n=200")
                if(session==generation) { state.replaceHistory(history.optJSONArray("items").objects().mapNotNull(::historyItem)); publish() }
                // New posts can arrive while the App has no socket. Reconcile on reconnect.
                runCatching { Api.feed() }.onSuccess { page -> if(session==generation) { inbox.receive(page.items.map { it.path }); persistFeed() } }

            } catch(e: CancellationException) { throw e }
            catch(e: Exception) { if(session==generation) error.value=e.message ?: "聊天加载失败" }
        }
    }
    private fun handle(m: JSONObject) {
        when(m.optString("t")) {
            "hello" -> {
                generation++; revision++
                // Re-read canonical activity titles after events missed offline.
                activityUpdates.clear(); activityVersion.intValue++
                state.hello(m.optJSONArray("history").objects().mapNotNull(::historyItem),m.optBoolean("busy"),AvatarStatus.from(m.optJSONObject("avatar")))
                connected.value=true; error.value=""; refresh(); filesVersion.intValue++;libraryVersion.intValue++
            }
            "user" -> { (historyItem(m) as? ChatItem.User)?.let(state::user); revision++ }
            "say" -> { (historyItem(m) as? ChatItem.Assistant)?.let(state::say); revision++ }
            "activity_message" -> { SideChats.message(m); activityVersion.intValue++ }
            "options_used" -> { if(sideChatEventId(m)!=null) SideChats.message(m) else { state.optionsUsed(m.optString("messageId")); revision++ } }
            "status" -> { state.status(m.optBoolean("busy")); revision++ }
            "avatar" -> { state.avatar(AvatarStatus.from(m)); revision++ }
            "turn_end" -> { state.endTurn(); revision++ }
            "activity", "activity_step", "activity_stop" -> {
                SideChats.activity(m)
                val update=ActivityTitleUpdate.from(m)
                if(update!=null) {
                    val previous=activityUpdates[update.id]
                    activityUpdates[update.id]=update.copy(title=update.title ?: previous?.title,summary=update.summary ?: previous?.summary)
                } else activityVersion.intValue++
                if(m.optString("t")=="activity_stop" && !m.optBoolean("ok")) error.value=m.optString("error").ifBlank { "停止活动失败" }
            }
            "background_activities" -> {
                val id=m.optString("id")
                when(m.optString("phase")) {
                    "snapshot" -> { background.clear(); background.addAll(m.optJSONArray("items").objects().map { BackgroundActivity(it.optString("id"),it.optString("description"),it.optLong("startedAt")) }.filter { it.id.isNotBlank() }.distinctBy { it.id }) }
                    "started" -> if(id.isNotBlank() && background.none { it.id==id }) background.add(BackgroundActivity(id,m.optString("description"),m.optLong("startedAt")))
                    "notification" -> if(m.optString("status") in setOf("completed","failed","stopped","killed")) background.removeAll { it.id==id }
                    "updated", "progress" -> {
                        val i=background.indexOfFirst { it.id==id }; val patch=m.optJSONObject("patch") ?: m
                        if(patch.optString("status") in setOf("completed","failed","stopped","killed")) background.removeAll { it.id==id }
                        else if(i>=0) background[i]=background[i].copy(description=patch.optString("description").ifBlank { background[i].description })
                    }
                }; activityVersion.intValue++
            }
            "feed_new" -> { inbox.receive(m.optJSONArray("items").objects().map { it.optString("path") }); persistFeed(); feedVersion.intValue++ }
            "feed_settings" -> feedSettingsVersion.intValue++
            "feed_updated" -> {feedVersion.intValue++;com.xiamu.agent.media.Images.clear()}
            "library_updated" -> {libraryVersion.intValue++;com.xiamu.agent.media.Images.clear()}
            "ideas_updated","goals_updated" -> filesVersion.intValue++
            "settings" -> settingsVersion.intValue++
            "files_changed", "memory_updated", "connectors_changed", "devices" -> filesVersion.intValue++
            "error" -> error.value=m.optString("error").ifBlank { "请求失败，请重试" }
        }; publish()
    }
    private class Listener : WebSocketListener() {
        override fun onOpen(ws: WebSocket,response: Response) { main.post { if(socket===ws) retry=0 } }
        override fun onMessage(ws: WebSocket,text: String) { val m=runCatching { JSONObject(text) }.getOrNull() ?: return; main.post { if(socket===ws && wanted) handle(m) } }
        override fun onClosing(ws: WebSocket,code: Int,reason: String) { ws.close(1000,null); drop(ws) }
        override fun onClosed(ws: WebSocket,code: Int,reason: String) = drop(ws)
        override fun onFailure(ws: WebSocket,t: Throwable,response: Response?) = drop(ws)
        private fun drop(ws: WebSocket) { main.post {
            if(socket!==ws) return@post
            socket=null; connected.value=false; generation++; state.disconnected(); SideChats.disconnected(); publish(); background.clear()
            if(wanted) { val wait=(1000L shl retry.coerceAtMost(5)).coerceAtMost(30000L); retry++; main.postDelayed({ if(wanted) connect() },wait) }
        } }
    }
}
