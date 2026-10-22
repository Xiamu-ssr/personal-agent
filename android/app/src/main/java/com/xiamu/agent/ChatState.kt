package com.xiamu.agent

import org.json.JSONObject
import androidx.compose.runtime.snapshots.Snapshot

sealed class ChatItem {
    data class User(val text: String,val attachments: List<Attachment> = emptyList(),val ts: Long = 0,val id: String = "",val quote: ChatQuote? = null) : ChatItem()
    data class Assistant(val text: String,val ts: Long = 0,val media: List<ReplyMedia> = emptyList(),val id: String = "",val options: List<SayOption> = emptyList(),val cards: List<SayCard> = emptyList(),val optionsUsed: Boolean = false,val choosing: Boolean = false,val activityId: String? = null) : ChatItem() {
        val displayMedia: List<ReplyMedia> get() = (cards.filterIsInstance<SayCard.Media>().map { it.file } + media).distinctBy { it.path }
    }
}
internal fun historyItem(h: JSONObject): ChatItem? = when(h.optString("role")) {
    "user" -> if(h.optString("source")=="onboarding") null else ChatItem.User(h.optString("text"),h.optJSONArray("attachments").objects().map(Attachment::from),ts=h.optLong("ts"),id=h.optString("id"),quote=ChatQuote.from(h.optJSONObject("quote")))
    "assistant" -> ChatItem.Assistant(h.optString("text"),h.optLong("ts"),replyMedia(h),h.optString("id"),sayOptions(h),sayCards(h),h.optBoolean("optionsUsed"),activityId=h.optString("activityId").takeIf { it.isNotBlank() })
    else -> null
}
data class BackgroundActivity(val id: String,val description: String,val startedAt: Long)

/** Id-based 0.8.1 chat reducer. turn_end never creates bubbles or declares SDK idle. */
class Conversation(val items: MutableList<ChatItem> = mutableListOf()) {
    var busy=false; private set
    var avatar=AvatarStatus(); private set
    private val consumed=mutableSetOf<String>()
    fun hello(history: List<ChatItem>, busy: Boolean, avatar: AvatarStatus) {
        this.busy=busy; this.avatar=avatar
        replaceHistory(history)
    }
    fun replaceHistory(history: List<ChatItem>) {
        history.filterIsInstance<ChatItem.Assistant>().filter { it.optionsUsed }.forEach { consumed.add(it.id) }
        val merged=mergeChatMessages(history,items.toList()).map { if(it is ChatItem.Assistant && it.id in consumed) it.copy(optionsUsed=true,choosing=false) else it }
        if(merged!=items) Snapshot.withMutableSnapshot { items.clear(); items.addAll(merged) }
    }
    fun clear() { items.clear(); consumed.clear(); busy=false; avatar=AvatarStatus() }
    fun user(m: ChatItem.User) {
        val existing=items.indexOfFirst { it is ChatItem.User && m.id.isNotBlank() && it.id==m.id }
        if(existing>=0) { items[existing]=m; return }
        items.add(m)
    }
    fun say(m: ChatItem.Assistant) {
        if(m.optionsUsed) consumed.add(m.id)
        val index=items.indexOfFirst { it is ChatItem.Assistant && m.id.isNotBlank() && it.id==m.id }
        val value=m.copy(optionsUsed=m.optionsUsed || m.id in consumed)
        if(index>=0) items[index]=value else items.add(value)
    }
    fun choose(messageId: String,optionId: String): Boolean {
        val i=items.indexOfFirst { it is ChatItem.Assistant && it.id==messageId }
        val m=items.getOrNull(i) as? ChatItem.Assistant ?: return false
        if(m.optionsUsed || m.choosing || m.options.none { it.id==optionId }) return false
        items[i]=m.copy(choosing=true); return true
    }
    fun optionsUsed(id: String) {
        consumed.add(id)
        val i=items.indexOfFirst { it is ChatItem.Assistant && it.id==id }
        if(i>=0) items[i]=(items[i] as ChatItem.Assistant).copy(optionsUsed=true,choosing=false)
    }
    fun choiceFailed(id: String) {
        val i=items.indexOfFirst { it is ChatItem.Assistant && it.id==id }
        if(i>=0) items[i]=(items[i] as ChatItem.Assistant).copy(choosing=false)
    }
    fun status(value: Boolean) { busy=value }
    fun avatar(value: AvatarStatus) { avatar=value }
    fun endTurn() = Unit
    fun disconnected() { busy=false; avatar=AvatarStatus() }
}
