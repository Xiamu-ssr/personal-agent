package com.xiamu.agent.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.automirrored.outlined.Article
import androidx.compose.material.icons.outlined.AccountBalanceWallet
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.AutoMode
import androidx.compose.material.icons.outlined.Badge
import androidx.compose.material.icons.outlined.Cake
import androidx.compose.material.icons.outlined.CheckCircleOutline
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.FavoriteBorder
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.KeyboardVoice
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Newspaper
import androidx.compose.material.icons.outlined.People
import androidx.compose.material.icons.outlined.RateReview
import androidx.compose.material.icons.automirrored.outlined.ReceiptLong
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.SettingsSuggest
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material.icons.outlined.WorkOutline
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xiamu.agent.Api
import com.xiamu.agent.Chat
import com.xiamu.agent.Running
import com.xiamu.agent.objects
import com.xiamu.agent.strings
import kotlinx.coroutines.delay
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.Date

@Composable
private fun SettingsButton() = CircleButton(Icons.Outlined.Settings, "设置") { Nav.open(Route.Settings) }

private data class Job(val id: String, val name: String, val cron: String, val kind: String, val enabled: Boolean)

private suspend fun schedule(): List<Job> = Api.getJson("/api/state").optJSONArray("schedule").objects().map {
    Job(it.optString("id"), it.optString("name").ifBlank { it.optString("id") }, it.optString("cron"), it.optString("kind"), it.optBoolean("enabled", true))
}

/** "30 7 * * *" → 每天 7:30, "0 20 * * 0" → 每周日 20:00, "0 9 * * 1-5" → 工作日 9:00 … */
fun cronLabel(c: String): String {
    val p = c.trim().split(Regex("\\s+"))
    if (p.size != 5) return c
    val (mi, h, dom, mon, dow) = p
    val num = Regex("\\d+")
    if (mi.startsWith("*/") && h == "*") return "每 ${mi.drop(2)} 分钟"
    if (mi.matches(num) && h.startsWith("*/")) return "每 ${h.drop(2)} 小时"
    if (mi.matches(num) && h == "*") return "每小时第 $mi 分"
    if (!mi.matches(num) || !h.matches(Regex("\\d+(,\\d+)*"))) return c
    val time = h.split(",").joinToString("、") { "%d:%02d".format(it.toInt(), mi.toInt()) }
    val names = "日一二三四五六日"
    val week = when {
        dow == "*" -> null
        dow == "1-5" -> "工作日"
        dow in setOf("0,6", "6,0", "6,7", "6-7") -> "周末"
        dow.matches(Regex("[0-7](,[0-7])*")) -> "每周" + dow.split(",").joinToString("、") { names[it.toInt()].toString() }
        else -> return c
    }
    return when {
        dom == "*" && mon == "*" && week == null -> "每天 $time"
        dom == "*" && mon == "*" -> "$week $time"
        dom.matches(num) && mon == "*" && week == null -> "每月 $dom 日 $time"
        dom.matches(num) && mon.matches(num) && week == null -> "每年 $mon 月 $dom 日 $time"
        else -> c
    }
}

// ---------- 今日 ----------

private data class Brief(val day: String, val name: String, val mtime: Long, val title: String?) {
    val path get() = "data/briefs/$day/$name"
    val label get() = title ?: name.removeSuffix(".html")
}

private data class Today(val briefs: List<Brief>, val sites: List<Api.Entry>, val morning: String)

