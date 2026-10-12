package com.xiamu.agent.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xiamu.agent.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.time.LocalDate
import java.time.ZoneId

@Composable
internal fun SettingsButton() = CircleButton(Icons.Outlined.Settings, "设置") { Nav.open(Route.Settings) }

internal data class ScheduledJob(val id: String, val name: String, val cron: String, val kind: String, val enabled: Boolean)
internal suspend fun schedule(): List<ScheduledJob> = Api.getJson("/api/state").optJSONArray("schedule").objects().map {
    ScheduledJob(it.optString("id"), it.optString("name").ifBlank { it.optString("id") }, it.optString("cron"), it.optString("kind"), it.optBoolean("enabled", true))
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


@Composable
fun TasksScreen(bottom: Dp) {
    val scope = rememberCoroutineScope()
    val list = androidx.compose.foundation.lazy.rememberLazyListState()
    var seg by rememberSaveable { mutableIntStateOf(0) }
    var notice by remember { mutableStateOf("") }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var timeline by remember { mutableStateOf(JobsTimeline()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf("") }
    var loaded by remember { mutableStateOf(false) }
    suspend fun fetch(before: Long? = null) {
        loading = true; error = ""
        try {
            val page = Api.jobs(before)
            check(before == null || page.next == null || page.next < before) { "任务分页游标没有前进" }
            timeline = timeline.apply(page, older = before != null)
            loaded = true
        } catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (e: Exception) { error = e.message ?: "任务加载失败" }
        finally { loading = false }
    }
    LaunchedEffect(Unit) {
        Chat.refreshRunning(); fetch()
        while (true) { delay(1000); now = System.currentTimeMillis() }
    }
    val nearEnd by remember { derivedStateOf {
        val layout = list.layoutInfo
        layout.totalItemsCount > 0 && (layout.visibleItemsInfo.lastOrNull()?.index ?: 0) >= layout.totalItemsCount - 3
    } }
    LaunchedEffect(seg) {
        // Collect sequentially. A loading-state update must not cancel its own HTTP request.
        snapshotFlow { timeline.next?.takeIf { seg == 0 && nearEnd && !loading && loaded && error.isBlank() } }.collect { next ->
            if (next != null) fetch(next)
        }
    }
    val (jobs, scheduleError) = load("schedule", cacheValue = false) { schedule() }
    val running = if (Chat.connected.value) (Chat.running.toList() + Chat.tasks.map { Running(it.id, it.description, it.startedAt) }).distinctBy { it.id } else timeline.running
    LazyColumn(state = list, modifier = Modifier.fillMaxSize().testTag("jobs-list"), contentPadding = pagePadding(bottom)) {
        item(key = "header") { PageHeader("任务") { SettingsButton() } }
        item(key = "segments") { SegTabs(listOf("任务", "定时"), seg, Modifier.padding(bottom = 12.dp)) { seg = it } }
        if (seg == 0) {
            if (running.isNotEmpty()) {
                item(key = "running-title") { SectionTitle("进行中") }
                running.forEach { r -> item(key = "running:${r.id}") {
                    val task = Chat.tasks.firstOrNull { it.id == r.id }
                    CardList(Modifier.padding(bottom = 6.dp)) {
                        ListRow(r.label, "已运行 ${elapsed(r.started, now)}", leading = {
                            CircularProgressIndicator(Modifier.size(22.dp), color = Pal.Link, strokeWidth = 2.dp)
                        }, trailing = { if (task != null) TaskStopButton(task) else Tag("进行中") },
                            onClick = { Nav.open(Route.TaskDetail(r.id, r.label)) })
                        if (task?.error?.isNotBlank() == true) ErrorNote(task.error)
                    }
                } }
            }
            groupJobs(timeline.recent.filter { it.id !in running.map { r -> r.id } }).forEach { (group, records) ->
                item(key = "group:$group") { SectionTitle(group.label) }
                records.forEach { job -> item(key = "job:${job.id}") {
                    CardList(Modifier.padding(bottom = 6.dp)) {
                        ListRow(job.title, "${whenLabel(job.ts)} · ${job.status.label}",
                            if (job.status == TaskStatus.Error) Icons.Outlined.ErrorOutline else Icons.Outlined.CheckCircleOutline,
                            if (job.status == TaskStatus.Error) Pal.Danger else Pal.Online,
                            onClick = { Nav.open(Route.TaskDetail(job.id, job.title, job.path ?: job.outputs.firstOrNull(::isBriefPath))) })
                    }
                } }
            }
            if (loading) item(key = "loading") { Loading() }
            if (error.isNotBlank()) item(key = "error") {
                ErrorNote(error)
                QuietButton("重试") { scope.launch { fetch(if (loaded) timeline.next else null) } }
            }
            if (loaded && !loading && timeline.recent.isEmpty() && running.isEmpty()) item { EmptyNote("还没有任务") }
            if (loaded && !loading && timeline.next == null && timeline.recent.isNotEmpty()) item { FooterNote("已显示全部任务") }
        } else {
            when {
                jobs == null && scheduleError.isNotBlank() -> item { ErrorNote(scheduleError) }
                jobs == null -> item { Loading() }
                jobs.isEmpty() -> item { EmptyNote("还没有定时任务") }
                else -> item {
                    CardList {
                        jobs.forEachIndexed { i, j ->
                            if (i > 0) Hairline()
                            val system = j.kind in setOf("compact", "cleanup")
                            ListRow(j.name, cronLabel(j.cron) + if (!j.enabled) " · 已暂停" else "", if (system) Icons.Outlined.SettingsSuggest else Icons.Outlined.Schedule,
                                Pal.Link, trailing = {
                                    if (system) Tag("系统任务") else QuietButton("立即运行") {
                                        scope.launch {
                                            notice = runCatching { Api.postJson("/api/run", JSONObject().put("id", j.id)); "已安排「${j.name}」，完成后会送到聊天和今日" }.getOrElse { it.message ?: "运行失败" }
                                        }
                                    }
                                })
                        }
                    }
                }
            }
        }
        if (notice.isNotBlank()) item { Text(notice, fontSize = Type.Secondary, color = Pal.Link, modifier = Modifier.padding(top = 12.dp)) }
    }
}
