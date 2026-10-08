package com.xiamu.agent.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xiamu.agent.Api
import com.xiamu.agent.Chat
import kotlinx.coroutines.launch
import org.json.JSONObject

/** Load something from the server; reload when data/ changes. */
@Composable
private fun <T> load(key: Any, block: suspend () -> T): Pair<T?, String> {
    var value by remember(key) { mutableStateOf<T?>(null) }
    var err by remember(key) { mutableStateOf("") }
    LaunchedEffect(key, Chat.filesVersion.value) {
        runCatching { block() }.onSuccess { value = it; err = "" }.onFailure { err = it.message ?: "出错了" }
    }
    return value to err
}

@Composable
private fun Row2(title: String, sub: String = "", onClick: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.surface, shape = RoundedCornerShape(12.dp),
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
    ) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(title, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (sub.isNotBlank()) Text(sub, fontSize = 12.sp, color = MaterialTheme.colorScheme.outline, maxLines = 2)
            }
            Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null, tint = MaterialTheme.colorScheme.outline)
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(text, fontSize = 13.sp, color = MaterialTheme.colorScheme.outline, modifier = Modifier.padding(top = 8.dp, bottom = 2.dp))
}

private val listPad = androidx.compose.foundation.layout.PaddingValues(14.dp)

// ---------- 看板 ----------

@Composable
fun BoardScreen(open: (Page) -> Unit) {
    var sub by rememberSaveable { mutableIntStateOf(0) }
    Column(Modifier.fillMaxSize()) {
        TabRow(selectedTabIndex = sub, containerColor = MaterialTheme.colorScheme.background) {
            Tab(sub == 0, { sub = 0 }, text = { Text("简报") })
            Tab(sub == 1, { sub = 1 }, text = { Text("站点") })
        }
        if (sub == 0) Briefs(open) else Sites(open)
    }
}

private data class Brief(val date: String, val name: String, val mtime: Long)

@Composable
private fun Briefs(open: (Page) -> Unit) {
    val (briefs, err) = load("briefs") {
        Api.tree("data/briefs").filter { it.dir }.take(14).flatMap { d ->
            Api.tree("data/briefs/${d.name}").filter { !it.dir && it.name.endsWith(".html") }.map { Brief(d.name, it.name, it.mtime) }
        }
    }
    LazyColumn(contentPadding = listPad, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        when {
            err.isNotBlank() -> item { Empty(err) }
            briefs == null -> item { Loading() }
            briefs.isEmpty() -> item { Empty("还没有简报。\n晨报每天 7:30 生成。") }
            else -> briefs.groupBy { it.date }.forEach { (date, list) ->
                item { SectionTitle(date) }
                items(list) { b ->
                    val title = b.name.removeSuffix(".html")
                    Row2(title, timeLabel(b.mtime)) { open(Page.Web("$title · ${b.date}", "data/briefs/${b.date}/${b.name}")) }
                }
            }
        }
    }
}

@Composable
private fun Sites(open: (Page) -> Unit) {
    val (sites, err) = load("sites") { Api.tree("data/sites").filter { it.dir } }
    LazyColumn(contentPadding = listPad, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        when {
            err.isNotBlank() -> item { Empty(err) }
            sites == null -> item { Loading() }
            sites.isEmpty() -> item { Empty("还没有站点。\n让豆豆帮你做个页面试试，比如「做个记账图表」。") }
            else -> items(sites) { s -> Row2(s.name, "更新于 " + timeLabel(s.mtime)) { open(Page.Web(s.name, "data/sites/${s.name}")) } }
        }
    }
}

// ---------- 任务 ----------

private data class Job(val id: String, val name: String, val cron: String, val kind: String)

private fun cronLabel(c: String): String {
    val p = c.trim().split(Regex("\\s+"))
    if (p.size != 5) return c
    val time = if (p[0].all { it.isDigit() } && p[1].all { it.isDigit() }) "%s:%02d".format(p[1], p[0].toInt()) else "${p[1]}时${p[0]}分"
    val days = listOf("周日", "周一", "周二", "周三", "周四", "周五", "周六")
    return when {
        p[2] == "*" && p[4] == "*" -> "每天 $time"
        p[4].all { it.isDigit() } -> "每${days[p[4].toInt() % 7].drop(1).let { "周$it" }} $time"
        else -> c
    }
}

