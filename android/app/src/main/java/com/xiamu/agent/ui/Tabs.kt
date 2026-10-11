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
    var seg by rememberSaveable { mutableIntStateOf(0) }
    var notice by remember { mutableStateOf("") }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { Chat.refreshRunning(); while (true) { delay(1000); now = System.currentTimeMillis() } }
    val (recent, error) = load("jobs", cacheValue = false) { Api.getJson("/api/jobs").optJSONArray("recent").objects().sortedByDescending { it.optLong("ts") } }
    val (jobs, scheduleError) = load("schedule", cacheValue = false) { schedule() }
    LazyColumn(contentPadding = pagePadding(bottom)) {
        item { PageHeader("任务") { SettingsButton() } }
        item { SegTabs(listOf("任务", "定时"), seg, Modifier.padding(bottom=12.dp)) { seg = it } }
        if (seg == 0) {
            val running = Chat.running.toList() + Chat.tasks.map { Running("task:${it.id}", it.description, it.startedAt) }
            if (running.isNotEmpty()) item {
                CardList {
                    running.forEachIndexed { i, r ->
                        if (i > 0) Hairline()
                        val task = Chat.tasks.firstOrNull { "task:${it.id}" == r.id }
                        ListRow(r.label, "已运行 ${elapsed(r.started, now)}", leading = {
                            CircularProgressIndicator(Modifier.size(28.dp), color=Pal.Gold, strokeWidth=2.dp)
                        }, trailing = { if (task != null) TaskStopButton(task) else Tag("进行中") })
                        if (task?.error?.isNotBlank() == true) ErrorNote(task.error)
                    }
                }
            }
            if (Chat.jobsError.value.isNotBlank()) item { ErrorNote(Chat.jobsError.value) }
            when {
                recent == null && error.isNotBlank() -> item { ErrorNote(error) }
                recent == null -> item { Loading() }
                recent.isEmpty() && running.isEmpty() -> item { EmptyNote("现在没有在跑的任务") }
                else -> {
                    val start = LocalDate.now().atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli()
                    recent.orEmpty().groupBy { when { it.optLong("ts") >= start -> "今天"; it.optLong("ts") >= start - 6 * 86_400_000L -> "近 7 天"; else -> "更早" } }.forEach { (group, list) ->
                        item { SectionTitle(group) }
                        item {
                            CardList {
                                list.forEachIndexed { i, job ->
                                    if (i > 0) Hairline()
                                    val ok = job.optBoolean("ok")
                                    val path = job.optString("path").ifBlank { job.optJSONArray("outputs").strings().firstOrNull().orEmpty() }
                                    ListRow(job.optString("title").ifBlank { job.optString("label") }, "${whenLabel(job.optLong("ts"))} · ${if(ok) "成功" else "出错"}",
                                        if (ok) Icons.Outlined.CheckCircleOutline else Icons.Outlined.ErrorOutline, if(ok) Color(0xFF527C80) else Pal.Danger,
                                        onClick = if(path.isBlank()) null else ({ if(path.startsWith("data/briefs/") && path.endsWith(".json")) Nav.brief(path)
                                            else Nav.open(Route.Web(job.optString("title").ifBlank { path.substringAfterLast('/') }, path)) }))
                                }
                            }
                        }
                    }
                }
            }
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
                            ListRow(j.name, cronLabel(j.cron) + if(!j.enabled) " · 已暂停" else "", if(system) Icons.Outlined.SettingsSuggest else Icons.Outlined.Schedule,
                                Pal.Link, trailing = {
                                    if(system) Tag("系统任务") else QuietButton("立即运行") {
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
        if (notice.isNotBlank()) item { Text(notice, fontSize=13.sp, color=Pal.GoldInk, modifier=Modifier.padding(top=12.dp)) }
    }
}
