package com.xiamu.agent

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Selection order is stable; completing a send removes only its captured attachments. */
data class AttachmentDraft<T>(val items: List<T> = emptyList()) {
    fun add(values: List<T>) = copy(items = (items + values).distinct())
    fun remove(values: List<T>) = copy(items = items.filterNot { it in values })
}

data class ChatQuote(val kind: String, val title: String, val emoji: String, val source: String,
    val path: String = "", val id: String = "", val revision: String = "", val description: String = "", val reply: String = "") {
    fun reference() = JSONObject().put("kind", kind).apply {
        if(kind == "feed") put("path", path) else { put("id", id); put("revision", revision) }
    }
    fun json() = reference().put("title", title).put("emoji", emoji).put("source", source).apply {
        if(kind == "idea") { put("description", description); put("reply", reply) }
    }
    companion object {
        fun from(post: FeedPost) = ChatQuote("feed", post.title, post.icon, post.source, path = post.path)
        fun from(idea: Idea, revision: String, group: String) = ChatQuote("idea", idea.title, idea.icon, group, id = idea.id, revision = revision, description = idea.description, reply = idea.reply)
        fun from(j: JSONObject?): ChatQuote? {
            if (j == null || j.optString("title").isBlank()) return null
            val kind = j.optString("kind")
            val path = j.optString("path")
            if (kind == "feed") {
                if (!isDataFile(path) || !path.startsWith("data/feed/")) return null
            } else if (kind == "idea") {
                if(j.optString("id").isBlank() || j.optString("revision").isBlank() || j.optString("reply").isBlank()) return null
            } else return null
            return ChatQuote(kind, j.getString("title"), j.optString("emoji"), j.optString("source"), path,
                j.optString("id"), j.optString("revision"), j.optString("description"), j.optString("reply"))
        }
    }
}

/** The same payload keeps its UUID after failure; a successful send releases it. */
class SendAttempt(private val uuid: () -> String = { UUID.randomUUID().toString() }) {
    var sending = false; private set
    private var payload: String? = null
    private var clientId: String? = null
    fun begin(key: String): String? {
        if (sending) return null
        if (payload != key || clientId == null) { payload = key; clientId = uuid() }
        sending = true
        return clientId
    }
    fun failed(retryable: Boolean = true) { if(retryable) sending = false else reset() }
    fun accepted() { reset() }
    fun reset() { sending = false; payload = null; clientId = null }
}

data class OutgoingMessage(val text: String, val attachments: List<Attachment>, val clientId: String, val quote: ChatQuote? = null) {
    val path: String get() = "/api/send"
    fun json(): JSONObject = JSONObject().put("clientId", clientId).put("text", text).apply {
        put("attachments", JSONArray(attachments.map { it.toJson() }))
        if (quote != null) put("quote", quote.reference())
    }
}

/** Snapshots can race with WS events. Keep every id, and never revive consumed options. */
fun mergeChatMessages(history: List<ChatItem>, live: List<ChatItem>): List<ChatItem> {
    val merged = linkedMapOf<String, ChatItem>()
    (history + live).forEachIndexed { index, item ->
        val id = when (item) { is ChatItem.User -> item.id; is ChatItem.Assistant -> item.id }
        val role = when(item) { is ChatItem.User -> "user"; is ChatItem.Assistant -> "assistant" }
        val key = "$role:${id.ifBlank { "anonymous:$index" }}"
        val previous = merged[key]
        merged[key] = when {
            item is ChatItem.Assistant && previous is ChatItem.Assistant -> item.copy(optionsUsed = item.optionsUsed || previous.optionsUsed, activityId = item.activityId ?: previous.activityId)
            item is ChatItem.User && previous is ChatItem.User -> item.copy(quote = item.quote ?: previous.quote)
            else -> item
        }
    }
    return merged.values.sortedBy { when (it) { is ChatItem.User -> it.ts; is ChatItem.Assistant -> it.ts } }
}
