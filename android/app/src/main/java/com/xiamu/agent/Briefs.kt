package com.xiamu.agent

import org.json.JSONObject
import java.net.URI
import java.net.URLDecoder
import java.time.OffsetDateTime

/** Each card is the complete HTML document supplied by /api/briefs. */
data class HtmlBriefCard(val html: String)

/** The root attribute is inserted into the local response before the HTML parser runs. */
fun briefWithSkin(html: String, skin: Skin): String {
    val root = Regex("<html\\b([^>]*)>", RegexOption.IGNORE_CASE)
    require(root.containsMatchIn(html)) { "简报缺少 HTML 文档" }
    val match = root.find(html)!!
    val attributes = match.groupValues[1].replace(Regex("\\s+data-skin\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)", RegexOption.IGNORE_CASE), "")
    return html.replaceRange(match.range, "<html data-skin=\"${skin.id}\"$attributes>")
}

data class BriefDocument(val date: String, val name: String, val time: Long, val path: String, val cards: List<HtmlBriefCard>) {
    companion object {
        fun from(j: JSONObject): BriefDocument? = runCatching {
            val path = j.getString("path")
            require(isBriefPath(path))
            val cards = j.getJSONArray("cards").objects().map { HtmlBriefCard(it.getString("html")) }
            require(cards.size in 1..6 && cards.all { it.html.isNotBlank() })
            BriefDocument(j.getString("date"), j.getString("name"),
                OffsetDateTime.parse(j.getString("time")).toInstant().toEpochMilli(), path, cards)
        }.getOrNull()
    }
}

fun isBriefPath(path: String): Boolean = path.startsWith("data/briefs/") && path.endsWith(".html") &&
    path.split('/').none { it.isBlank() || it == "." || it == ".." } && !path.contains('\\')

/** All navigation is consumed. Only a main-frame prompt URL produces an App action. */
object BriefNavigation {
    fun prompt(url: String, mainFrame: Boolean = true): String? = runCatching {
        if (!mainFrame) return null
        val uri = URI(url)
        if (uri.scheme != "doudou" || uri.rawAuthority != "prompt" || !uri.rawPath.isNullOrEmpty() || uri.rawFragment != null) return null
        val fields = uri.rawQuery?.split('&') ?: return null
        if (fields.size != 1 || !fields[0].startsWith("text=")) return null
        URLDecoder.decode(fields[0].substringAfter('='), "UTF-8").takeIf { it.isNotBlank() }
    }.getOrNull()

    // Inline images remain usable; no file, content, app asset or network resource is allowed.
    fun inlineResource(url: String): Boolean = url.startsWith("data:", ignoreCase = true)
}

data class AvatarChoice(val shape: String = "bean", val palette: String = "mist") {
    companion object {
        val shapes = linkedMapOf("bean" to "豆子", "girl" to "女生", "boy" to "男生", "cat" to "猫")
        val palettes = linkedMapOf("mist" to "晨雾蓝", "dusk" to "暮光金", "mint" to "薄荷", "sakura" to "樱粉")
        fun from(j: JSONObject?) = AvatarChoice(j?.optString("shape")?.takeIf { it in shapes } ?: "bean", j?.optString("palette")?.takeIf { it in palettes } ?: "mist")
    }
}
