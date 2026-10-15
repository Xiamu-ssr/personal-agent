package com.xiamu.agent

import org.json.JSONObject
import java.time.LocalDate

/** The 0.8 say contract; unsupported or invalid cards are omitted individually. */
data class SayOption(val id: String, val label: String, val reply: String)
sealed interface SayCard {
    data class Connector(val id: String) : SayCard
    data class Goal(val name: String) : SayCard
    data class Link(val url: String, val title: String, val description: String, val image: String?) : SayCard
    data class Media(val file: ReplyMedia) : SayCard
    data object Browser : SayCard
    data class Device(val capability: String?) : SayCard
}
private fun httpUrl(s: String): Boolean = runCatching { java.net.URI(s).let { it.scheme in setOf("http", "https") && !it.host.isNullOrBlank() && it.userInfo == null } }.getOrDefault(false)
fun sayCards(j: JSONObject): List<SayCard> = j.optJSONArray("cards").objects().take(20).mapNotNull { c ->
    when(c.optString("type")) {
        "connector" -> c.optString("id").takeIf(String::isNotBlank)?.let(SayCard::Connector)
        "goal" -> c.optString("name").takeIf(String::isNotBlank)?.let(SayCard::Goal)
        "link" -> c.optString("url").takeIf(::httpUrl)?.let { SayCard.Link(it, c.optString("title").ifBlank { it }, c.optString("description"), c.optString("image").takeIf(::httpUrl)) }
        "image", "video", "audio", "file" -> ReplyMedia.from(JSONObject(c.toString()).put("kind", c.getString("type")))?.let(SayCard::Media)
        "browser" -> SayCard.Browser
        "device" -> SayCard.Device(c.optString("capability").takeIf(String::isNotBlank))
        else -> null
    }
}.distinctBy { if(it is SayCard.Media) it.file.path else it }
fun sayOptions(j: JSONObject): List<SayOption> = j.optJSONArray("options").objects().take(12).mapNotNull {
    val id=it.optString("id"); val label=it.optString("label")
    if(id.isBlank() || label.isBlank()) null else SayOption(id,label,it.optString("reply").ifBlank { label })
}.distinctBy { it.id }

data class AvatarStatus(val state: String = "idle", val text: String = "") {
    companion object {
        val states = listOf("idle", "working", "waiting", "happy", "error")
        fun from(j: JSONObject?) = AvatarStatus(j?.optString("state")?.takeIf { it in states } ?: "idle", j?.optString("text").orEmpty())
    }
}

data class FeedPost(val path: String, val date: String, val title: String, val source: String, val url: String, val published: String, val icon: String, val image: String?, val body: String) {
    val showOriginalLink: Boolean get()=url.isNotBlank() && !feedBodyHasLink(body)
    companion object { fun from(j: JSONObject): FeedPost {
        val date=j.getString("date"); LocalDate.parse(date)
        val path=j.getString("path"); require(isDataFile(path) && path.startsWith("data/feed/"))
        return FeedPost(path,date,j.getString("title"),j.optString("source"),j.optString("url"),j.optString("published"),j.optString("icon").ifBlank { "📰" },j.optString("image").takeIf(::isDataFile),j.optString("body"))
    } }
}

