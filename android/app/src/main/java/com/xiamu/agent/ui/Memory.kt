package com.xiamu.agent.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xiamu.agent.*
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import org.json.JSONObject

private const val PROFILE = "data/memory/profile/总档.md"
private val categories = linkedMapOf("work" to "工作", "project" to "项目", "life" to "生活", "health" to "健康", "people" to "人际",
    "preferences" to "偏好", "interests" to "兴趣", "finance" to "财务", "feedback" to "反馈", "history" to "历史", "automation-prefs" to "自动化偏好", "voice-notes" to "语音笔记", "role" to "角色")
private data class MemoryFolder(val dir: String, val files: List<Api.Entry>)
private suspend fun optionalFile(path: String): String = try { Api.readFile(path) } catch(e: Api.ApiError) { if(e.code == 404) "" else throw e }

@Composable
fun MemoryScreen(bottom: Dp) {
    val (state, _) = load("state") { Api.getJson("/api/state") }
    val (profile, profileError) = load("profile") { optionalFile(PROFILE) }
    val (health, healthError) = load("health") { Api.health() }
    val (folders, folderError) = load("memcats") { coroutineScope {
        Api.treeOrEmpty("data/memory").filter { it.dir && it.name != "profile" && it.name in categories }.map { dir -> async {
            MemoryFolder(dir.name, Api.treeOrEmpty("data/memory/${dir.name}").filter { !it.dir }.sortedByDescending { it.mtime })
        } }.awaitAll().sortedBy { categories.keys.indexOf(it.dir) }
    } }
    LazyColumn(contentPadding=pagePadding(bottom)) {
        item { PageHeader("记忆") { SettingsButton() } }
        item {
            Column(Modifier.fillMaxWidth().card(radius=24.dp).padding(20.dp)) {
                Row(verticalAlignment=Alignment.CenterVertically) {
                    Text("我对 ${state?.optString("userCall")?.ifBlank { null } ?: "你"} 的了解", fontSize = Type.Page, fontFamily = Type.titleFamily, fontWeight=FontWeight.Bold, color=Pal.Ink, modifier=Modifier.weight(1f))
                    Icon(Icons.Outlined.AutoAwesome, null, tint=Pal.Gold, modifier=Modifier.size(24.dp))
                }
                Spacer(Modifier.height(16.dp))
                when {
                    profile == null && profileError.isNotBlank() -> ErrorNote(profileError)
                    profile == null -> Loading()
                    profile.isBlank() -> EmptyNote("还是空的，聊得越多越完整")
                    else -> {
                        val excerpt = profile.lines().filterNot { it.trimStart().startsWith("#") || it.startsWith("更新") }.filter { it.isNotBlank() }.take(4).joinToString("\n")
                        Markdown(excerpt, fontSize=15) { Nav.open(memoryDoc(it)) }
                        Text("查看全部", fontSize = Type.Secondary, color=Pal.Link, modifier=Modifier.padding(top=14.dp).tap { Nav.open(Route.Doc("我对你的了解", PROFILE, pointers=true)) })
                    }
                }
            }
        }
        item { SectionTitle("全部") }
        item {
            val today = health?.today
            Column(Modifier.fillMaxWidth().card().tap { Nav.open(Route.Health) }.padding(20.dp)) {
                Text("健康", fontSize = Type.Body, fontWeight=FontWeight.SemiBold, color=Pal.Ink)
                val slots = listOf("sleep" to "睡眠", "resting_heart_rate" to "静息心率", "steps" to "步数", "hrv" to "心率变异性")
                slots.chunked(2).forEach { row -> Row(Modifier.fillMaxWidth().padding(top=16.dp)) {
                    row.forEach { (key, label) ->
                        val value = when (key) {
                            "sleep" -> sleepLabel(today?.sleepMinutes)
                            "resting_heart_rate" -> healthNumber(today?.restingHr)
                            "steps" -> healthNumber(today?.steps)
                            else -> healthNumber(today?.hrv)
                        }
                        val unit = if (value == "--") "" else when (key) { "resting_heart_rate" -> "bpm"; "steps" -> "步"; "hrv" -> "ms"; else -> "" }
                        Column(Modifier.weight(1f)) {
                            Text(label, fontSize = Type.Label, color=Pal.Muted)
                            Row(verticalAlignment=Alignment.Bottom, horizontalArrangement=Arrangement.spacedBy(4.dp)) {
                                Text(value, fontSize = Type.Number, fontWeight=FontWeight.Bold, color=Pal.Ink)
                                Text(unit, fontSize = Type.Tiny, color=Pal.Muted, modifier=Modifier.padding(bottom=4.dp))
                            }
                        }
                    }
                } }
                if(health?.days?.all { it.sleepMinutes == null && it.restingHr == null && it.steps == null && it.hrv == null } != false) Text("还没有健康数据", fontSize = Type.Tiny, color=Pal.Faint, modifier=Modifier.padding(top=14.dp))
                if(healthError.isNotBlank()) ErrorNote(healthError)
            }
        }
        item {
            val voice = folders?.firstOrNull { it.dir == "voice-notes" }?.files.orEmpty()
            Column(Modifier.fillMaxWidth().padding(top=12.dp).card().tap { Nav.open(Route.MemoryCategory("voice-notes")) }.padding(20.dp)) {
                Row(verticalAlignment=Alignment.CenterVertically, horizontalArrangement=Arrangement.spacedBy(12.dp)) {
                    IconTile(Icons.Outlined.KeyboardVoice, Pal.Link)
                    Column {
                        Text("语音笔记", fontSize = Type.Body, fontWeight=FontWeight.SemiBold, color=Pal.Ink)
                        Text(if(voice.isEmpty()) "按住说话发的语音笔记会出现在这里" else "${voice.size} 条 · 最近 ${whenLabel(voice.first().mtime)}", fontSize = Type.Label, lineHeight = Type.SecondaryLine, color=Pal.Muted)
                    }
                }
            }
        }
        if(folderError.isNotBlank()) item { ErrorNote(folderError) }
        folders.orEmpty().filter { it.dir !in setOf("health", "voice-notes") && it.files.isNotEmpty() }.chunked(2).forEach { pair -> item {
            Row(Modifier.padding(top=16.dp), horizontalArrangement=Arrangement.spacedBy(12.dp)) {
                pair.forEach { folder ->
                    val tint = Pal.Link
                    Column(Modifier.weight(1f).tap { Nav.open(Route.MemoryCategory(folder.dir)) }) {
                        Box(Modifier.padding(start=14.dp).width(54.dp).height(9.dp).background(tint.copy(alpha=.18f),RoundedCornerShape(topStart=8.dp,topEnd=8.dp)))
                        Column(Modifier.fillMaxWidth().card(radius=18.dp).padding(18.dp)) {
                            Icon(Icons.Outlined.Folder, null, tint=tint, modifier=Modifier.size(24.dp))
                            Text(categories[folder.dir].orEmpty(), fontSize = Type.Body, fontWeight=FontWeight.SemiBold, color=Pal.Ink, modifier=Modifier.padding(top=12.dp))
                            Text("${folder.files.size} 项", fontSize = Type.Label, color=Pal.Muted, modifier=Modifier.padding(top=4.dp))
                            Text(folder.files.first().name.removeSuffix(".md"), fontSize = Type.Tiny, color=Pal.Faint, maxLines=1, overflow=TextOverflow.Ellipsis, modifier=Modifier.padding(top=6.dp))
                        }
                    }
                }
                if(pair.size == 1) Spacer(Modifier.weight(1f))
            }
        } }
    }
}

@Composable
fun MemoryCategoryScreen(dir: String) {
    val c = ctx()
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    val (files,error) = load("mem:$dir") { Api.treeOrEmpty("data/memory/$dir").filter { !it.dir } }
    SubPage(categories[dir] ?: dir) {
        item { BigTitle(categories[dir] ?: dir, files?.let { "${it.size} 项" }) }
        item { when {
            files == null && error.isNotBlank() -> ErrorNote(error)
            files == null -> Loading()
            files.isEmpty() -> EmptyNote("这里还是空的")
            else -> CardList { files.forEachIndexed { i,file ->
                if(i > 0) Hairline()
                ListRow(file.name.removeSuffix(".md"), "更新于 ${whenLabel(file.mtime)}", Icons.Outlined.Folder, Pal.Link) {
                    if(file.name.endsWith(".md")) Nav.open(memoryDoc("$dir/${file.name}"))
                    else scope.launch { openFile(c, "data/memory/$dir/${file.name}", file.name) }
                }
            } }
        } }
    }
}
