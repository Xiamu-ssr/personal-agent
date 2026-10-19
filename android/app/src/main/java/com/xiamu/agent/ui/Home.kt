package com.xiamu.agent.ui

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.xiamu.agent.*
import kotlinx.coroutines.launch

val mainTabs=listOf("聊天","动态","点子","目标","资源库")
val FloatingHeaderSpace get()=if(Nav.tab.intValue==0) 96.dp else 64.dp
private val tabIcons=listOf(Icons.Outlined.ChatBubbleOutline,Icons.Outlined.Feed,Icons.Outlined.Lightbulb,Icons.Outlined.CheckBox,Icons.Outlined.Category)
@Composable
fun HomeHeader(sideChat: Boolean = false) {
    Box(Modifier.fillMaxWidth().height(FloatingHeaderSpace).background(Pal.Background).padding(horizontal=16.dp,vertical=8.dp)) {
        Box(Modifier.align(Alignment.TopStart).padding(top=8.dp)) { CircleButton(Icons.Outlined.Menu,"打开抽屉") { Nav.drawer.value=true } }
        Box(Modifier.align(Alignment.TopCenter)) {
            if(Nav.tab.intValue==0) AvatarLabel(subtitle=if(sideChat) "旁聊" else null) { Nav.console.value=true }
            else Text(mainTabs[Nav.tab.intValue],style=Type.title(19),color=Pal.Ink,modifier=Modifier.padding(top=17.dp))
        }
        if(sideChat) Box(Modifier.align(Alignment.TopEnd).padding(top=8.dp)) { CircleButton(Icons.Outlined.Close,"回到主聊天") { Nav.home(0) } }
        else if(Nav.tab.intValue==1) Box(Modifier.align(Alignment.TopEnd).padding(top=8.dp)) { CircleButton(Icons.Outlined.Tune,"调节动态") { Nav.feedSettings.value=true } }
    }
}
@Composable
fun MainNavBar() {
    Row(Modifier.widthIn(max=390.dp).fillMaxWidth().height(64.dp).clip(RoundedCornerShape(24.dp)).background(Pal.Card).padding(horizontal=5.dp,vertical=4.dp),verticalAlignment=Alignment.CenterVertically) {
        mainTabs.forEachIndexed { index,label ->
            val selected=Nav.tab.intValue==index
            Box(Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(18.dp)).tap { Nav.home(index) },contentAlignment=Alignment.Center) {
                Column(horizontalAlignment=Alignment.CenterHorizontally,verticalArrangement=Arrangement.spacedBy(3.dp)) {
                    Box(Modifier.width(44.dp).height(28.dp).background(if(selected) Pal.Field else Color.Transparent,CircleShape),contentAlignment=Alignment.Center) {
                        Icon(tabIcons[index],label,tint=if(selected) Pal.Ink else Pal.Muted,modifier=Modifier.size(21.dp))
                    }
                    Text(label,style=Type.body(10),color=if(selected) Pal.Ink else Pal.Muted)
                }
                if(index==1 && Chat.feedUnread.value) Box(Modifier.align(Alignment.TopEnd).padding(top=5.dp,end=13.dp).size(6.dp).background(Color(0xFFED4747),CircleShape))
            }
        }
    }
}
@Composable
fun RowActions(label: String,onClick: () -> Unit) { Box(Modifier.fillMaxWidth().padding(horizontal=20.dp,vertical=8.dp),contentAlignment=Alignment.CenterEnd) { QuietButton(label,onClick) } }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SideDrawer() {
    ModalNavigationDrawer(drawerState=rememberDrawerState(DrawerValue.Open),drawerContent={
        ModalDrawerSheet(drawerContainerColor=Pal.Background,modifier=Modifier.fillMaxWidth(.86f)) {
            Column(Modifier.fillMaxSize().statusBarsPadding().padding(horizontal=20.dp)) {
                Row(Modifier.fillMaxWidth().padding(vertical=20.dp),verticalAlignment=Alignment.CenterVertically) {
                    Text(Chat.agentName.value,style=Type.title(22),color=Pal.Ink,modifier=Modifier.weight(1f))
                    CircleButton(Icons.Outlined.Close,"关闭抽屉") { Nav.drawer.value=false }
                }
                GoldButton("新旁聊",Modifier.fillMaxWidth().padding(bottom=12.dp)) { Nav.sideChat() }
                mainTabs.forEachIndexed { i,label ->
                    ListRow(label,icon=tabIcons[i],onClick={Nav.home(i)})
                }
                Hairline(); SectionTitle("旁聊")
                SideChatList(Modifier.weight(1f))
                ListRow("设置",icon=Icons.Outlined.Settings,onClick={Nav.open(Route.Settings)})
                Spacer(Modifier.navigationBarsPadding())
            }
        }
    },content={ Box(Modifier.fillMaxSize().tap { Nav.drawer.value=false }) })
}

