package com.xiamu.agent.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Badge
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xiamu.agent.*
import kotlinx.coroutines.*
import java.time.LocalDate
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

private data class Diary(val day: String, val title: String, val excerpt: String) { val path get() = "data/diary/$day.md" }
private fun parseDiary(day: String, text: String): Diary {
    val lines = text.lines().map { it.trim() }.filter { it.isNotBlank() }
    return Diary(day, lines.firstOrNull()?.trimStart('#',' ')?.ifBlank { null } ?: day,
        lines.drop(1).filterNot { it.startsWith("#") }.joinToString(" ") { it.trimStart('-','*','>',' ').replace("**", "") }.take(140))
}
private suspend fun diaries(limit: Int) = coroutineScope {
    Api.treeOrEmpty("data/diary").filter { !it.dir && it.name.endsWith(".md") }.sortedByDescending { it.name }.take(limit).map { file ->
        async { parseDiary(file.name.removeSuffix(".md"), Api.readFile("data/diary/${file.name}")) }
    }.awaitAll()
}

@Composable
fun DouScreen(bottom: Dp) {
    val (state, _) = load("state") { Api.getJson("/api/state") }
    val (profile, profileError) = load("appProfile") { Api.profile() }
    val (recent, error) = load("diaries:6") { diaries(6) }
    val diaryTime=state?.optJSONArray("schedule").objects().firstOrNull { it.optString("id")=="night" }?.let { cronLabel(it.optString("cron")).removePrefix("每天 ") } ?: "22:30"
    var choosing by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var saveError by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    LaunchedEffect(profile) { profile?.let { Appearance.choice.value = it } }
    fun save(choice: AvatarChoice) {
        if(saving) return
        saving = true; saveError = ""
        scope.launch {
            try { Api.saveProfile(choice); Appearance.choice.value = choice; invalidateCache("appProfile") }
            catch(e: Exception) { if(e is CancellationException) throw e; saveError = e.message ?: "外观保存失败" }
            finally { saving = false }
        }
    }
    LazyColumn(contentPadding=pagePadding(bottom)) {
        item { Row(Modifier.fillMaxWidth().statusBarsPadding().padding(top=18.dp), horizontalArrangement=Arrangement.End) { SettingsButton() } }
        item {
            Column(Modifier.fillMaxWidth().padding(bottom=16.dp), horizontalAlignment=Alignment.CenterHorizontally) {
                Box(Modifier.fillMaxWidth().height(260.dp).tap { choosing = true }, contentAlignment=Alignment.Center) { Avatar(246.dp) }
                Text(state?.optString("agentName")?.ifBlank { null } ?: "豆豆", fontSize = Type.Number, fontWeight=FontWeight.Bold, color=Pal.Ink)
                val first = state?.let(Api::firstChatTime)
                val date = first?.let { Instant.ofEpochMilli(it).atZone(ZoneId.systemDefault()).toLocalDate().format(DateTimeFormatter.ofPattern("yyyy年M月d日")) }
                val user = state?.optString("userCall")?.ifBlank { null } ?: "你"
                Text(if(date != null) "从${date}起陪伴${user}" else "从第一次对话起陪伴${user}", fontSize = Type.Secondary, color=Pal.Muted, modifier=Modifier.padding(top=8.dp))
                Text("更换外观", fontSize = Type.Label, color=Pal.Link, modifier=Modifier.padding(top=10.dp).tap { choosing = true })
                if(profileError.isNotBlank()) ErrorNote(profileError)
            }
        }
        item { SectionTitle("最近的日记") { Text("查看所有日记", fontSize = Type.Label, color=Pal.Link, modifier=Modifier.tap { Nav.open(Route.Diaries) }) } }
        item { when {
            recent == null && error.isNotBlank() -> ErrorNote(error)
            recent == null -> Loading()
            recent.isEmpty() -> EmptyNote("豆豆每晚 $diaryTime 写一篇日记")
            else -> LazyRow(contentPadding=PaddingValues(vertical=6.dp), horizontalArrangement=Arrangement.spacedBy(16.dp)) {
                items(recent) { DiaryCard(it, Modifier.fillParentMaxWidth(.8f)) }
            }
        } }
        item { SectionTitle("豆豆的设定") }
        item { CardList { ListRow("角色设定", "豆豆是谁、怎么说话、怎么做事", Icons.Outlined.Badge, Pal.Link) { Nav.open(memoryDoc("role/角色.md")) } } }
    }
    if(choosing) AlertDialog(onDismissRequest={ if(!saving) choosing=false }, title={ Text("豆豆的外观") }, text={
        Column(verticalArrangement=Arrangement.spacedBy(14.dp)) {
            val selected = Appearance.choice.value
            Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(6.dp)) {
                AvatarChoice.shapes.forEach { (id,label) -> Column(Modifier.weight(1f).tap(!saving) { save(selected.copy(shape=id)) },horizontalAlignment=Alignment.CenterHorizontally) {
                    Avatar(52.dp, choice=selected.copy(shape=id))
                    Text(label, fontSize = Type.Label, color=if(selected.shape==id) Pal.GoldInk else Pal.Muted, modifier=Modifier.padding(top=6.dp))
                } }
            }
            AvatarChoice.palettes.forEach { (id,label) -> Row(Modifier.fillMaxWidth().tap(!saving) { save(selected.copy(palette=id)) }.padding(vertical=4.dp),verticalAlignment=Alignment.CenterVertically) {
                Avatar(30.dp, choice=selected.copy(palette=id))
                Text(label, fontSize = Type.Secondary, color=if(selected.palette==id) Pal.GoldInk else Pal.Muted, modifier=Modifier.padding(start=12.dp))
                if(selected.palette==id) Text("已选", fontSize = Type.Tiny, color=Pal.GoldInk, modifier=Modifier.padding(start=12.dp))
            } }
            if(saving) Text("正在保存…", fontSize = Type.Label, color=Pal.Muted)
            if(saveError.isNotBlank()) ErrorNote(saveError)
        }
    }, confirmButton={ TextButton(enabled=!saving,onClick={ choosing=false }) { Text("完成") } })
}


