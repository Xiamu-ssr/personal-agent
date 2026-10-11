package com.xiamu.agent

import org.json.JSONObject
import java.time.OffsetDateTime

/** JSON briefs only. Invalid/missing blocks are omitted independently, never sent to a WebView. */
data class BriefDocument(val date: String, val name: String, val time: Long, val path: String, val cards: List<BriefCard>) {
    companion object {
        fun from(j: JSONObject): BriefDocument? {
            val path = j.optString("path")
            if (!path.startsWith("data/briefs/") || !path.endsWith(".json")) return null
            val brief = j.optJSONObject("brief") ?: return null
            if (brief.optInt("v") != 1) return null
            val cards = brief.optJSONArray("cards").objects().take(5).mapNotNull(BriefCard::from)
            if (cards.isEmpty()) return null
            val time = runCatching { OffsetDateTime.parse(j.optString("time").ifBlank { brief.optString("time") }).toInstant().toEpochMilli() }
                .getOrElse { j.optLong("time") }
            return BriefDocument(j.optString("date"), j.optString("name").ifBlank { brief.optString("name") }, time, path, cards)
        }
    }
}

data class BriefCard(val chip: String, val title: String, val summary: String, val blocks: List<BriefBlock>, val action: BriefAction?) {
    companion object {
        fun from(j: JSONObject): BriefCard? {
            val title = j.optString("title")
            if (title.isBlank()) return null
            val action = j.optJSONObject("action")?.let {
                val label = it.optString("label"); val prompt = it.optString("prompt")
                if (label.isBlank() || prompt.isBlank()) null else BriefAction(label, prompt)
            }
            return BriefCard(j.optString("chip"), title, j.optString("summary"), j.optJSONArray("blocks").objects().take(4).mapNotNull(BriefBlock::from), action)
        }
    }
}
data class BriefAction(val label: String, val prompt: String)
data class BriefPart(val primary: String, val text: String = "", val meta: String = "", val tone: String = "info", val unit: String = "", val delta: String = "")
data class BriefBlock(val type: String, val items: List<BriefPart> = emptyList(), val text: String = "") {
    companion object {
        fun from(j: JSONObject): BriefBlock? {
            val type = j.optString("type")
            if (type == "note") return j.optString("text").takeIf { it.isNotBlank() }?.let { BriefBlock(type, text = it) }
            val limit = when (type) { "timeline", "metrics" -> 4; "tiles" -> 3; "list" -> 6; else -> return null }
            val items = j.optJSONArray("items").objects().take(limit).mapNotNull {
                when (type) {
                    "timeline" -> if (it.optString("when").isBlank() || it.optString("label").isBlank()) null
                        else BriefPart(it.optString("label"), it.optString("text"), it.optString("when"))
                    "tiles" -> it.optString("title").takeIf(String::isNotBlank)?.let { title -> BriefPart(title, it.optString("text"), it.optString("tag"), it.optString("tone")) }
                    "metrics" -> if (!it.has("value") || it.isNull("value") || it.optString("label").isBlank()) null
                        else BriefPart(it.optString("value"), it.optString("label"), unit = it.optString("unit"), delta = it.optString("delta"))
                    else -> it.optString("text").takeIf(String::isNotBlank)?.let { text -> BriefPart(text, meta = it.optString("meta")) }
                }
            }
            return if (items.isEmpty()) null else BriefBlock(type, items)
        }
    }
}

data class AvatarChoice(val shape: String = "bean", val palette: String = "mist") {
    companion object {
        val shapes = linkedMapOf("bean" to "豆子", "girl" to "女生", "boy" to "男生", "cat" to "猫")
        val palettes = linkedMapOf("mist" to "晨雾蓝", "dusk" to "暮光金", "mint" to "薄荷", "sakura" to "樱粉")
        fun from(j: JSONObject?) = AvatarChoice(j?.optString("shape")?.takeIf { it in shapes } ?: "bean", j?.optString("palette")?.takeIf { it in palettes } ?: "mist")
    }
}