@Composable
fun TasksScreen() {
    val scope = rememberCoroutineScope()
    var toast by remember { mutableStateOf("") }
    val (jobs, err) = load("state") {
        val arr = Api.getJson("/api/state").getJSONArray("schedule")
        (0 until arr.length()).map {
            val j: JSONObject = arr.getJSONObject(it)
            Job(j.optString("id"), j.optString("name"), j.optString("cron"), j.optString("kind"))
        }
    }
    LazyColumn(contentPadding = listPad, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (Chat.activities.isNotEmpty()) {
            item { SectionTitle("最近") }
            items(Chat.activities.take(8)) { a ->
                Surface(color = MaterialTheme.colorScheme.surface, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(14.dp)) {
                        Text(a.label, fontWeight = FontWeight.Medium)
                        Text((if (a.done) "完成 · " else "进行中 · ") + a.detail, fontSize = 12.sp, color = MaterialTheme.colorScheme.outline)
                    }
                }
            }
        }
        item { SectionTitle("定时") }
        when {
            err.isNotBlank() -> item { Empty(err) }
            jobs == null -> item { Loading() }
            else -> items(jobs) { j ->
                Surface(color = MaterialTheme.colorScheme.surface, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(j.name, fontWeight = FontWeight.Medium)
                            Text(cronLabel(j.cron), fontSize = 12.sp, color = MaterialTheme.colorScheme.outline)
                        }
                        if (j.kind.isBlank()) {
                            AssistChip(
                                onClick = {
                                    scope.launch {
                                        toast = runCatching { Api.postJson("/api/run", JSONObject().put("id", j.id)); "${j.name} 开始跑了，好了会出现在聊天和看板里" }
                                            .getOrElse { it.message ?: "失败" }
                                    }
                                },
                                label = { Text("现在跑") },
                                leadingIcon = { Icon(Icons.Outlined.PlayArrow, null) },
                            )
                        }
                    }
                }
            }
        }
        if (toast.isNotBlank()) item { Text(toast, fontSize = 12.sp, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(4.dp)) }
        item {
            Text("想加或改定时任务，直接在聊天里跟豆豆说。", fontSize = 12.sp, color = MaterialTheme.colorScheme.outline, modifier = Modifier.padding(top = 12.dp))
        }
    }
}

// ---------- 记忆 ----------

private val categoryNames = mapOf(
    "profile" to "总档", "people" to "人", "preferences" to "偏好", "life" to "生活", "work" to "工作", "project" to "项目",
    "interests" to "兴趣", "history" to "历史", "health" to "健康", "finance" to "财务", "feedback" to "反馈",
    "automation-prefs" to "自动化偏好", "role" to "角色", "voice-notes" to "语音笔记",
)

@Composable
fun MemoryScreen(open: (Page) -> Unit) {
    var category by rememberSaveable { mutableStateOf<String?>(null) }
    val cat = category
    if (cat != null) {
        androidx.activity.compose.BackHandler { category = null }
        val (files, err) = load("mem:$cat") { Api.tree("data/memory/$cat").filter { !it.dir } }
        LazyColumn(contentPadding = listPad, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item {
                Text("‹ ${categoryNames[cat] ?: cat}", fontWeight = FontWeight.SemiBold, fontSize = 17.sp,
                    modifier = Modifier.clickable { category = null }.padding(vertical = 6.dp))
            }
            when {
                err.isNotBlank() -> item { Empty(err) }
                files == null -> item { Loading() }
                files.isEmpty() -> item { Empty("这里还是空的") }
                else -> items(files) { f ->
                    Row2(f.name.removeSuffix(".md"), "更新于 " + timeLabel(f.mtime)) { open(Page.Doc(f.name.removeSuffix(".md"), "data/memory/$cat/${f.name}")) }
                }
            }
        }
        return
    }
    val (cats, err) = load("memory") {
        Api.tree("data/memory").filter { it.dir }.map { it.name to Api.tree("data/memory/${it.name}").count { e -> !e.dir } }
    }
    val (profile, _) = load("profile") { Api.readFile("data/memory/profile/总档.md") }
    LazyColumn(contentPadding = listPad, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()
                .clickable { open(Page.Doc("我对你的了解", "data/memory/profile/总档.md")) }) {
                Column(Modifier.padding(16.dp)) {
                    Text("我对你的了解", fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onPrimaryContainer)
                    Text(
                        profile?.lines()?.filter { it.startsWith("- ") }?.take(4)?.joinToString("\n") { it.drop(2) }?.ifBlank { null } ?: "还是空的，聊得越多越完整",
                        fontSize = 13.sp, color = MaterialTheme.colorScheme.onPrimaryContainer, modifier = Modifier.padding(top = 6.dp), maxLines = 4,
                    )
                }
            }
        }
        when {
            err.isNotBlank() -> item { Empty(err) }
            cats == null -> item { Loading() }
            else -> items(cats.filter { it.first != "profile" }) { (name, n) ->
                Row2(categoryNames[name] ?: name, "$n 个文件") { category = name }
            }
        }
    }
}

// ---------- 日记 ----------

@Composable
fun DiaryScreen(open: (Page) -> Unit) {
    val (days, err) = load("diary") { Api.tree("data/diary").filter { !it.dir && it.name.endsWith(".md") } }
    LazyColumn(contentPadding = listPad, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        when {
            err.isNotBlank() -> item { Empty(err) }
            days == null -> item { Loading() }
            days.isEmpty() -> item { Empty("豆豆每晚 22:30 写一篇日记。") }
            else -> items(days) { d ->
                val date = d.name.removeSuffix(".md")
                Row2(date, "豆豆的日记") { open(Page.Doc(date, "data/diary/${d.name}")) }
            }
        }
    }
}