@Composable
private fun DiaryCard(diary: Diary, modifier: Modifier = Modifier) {
    val date = runCatching { LocalDate.parse(diary.day) }.getOrNull()
    val week = (date?.dayOfWeek?.value ?: 7) % 7
    Column(modifier.graphicsLayer { rotationZ=if(week%2==0) -1.5f else 1.5f }.heightIn(min=216.dp)
        .card(radius=8.dp,color=Pal.Card).tap { Nav.open(Route.Doc(diary.title,diary.path)) }.padding(18.dp)) {
        Column(Modifier.background(Pal.Card.copy(alpha=.72f),RoundedCornerShape(6.dp)).padding(horizontal=10.dp,vertical=6.dp),horizontalAlignment=Alignment.CenterHorizontally) {
            Text(date?.format(DateTimeFormatter.ofPattern("EEE",Locale.US))?.uppercase() ?: "", fontSize = Type.Tiny,fontWeight=FontWeight.SemiBold,color=Pal.Muted)
            Text(date?.dayOfMonth?.toString().orEmpty(),fontSize = Type.Number,fontWeight=FontWeight.Bold,color=Pal.Ink)
        }
        Text(diary.title, fontSize = Type.Body,lineHeight = Type.BodyLine,fontWeight=FontWeight.SemiBold,color=Pal.Ink,maxLines=2,overflow=TextOverflow.Ellipsis,modifier=Modifier.padding(top=12.dp))
        Text(diary.excerpt, fontSize = Type.Secondary,lineHeight = Type.BodyLine,color=Pal.Muted,maxLines=3,overflow=TextOverflow.Ellipsis,modifier=Modifier.padding(top=8.dp))
    }
}

@Composable
fun DiariesScreen() {
    val (list,error) = load("diaryFiles-v4") { diaries(100) }
    SubPage("日记") {
        item { BigTitle("豆豆的日记") }
        when {
            list == null && error.isNotBlank() -> item { ErrorNote(error) }
            list == null -> item { Loading() }
            list.isEmpty() -> item { EmptyNote("还没有日记") }
            else -> items(list.chunked(2)) { pair -> Row(Modifier.fillMaxWidth().padding(vertical=9.dp),horizontalArrangement=Arrangement.spacedBy(14.dp)) {
                pair.forEach { DiaryCard(it,Modifier.weight(1f)) }; if(pair.size==1) Spacer(Modifier.weight(1f))
            } }
        }
    }
}
