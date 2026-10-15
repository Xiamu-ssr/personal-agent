package com.xiamu.agent

import org.json.JSONObject

sealed class ChatItem {
    data class User(val text: String,val attachments: List<Attachment> = emptyList(),val pending: Boolean = false,val ts: Long = 0,val id: String = "") : ChatItem()
    data class Assistant(val text: String,val ts: Long = 0,val media: List<ReplyMedia> = emptyList(),val id: String = "",val options: List<SayOption> = emptyList(),val cards: List<SayCard> = emptyList(),val optionsUsed: Boolean = false,val choosing: Boolean = false) : ChatItem() {
        val displayMedia: List<ReplyMedia> get() = (cards.filterIsInstance<SayCard.Media>().map { it.file } + media).distinctBy { it.path }
    }
}
internal fun historyItem(h: JSONObject): ChatItem? = when(h.optString("role")) {
    "user" -> if(h.optString("source")=="onboarding") null else ChatItem.User(h.optString("text"),h.optJSONArray("attachments").objects().map(Attachment::from),ts=h.optLong("ts"),id=h.optString("id"))
    "assistant" -> ChatItem.Assistant(h.optString("text"),h.optLong("ts"),replyMedia(h),h.optString("id"),sayOptions(h),sayCards(h),h.optBoolean("optionsUsed"))
    else -> null
}
data class BackgroundActivity(val id: String,val description: String,val startedAt: Long)

/** Pure, id-based 0.8 chat reducer. turn_end only closes provisional text. */
class Conversation(val items: MutableList<ChatItem> = mutableListOf()) {
    var busy=false; private set
    var avatar=AvatarStatus(); private set
    private val consumed=mutableSetOf<String>()
    private val deltas=linkedMapOf<String,String>()
    val streaming get() = deltas.values.joinToString("\n\n")
    fun hello(history: List<ChatItem>, busy: Boolean, avatar: AvatarStatus) {
        this.busy=busy; this.avatar=avatar; deltas.clear(); consumed.clear()
        history.filterIsInstance<ChatItem.Assistant>().filter { it.optionsUsed }.forEach { consumed.add(it.id) }
        items.clear(); items.addAll(history)
    }
    fun replaceHistory(history: List<ChatItem>) {
        val pending=items.filterIsInstance<ChatItem.User>().filter { it.pending }
        history.filterIsInstance<ChatItem.Assistant>().filter { it.optionsUsed }.forEach { consumed.add(it.id) }
        items.clear(); items.addAll(history.map { if(it is ChatItem.Assistant && it.id in consumed) it.copy(optionsUsed=true) else it }); items.addAll(pending)
    }
    fun sent(text: String,attachments: List<Attachment>,ts: Long) { items.add(ChatItem.User(text,attachments,true,ts)) }
    fun user(m: ChatItem.User) {
        val existing=items.indexOfFirst { it is ChatItem.User && m.id.isNotBlank() && it.id==m.id }
        if(existing>=0) { items[existing]=m; return }
        val pending=items.indexOfFirst { it is ChatItem.User && it.pending && it.text==m.text && it.attachments.map { a->a.path }==m.attachments.map { a->a.path } }
        if(pending>=0) items[pending]=m else items.add(m)
    }
    fun say(m: ChatItem.Assistant) {
        deltas.remove(m.id)
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
    fun delta(id: String,text: String) { if(id.isNotBlank() && items.none { it is ChatItem.Assistant && it.id==id }) deltas[id]=deltas[id].orEmpty()+text }
    fun endTurn() { deltas.clear() }
    fun disconnected() { busy=false; deltas.clear(); avatar=AvatarStatus() }
}
