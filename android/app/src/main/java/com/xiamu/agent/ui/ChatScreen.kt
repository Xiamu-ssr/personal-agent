package com.xiamu.agent.ui

import android.graphics.Bitmap
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.automirrored.outlined.Article
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Alarm
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.rounded.Pause
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.animation.core.*
import androidx.compose.ui.draw.alpha
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xiamu.agent.Attachment
import com.xiamu.agent.Chat
import com.xiamu.agent.ChatItem
import com.xiamu.agent.device.DeviceService
import com.xiamu.agent.media.Images
import com.xiamu.agent.media.VoicePlayer
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun ChatScreen(list: LazyListState, bottom: Dp, scroll: ConversationScrollState = remember { ConversationScrollState() }) {
    val items = Chat.items
    val streaming = Chat.streaming.value
    val busy = Chat.busy.value
    val extra = if ((busy && !Chat.turnClosed.value) || streaming.isNotBlank()) 1 else 0
    var searching by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    var highlight by remember { mutableIntStateOf(-1) }
    val scope = rememberCoroutineScope()
    var headerH by remember { mutableIntStateOf(0) }
    val density = LocalDensity.current
    BindConversationScroll(list, scroll, items.count { it is ChatItem.User || it is ChatItem.Assistant } + if (streaming.isNotBlank()) 1 else 0,
        "${items.size}:${streaming.length}:$busy", Draft.sentVersion.intValue, bottom)

    Box(Modifier.fillMaxSize()) {
        LazyColumn(
            state = list,
            modifier = Modifier.fillMaxSize().testTag("chat-list"),
            contentPadding = PaddingValues(start = 18.dp, end = 18.dp, top = with(density) { headerH.toDp() } + 2.dp, bottom = bottom + 14.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            if (items.isEmpty() && !busy) item { EmptyChat() }
            itemsIndexed(items) { i, it -> ChatRow(it, highlight == i) }
            if (extra == 1) item { Streaming(streaming, Chat.toolHint.value, busy && !Chat.turnClosed.value) }
        }
        ReturnToBottom(list, scroll, Modifier.align(Alignment.BottomEnd).padding(end = 20.dp, bottom = bottom + 20.dp))
        // Header floats over the list with a fade so messages scroll under it.
        Column(
            Modifier.fillMaxWidth().background(
                androidx.compose.ui.graphics.Brush.verticalGradient(0f to Pal.Background, .9f to Pal.Background, 1f to Pal.Background.copy(alpha = 0f)),
            ).onSizeChanged { headerH = it.height }.statusBarsPadding().padding(bottom = 12.dp),
        ) {
            if (searching) {
                SearchBar(query, { query = it }) { searching = false; query = ""; highlight = -1 }
                if (query.isNotBlank()) SearchResults(query) { i ->
                    searching = false
                    highlight = i
                    scope.launch {
                        list.animateScrollToItem(i)
                        delay(2500)
                        highlight = -1
                    }
                }
            } else {
                ChatHeader(onSearch = { searching = true })
                ActivityStrip()
                if (Chat.error.value.isNotBlank()) {
                    Text(
                        Chat.error.value, fontSize = Type.Label, color = Pal.Danger,
                        modifier = Modifier.padding(horizontal = 20.dp).padding(top = 8.dp).fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp)).background(Pal.Danger.copy(alpha = .1f)).tap { Chat.error.value = "" }
                            .padding(horizontal = 14.dp, vertical = 8.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun ChatHeader(onSearch: () -> Unit) {
    val connected = Chat.connected.value
    val busy = Chat.busy.value
    val dot = when { !connected -> Pal.Faint; busy -> Pal.Gold; else -> Pal.Online }
    val pulse = rememberInfiniteTransition(label="busy-dot").animateFloat(.35f,1f,infiniteRepeatable(tween(900),RepeatMode.Reverse),label="breathe")
    Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(
            Modifier.clip(RoundedCornerShape(24.dp)).background(Pal.Card)
                .padding(start = 5.dp, end = 14.dp, top = 5.dp, bottom = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Avatar(34.dp)
            Text("豆豆", fontSize = Type.Body, fontWeight=FontWeight.SemiBold, color=Pal.Ink, modifier=Modifier.padding(horizontal=9.dp))
            Box(Modifier.alpha(if(connected && busy) pulse.value else 1f)) { StatusDot(dot, 8.dp) }
        }
        Spacer(Modifier.weight(1f))
        Row(
            Modifier.clip(RoundedCornerShape(24.dp)).background(Pal.Card)
                .padding(horizontal = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            HeaderIcon(Icons.Outlined.Search, "搜索", onSearch)
            HeaderIcon(Icons.Outlined.Settings, "设置") { Nav.open(Route.Settings) }
        }
    }
}

@Composable
private fun HeaderIcon(icon: androidx.compose.ui.graphics.vector.ImageVector, desc: String, onClick: () -> Unit) {
    Box(Modifier.size(42.dp).clip(CircleShape).tap(onClick = onClick), contentAlignment = Alignment.Center) {
        Icon(icon, desc, tint = Pal.Icon, modifier = Modifier.size(20.dp))
    }
}

/** Background jobs and sub-tasks in flight; collapsible. The list itself comes from the server on connect. */
@Composable
private fun ActivityStrip() {
    val running = Chat.running
    if (running.isEmpty()) return
    var open by remember { mutableStateOf(false) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(1000); now = System.currentTimeMillis() } }
    Column(
        Modifier.padding(horizontal = 20.dp).padding(top = 10.dp).fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Pal.Card)
            .tap { open = !open }.padding(horizontal = 14.dp, vertical = 9.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(Modifier.size(12.dp), color = Pal.Gold, strokeWidth = 1.5.dp)
            val first = running.first()
            Text(
                if (running.size == 1) "${first.label} · 已运行 ${elapsed(first.started, now)}" else "${running.size} 个任务在跑 · ${first.label}",
                fontSize = Type.Label, color = Pal.Ink, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 10.dp).weight(1f),
            )
            Icon(if (open) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, if (open) "收起" else "展开", tint = Pal.Muted, modifier = Modifier.size(18.dp))
        }
        AnimatedVisibility(open) {
            Column(Modifier.padding(top = 6.dp)) {
                running.forEach { r ->
                    Text("${r.label} · ${elapsed(r.started, now)}", fontSize = Type.Label, color = Pal.Muted, modifier = Modifier.padding(start = 22.dp, top = 4.dp))
                }
            }
        }
    }
}

@Composable
private fun SearchBar(query: String, onChange: (String) -> Unit, onClose: () -> Unit) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 12.dp, top = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(
            Modifier.weight(1f).heightIn(min = 46.dp).clip(RoundedCornerShape(23.dp)).background(Pal.Card).padding(horizontal = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Outlined.Search, null, tint = Pal.Faint, modifier = Modifier.size(18.dp))
            BasicTextField(
                query, onChange, singleLine = true, textStyle = TextStyle(fontSize = Type.Body, color = Pal.Ink), cursorBrush = SolidColor(Pal.Gold),
                modifier = Modifier.weight(1f).padding(start = 8.dp).focusRequester(focus),
                decorationBox = { inner -> Box { if (query.isEmpty()) Text("搜索聊天记录", fontSize = Type.Body, color = Pal.Faint); inner() } },
            )
        }
        Text("取消", fontSize = Type.Body, color = Pal.Link, modifier = Modifier.tap(onClick = onClose).padding(horizontal = 10.dp, vertical = 8.dp))
    }
}

private fun itemText(it: ChatItem): String = when (it) {
    is ChatItem.User -> it.text + it.attachments.joinToString(" ") { a -> a.name + " " + (a.transcript ?: "") }
    is ChatItem.Assistant -> it.text
    is ChatItem.Alarm -> it.text
    is ChatItem.Card -> it.title
    is ChatItem.Note -> ""
}

@Composable
private fun SearchResults(query: String, onPick: (Int) -> Unit) {
    val hits = Chat.items.withIndex().filter { itemText(it.value).contains(query, ignoreCase = true) }.reversed()
    Column(
        Modifier.padding(horizontal = 20.dp).padding(top = 10.dp).fillMaxWidth().heightIn(max = 420.dp).card(radius = 20.dp, color = Pal.Card)
            .verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 6.dp),
    ) {
        if (hits.isEmpty()) EmptyNote("没找到「$query」", Modifier.padding(horizontal = 2.dp))
        hits.forEachIndexed { n, (i, it) ->
            if (n > 0) Hairline()
            val text = itemText(it).replace('\n', ' ')
            val at = text.indexOf(query, ignoreCase = true).coerceAtLeast(0)
            val start = (at - 18).coerceAtLeast(0)
            val snippet = (if (start > 0) "…" else "") + text.substring(start)
            Column(Modifier.fillMaxWidth().tap { onPick(i) }.padding(vertical = 11.dp)) {
                Text(when (it) { is ChatItem.User -> "我"; is ChatItem.Alarm -> "定时提醒"; else -> "豆豆" }, fontSize = Type.Tiny, color = Pal.Faint)
                Text(
                    buildAnnotatedString {
                        var k = 0
                        while (k < snippet.length) {
                            val m = snippet.indexOf(query, k, ignoreCase = true)
                            if (m < 0) { append(snippet.substring(k)); break }
                            append(snippet.substring(k, m))
                            withStyle(SpanStyle(color = Pal.GoldInk, fontWeight = FontWeight.SemiBold, background = Pal.Quiet)) {
                                append(snippet.substring(m, m + query.length))
                            }
                            k = m + query.length
                        }
                    },
                    fontSize = Type.Secondary, color = Pal.Ink, maxLines = 2, overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun EmptyChat() {
    Column(Modifier.fillMaxWidth().padding(top = 80.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Avatar(84.dp)
        Text("跟豆豆说点什么吧", fontSize = Type.CardTitle, fontWeight = FontWeight.Medium, color = Pal.Ink, modifier = Modifier.padding(top = 20.dp))
        Text("它会记住重要的事，也能替你跑腿", fontSize = Type.Secondary, color = Pal.Muted, modifier = Modifier.padding(top = 6.dp))
    }
}

@Composable
internal fun ChatRow(item: ChatItem, highlight: Boolean = false) {
    when (item) {
        is ChatItem.User -> UserBubble(item, highlight)
        is ChatItem.Assistant -> Bubble(highlight) { SelectionContainer { Markdown(item.text, color = Pal.Ink) } }
        is ChatItem.Alarm -> Row(Modifier.fillMaxWidth().padding(vertical = 2.dp).testTag("schedule-message"),
            horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.Alarm, null, tint = Pal.Muted, modifier = Modifier.size(14.dp))
            Text(item.text, fontSize = Type.Label, color = Pal.Muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 6.dp))
        }
        is ChatItem.Card -> {
            val c = ctx()
            val scope = rememberCoroutineScope()
            if(item.path != null && com.xiamu.agent.isBriefPath(item.path)) {
                val (brief, _) = load("chat-brief:${item.path}") { com.xiamu.agent.Api.briefs().firstOrNull { it.path == item.path } }
                Row(Modifier.fillMaxWidth().card(radius = 20.dp).tap { Nav.brief(item.path) }.padding(18.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconTile(Icons.AutoMirrored.Outlined.Article, Pal.Link, 42.dp)
                    Column(Modifier.padding(start = 12.dp).weight(1f)) {
                        Text(brief?.name ?: item.label.ifBlank { item.title }, fontSize = Type.Body, fontWeight = FontWeight.SemiBold, color = Pal.Ink)
                        Text(whenLabel(brief?.time ?: item.ts), fontSize = Type.Label, color = Pal.Muted, modifier = Modifier.padding(top = 4.dp))
                    }
                }
                return
            }
            Row(
                Modifier.fillMaxWidth().card(radius = 20.dp).tap(item.path != null) { scope.launch { openFile(c, item.path!!, item.title) } }
                    .padding(14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconTile(Icons.AutoMirrored.Outlined.Article, Pal.Link, 42.dp)
                Column(Modifier.padding(start = 12.dp).weight(1f)) {
                    Text(item.title, fontSize = Type.Body, fontWeight = FontWeight.Medium, color = Pal.Ink, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(listOfNotNull(item.label.ifBlank { null }, if (item.ts > 0) whenLabel(item.ts) else null).joinToString(" · ").ifBlank { "点开看" },
                        fontSize = Type.Label, color = Pal.Muted, modifier = Modifier.padding(top = 2.dp))
                }
            }
        }
        is ChatItem.Note -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
            Text(
                item.text, fontSize = Type.Tiny, color = Pal.Muted,
                modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(Pal.Card).padding(horizontal = 10.dp, vertical = 4.dp),
            )
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun UserBubble(item: ChatItem.User, highlight: Boolean) {
    var menu by remember(item.id) { mutableStateOf(false) }
    var editing by remember(item.id) { mutableStateOf(false) }
    var text by remember(item.id,item.text) { mutableStateOf(item.text) }
    Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.End) {
        Spacer(Modifier.width(48.dp))
        Box(Modifier.weight(1f,fill=false)) {
            Column(Modifier.clip(RoundedCornerShape(20.dp,20.dp,6.dp,20.dp))
                .background(if(highlight) Pal.Quiet else if(item.queued) Pal.UserBubble.copy(alpha=.1f) else Pal.UserBubble)
                .then(if(item.queued && item.id.isNotBlank()) Modifier.combinedClickable(onClick={},onLongClick={ menu=true }) else Modifier)
                .testTag(if(item.queued) "queued-message" else "user-message").padding(horizontal=14.dp,vertical=11.dp),
                verticalArrangement=Arrangement.spacedBy(8.dp),horizontalAlignment=Alignment.End) {
                Attachments(item.attachments)
                if(item.text.isNotBlank()) {
                    if(item.queued) Text(item.text,fontSize = Type.Body,lineHeight = Type.BodyLine,color=Pal.UserText.copy(alpha=.65f))
                    else SelectionContainer { Text(item.text,fontSize = Type.Body,lineHeight = Type.BodyLine,color=Pal.UserText) }
                }
                if(item.queued) Text("排队中",fontSize = Type.Tiny,color=Pal.Muted)
            }
            DropdownMenu(expanded=menu,onDismissRequest={ menu=false }) {
                DropdownMenuItem(text={ Text("撤回") },onClick={ menu=false; Chat.unqueue(item.id) })
                DropdownMenuItem(text={ Text("修改") },onClick={ menu=false; text=item.text; editing=true })
            }
        }
    }
    if(editing) AlertDialog(onDismissRequest={editing=false},title={Text("修改排队消息")},text={
        OutlinedTextField(text,{text=it},modifier=Modifier.fillMaxWidth(),minLines=2,maxLines=5)
    },confirmButton={ TextButton(enabled=text.isNotBlank() || item.attachments.isNotEmpty(),onClick={ Chat.editQueued(item.id,text); editing=false }) { Text("保存") } },
        dismissButton={TextButton(onClick={editing=false}) {Text("取消")}})
}

@Composable
internal fun Bubble(highlight: Boolean = false, content: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth()) {
        Box(
            Modifier.weight(1f, fill = false)
                .then(if (highlight) Modifier.background(Pal.Quiet, RoundedCornerShape(14.dp)) else Modifier)
                .padding(horizontal = 2.dp, vertical = 6.dp),
        ) { content() }
        Spacer(Modifier.width(24.dp))
    }
}

@Composable
private fun Streaming(text: String, hint: String, active: Boolean) {
    Bubble {
        Column {
            if (text.isNotBlank()) Markdown(text, color = Pal.Ink)
            if (active) ToolRow(hint.ifBlank { if (text.isBlank()) "在想" else "还在写" }, hint, active = true)
        }
    }
}

@Composable
private fun Attachments(list: List<Attachment>) {
    if (list.isEmpty()) return
    val c = ctx()
    val scope = rememberCoroutineScope()
    list.forEach { a ->
        when (a.kind) {
            "image" -> RemoteImage(a.path, Modifier.sizeIn(maxWidth = 220.dp, maxHeight = 260.dp).clip(RoundedCornerShape(14.dp)).tap { Nav.open(Route.Image(a.path)) })
            "voice" -> VoiceRow(a)
            else -> Row(
                Modifier.widthIn(max = 260.dp).clip(RoundedCornerShape(14.dp)).background(Pal.Card)
                    .tap { scope.launch { runCatching { openFile(c, a.path, a.name) }.onFailure { Chat.error.value = "打不开：${it.message}" } } }
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.AutoMirrored.Outlined.InsertDriveFile, null, tint = Pal.Link, modifier = Modifier.size(24.dp))
                Text(a.name, fontSize = Type.Secondary, color = Pal.Ink, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 10.dp))
            }
        }
    }
}

@Composable
private fun VoiceRow(a: Attachment) {
    val c = ctx()
    val playing = VoicePlayer.playing.value == a.path
    Column(Modifier.widthIn(min = 180.dp, max = 260.dp).clip(RoundedCornerShape(14.dp)).background(Pal.Card).padding(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(34.dp).gold().tap { VoicePlayer.toggle(c, a.path) }, contentAlignment = Alignment.Center) {
                Icon(if (playing) Icons.Rounded.Pause else Icons.Rounded.PlayArrow, if (playing) "暂停" else "播放", tint = Pal.GoldInk, modifier = Modifier.size(20.dp))
            }
            Text("语音笔记", fontSize = Type.Secondary, fontWeight = FontWeight.Medium, color = Pal.Ink, modifier = Modifier.padding(start = 10.dp))
        }
        val t = a.transcript
        Text(
            t ?: "正在转文字…", fontSize = Type.Secondary, lineHeight = Type.SecondaryLine, color = if (t == null) Pal.Faint else Pal.UserText,
            modifier = Modifier.padding(top = 8.dp, start = 2.dp),
        )
    }
}

@Composable
private fun RemoteImage(path: String, modifier: Modifier) {
    var bmp by remember(path) { mutableStateOf<Bitmap?>(Images.cached(path, 720)) }
    var failed by remember(path) { mutableStateOf(false) }
    LaunchedEffect(path) { if (bmp == null) Images.load(path, 720).let { if (it == null) failed = true else bmp = it } }
    val b = bmp
    if (b != null) {
        val ratio = b.width.toFloat() / b.height.coerceAtLeast(1)
        Image(b.asImageBitmap(), null, contentScale = ContentScale.Crop, modifier = modifier.aspectRatio(ratio.coerceIn(0.5f, 2.5f)))
    } else {
        Box(modifier.size(160.dp, 120.dp).background(Pal.Card), contentAlignment = Alignment.Center) {
            if (failed) Text("图片加载失败", fontSize = Type.Label, color = Pal.Faint)
            else CircularProgressIndicator(Modifier.size(18.dp), color = Pal.Gold, strokeWidth = 2.dp)
        }
    }
}
