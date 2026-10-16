package com.xiamu.agent

import org.json.JSONObject

data class SideChatEntry(val id: String,val title: String,val status: ActivityStatus,val time: Long)

fun sideChatEntries(timeline: ActivitiesTimeline): List<SideChatEntry> =
    (timeline.running.filter { it.chatType=="side" }.map { SideChatEntry(it.id,it.label,ActivityStatus.Running,it.started) } +
        timeline.recent.filter { it.chatType=="side" }.map { SideChatEntry(it.id,it.title,it.status,it.ts) })
        .distinctBy { it.id }.sortedByDescending { it.time }

data class SideChatHistory(val id: String,val title: String,val status: ActivityStatus,val messages: List<ChatItem>) {
    companion object {
        fun from(j: JSONObject): SideChatHistory {
            val id=j.getString("id")
            require(id.isNotBlank() && j.optString("chatType")=="side") { "这不是旁聊记录" }
            val messages=j.getJSONArray("messages").objects().mapNotNull { m ->
                require(m.optString("activityId")==id && m.optString("chatType")=="side" && m.optString("id").isNotBlank()) { "旁聊消息归属不一致" }
                historyItem(m)
            }
            return SideChatHistory(id,j.getString("title"),ActivityStatus.from(j.getString("status")),messages)
        }
    }
}

/** Main chat events have no side scope, including options_used from the main chat. */
fun sideChatEventId(event: JSONObject): String? = event.optString("activityId").takeIf {
    it.isNotBlank() && event.optString("chatType")=="side"
}

fun createdSideChatId(result: JSONObject): String {
    require(result.optBoolean("ok") && result.optString("chatType")=="side" && result.optString("id").isNotBlank()) { "新旁聊未创建成功" }
    return result.getString("id")
}

/** Merge an HTTP snapshot with messages already received on WS while that request was in flight. */
fun mergeSideMessages(history: List<ChatItem>,live: List<ChatItem>): List<ChatItem> {
    return mergeChatMessages(history,live)
}
