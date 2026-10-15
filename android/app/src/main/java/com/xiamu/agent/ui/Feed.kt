package com.xiamu.agent.ui

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.*
import com.xiamu.agent.*
import kotlinx.coroutines.*

@Composable
fun FeedScreen(bottom: Dp) {
    val scope=rememberCoroutineScope()
    val list=rememberLazyListState()
    var timeline by remember { mutableStateOf(FeedTimeline()) }
    var loading by remember { mutableStateOf(false) }
    var loaded by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var notice by remember { mutableStateOf("") }
    var request by remember { mutableStateOf("") }
    suspend fun fetch(older: Boolean = false) {
        if(loading) return
        loading=true; error=""
        try { timeline=timeline.apply(Api.feed(if(older) timeline.next else null),older); loaded=true }
        catch(e: CancellationException) { throw e }
        catch(e: Exception) { error=e.message ?: "动态加载失败" }
        finally { loading=false }
    }
    DisposableEffect(Unit) { Chat.enterFeed(); onDispose { Chat.leaveFeed() } }
    LaunchedEffect(Chat.feedVersion.intValue,Chat.filesVersion.intValue) { fetch() }
    val nearEnd by remember { derivedStateOf { list.layoutInfo.visibleItemsInfo.lastOrNull()?.index?.let { it>=list.layoutInfo.totalItemsCount-2 } ?: false } }
    LaunchedEffect(list) { snapshotFlow { timeline.next?.takeIf { nearEnd && loaded && !loading && error.isBlank() } }.collect { if(it!=null) fetch(true) } }
    val context=ctx()
    LazyColumn(state=list,modifier=Modifier.fillMaxSize(),contentPadding=pagePadding(bottom)) {
        item { Row(Modifier.fillMaxWidth().padding(top=8.dp,bottom=12.dp),verticalAlignment=Alignment.CenterVertically) { Text("动态",style=Type.title(23),color=Pal.Ink,modifier=Modifier.weight(1f)); QuietButton("刷新") { scope.launch { runCatching { Api.postJson("/api/feed/refresh") }.onSuccess { notice=if(it.optString("mode")=="skipped") "正在查看，稍后会有新动态" else "豆豆正在看最新消息" }.onFailure { notice=it.message ?: "刷新失败" } } } } }
        item { OutlinedTextField(request,{request=it},placeholder={Text("想看什么")},singleLine=true,shape=RoundedCornerShape(28.dp),modifier=Modifier.fillMaxWidth().padding(bottom=20.dp),keyboardOptions=KeyboardOptions(imeAction=ImeAction.Send),keyboardActions=KeyboardActions(onSend={if(request.isNotBlank()) { Draft.send(context,request,includeDraft=false); request="" }}),trailingIcon={IconButton(onClick={ if(request.isNotBlank()) { Draft.send(context,request,includeDraft=false); request="" } }) { Icon(Icons.Outlined.ArrowUpward,"发送想看的内容") }}) }
        if(notice.isNotBlank()) item { FooterNote(notice) }
        var date=""
        timeline.items.forEach { post ->
            if(post.date!=date) { date=post.date; item(key="day:${post.date}") { Text(dayTitle(post.date),style=Type.body(12),color=Pal.Muted,modifier=Modifier.padding(bottom=16.dp,top=12.dp)) } }
            item(key=post.path) { FeedPostView(post) }
        }
        if(loading) item { Loading() }
        if(error.isNotBlank()) item { ErrorNote(error); QuietButton("重试") { scope.launch { fetch() } } }
        if(loaded && timeline.items.isEmpty()) item { EmptyNote("有新鲜事时，豆豆会放在这里。") }
        if(!loading && timeline.next!=null) item { RowActions("更早的动态") { scope.launch { fetch(true) } } }
    }
}

