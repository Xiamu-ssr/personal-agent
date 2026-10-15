package com.xiamu.agent.ui

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
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
            SegTabs(listOf("活动","权限","电脑","定时","记忆"),tab) { tab=it }
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when(tab) {
                    0 -> ActivitiesPanel()
                    1 -> PermissionsPanel()
                    2 -> ComputerPanel()
                    3 -> SchedulesPanel()
                    4 -> MemoryCards()
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
    suspend fun fetch(older: Boolean=false) {
        loading=true
        try { timeline=timeline.apply(Api.activities(if(older) timeline.next else null),older); error="" }
        catch(e: CancellationException) { throw e } catch(e: Exception) { error=e.message ?: "活动加载失败" } finally { loading=false }
    }
    LaunchedEffect(Chat.activityVersion.intValue) { fetch() }
    LazyColumn(contentPadding=PaddingValues(bottom=20.dp)) {
        if(timeline.running.isNotEmpty()) item { SectionTitle("进行中") }
        timeline.running.forEach { a -> item(key="running:${a.id}") { CardList(Modifier.padding(bottom=8.dp)) {
            ListRow(a.label,"已运行 ${elapsed(a.started)}",Icons.Outlined.Pending,onClick={Nav.open(Route.ActivityDetail(a.id,a.label))},trailing={QuietButton("停止") { scope.launch { runCatching { Api.postJson("/api/activities/${Api.encode(a.id)}/stop") }.onFailure { error=it.message ?: "停止失败" } } }})
        } } }
        groupActivities(timeline.recent).forEach { (group,records) ->
            item { SectionTitle(group.label) }
            records.forEach { a -> item(key=a.id) { ListRow(a.title,"${clock(a.ts)} · ${a.status.label}",Icons.Outlined.CheckCircleOutline,onClick={Nav.open(Route.ActivityDetail(a.id,a.title))}) } }
        }
        if(loading) item { Loading() }
        if(error.isNotBlank()) item { ErrorNote(error); QuietButton("重试") { scope.launch { fetch() } } }
        if(timeline.recent.isEmpty() && timeline.running.isEmpty() && !loading) item { EmptyNote("今天还没有活动。") }
        if(timeline.next!=null && !loading) item { RowActions("更早的活动") { scope.launch { fetch(true) } } }
    }
}
@Composable
private fun PermissionsPanel() {
    val (loaded,error)=load("settings") { Api.settings() }
    var settings by remember(loaded) { mutableStateOf(loaded) }
    var saving by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf("") }
    val scope=rememberCoroutineScope()
    Column(Modifier.padding(top=22.dp)) {
        Text("权限",style=Type.title(20),color=Pal.Ink)
        Spacer(Modifier.height(12.dp))
        settings?.let { current -> CardList { current.permissionModes.forEachIndexed { i,o ->
            if(i>0) Hairline()
            ListRow(o.label,o.note,subLines=3,trailing={RadioButton(current.permissionMode==o.id,null,enabled=!saving)},onClick={
                if(!saving && o.id!=current.permissionMode) { saving=true; scope.launch {
                    try { settings=Api.saveSettings(permissionMode=o.id); invalidateCache("settings") }
                    catch(e: CancellationException) { throw e } catch(e: Exception) { note=e.message ?: "保存失败" } finally { saving=false }
                } }
            })
        } } }
        if(error.isNotBlank() || note.isNotBlank()) ErrorNote(error.ifBlank { note })
        FooterNote("从下一轮主聊天生效。")
    }
}
@Composable
private fun ComputerPanel() {
    val (connections,error)=load("connectors") { com.xiamu.agent.connectors.CloudConnectors.list() }
    LazyColumn {
        item { SectionTitle("云端浏览器"); BrowserPreview(true) }
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