@Composable
private fun SideChatList(modifier: Modifier) {
    val scope=rememberCoroutineScope()
    var timeline by remember { mutableStateOf(ActivitiesTimeline()) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    suspend fun fetch(older: Boolean=false) {
        if(loading) return
        loading=true
        try {
            var value=timeline.apply(Api.activities(if(older) timeline.next else null),older)
            // The shared activity index can contain a page with no side chats.
            while(sideChatEntries(value).size<12 && value.next!=null) {
                val cursor=value.next
                value=value.apply(Api.activities(cursor),true)
                check(value.next==null || value.next!!<cursor!!) { "旁聊分页游标没有前进" }
            }
            timeline=value; error=""
        } catch(e: kotlinx.coroutines.CancellationException) { throw e }
        catch(e: Exception) { error=e.message ?: "旁聊列表加载失败" }
        finally { loading=false }
    }
    LaunchedEffect(Chat.activityVersion.intValue) { fetch() }
    LazyColumn(modifier) {
        val entries=sideChatEntries(timeline)
        entries.forEach { entry -> item(key=entry.id) {
            ListRow(entry.title,if(entry.status==ActivityStatus.Running) "正在聊" else whenLabel(entry.time),Icons.Outlined.ChatBubbleOutline,onClick={Nav.sideChat(entry.id)})
        } }
        if(loading) item { Loading() }
        if(error.isNotBlank()) item { ErrorNote(error); QuietButton("重试") { scope.launch { fetch() } } }
        if(!loading && entries.isEmpty() && error.isBlank()) item { EmptyNote("想单独聊的事，可以从新旁聊开始。") }
        if(!loading && timeline.next!=null) item { QuietButton("更早的旁聊") { scope.launch { fetch(true) } } }
    }
}
@Composable
fun AppearanceScreen() {
    SubPage("外观") {
        item { Spacer(Modifier.height(20.dp)); CardList {
            listOf("system" to "跟随系统","light" to "浅色","dark" to "深色").forEachIndexed { i,(key,label) ->
                if(i>0) Hairline()
                ListRow(label,trailing={ RadioButton(ThemeState.preference.value==key,{ThemeState.select(key)}) },onClick={ThemeState.select(key)})
            }
        } }
    }
}

@Composable
fun ServerScreen() {
    var server by remember { mutableStateOf(Prefs.server) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    val scope=rememberCoroutineScope()
    val context=ctx()
    SubPage("云端地址") {
        item { Spacer(Modifier.height(24.dp)); OutlinedTextField(server,{server=it},label={Text("云端地址")},singleLine=true,modifier=Modifier.fillMaxWidth(),shape=RoundedCornerShape(18.dp)); FooterNote("保存时会验证与云端的连接。") }
        if(error.isNotBlank()) item { ErrorNote(error) }
        item { GoldButton(if(saving) "正在连接…" else "保存",Modifier.fillMaxWidth().padding(top=24.dp),!saving && server.isNotBlank()) {
            saving=true
            scope.launch {
                try {
                    Api.login(server,Prefs.token)
                    Chat.reset(); Draft.reset(); Voice.cancel(); com.xiamu.agent.media.Images.clear(); clearCache()
                    Chat.connect(); com.xiamu.agent.device.DeviceService.start(context,reregister=true); Nav.back()
                } catch(e: kotlinx.coroutines.CancellationException) { throw e }
                catch(e: Exception) { error=e.message ?: "连接失败" }
                finally { saving=false }
            }
        } }
    }
}