@Composable
private fun FeedPostView(post: FeedPost) {
    val scope=rememberCoroutineScope()
    val context=ctx()
    var reaction by remember(post.path) { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    fun feedback(action: String) {
        if(sending) return
        sending=true
        scope.launch {
            try { Api.feedback(post.path,action); if(action=="discuss") Nav.home(0) else reaction=action }
            catch(e: CancellationException) { throw e }
            catch(e: Exception) { error=e.message ?: "反馈失败" }
            finally { sending=false }
        }
    }
    Row(Modifier.fillMaxWidth().padding(bottom=18.dp),horizontalArrangement=Arrangement.spacedBy(10.dp)) {
        Text(post.icon,fontSize=26.sp,modifier=Modifier.width(32.dp))
        Column(Modifier.weight(1f)) {
            Text(post.source,style=Type.body(11),color=Pal.Muted.copy(alpha=.75f))
            Text(post.title,style=Type.title(15),color=Pal.Ink,modifier=Modifier.padding(top=5.dp,bottom=5.dp))
            Markdown(post.body,fontSize=13,lineHeightMultiplier=1.65f)
            if(post.showOriginalLink) Text("阅读原文 ↗",style=Type.body(12),color=Pal.Link,modifier=Modifier.tap { openBrowser(context,post.url) }.padding(vertical=7.dp))
            post.image?.let { ContentImage(it,Modifier.fillMaxWidth().height(180.dp).clip(RoundedCornerShape(15.dp))) }
            Row(Modifier.fillMaxWidth().padding(top=8.dp),verticalAlignment=Alignment.CenterVertically) {
                IconButton(onClick={feedback("like")},enabled=!sending,modifier=Modifier.size(36.dp)) { Icon(if(reaction=="like") Icons.Outlined.ThumbUpAlt else Icons.Outlined.ThumbUpOffAlt,"赞",tint=if(reaction=="like") Pal.Ink else Pal.Muted,modifier=Modifier.size(19.dp)) }
                IconButton(onClick={feedback("dislike")},enabled=!sending,modifier=Modifier.size(36.dp)) { Icon(if(reaction=="dislike") Icons.Outlined.ThumbDownAlt else Icons.Outlined.ThumbDownOffAlt,"踩",tint=if(reaction=="dislike") Pal.Ink else Pal.Muted,modifier=Modifier.size(19.dp)) }
                TextButton(onClick={feedback("discuss")},enabled=!sending,contentPadding=PaddingValues(horizontal=5.dp),modifier=Modifier.height(36.dp)) { Icon(Icons.Outlined.ChatBubbleOutline,null,modifier=Modifier.size(17.dp)); Text(" 讨论",style=Type.body(12),color=Pal.Ink) }
                Spacer(Modifier.weight(1f))
                Text(publishedAgo(post.published),style=Type.body(10),color=Pal.Muted,maxLines=1)
            }
            if(error.isNotBlank()) ErrorNote(error)
        }
    }
    Hairline(); Spacer(Modifier.height(18.dp))
}
private fun publishedAgo(value: String): String = runCatching { ago(java.time.LocalDateTime.parse(value.replace(" ","T")).atZone(java.time.ZoneId.systemDefault()).toInstant().toEpochMilli()) }.getOrDefault(value)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FeedSettingsSheet() {
    val (settings,error)=load("feed-settings",cacheValue=false,revision=Chat.feedSettingsVersion.intValue) { Api.feedSettings() }
    val scope=rememberCoroutineScope()
    ModalBottomSheet(onDismissRequest={Nav.feedSettings.value=false},sheetState=rememberModalBottomSheetState(skipPartiallyExpanded=true),containerColor=Pal.Background) {
        Box(Modifier.fillMaxWidth().fillMaxHeight(.9f)) {
        if(settings==null) { if(error.isBlank()) Loading() else ErrorNote(error) }
        settings?.let { original ->
            var instructions by remember(original) { mutableStateOf(original.instructions) }
            var enabled by remember(original) { mutableStateOf(original.enabled) }
            var interval by remember(original) { mutableIntStateOf(original.interval) }
            var start by remember(original) { mutableStateOf(original.start) }
            var end by remember(original) { mutableStateOf(original.end) }
            var saving by remember { mutableStateOf(false) }
            var note by remember { mutableStateOf("") }
            Column(Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(horizontal=20.dp).navigationBarsPadding()) {
                Text("动态说明",style=Type.title(21),color=Pal.Ink)
                Text("修改会用于下一次动态。",style=Type.body(13),color=Pal.Muted,modifier=Modifier.padding(vertical=8.dp))
                OutlinedTextField(instructions,{instructions=it},modifier=Modifier.fillMaxWidth(),minLines=6,maxLines=12,shape=RoundedCornerShape(20.dp))
                ListRow("自动更新",trailing={GoldSwitch(enabled,{enabled=it})})
                SegTabs(listOf("15 分钟","30 分钟","60 分钟"),listOf(15,30,60).indexOf(interval)) { interval=listOf(15,30,60)[it] }
                Row(Modifier.padding(vertical=12.dp),horizontalArrangement=Arrangement.spacedBy(12.dp)) {
                    OutlinedTextField(start,{start=it},label={Text("开始时段")},singleLine=true,modifier=Modifier.weight(1f))
                    OutlinedTextField(end,{end=it},label={Text("结束时段")},singleLine=true,modifier=Modifier.weight(1f))
                }
                if(note.isNotBlank()) ErrorNote(note)
                GoldButton(if(saving) "保存中…" else "保存",Modifier.fillMaxWidth().padding(bottom=24.dp),!saving) {
                    saving=true
                    scope.launch { try { Api.saveFeedSettings(FeedSettings(enabled,interval,start,end,instructions)); Nav.feedSettings.value=false }
                        catch(e: CancellationException) { throw e } catch(e: Exception) { note=e.message ?: "保存失败" } finally { saving=false } }
                }
            }
        }
    }
    }
}