/** Avoid a second source-link row when the body already offers a clickable web link. */
fun feedBodyHasLink(body: String): Boolean {
    val prose=body.replace(Regex("(?s)```.*?```|`[^`\\n]*`"),"")
    return Regex("""(?<!!)\[[^\]]+]\(\s*https?://[^)\s]+\s*\)""",RegexOption.IGNORE_CASE).containsMatchIn(prose)
}
data class FeedPage(val days: List<String>, val items: List<FeedPost>, val next: String?) {
    companion object { fun from(j: JSONObject) = FeedPage(j.optJSONArray("days").strings(),j.getJSONArray("items").objects().map(FeedPost::from),j.optString("next").takeIf { !j.isNull("next") && it.isNotBlank() }?.also { LocalDate.parse(it) }) }
}
data class FeedTimeline(val items: List<FeedPost> = emptyList(), val next: String? = null) {
    fun apply(page: FeedPage, older: Boolean): FeedTimeline {
        require(!older || next == null || page.next == null || page.next < next) { "动态分页游标没有前进" }
        return FeedTimeline((if(older) items + page.items else page.items).distinctBy { it.path }.sortedByDescending { it.path },page.next)
    }
}
/** Feed events are idempotent; being in the visible feed consumes new events immediately. */
class FeedInbox(unread: Boolean = false,known: Set<String> = emptySet()) {
    private val received = known.toCollection(linkedSetOf())
    val knownPaths: Set<String> get() = received.toSet()
    var unread = unread; private set
    var visible = false; private set
    fun enter() { visible=true; unread=false }
    fun leave() { visible=false }
    fun receive(paths: List<String>) {
        val fresh=paths.filter(String::isNotBlank).any { received.add(it) }
        paths.filter(String::isNotBlank).forEach { received.add(it) }
        while(received.size>1000) received.remove(received.first())
        if(fresh && !visible) unread=true
    }
}
data class FeedSettings(val enabled: Boolean, val interval: Int, val start: String, val end: String, val instructions: String) {
    fun json()=JSONObject().put("enabled",enabled).put("interval",interval).put("start",start).put("end",end).put("instructions",instructions)
    fun validate() { require(interval in listOf(15,30,60)); require(Regex("([01]\\d|2[0-3]):[0-5]\\d").matches(start) && Regex("([01]\\d|2[0-3]):[0-5]\\d").matches(end) && start != end) { "请填写不同的开始、结束时间（HH:MM）" }; require(instructions.length<=40000) { "动态说明最多 40000 字" } }
    companion object { fun from(j: JSONObject)=FeedSettings(j.getBoolean("enabled"),j.getInt("interval"),j.getString("start"),j.getString("end"),j.getString("instructions")) }
}
data class Idea(val id: String,val icon: String,val title: String,val description: String,val reply: String)
data class IdeaGroup(val name: String,val items: List<Idea>)
data class Ideas(val revision: String,val groups: List<IdeaGroup>) {
    companion object {
        fun from(j: JSONObject): Ideas {
            val groups=j.getJSONArray("groups").objects().map { group ->
                IdeaGroup(group.getString("name"),group.getJSONArray("items").objects().map { i ->
                    Idea(i.getString("id"),i.optString("icon"),i.getString("title"),i.optString("description"),i.getString("reply"))
                })
            }
            return Ideas(j.getString("revision"),groups)
        }
    }
}
data class Goal(val name: String,val path: String,val title: String,val domain: String,val cadence: String,val due: String?,val status: String,val progress: Int,val body: String,val nextCheckin: String?) {
    companion object {
        val domains=listOf("健康","人际","金融","事业","兴趣","效率","其他")
        fun from(j: JSONObject): Goal {
            val domain=j.getString("domain"); val status=j.getString("status"); val progress=j.getInt("progress")
            require(domain in domains && status in listOf("追踪中","暂停","完成","放弃") && progress in 0..100) { "目标格式不正确" }
            val path=j.getString("path"); require(isDataFile(path) && path.startsWith("data/goals/"))
            return Goal(j.getString("name"),path,j.getString("title"),domain,j.optString("cadence"),j.optString("due").takeIf { !j.isNull("due") && it.isNotBlank() },status,progress,j.optString("body"),j.optString("nextCheckin").takeIf { !j.isNull("nextCheckin") && it.isNotBlank() })
        }
    }
}
data class Artifact(val name: String,val path: String,val kind: String,val mtime: Long,val thumbnail: String?,val files: List<ReplyMedia>)
data class Library(val artifacts: List<Artifact>,val media: List<ReplyMedia>) {
    companion object { fun from(j: JSONObject)=Library(j.optJSONArray("artifacts").objects().sortedByDescending { it.optLong("mtime") }.map { Artifact(it.getString("name"),it.optString("path"),it.getString("kind"),it.optLong("mtime"),it.optString("thumbnail").takeIf { t -> t.startsWith("/api/library/thumbnail?") },it.optJSONArray("files").objects().mapNotNull(ReplyMedia::from)) },j.optJSONArray("media").objects().sortedByDescending { it.optLong("mtime") }.mapNotNull(ReplyMedia::from)) }
}
