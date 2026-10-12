package com.xiamu.agent.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xiamu.agent.*
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

private data class TodayData(val briefs: List<BriefDocument>, val sites: List<Api.Entry>, val morning: String)
private data class BriefRow(val key: String, val day: String = "", val brief: BriefDocument? = null, val card: HtmlBriefCard? = null)

internal fun briefDay(day: String): String = runCatching {
    val date = LocalDate.parse(day)
    when(date) { LocalDate.now() -> "今天"; LocalDate.now().minusDays(1) -> "昨天"; else -> date.format(DateTimeFormatter.ofPattern("M月d日 E", Locale.CHINA)) }
}.getOrDefault(day)

@Composable
fun TodayScreen(bottom: Dp, segment: Int = Nav.todaySegment.intValue) {
    val seg = segment
    val list = rememberLazyListState()
    val heights = remember { mutableStateMapOf<String, Dp>() }
    val visible by remember { derivedStateOf { list.layoutInfo.visibleItemsInfo.map { it.key }.toSet() } }
    val (data, error) = load("today-v6") { coroutineScope {
        val briefs = async { Api.briefs() }
        val sites = async { Api.treeOrEmpty("data/sites").filter { it.dir } }
        val morning = async { schedule().firstOrNull { it.name.contains("晨报") }?.let { "${it.name} ${cronLabel(it.cron).removePrefix("每天 ")}" } ?: "晨报 7:30" }
        TodayData(briefs.await(), sites.await(), morning.await())
    } }
    val rows = remember(data) { data?.briefs.orEmpty().groupBy { it.date }.flatMap { (day, entries) ->
        listOf(BriefRow("day:$day", day = day)) + entries.flatMap { brief ->
            listOf(BriefRow(brief.path, brief = brief)) + brief.cards.mapIndexed { i, card -> BriefRow("${brief.path}:$i", card = card) }
        }
    } }
    val target = Nav.briefPath.value
    LaunchedEffect(data, target) {
        if(data != null && target != null) {
            Nav.todaySegment.intValue = 0
            val index = rows.indexOfFirst { it.brief?.path == target }
            if(index >= 0) { list.scrollToItem(index + 2); Nav.briefPath.value = null }
        }
    }
    LazyColumn(state = list, modifier = Modifier.testTag("today-list"), contentPadding = pagePadding(bottom)) {
        item { PageHeader("今日") { SettingsButton() } }
        item { SegTabs(listOf("简报", "站点"), seg, Modifier.padding(bottom=12.dp)) { Nav.todaySegment.intValue = it } }
        when {
            data == null && error.isNotBlank() -> item { ErrorNote(error) }
            data == null -> item { Loading() }
            seg == 0 -> {
                if (data.briefs.isEmpty()) item {
                    Box(Modifier.fillMaxWidth().card().padding(horizontal=20.dp)) { EmptyNote("今天还没有简报 · ${data.morning}") }
                }
                rows.forEach { row -> item(key = row.key, contentType = when { row.card != null -> "html-card"; row.brief != null -> "brief-title"; else -> "day" }) {
                    when {
                        row.day.isNotBlank() -> SectionTitle(briefDay(row.day), Modifier.padding(top=0.dp))
                        row.brief != null -> Text("${clock(row.brief.time)} ${row.brief.name}", color=Pal.Muted, fontSize = Type.Label,
                            modifier=Modifier.padding(start=4.dp,bottom=10.dp))
                        row.card != null -> HtmlBriefCardView(row.card, row.key, row.key in visible, heights[row.key]) { heights[row.key] = it }
                    }
                } }
            }
            else -> {
                if(data.sites.isEmpty()) item { EmptyNote("还没有站点") }
                data.sites.chunked(2).forEach { pair -> item {
                    Row(Modifier.fillMaxWidth().padding(bottom=14.dp), horizontalArrangement=Arrangement.spacedBy(12.dp)) {
                        pair.forEach { SiteCard(it, Modifier.weight(1f)) }
                        if(pair.size == 1) Spacer(Modifier.weight(1f))
                    }
                } }
            }
        }
        if (data != null && error.isNotBlank()) item { ErrorNote(error) }
    }
}
