package com.xiamu.agent.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
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
private data class BriefRow(val day: String, val brief: BriefDocument? = null)

internal fun briefDay(day: String): String = runCatching {
    val date = LocalDate.parse(day)
    when(date) { LocalDate.now() -> "今天"; LocalDate.now().minusDays(1) -> "昨天"; else -> date.format(DateTimeFormatter.ofPattern("M月d日 E", Locale.CHINA)) }
}.getOrDefault(day)

@Composable
fun TodayScreen(bottom: Dp) {
    var seg by rememberSaveable { mutableIntStateOf(0) }
    val list = rememberLazyListState()
    val (data, error) = load("today-v4") { coroutineScope {
        val briefs = async { Api.briefs() }
        val sites = async { Api.treeOrEmpty("data/sites").filter { it.dir } }
        val morning = async { schedule().firstOrNull { it.name.contains("晨报") }?.let { "${it.name} ${cronLabel(it.cron).removePrefix("每天 ")}" } ?: "晨报 7:30" }
        TodayData(briefs.await(), sites.await(), morning.await())
    } }
    val rows = data?.briefs.orEmpty().groupBy { it.date }.flatMap { (day, entries) -> listOf(BriefRow(day)) + entries.map { BriefRow(day, it) } }
    val target = Nav.briefPath.value
    LaunchedEffect(data, target) {
        if(data != null && target != null) {
            seg = 0
            val index = rows.indexOfFirst { it.brief?.path == target }
            if(index >= 0) { list.scrollToItem(index + 2); Nav.briefPath.value = null }
        }
    }
    LazyColumn(state = list, contentPadding = pagePadding(bottom)) {
        item { PageHeader("今日") { SettingsButton() } }
        item { SegTabs(listOf("简报", "站点"), seg, Modifier.padding(bottom=12.dp)) { seg = it } }
        when {
            data == null && error.isNotBlank() -> item { ErrorNote(error) }
            data == null -> item { Loading() }
            seg == 0 -> {
                if (data.briefs.isEmpty()) item {
                    Box(Modifier.fillMaxWidth().card().padding(horizontal=20.dp)) { EmptyNote("今天还没有简报 · ${data.morning}") }
                }
                rows.forEach { row ->
                    if(row.brief == null) item(key="day:${row.day}") { SectionTitle(briefDay(row.day), Modifier.padding(top=0.dp)) }
                    else item(key=row.brief.path) {
                        Column(Modifier.fillMaxWidth().padding(bottom=12.dp)) {
                            Text("${clock(row.brief.time)} ${row.brief.name}", color=Pal.Muted, fontSize=12.sp, modifier=Modifier.padding(start=4.dp,bottom=10.dp))
                            row.brief.cards.forEach { BriefCardView(it, Modifier.padding(bottom=12.dp)) }
                        }
                    }
                }
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

@Composable
fun BriefCardView(card: BriefCard, modifier: Modifier = Modifier, compact: Boolean = false) {
    val c = ctx()
    Column(modifier.fillMaxWidth().card(radius=24.dp).padding(20.dp), verticalArrangement=Arrangement.spacedBy(12.dp)) {
        if(card.chip.isNotBlank()) Text(card.chip, fontSize=11.sp, color=Pal.GoldInk, fontWeight=FontWeight.SemiBold)
        Text(card.title, fontSize=20.sp, lineHeight=29.sp, fontWeight=FontWeight.SemiBold, color=Pal.Ink)
        if(card.summary.isNotBlank()) Text(card.summary, fontSize=14.sp, lineHeight=23.sp, color=Pal.Muted)
        if(!compact) {
            card.blocks.forEach { BriefBlockView(it) }
            card.action?.let { action -> GoldButton(action.label, Modifier.fillMaxWidth()) { Draft.send(c, action.prompt, includeDraft=false) } }
        }
    }
}

@Composable
private fun BriefBlockView(block: BriefBlock) {
    when(block.type) {
        "note" -> Text(block.text, fontSize=12.sp, lineHeight=18.sp, color=Pal.Muted,
            modifier=Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Color(0xFFE9EDF1)).padding(12.dp))
        "timeline" -> Row(Modifier.fillMaxWidth(), horizontalArrangement=Arrangement.spacedBy(10.dp)) {
            block.items.forEach { part -> Column(Modifier.weight(1f)) {
                Text(part.meta, color=Pal.GoldInk, fontSize=13.sp, fontWeight=FontWeight.SemiBold)
                Box(Modifier.padding(vertical=7.dp).fillMaxWidth().height(2.dp).background(Pal.Gold.copy(alpha=.35f)))
                Text(part.primary, color=Pal.Ink, fontSize=13.sp, fontWeight=FontWeight.Medium)
                if(part.text.isNotBlank()) Text(part.text, color=Pal.Muted, fontSize=11.sp, lineHeight=16.sp)
            } }
        }
        "tiles" -> Row(Modifier.fillMaxWidth(), horizontalArrangement=Arrangement.spacedBy(8.dp)) {
            block.items.forEach { part -> Column(Modifier.weight(1f).clip(RoundedCornerShape(14.dp)).background(Color(0xFFEAF0F5)).padding(10.dp), verticalArrangement=Arrangement.spacedBy(6.dp)) {
                Text(part.primary, fontSize=13.sp, fontWeight=FontWeight.Medium, color=Pal.Ink)
                if(part.text.isNotBlank()) Text(part.text, fontSize=12.sp, lineHeight=18.sp, color=Pal.Muted)
                if(part.meta.isNotBlank()) Tag(part.meta, when(part.tone) { "ok" -> Color(0xFF4B8272); "warn" -> Color(0xFF967347); else -> Pal.Link })
            } }
        }
        "metrics" -> Row(Modifier.fillMaxWidth(), horizontalArrangement=Arrangement.spacedBy(8.dp)) {
            block.items.forEach { part -> Column(Modifier.weight(1f)) {
                Text(part.text, fontSize=11.sp, color=Pal.Muted)
                Text(part.primary, fontSize=24.sp, fontWeight=FontWeight.Bold, color=Pal.Ink)
                if(part.unit.isNotBlank()) Text(part.unit, fontSize=10.sp, color=Pal.Muted)
                if(part.delta.isNotBlank()) Text(part.delta, fontSize=11.sp, color=Pal.GoldInk)
            } }
        }
        "list" -> Column(verticalArrangement=Arrangement.spacedBy(8.dp)) {
            block.items.forEach { part -> Column {
                Text(part.primary, fontSize=14.sp, lineHeight=22.sp, color=Pal.Ink)
                if(part.meta.isNotBlank()) Text(part.meta, fontSize=11.sp, lineHeight=17.sp, color=Pal.Muted)
            } }
        }
    }
}
