package com.xiamu.agent.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBackIos
import androidx.compose.material.icons.outlined.CloudSync
import androidx.compose.material.icons.outlined.FavoriteBorder
import androidx.compose.material.icons.outlined.NightsStay
import androidx.compose.material.icons.outlined.DirectionsWalk
import androidx.compose.material.icons.outlined.MonitorHeart
import androidx.compose.material.icons.outlined.Article
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.xiamu.agent.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
fun HealthScreen() {
    val scope = rememberCoroutineScope()
    var revision by remember { mutableIntStateOf(0) }
    var syncing by remember { mutableStateOf(false) }
    var syncError by remember { mutableStateOf("") }
    var synced by remember { mutableStateOf<HealthData?>(null) }
    val (loaded, error) = load("health", revision = revision) { Api.health().also { if (revision > 0) synced = null } }
    val data = synced ?: loaded
    val seen = remember { mutableStateMapOf<String, Long>() }
    fun isNew(path: String, date: String?) = healthEntryIsNew(date, seen[path] ?: Prefs.healthSeen(path))
    fun mark(path: String) { val at = System.currentTimeMillis(); Prefs.markHealthSeen(path, at); seen[path] = at }
    Screen {
        LazyColumn(Modifier.fillMaxSize().navigationBarsPadding().testTag("health-list"), contentPadding = PaddingValues(start = 20.dp, end = 20.dp, bottom = 32.dp)) {
            item {
                Column(Modifier.statusBarsPadding().padding(top = 14.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircleButton(Icons.AutoMirrored.Outlined.ArrowBackIos, "返回", Nav::back)
                        Text("健康", style = Type.title(28), color = Pal.Ink, modifier = Modifier.weight(1f).padding(start = 10.dp))
                        if (syncing) CircularProgressIndicator(Modifier.padding(10.dp).size(22.dp).testTag("health-syncing"), color = Pal.Link, strokeWidth = 2.dp)
                        else CircleButton(Icons.Outlined.CloudSync, "同步健康") {
                            syncing = true; syncError = ""
                            scope.launch {
                                try { synced = Api.syncHealth(); revision++ }
                                catch (e: CancellationException) { throw e }
                                catch (e: Exception) { syncError = e.message ?: "同步失败，请重试" }
                                finally { syncing = false }
                            }
                        }
                    }
                    Text(data?.syncLabel() ?: "正在读取健康数据", style = Type.body(13), color = Pal.Muted,
                        modifier = Modifier.padding(top = 8.dp, start = 4.dp))
                }
            }
            if (data == null && error.isBlank()) item { Loading() }
            if (error.isNotBlank() || syncError.isNotBlank()) item { ErrorNote(syncError.ifBlank { error }) }
            if (data != null) {
                item { SectionTitle("今天") }
                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        MetricCard("睡眠", sleepLabel(data.today.sleepMinutes), "", Icons.Outlined.NightsStay, Pal.Info, data.days.map { it.sleepMinutes }, true, Modifier.weight(1f))
                        MetricCard("静息心率", healthNumber(data.today.restingHr), "bpm", Icons.Outlined.FavoriteBorder, Pal.Danger, data.days.map { it.restingHr }, false, Modifier.weight(1f))
                    }
                }
                item {
                    Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        MetricCard("心率变异性", healthNumber(data.today.hrv), "ms", Icons.Outlined.MonitorHeart, Pal.Gold, data.days.map { it.hrv }, false, Modifier.weight(1f))
                        MetricCard("步数", healthNumber(data.today.steps), "步", Icons.Outlined.DirectionsWalk, Pal.Link, data.days.map { it.steps }, true, Modifier.weight(1f))
                    }
                }
                item { SectionTitle("周报") }
                if (data.weekly.isEmpty()) item { EmptyNote("还没有健康周报") }
                data.weekly.forEach { report -> item(key = report.path) {
                    CardList(Modifier.padding(bottom = 10.dp)) {
                        ListRow(report.range, report.summary, Icons.Outlined.Article, Pal.Link, subLines = 2,
                            trailing = if (isNew(report.path, report.date)) { { Tag("新", Pal.Link) } } else null,
                            onClick = { mark(report.path); Nav.open(Route.HealthBrief(report.path, report.name)) })
                    }
                } }
                item { SectionTitle("健康记录") }
                if (data.records.isEmpty()) item { EmptyNote("还没有健康记录") }
                data.records.chunked(2).forEach { records -> item {
                    Row(Modifier.fillMaxWidth().padding(bottom = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        records.forEach { record ->
                            Column(Modifier.weight(1f).card().tap {
                                mark(record.path); Nav.open(Route.Doc(record.title, record.path, pointers = true))
                            }.padding(16.dp).testTag("health-record:${record.path}")) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(record.title, style = Type.title(17), color = Pal.Ink, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                                    if (isNew(record.path, record.updated)) Tag("新", Pal.Link)
                                }
                                Text(record.updated?.let { "更新于 $it" } ?: "更新日期未知", style = Type.body(12), color = Pal.Muted, modifier = Modifier.padding(top = 4.dp))
                                Box(Modifier.padding(vertical = 12.dp).fillMaxWidth().height(1.dp).background(Pal.Line))
                                Text(record.preview, style = Type.body(13), color = Pal.Muted, maxLines = 2, minLines = 2, overflow = TextOverflow.Ellipsis)
                            }
                        }
                        if (records.size == 1) Spacer(Modifier.weight(1f))
                    }
                } }
            }
        }
    }
}

