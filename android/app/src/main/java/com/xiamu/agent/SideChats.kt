package com.xiamu.agent

import androidx.compose.runtime.*
import kotlinx.coroutines.*
import org.json.JSONObject

object SideChats {
    private val sessions=mutableMapOf<String,SideChatSession>()
    fun session(id: String)=sessions.getOrPut(id) { SideChatSession(id) }
    fun reset() { sessions.values.forEach { it.close() }; sessions.clear() }
    fun disconnected() { sessions.values.forEach { it.disconnected() } }
    fun message(event: JSONObject) { sideChatEventId(event)?.let { session(it).message(event) } }
    fun activity(event: JSONObject) {
        if(event.optString("chatType")!="side") return
        sessions[event.optString("id")]?.activity(event)
    }
}

class SideChatSession(val id: String) {
    val items=mutableStateListOf<ChatItem>()
    val state=Conversation(items)
    val title=mutableStateOf("")
    val busy=mutableStateOf(false)
    val error=mutableStateOf("")
    val loaded=mutableStateOf(false)
    private val scope=CoroutineScope(SupervisorJob()+Dispatchers.Main.immediate)
    private var revision=0
    private var closed=false

    suspend fun refresh() {
        val before=revision
        try {
            val history=Api.sideChatHistory(id)
            if(closed) return
            title.value=history.title
            state.replaceHistory(mergeSideMessages(history.messages,items.toList()))
            if(before==revision) { state.status(history.status==ActivityStatus.Running); busy.value=state.busy }
            loaded.value=true; error.value=""
        } catch(e: CancellationException) { throw e }
        catch(e: Exception) { if(!closed) error.value=e.message ?: "旁聊加载失败" }
    }

    fun message(event: JSONObject) {
        if(closed || sideChatEventId(event)!=id) return
        when(event.optString("t")) {
            "activity_message" -> when(val message=historyItem(event)) {
                is ChatItem.User -> state.user(message)
                is ChatItem.Assistant -> state.say(message)
                null -> Unit
            }
            "options_used" -> state.optionsUsed(event.optString("messageId"))
        }
        revision++
    }

    fun activity(event: JSONObject) {
        if(closed || event.optString("id")!=id || event.optString("chatType")!="side") return
        title.value=event.optString("title").ifBlank { title.value }
        val running=event.optString("phase")=="started" || event.optString("status")=="running"
        state.status(running); busy.value=running; revision++
    }

    fun choose(messageId: String,optionId: String) {
        if(!state.choose(messageId,optionId)) return
        scope.launch {
            try { Api.chooseSideOption(id,messageId,optionId); if(!closed) state.optionsUsed(messageId) }
            catch(e: CancellationException) { throw e }
            catch(e: Exception) {
                if(!closed) {
                    if(e is Api.ApiError && e.code==409) state.optionsUsed(messageId) else state.choiceFailed(messageId)
                    error.value=e.message ?: "选项未发出，请重试"
                }
            }
        }
    }
    fun disconnected() { state.disconnected(); busy.value=false }
    fun close() { closed=true; scope.cancel() }
}
