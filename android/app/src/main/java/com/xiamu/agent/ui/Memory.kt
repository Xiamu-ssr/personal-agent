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

@Composable
fun MemoryCards() {
    val (memory,error)=load("memory") { Api.getJson("/api/memory") }
    Column(Modifier.padding(top=24.dp)) {
        Row(horizontalArrangement=Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1f).height(162.dp).card().tap { Nav.open(Route.Soul) }.padding(18.dp)) {
                Text("灵魂",style=Type.title(20),color=Pal.Ink); Spacer(Modifier.height(12.dp)); Text(memory?.optJSONObject("soul")?.optString("name") ?: Chat.agentName.value,style=Type.body(14),color=Pal.Ink); Text("人格与行为习惯",style=Type.body(12),color=Pal.Muted,modifier=Modifier.padding(top=8.dp))
            }
            Column(Modifier.weight(1f).height(162.dp).card().tap { Nav.open(Route.Memory) }.padding(18.dp)) {
                Text("记忆",style=Type.title(20),color=Pal.Ink); Spacer(Modifier.height(12.dp)); Text("关于你的事",style=Type.body(14),color=Pal.Ink); Text("原生记忆和健康",style=Type.body(12),color=Pal.Muted,modifier=Modifier.padding(top=8.dp))
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
            ListRow(soul?.optString("name") ?: Chat.agentName.value,soul?.optString("personality"),Icons.Outlined.Face,subLines=3,onClick={Nav.open(Route.Doc("人格","SOUL.md",editable=true))})
        } }
        if(error.isNotBlank()) item { ErrorNote(error) }
    }
}
@Composable
fun MemoryScreen(bottom: Dp) {
    val (memory,error)=load("memory") { Api.getJson("/api/memory") }
    SubPage("OpenClaw 记忆") {
        item { Spacer(Modifier.height(16.dp)); CardList {
            ListRow("豆豆的人格",icon=Icons.Outlined.Face,onClick={Nav.open(Route.Doc("人格","SOUL.md",editable=true))})
            Hairline(); ListRow("健康","手机同步的健康数据",Icons.Outlined.FavoriteBorder,onClick={Nav.open(Route.Health)})
        } }
        memory?.optJSONArray("items").objects().forEach { entry -> item { CardList(Modifier.padding(top=8.dp)) {
            ListRow(entry.optString("name"),entry.optString("path"),Icons.Outlined.Description,onClick={Nav.open(Route.Doc(entry.optString("name"),entry.optString("path"),editable=true))})
        } } }
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
        if(error.isNotBlank() || note.isNotBlank()) item { ErrorNote(error.ifBlank { note }) }
    }
}