@Composable
private fun MetricCard(title: String, value: String, unit: String, icon: ImageVector, color: Color, values: List<Double?>, bars: Boolean, modifier: Modifier) {
    Column(modifier.card().padding(14.dp).testTag("health-metric:$title")) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, null, tint = color, modifier = Modifier.size(16.dp))
            Text(title, style = Type.body(13), color = Pal.Ink, modifier = Modifier.padding(start = 6.dp))
        }
        Row(Modifier.padding(top = 13.dp, bottom = 10.dp), verticalAlignment = Alignment.Bottom) {
            Text(value, style = Type.title(if (title == "睡眠" && value != "--") 19 else 26), color = Pal.Ink, maxLines = 1)
            if (value != "--" && unit.isNotBlank()) Text(unit, style = Type.body(11), color = Pal.Muted, modifier = Modifier.padding(start = 4.dp, bottom = 4.dp))
        }
        HealthChart(values, bars, color, Modifier.fillMaxWidth().height(52.dp))
        Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            (6L downTo 0L).forEach { offset ->
                Text(java.time.LocalDate.now().minusDays(offset).dayOfMonth.toString(), style = Type.body(11), color = Pal.Faint)
            }
        }
    }
}

/** Missing days occupy a slot. Lines break across gaps; missing days never become zero. */
@Composable
internal fun HealthChart(values: List<Double?>, bars: Boolean, color: Color, modifier: Modifier) {
    val line = Pal.Line
    Canvas(modifier) {
        val present = values.filterNotNull()
        if (present.isEmpty()) return@Canvas
        val max = present.maxOrNull()!!.coerceAtLeast(1.0)
        val min = if (bars) 0.0 else present.minOrNull()!! - 4
        val range = (max - min).coerceAtLeast(8.0)
        val slot = size.width / 7
        fun point(index: Int, value: Double) = Offset(slot * (index + .5f), size.height - 4.dp.toPx() - ((value - min) / range * (size.height - 8.dp.toPx())).toFloat())
        if (!bars) drawLine(line, Offset(0f, size.height * .5f), Offset(size.width, size.height * .5f), strokeWidth = 1.dp.toPx())
        values.forEachIndexed { index, value ->
            if (value != null) {
                val p = point(index, value)
                if (bars) drawRoundRect(color.copy(alpha = if (index == 6) .75f else .23f),
                    topLeft = Offset(slot * index + 2.dp.toPx(), p.y), size = Size((slot - 4.dp.toPx()).coerceAtLeast(1f), (size.height - p.y).coerceAtLeast(1f)), cornerRadius = CornerRadius(3.dp.toPx()))
                else {
                    val previous = values.getOrNull(index - 1)
                    if (previous != null) drawLine(color.copy(alpha = .4f), point(index - 1, previous), p, strokeWidth = 1.5.dp.toPx())
                    drawCircle(color.copy(alpha = if (index == 6) 1f else .6f), 2.5.dp.toPx(), p)
                }
            }
        }
    }
}

@Composable
fun HealthBriefScreen(route: Route.HealthBrief) {
    val list = rememberLazyListState()
    val heights = remember { mutableStateMapOf<String, androidx.compose.ui.unit.Dp>() }
    val visible by remember { derivedStateOf { list.layoutInfo.visibleItemsInfo.map { it.key }.toSet() } }
    val (brief, error) = load("health-brief:${route.path}") { Api.briefItem(route.path) }
    Screen {
        Column(Modifier.fillMaxSize().navigationBarsPadding()) {
            SubHeader(route.title, Nav::back)
            LazyColumn(state = list, modifier = Modifier.fillMaxSize().testTag("health-brief-list"), contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp)) {
                if (brief == null && error.isBlank()) item { Loading() }
                if (error.isNotBlank()) item { ErrorNote(error) }
                brief?.let { doc ->
                    item { Text("${doc.date} · ${clock(doc.time)}", style = Type.body(13), color = Pal.Muted, modifier = Modifier.padding(bottom = 12.dp)) }
                    doc.cards.forEachIndexed { index, card ->
                        val key = "${doc.path}:$index"
                        item(key = key) { HtmlBriefCardView(card, key, key in visible, heights[key]) { heights[key] = it } }
                    }
                }
            }
        }
    }
}
