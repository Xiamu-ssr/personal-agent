package com.xiamu.agent.ui

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.xiamu.agent.*
import kotlinx.coroutines.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AvatarConsole() {
    var tab by remember { mutableIntStateOf(0) }
    val sideRoute=Nav.stack.filterIsInstance<Route.SideChat>().lastOrNull()
    val sideSession=sideRoute?.id?.let(SideChats::session)
    val scope=rememberCoroutineScope()
    ModalBottomSheet(onDismissRequest={Nav.console.value=false},sheetState=rememberModalBottomSheetState(skipPartiallyExpanded=true),containerColor=Pal.Background) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(.94f).navigationBarsPadding().padding(horizontal=16.dp)) {
            Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically) {
                CircleButton(Icons.Outlined.Close,"关闭控制台") { Nav.console.value=false }
                Column(Modifier.weight(1f),horizontalAlignment=Alignment.CenterHorizontally) { Avatar(64.dp); Text(Chat.agentName.value,style=Type.title(20),color=Pal.Ink); Text(if(Chat.avatar.value.state=="working") Chat.avatar.value.text.ifBlank { "努力工作中" } else if(Chat.connected.value) "在线" else "连接中",style=Type.body(12),color=Pal.Muted) }
                Spacer(Modifier.size(42.dp))
            }
            Spacer(Modifier.height(16.dp))
            SegTabs(listOf("活动","设备","定时","记忆"),tab) { tab=it }
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when(tab) {
                    0 -> ActivitiesPanel()
                    1 -> ComputerPanel()
                    2 -> SchedulesPanel()
                    3 -> MemoryCards()
                }
            }
            GoldButton(if(sideRoute!=null) "停止旁聊" else "停止当前回复",Modifier.fillMaxWidth().padding(vertical=12.dp),
                if(sideRoute!=null) sideSession?.busy?.value==true else Chat.busy.value) {
                if(sideSession==null) Chat.interrupt() else scope.launch {
                    try { Api.postJson("/api/activities/${Api.encode(sideSession.id)}/stop"); sideSession.refresh() }
                    catch(e: CancellationException) { throw e }
                    catch(e: Exception) { sideSession.error.value=e.message ?: "停止旁聊失败" }
                }
            }
        }
    }
}
@Composable
private fun ActivitiesPanel() {
    val scope=rememberCoroutineScope()
    var timeline by remember { mutableStateOf(ActivitiesTimeline()) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    val updates=Chat.activityUpdates.toMap()
    suspend fun fetch(older: Boolean=false) {
        loading=true
        try { timeline=timeline.apply(Api.activities(if(older) timeline.next else null),older).updated(Chat.activityUpdates.values); error="" }
        catch(e: CancellationException) { throw e } catch(e: Exception) { error=e.message ?: "活动加载失败" } finally { loading=false }
    }
    LaunchedEffect(Chat.activityVersion.intValue) { fetch() }
    LaunchedEffect(updates) { timeline=timeline.updated(updates.values) }
    LazyColumn(contentPadding=PaddingValues(bottom=20.dp)) {
        if(timeline.running.isNotEmpty()) item { SectionTitle("进行中") }
        timeline.running.forEach { a -> item(key="running:${a.id}") {
            ActivityRow(a.label,a.summary,"${clock(a.started)} · 进行中",Icons.Outlined.Pending,onClick={Nav.open(Route.ActivityDetail(a.id,a.label))},trailing={QuietButton("停止") { scope.launch { runCatching { Api.postJson("/api/activities/${Api.encode(a.id)}/stop") }.onFailure { error=it.message ?: "停止失败" } } }})
        } }
        groupActivities(timeline.recent).forEach { (group,records) ->
            item { SectionTitle(group.label) }
            records.forEach { a -> item(key=a.id) { ActivityRow(a.title,a.summary,"${clock(a.ts)} · ${a.status.label}",Icons.Outlined.CheckCircleOutline,onClick={Nav.open(Route.ActivityDetail(a.id,a.title))}) } }
        }
        if(loading) item { Loading() }
        if(error.isNotBlank()) item { ErrorNote(error); QuietButton("重试") { scope.launch { fetch() } } }
        if(timeline.recent.isEmpty() && timeline.running.isEmpty() && !loading) item { EmptyNote("今天还没有活动。") }
        if(timeline.next!=null && !loading) item { RowActions("更早的活动") { scope.launch { fetch(true) } } }
    }
}
@Composable
private fun ActivityRow(title: String,summary: String,time: String,icon: ImageVector,onClick: () -> Unit,trailing: (@Composable () -> Unit)? = null) {
    Row(Modifier.fillMaxWidth().tap(onClick=onClick).padding(vertical=12.dp),verticalAlignment=Alignment.Top) {
        Box(Modifier.padding(top=2.dp).size(32.dp).background(Pal.Quiet,CircleShape),contentAlignment=Alignment.Center) {
            Icon(icon,null,tint=Pal.Icon,modifier=Modifier.size(18.dp))
        }
        Column(Modifier.weight(1f).padding(start=12.dp)) {
            Text(title,style=Type.title(15),color=Pal.Ink,maxLines=1,overflow=TextOverflow.Ellipsis)
            if(summary.isNotBlank()) Text(summary,style=Type.body(13),color=Pal.Muted,maxLines=1,overflow=TextOverflow.Ellipsis,modifier=Modifier.padding(top=3.dp))
            Text(time,style=Type.body(12),color=Pal.Faint,modifier=Modifier.padding(top=3.dp))
        }
        trailing?.let { Box(Modifier.padding(start=8.dp)) { it() } }
    }
}
@Composable
private fun ComputerPanel() {
    val (connections,error)=load("connectors") { com.xiamu.agent.connectors.CloudConnectors.list() }
    LazyColumn {
        item { SectionTitle("在线设备") }
        connections?.others?.forEach { d -> item { CardList(Modifier.padding(bottom=8.dp)) { ListRow(d.name,if(d.online) "在线" else "离线",deviceIcon(d.kind),onClick={Nav.open(Route.Connectors(2,d.id))}) } } }
        if(error.isNotBlank()) item { ErrorNote(error) }
    }
}
@Composable
private fun SchedulesPanel() {
    val (loaded,error)=load("schedules",cacheValue=false,revision=Chat.activityVersion.intValue+Chat.feedSettingsVersion.intValue) { Api.getJson("/api/schedules").optJSONArray("items").objects() }
    val scope=rememberCoroutineScope()
    var notice by remember { mutableStateOf("") }
    val changes=remember { mutableStateMapOf<String,Boolean>() }
    LazyColumn {
        item { SectionTitle("定时安排") }
        loaded.orEmpty().forEach { s -> item(key=s.optString("id")) {
            val id=s.optString("id"); val enabled=changes[id] ?: s.optBoolean("enabled")
            Column(Modifier.padding(bottom=10.dp).fillMaxWidth().card().padding(horizontal=16.dp,vertical=4.dp)) {
                ListRow(s.optString("name").ifBlank { id },if(id=="feed") "${s.optString("start")}–${s.optString("end")} · 每 ${s.optInt("interval")} 分钟" else cronLabel(s.optString("cron")),subLines=2,trailing={GoldSwitch(enabled) { want -> scope.launch {
                    try { Api.putJson("/api/schedules/${Api.encode(id)}",org.json.JSONObject().put("enabled",want)); changes[id]=want }
                    catch(e: CancellationException) { throw e } catch(e: Exception) { notice=e.message ?: "保存失败" }
                } }})
                Text("下次 · ${s.optString("nextRun").takeIf { !s.isNull("nextRun") } ?: "暂无安排"}",style=Type.body(11),color=Pal.Muted)
                RowActions(if(s.optBoolean("running")) "正在运行" else "立即运行") { scope.launch {
                    try { val r=Api.postJson("/api/schedules/${Api.encode(id)}/run"); notice=if(r.optString("mode")=="skipped") "已经在运行" else "已安排运行" }
                    catch(e: CancellationException) { throw e } catch(e: Exception) { notice=e.message ?: "运行失败" }
                } }
            }
        } }
        if(error.isNotBlank()) item { ErrorNote(error) }
        if(notice.isNotBlank()) item { FooterNote(notice) }
    }
}
fun cronLabel(c: String): String {
    val p=c.trim().split(Regex("\\s+")); if(p.size!=5) return c
    val minute=p[0].toIntOrNull(); val hour=p[1].toIntOrNull()
    return when {
        minute!=null && hour!=null -> when(p[4]) { "*"->"每天"; "1"->"每周一"; "1-5"->"工作日"; else->"每周 ${p[4]}" }+" %02d:%02d".format(hour,minute)
        p[1].startsWith("*/") -> "每 ${p[1].drop(2)} 小时"
        else -> c
    }
}
