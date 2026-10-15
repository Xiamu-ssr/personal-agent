package com.xiamu.agent.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.xiamu.agent.*
import kotlinx.coroutines.*

private val categoryNames=mapOf("profile" to "总档","work" to "工作","project" to "项目","life" to "生活","health" to "健康","people" to "人际","preferences" to "偏好","interests" to "兴趣","finance" to "财务","feedback" to "反馈","history" to "历史","automation-prefs" to "自动化偏好","voice-notes" to "语音笔记")
@Composable
fun MemoryCards() {
    val (memory,error)=load("memory") { Api.getJson("/api/memory") }
    Column(Modifier.padding(top=24.dp)) {
        Row(horizontalArrangement=Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1f).height(162.dp).card().tap { Nav.open(Route.Soul) }.padding(18.dp)) {
                Text("灵魂",style=Type.title(20),color=Pal.Ink); Spacer(Modifier.height(12.dp)); Text(memory?.optJSONObject("soul")?.optString("name") ?: Chat.agentName.value,style=Type.body(14),color=Pal.Ink); Text("名字、性格和日记",style=Type.body(12),color=Pal.Muted,modifier=Modifier.padding(top=8.dp))
            }
            Column(Modifier.weight(1f).height(162.dp).card().tap { Nav.open(Route.Memory) }.padding(18.dp)) {
                Text("记忆",style=Type.title(20),color=Pal.Ink); Spacer(Modifier.height(12.dp)); Text("关于你的事",style=Type.body(14),color=Pal.Ink); Text("总档、分类和健康",style=Type.body(12),color=Pal.Muted,modifier=Modifier.padding(top=8.dp))
            }
        }
        if(error.isNotBlank()) ErrorNote(error)
    }
}
@Composable
fun SoulScreen() {
    val (memory,error)=load("memory") { Api.getJson("/api/memory") }
    val soul=memory?.optJSONObject("soul")
    SubPage("灵魂") {
        item { Spacer(Modifier.height(16.dp)); CardList {
            ListRow(soul?.optString("name") ?: Chat.agentName.value,soul?.optString("personality"),Icons.Outlined.Face,subLines=3,onClick={Nav.open(Route.Doc("角色","data/soul/角色.md",editable=true))})
        } }
        item { SectionTitle("日记") }
        soul?.optJSONArray("diary").objects().forEach { entry -> item { CardList(Modifier.padding(bottom=8.dp)) { ListRow(entry.optString("name"),icon=Icons.Outlined.Book,onClick={Nav.open(Route.Doc(entry.optString("name"),entry.optString("path"),editable=true))}) } } }
        if(error.isNotBlank()) item { ErrorNote(error) }
    }
}
@Composable
fun DiariesScreen()=SoulScreen()
@Composable
fun MemoryScreen(bottom: Dp) {
    val (memory,error)=load("memory") { Api.getJson("/api/memory") }
    SubPage("记忆") {
        item { Spacer(Modifier.height(16.dp)); CardList {
            ListRow("总档","豆豆对你的了解",Icons.Outlined.PersonOutline,onClick={Nav.open(Route.Doc("总档",memory?.optString("profile") ?: "data/memory/profile/总档.md",pointers=true,editable=true))})
            Hairline(); ListRow("健康","手机同步的数据与记录",Icons.Outlined.FavoriteBorder,onClick={Nav.open(Route.Health)})
        } }
        item { SectionTitle("分类") }
        memory?.optJSONArray("categories").objects().forEach { category -> item { CardList(Modifier.padding(bottom=8.dp)) {
            val name=category.optString("name")
            ListRow(categoryNames[name] ?: name,"${category.optJSONArray("items").objects().size} 项",Icons.Outlined.Folder,onClick={Nav.open(Route.MemoryCategory(name))})
        } } }
        if(error.isNotBlank()) item { ErrorNote(error) }
    }
}
@Composable
fun MemoryCategoryScreen(dir: String) {
    val (memory,error)=load("memory") { Api.getJson("/api/memory") }
    val items=memory?.optJSONArray("categories").objects().firstOrNull { it.optString("name")==dir }?.optJSONArray("items").objects()
    SubPage(categoryNames[dir] ?: dir) {
        item { Spacer(Modifier.height(16.dp)) }
        items.forEach { entry -> item { CardList(Modifier.padding(bottom=8.dp)) { ListRow(entry.optString("name"),icon=Icons.Outlined.Description,onClick={Nav.open(Route.Doc(entry.optString("name"),entry.optString("path"),pointers=true,editable=true))}) } } }
        if(error.isNotBlank()) item { ErrorNote(error) }
    }
}
@Composable
fun HealthScreen() {
    val (loaded,error)=load("health",cacheValue=false) { Api.health() }
    var data by remember(loaded) { mutableStateOf(loaded) }
    var note by remember { mutableStateOf("") }
    var syncing by remember { mutableStateOf(false) }
    val scope=rememberCoroutineScope()
    SubPage("健康") {
        item { RowActions(if(syncing) "同步中…" else "同步") { if(!syncing) { syncing=true; scope.launch {
            try { data=Api.syncHealth(); note="" } catch(e: CancellationException) { throw e } catch(e: Exception) { note=e.message ?: "同步失败" } finally { syncing=false }
        } } }; FooterNote(data?.syncLabel() ?: "正在读取") }
        data?.days?.reversed()?.forEach { day -> item { Column(Modifier.fillMaxWidth().padding(top=12.dp).card().padding(16.dp)) {
            Text(day.date.toString(),style=Type.title(15),color=Pal.Ink)
            Text("睡眠 ${sleepLabel(day.sleepMinutes)}\n静息心率 ${healthNumber(day.restingHr)} bpm\n心率变异性 ${healthNumber(day.hrv)} ms\n步数 ${healthNumber(day.steps)}",style=Type.body(14),color=Pal.Ink,modifier=Modifier.padding(top=10.dp))
        } } }
        item { SectionTitle("记录") }
        data?.records?.forEach { record -> item { CardList(Modifier.padding(bottom=8.dp)) { ListRow(record.title,record.preview,subLines=2,onClick={Nav.open(Route.Doc(record.title,record.path,editable=true))}) } } }
        if(error.isNotBlank() || note.isNotBlank()) item { ErrorNote(error.ifBlank { note }) }
    }
}