@Composable
fun TodayScreen(bottom: Dp) {
    val c = ctx()
    val scope = rememberCoroutineScope()
    val (data, err) = load("today") { coroutineScope {
        // Job cards carry nicer titles ("晚报 · 10/08：…") than the file names.
        val titles = async { runCatching {
            Api.getJson("/api/jobs").optJSONArray("recent").objects().flatMap { j -> j.optJSONArray("outputs").strings().map { it to j.optString("title") } }.toMap()
        }.getOrDefault(emptyMap()) }
        val sites = async { Api.treeOrEmpty("data/sites").filter { it.dir } }
        val morning = async { runCatching { schedule().firstOrNull { it.name.contains("晨报") }?.let { "${it.name} ${cronLabel(it.cron).removePrefix("每天 ")}" } }.getOrNull() }
        val days = Api.treeOrEmpty("data/briefs").filter { it.dir }.sortedByDescending { it.name }.take(8)
        val briefs = days.map { d -> async {
            Api.treeOrEmpty("data/briefs/${d.name}").filter { !it.dir && it.name.endsWith(".html") }
                .map { Brief(d.name, it.name, it.mtime, titles.await()["data/briefs/${d.name}/${it.name}"]?.ifBlank { null }) }
        } }.awaitAll().flatten()
        Today(briefs, sites.await(), morning.await() ?: "晨报 7:30")
    } }
    val today = ymd.format(Date())
    LazyColumn(contentPadding = pagePadding(bottom)) {
        item { PageHeader("今日", dateWeek()) { SettingsButton() } }
        when {
            data == null && err.isNotBlank() -> item { ErrorNote(err) }
            data == null -> item { Loading() }
            else -> {
                val todays = data.briefs.filter { it.day == today }
                val latest = todays.firstOrNull()
                item {
                    Column(
                        Modifier.padding(top = 12.dp).fillMaxWidth().card(radius = 24.dp)
                            .tap(latest != null) { Nav.open(Route.Web(latest!!.label, latest.path)) }.padding(22.dp),
                    ) {
                        Text("最新简报", fontSize = 12.sp, color = Pal.Muted)
                        if (latest != null) {
                            Text(latest.label, fontSize = 19.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold, color = Pal.Ink,
                                modifier = Modifier.padding(top = 10.dp))
                            Text("${latest.name.removeSuffix(".html")} · ${clock(latest.mtime)} 生成", fontSize = 13.sp, color = Pal.Muted,
                                modifier = Modifier.padding(top = 6.dp))
                            Row(Modifier.padding(top = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text("打开简报", fontSize = 13.sp, color = Pal.Link)
                                Icon(Icons.AutoMirrored.Outlined.ArrowForward, null, tint = Pal.Link, modifier = Modifier.padding(start = 6.dp).size(14.dp))
                            }
                        } else {
                            Text("今天还没有简报", fontSize = 19.sp, fontWeight = FontWeight.SemiBold, color = Pal.Ink, modifier = Modifier.padding(top = 10.dp))
                            Text(data.morning + " 会送到这里", fontSize = 13.sp, color = Pal.Muted, modifier = Modifier.padding(top = 6.dp))
                        }
                    }
                }
                if (todays.size > 1) {
                    item { SectionTitle("今天的简报") }
                    item { BriefList(todays) }
                }
                val earlier = data.briefs.filter { it.day != today }.groupBy { it.day }.entries.take(7)
                if (earlier.isNotEmpty()) {
                    item { SectionTitle("最近") }
                    earlier.forEach { (day, list) ->
                        item { Text(dayTitle(day), fontSize = 12.sp, color = Pal.Muted, modifier = Modifier.padding(start = 4.dp, top = 6.dp, bottom = 8.dp)) }
                        item { BriefList(list); Spacer(Modifier.height(8.dp)) }
                    }
                }
                item { SectionTitle("站点") }
                item {
                    if (data.sites.isEmpty()) EmptyNote("还没有站点。让豆豆帮你做个页面试试，比如「做个记账图表」。", Modifier.padding(horizontal = 4.dp))
                    else CardList {
                        data.sites.forEachIndexed { i, s ->
                            if (i > 0) Hairline()
                            ListRow(s.name, "更新于 " + whenLabel(s.mtime), Icons.Outlined.Language, Color(0xFF478AA8)) {
                                scope.launch { openFile(c, "data/sites/${s.name}/index.html", s.name) }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun BriefList(list: List<Brief>) {
    CardList {
        list.forEachIndexed { i, b ->
            if (i > 0) Hairline()
            ListRow(b.label, "${b.name.removeSuffix(".html")} · ${clock(b.mtime)}", Icons.AutoMirrored.Outlined.Article, Color(0xFF4A77A0), subLines = 1) {
                Nav.open(Route.Web(b.label, b.path))
            }
        }
    }
}

// ---------- 任务 ----------

private data class Suggestion(val title: String, val sub: String, val icon: ImageVector, val ask: String, val key: String)

private val suggestions = listOf(
    Suggestion("每日新闻速览", "每天早上挑 5 条你可能关心的新闻", Icons.Outlined.Newspaper,
        "帮我加一个定时任务：每天早上 8 点给我一份新闻速览，挑 5 条我可能关心的", "新闻"),
    Suggestion("每周开销小结", "每周日晚上按短信里的消费记录汇总", Icons.AutoMirrored.Outlined.ReceiptLong,
        "帮我加一个定时任务：每周日 21:00 根据短信里的消费记录做一份本周开销小结", "开销"),
    Suggestion("生日提醒", "记忆里谁快过生日了，提前一天告诉你", Icons.Outlined.Cake,
        "帮我加一个定时任务：每天早上看看记忆里有没有明天过生日的人，有就提醒我", "生日"),
)

@Composable
fun TasksScreen(bottom: Dp) {
    val c = ctx()
    val scope = rememberCoroutineScope()
    var seg by rememberSaveable { mutableIntStateOf(0) }
    var toast by remember { mutableStateOf("") }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        Chat.refreshRunning()
        while (true) { delay(1000); now = System.currentTimeMillis() }
    }
    LaunchedEffect(toast) { if (toast.isNotBlank()) { delay(4000); toast = "" } }
    val (recent, rerr) = load("jobs", cacheValue = false) { Api.getJson("/api/jobs").optJSONArray("recent").objects() }
    val (jobs, jerr) = load("schedule", cacheValue = false) { schedule() }
    LazyColumn(contentPadding = pagePadding(bottom)) {
        item { PageHeader("任务") { SettingsButton() } }
        item { SegTabs(listOf("进行中", "已完成", "定时"), seg, Modifier.padding(top = 4.dp, bottom = 12.dp)) { seg = it } }
        when (seg) {
            0 -> item {
                val running = Chat.running.toList() + Chat.tasks.map { Running("task:${it.id}", it.description, it.startedAt) }
                if (running.isEmpty() && Chat.jobsLoading.value) Loading()
                else if (running.isEmpty() && Chat.jobsError.value.isNotBlank()) ErrorNote(Chat.jobsError.value)
                else if (running.isEmpty()) Box(Modifier.fillMaxWidth().card().padding(horizontal = 20.dp)) { EmptyNote("现在没有在跑的任务") }
                else CardList {
                    running.forEachIndexed { i, r ->
                        if (i > 0) Hairline()
                        ListRow(r.label, "进行中 · 已运行 ${elapsed(r.started, now)}", if (r.id.startsWith("job:")) Icons.Outlined.Schedule else Icons.Outlined.Sync,
                            Color(0xFF697DA2), trailing = {
                                val task = Chat.tasks.firstOrNull { "task:${it.id}" == r.id }
                                if (task != null) TaskStopButton(task)
                                else CircularProgressIndicator(Modifier.size(16.dp), color = Pal.Gold, strokeWidth = 2.dp)
                            })
                        Chat.tasks.firstOrNull { "task:${it.id}" == r.id }?.error?.takeIf { it.isNotBlank() }?.let {
                            Text(it, fontSize = 11.sp, color = Pal.Danger, modifier = Modifier.padding(start = 70.dp, end = 20.dp, bottom = 12.dp))
                        }
                    }
                }
            }
            1 -> item {
                when {
                    recent == null && rerr.isNotBlank() -> ErrorNote(rerr)
                    recent == null -> Loading()
                    recent.isEmpty() -> Box(Modifier.fillMaxWidth().card().padding(horizontal = 20.dp)) { EmptyNote("还没有完成的任务") }
                    else -> CardList {
                        recent.forEachIndexed { i, j ->
                            if (i > 0) Hairline()
                            val ok = j.optBoolean("ok")
                            val out = j.optJSONArray("outputs").strings().firstOrNull()
                            ListRow(
                                j.optString("title").ifBlank { j.optString("label") },
                                "${j.optString("label")} · ${whenLabel(j.optLong("ts"))} · ${if (ok) "完成" else "出错"}",
                                if (ok) Icons.Outlined.CheckCircleOutline else Icons.Outlined.ErrorOutline,
                                if (ok) Color(0xFF527C80) else Pal.Danger,
                                onClick = out?.let { { scope.launch { openFile(c, it, j.optString("label")) } } },
                            )
                        }
                    }
                }
            }
            else -> item {
                when {
                    jobs == null && jerr.isNotBlank() -> ErrorNote(jerr)
                    jobs == null -> Loading()
                    jobs.isEmpty() -> Box(Modifier.fillMaxWidth().card().padding(horizontal = 20.dp)) { EmptyNote("还没有定时任务") }
                    else -> CardList {
                        jobs.forEachIndexed { i, j ->
                            if (i > 0) Hairline()
                            val system = j.kind == "compact" || j.kind == "cleanup"
                            ListRow(
                                j.name, cronLabel(j.cron) + if (!j.enabled) " · 已暂停" else "",
                                if (system) Icons.Outlined.SettingsSuggest else Icons.Outlined.Schedule,
                                if (system) Pal.Faint else Color(0xFF697DA2),
                                trailing = {
                                    if (system || j.kind.isNotBlank()) Tag("系统任务")
                                    else QuietButton("立即运行") {
                                        scope.launch {
                                            toast = runCatching { Api.postJson("/api/run", JSONObject().put("id", j.id)); "「${j.name}」开始跑了，好了会出现在聊天和今日里" }
                                                .getOrElse { "没跑起来：${it.message}" }
                                            Chat.refreshRunning()
                                        }
                                    }
                                },
                            )
                        }
                    }
                }
            }
        }
        if (toast.isNotBlank()) item { Text(toast, fontSize = 13.sp, color = Pal.GoldInk, modifier = Modifier.padding(start = 4.dp, top = 12.dp)) }
        val names = jobs.orEmpty().joinToString(" ") { it.name }
        val recs = suggestions.filter { !names.contains(it.key) }
        if (recs.isNotEmpty()) {
            item { SectionTitle("为你推荐", Modifier.padding(top = 8.dp)) }
            item {
                CardList {
                    recs.forEachIndexed { i, s ->
                        if (i > 0) Hairline()
                        ListRow(s.title, s.sub, s.icon, Color(0xFF96734F)) { Draft.send(c, s.ask, includeDraft = false) }
                    }
                }
            }
        }
        item { FooterNote("想加或改定时任务，直接在聊天里跟豆豆说。") }
    }
}

// ---------- 记忆 ----------

private class Category(val dir: String, val name: String, val icon: ImageVector, val tint: Color)

private val categories = listOf(
    Category("work", "工作", Icons.Outlined.WorkOutline, Color(0xFF417DAC)),
    Category("project", "项目", Icons.Outlined.Folder, Color(0xFF428B94)),
    Category("life", "生活", Icons.Outlined.Home, Color(0xFF9F7E51)),
    Category("health", "健康", Icons.Outlined.FavoriteBorder, Color(0xFFC36577)),
    Category("people", "人际", Icons.Outlined.People, Color(0xFF597AC0)),
    Category("preferences", "偏好", Icons.Outlined.Tune, Color(0xFF7E6BA5)),
    Category("interests", "兴趣", Icons.Outlined.AutoAwesome, Color(0xFFA06C8E)),
    Category("finance", "财务", Icons.Outlined.AccountBalanceWallet, Color(0xFF4E79A3)),
    Category("feedback", "反馈", Icons.Outlined.RateReview, Color(0xFF4E79A3)),
    Category("history", "历史", Icons.Outlined.History, Color(0xFF4E79A3)),
    Category("automation-prefs", "自动化偏好", Icons.Outlined.AutoMode, Color(0xFF4E79A3)),
    Category("voice-notes", "语音笔记", Icons.Outlined.KeyboardVoice, Color(0xFF4E79A3)),
    Category("role", "角色", Icons.Outlined.Badge, Color(0xFF4E79A3)),
)

private fun category(dir: String) = categories.firstOrNull { it.dir == dir } ?: Category(dir, dir, Icons.Outlined.Folder, Color(0xFF4E79A3))

private const val PROFILE = "data/memory/profile/总档.md"

@Composable
fun MemoryScreen(bottom: Dp) {
    val (profile, perr) = load("profile") {
        try {
            Api.readFile(PROFILE)
        } catch (e: Api.ApiError) {
            if (e.code == 404) "" else throw e
        }
    }
    val (cats, cerr) = load("memcats") { coroutineScope {
        Api.treeOrEmpty("data/memory").filter { it.dir && it.name != "profile" }
            .map { async { it.name to Api.treeOrEmpty("data/memory/${it.name}").count { e -> !e.dir } } }.awaitAll()
            .filter { it.second > 0 }
            .sortedBy { (d, _) -> categories.indexOfFirst { it.dir == d }.let { if (it < 0) 99 else it } }
    } }
    var expanded by rememberSaveable { mutableStateOf(false) }
    LazyColumn(contentPadding = pagePadding(bottom)) {
        item { PageHeader("记忆") { SettingsButton() } }
        item { SectionTitle("我对你的了解", Modifier.padding(top = 0.dp)) }
        item {
            Column(Modifier.fillMaxWidth().card(radius = 24.dp).padding(horizontal = 20.dp, vertical = 18.dp)) {
                when {
                    profile == null && perr.isNotBlank() -> ErrorNote(perr)
                    profile == null -> Loading()
                    profile.isBlank() -> EmptyNote("还是空的，聊得越多越完整")
                    else -> {
                        val lines = profile.lines()
                        val updated = lines.firstOrNull { it.startsWith("更新") }
                        val body = lines.filterNot { it == updated || it.trim() == "# 我对你的了解" }
                        val bullets = body.indices.filter { body[it].trimStart().startsWith("- ") }
                        val cut = if (!expanded && bullets.size > 4) bullets[4] else body.size
                        if (updated != null) Text(updated.replace("：", " "), fontSize = 11.sp, color = Pal.Faint, modifier = Modifier.padding(bottom = 8.dp))
                        Markdown(body.take(cut).joinToString("\n"), fontSize = 14, color = Color(0xFF3A4757)) { Nav.open(memoryDoc(it)) }
                        if (bullets.size > 4) {
                            Text(
                                if (expanded) "收起" else "展开全部 ${bullets.size} 条", fontSize = 13.sp, color = Pal.Link,
                                modifier = Modifier.padding(top = 10.dp).tap { expanded = !expanded },
                            )
                        }
                    }
                }
            }
        }
        item { SectionTitle("分类") }
        when {
            cats == null && cerr.isNotBlank() -> item { ErrorNote(cerr) }
            cats == null -> item { Loading() }
            cats.isEmpty() -> item { EmptyNote("豆豆还没有分门别类记下什么", Modifier.padding(horizontal = 4.dp)) }
            else -> items(cats.chunked(2)) { pair ->
                Row(Modifier.padding(bottom = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    pair.forEach { (dir, n) ->
                        val cat = category(dir)
                        Column(
                            Modifier.weight(1f).heightIn(min = 124.dp).card(radius = 22.dp, color = Color(0xB8FBFCFE))
                                .tap { Nav.open(Route.MemoryCategory(dir)) }.padding(18.dp),
                        ) {
                            IconTile(cat.icon, cat.tint, 40.dp)
                            Spacer(Modifier.weight(1f).height(16.dp))
                            Text(cat.name, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, color = Pal.Ink, modifier = Modifier.padding(top = 14.dp))
                            Text("$n 项", fontSize = 12.sp, color = Pal.Muted, modifier = Modifier.padding(top = 3.dp))
                        }
                    }
                    if (pair.size == 1) Spacer(Modifier.weight(1f))
                }
            }
        }
    }
}

@Composable
fun MemoryCategoryScreen(dir: String) {
    val c = ctx()
    val scope = rememberCoroutineScope()
    val cat = category(dir)
    val (files, err) = load("mem:$dir") { Api.treeOrEmpty("data/memory/$dir").filter { !it.dir } }
    SubPage(cat.name) {
        item { BigTitle(cat.name, files?.let { "${it.size} 项" }) }
        item {
            when {
                files == null && err.isNotBlank() -> ErrorNote(err)
                files == null -> Loading()
                files.isEmpty() -> EmptyNote("这里还是空的")
                else -> CardList(Modifier.padding(top = 8.dp)) {
                    files.forEachIndexed { i, f ->
                        if (i > 0) Hairline()
                        ListRow(f.name.removeSuffix(".md"), "更新于 " + whenLabel(f.mtime), cat.icon, cat.tint) {
                            if (f.name.endsWith(".md")) Nav.open(memoryDoc("$dir/${f.name}"))
                            else scope.launch { openFile(c, "data/memory/$dir/${f.name}", f.name) }
                        }
                    }
                }
            }
        }
    }
}

// ---------- 豆豆 ----------

private data class Diary(val day: String, val title: String, val excerpt: String) {
    val path get() = "data/diary/$day.md"
}

private fun parseDiary(day: String, text: String): Diary {
    val lines = text.lines().map { it.trim() }.filter { it.isNotBlank() }
    val title = lines.firstOrNull()?.trimStart('#', ' ')?.ifBlank { null } ?: day
    val excerpt = lines.drop(1).filterNot { it.startsWith("#") }.joinToString(" ") { it.trimStart('-', '*', '>', ' ').replace("**", "") }
    return Diary(day, title, excerpt.take(90))
}

private suspend fun diaries(n: Int): List<Diary> = coroutineScope {
    Api.treeOrEmpty("data/diary").filter { !it.dir && it.name.endsWith(".md") }.sortedByDescending { it.name }.take(n).map {
        val day = it.name.removeSuffix(".md")
        async { parseDiary(day, Api.readFile("data/diary/${it.name}")) }
    }.awaitAll()
}

@Composable
fun DouScreen(bottom: Dp) {
    val (first, _) = load("firstChat") { Api.firstChatTime() ?: -1L }
    val (recent, err) = load("diaries:6") { diaries(6) }
    val (night, _) = load("schedule") { schedule() }
    val diaryTime = night?.firstOrNull { it.id == "night" }?.let { cronLabel(it.cron).removePrefix("每天 ") } ?: "22:30"
    LazyColumn(contentPadding = pagePadding(bottom)) {
        item {
            Row(Modifier.fillMaxWidth().statusBarsPadding().padding(top = 18.dp), horizontalArrangement = Arrangement.End) { SettingsButton() }
        }
        item {
            Column(Modifier.fillMaxWidth().padding(bottom = 18.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Avatar(116.dp, Modifier.shadow(18.dp, androidx.compose.foundation.shape.CircleShape, ambientColor = Color(0x407D8FA6), spotColor = Color(0x407D8FA6)))
                Text("豆豆", fontSize = 26.sp, fontWeight = FontWeight.Bold, color = Pal.Ink, modifier = Modifier.padding(top = 22.dp))
                val days = first?.takeIf { it > 0 }?.let { dayDiff(it) }
                Text(
                    when {
                        days == null -> "从第一次对话开始，慢慢了解你"
                        days == 0 -> "从今天第一次对话开始，慢慢了解你"
                        else -> "从 $days 天前第一次对话开始，慢慢了解你"
                    },
                    fontSize = 13.sp, color = Pal.Muted, modifier = Modifier.padding(top = 8.dp),
                )
            }
        }
        item {
            SectionTitle("最近的日记") {
                if (!recent.isNullOrEmpty()) Text("查看所有日记", fontSize = 13.sp, color = Pal.Link, modifier = Modifier.tap { Nav.open(Route.Diaries) })
            }
        }
        item {
            when {
                recent == null && err.isNotBlank() -> ErrorNote(err)
                recent == null -> Loading()
                recent.isEmpty() -> Box(Modifier.fillMaxWidth().card().padding(horizontal = 20.dp)) { EmptyNote("豆豆每晚 $diaryTime 写一篇日记") }
                else -> LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    items(recent) { d -> DiaryCard(d, Modifier.fillParentMaxWidth(0.8f)) }
                }
            }
        }
        item { SectionTitle("豆豆的设定") }
        item {
            CardList {
                ListRow("角色设定", "豆豆是谁、怎么说话、怎么做事", Icons.Outlined.Badge, Color(0xFF637DA0)) { Nav.open(memoryDoc("role/角色.md")) }
            }
        }
    }
}

@Composable
private fun DiaryCard(d: Diary, modifier: Modifier = Modifier) {
    Column(
        modifier.heightIn(min = 156.dp).card(radius = 22.dp).tap { Nav.open(Route.Doc(dayTitle(d.day), d.path)) }.padding(20.dp),
    ) {
        Text(dayTitle(d.day), fontSize = 11.sp, color = Pal.Faint)
        Text(d.title, fontSize = 15.sp, lineHeight = 23.sp, fontWeight = FontWeight.SemiBold, color = Pal.Ink, maxLines = 2, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = 12.dp))
        if (d.excerpt.isNotBlank()) {
            Text(d.excerpt, fontSize = 13.sp, lineHeight = 20.sp, color = Pal.Muted, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 8.dp))
        }
    }
}

@Composable
fun DiariesScreen() {
    val (list, err) = load("diaryFiles") { Api.treeOrEmpty("data/diary").filter { !it.dir && it.name.endsWith(".md") }.sortedByDescending { it.name } }
    SubPage("日记") {
        item { BigTitle("豆豆的日记", "每晚整理完记忆后写一篇") }
        when {
            list == null && err.isNotBlank() -> item { ErrorNote(err) }
            list == null -> item { Loading() }
            list.isEmpty() -> item { EmptyNote("还没有日记") }
            else -> items(list, key = { it.name }) { file ->
                val day = file.name.removeSuffix(".md")
                val (text, readError) = load("diary:$day") { Api.readFile("data/diary/${file.name}") }
                when {
                    text != null -> DiaryCard(parseDiary(day, text), Modifier.fillMaxWidth().padding(top = 12.dp))
                    readError.isNotBlank() -> ErrorNote(readError)
                    else -> Loading()
                }
            }
        }
        item { Spacer(Modifier.width(1.dp)) }
    }
}
