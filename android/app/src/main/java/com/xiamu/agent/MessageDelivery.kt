package com.xiamu.agent

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Selection order is stable; completing a send removes only its captured attachments. */
data class AttachmentDraft<T>(val items: List<T> = emptyList()) {
    fun add(values: List<T>) = copy(items = (items + values).distinct())
    fun remove(values: List<T>) = copy(items = items.filterNot { it in values })
}

data class FeedQuote(val path: String, val title: String, val emoji: String, val source: String) {
    fun json() = JSONObject().put("kind", "feed").put("path", path).put("title", title).put("emoji", emoji).put("source", source)
    companion object {
        fun from(post: FeedPost) = FeedQuote(post.path, post.title, post.icon, post.source)
        fun from(j: JSONObject?): FeedQuote? {
            if (j == null || j.optString("kind") != "feed") return null
            val path = j.optString("path")
            if (!isDataFile(path) || !path.startsWith("data/feed/") || j.optString("title").isBlank()) return null
            return FeedQuote(path, j.getString("title"), j.optString("emoji"), j.optString("source"))
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

data class OutgoingMessage(val text: String, val attachments: List<Attachment>, val clientId: String, val quote: FeedQuote? = null) {
    val path: String get() = if (quote == null) "/api/send" else "/api/feed/feedback"
    fun json(): JSONObject = JSONObject().put("clientId", clientId).put("text", text).apply {
        if (quote != null) { put("path", quote.path); put("action", "discuss") }
        else put("attachments", JSONArray(attachments.map { it.toJson() }))
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
