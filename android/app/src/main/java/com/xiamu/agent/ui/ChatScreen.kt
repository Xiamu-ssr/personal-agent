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
import androidx.compose.runtime.DisposableEffect
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
import com.xiamu.agent.SayCard
import com.xiamu.agent.Api
import androidx.compose.material.icons.outlined.*
import com.xiamu.agent.device.DeviceService
import com.xiamu.agent.media.Images
import com.xiamu.agent.media.VoicePlayer
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun ChatScreen(list: LazyListState,bottom: Dp,scroll: ConversationScrollState = remember { ConversationScrollState() },
    items: List<ChatItem> = Chat.items,streaming: String = Chat.streaming.value,error: String = Chat.error.value,
    sentVersion: Int = Draft.sentVersion.intValue,emptyText: String = if(Chat.connected.value) "豆豆正在准备第一句话…" else "正在连接云端…",
    onChoose: (String,String) -> Unit = Chat::choose) {
    BindConversationScroll(list,scroll,items.size,"${items.size}:${streaming.length}",sentVersion,bottom)
    val visible by remember(list) { derivedStateOf { list.layoutInfo.visibleItemsInfo.map { it.index }.toSet() } }
    Box(Modifier.fillMaxSize()) {
        LazyColumn(state=list,modifier=Modifier.fillMaxSize().testTag("chat-list"),contentPadding=PaddingValues(start=16.dp,end=16.dp,top=FloatingHeaderSpace+8.dp,bottom=bottom+12.dp),verticalArrangement=Arrangement.spacedBy(7.dp)) {
            if(items.isEmpty()) item { EmptyNote(emptyText) }
            itemsIndexed(items,key={ i,item -> when(item) { is ChatItem.User -> item.id.ifBlank { "pending:$i" }; is ChatItem.Assistant -> item.id.ifBlank { "assistant:$i" } } }) { i,item -> ChatRow(item,mediaActive=i in visible,onChoose=onChoose) }
            if(streaming.isNotBlank()) item { Bubble { Markdown(streaming) } }
            if(error.isNotBlank()) item { ErrorNote(error) }
        }
        ReturnToBottom(list,scroll,Modifier.align(Alignment.BottomEnd).padding(end=16.dp,bottom=bottom+12.dp))
    }
}
@Composable
internal fun ChatRow(item: ChatItem,highlight: Boolean = false,mediaActive: Boolean = true,onChoose: (String,String) -> Unit = Chat::choose) {
    when(item) {
        is ChatItem.User -> Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.End) {
            Spacer(Modifier.width(42.dp))
            Column(Modifier.weight(1f,fill=false).clip(RoundedCornerShape(21.dp,21.dp,5.dp,21.dp)).background(Pal.UserBubble).padding(horizontal=15.dp,vertical=11.dp)) {
                Attachments(item.attachments,mediaActive)
                if(item.text.isNotBlank()) SelectionContainer { Text(item.text,style=Type.body(15),color=Pal.UserText) }
                if(item.pending) Text("发送中…",style=Type.body(11),color=Pal.UserText.copy(alpha=.65f))
            }
        }
        is ChatItem.Assistant -> Bubble(highlight) { Column {
            if(item.text.isNotBlank()) SelectionContainer { Markdown(item.text,color=Pal.Ink) }
            item.cards.filter { it !is SayCard.Media }.forEach { SayCardView(it,mediaActive) }
            MediaViews(item.displayMedia,mediaActive)
            if(item.options.isNotEmpty()) Column(Modifier.fillMaxWidth().padding(top=12.dp),verticalArrangement=Arrangement.spacedBy(7.dp)) {
                item.options.forEach { option ->
                    val enabled=!item.optionsUsed && !item.choosing
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(13.dp)).background(Pal.Background).border(1.dp,if(enabled) Pal.Ink.copy(alpha=.35f) else Pal.Line,RoundedCornerShape(13.dp)).tap(enabled) { onChoose(item.id,option.id) }.padding(horizontal=14.dp,vertical=13.dp),verticalAlignment=Alignment.CenterVertically) {
                        Text(option.label,style=Type.body(15),color=if(enabled) Pal.Ink else Pal.Muted,modifier=Modifier.weight(1f))
                    }
                }
            }
        } }
    }
}
@Composable
internal fun Bubble(highlight: Boolean = false,content: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth()) {
        Box(Modifier.weight(1f,fill=false).clip(RoundedCornerShape(21.dp,21.dp,21.dp,5.dp)).background(if(highlight) Pal.Quiet else Pal.Card).padding(horizontal=15.dp,vertical=12.dp)) { content() }
        Spacer(Modifier.width(24.dp))
    }
}
@Composable
private fun SayCardView(card: SayCard,active: Boolean) {
    val scope=rememberCoroutineScope()
    val context=ctx()
    when(card) {
        is SayCard.Connector -> CardList(Modifier.padding(top=10.dp)) { ListRow(connectorTitle(card.id),"连接应用",Icons.Outlined.Hub,onClick={
            scope.launch {
                try {
                    val c=com.xiamu.agent.connectors.CloudConnectors.list().let { it.connected+it.catalog }.firstOrNull { it.name==card.id }
                    if(c!=null) Nav.open(Route.ConnectorDetail(c)) else Nav.open(Route.Connectors())
                } catch(e: kotlinx.coroutines.CancellationException) { throw e } catch(e: Exception) { Chat.error.value=e.message ?: "连接应用加载失败" }
            }
        }) }
        is SayCard.Goal -> CardList(Modifier.padding(top=10.dp)) { ListRow(card.name,"查看目标",Icons.Outlined.CheckBox,onClick={Nav.open(Route.GoalDetail(card.name))}) }
        is SayCard.Device -> CardList(Modifier.padding(top=10.dp)) { ListRow(if(card.capability=="health") "健康数据" else "开启本机能力","由你在这台设备上授权",Icons.Outlined.PhoneAndroid,onClick={Nav.open(Route.Capabilities)}) }
        is SayCard.Link -> Column(Modifier.fillMaxWidth().padding(top=10.dp).clip(RoundedCornerShape(16.dp)).background(Pal.Background).tap { openBrowser(context,card.url) }) {
            card.image?.let { ContentImage(it,Modifier.fillMaxWidth().height(140.dp)) }
            Column(Modifier.padding(12.dp)) { Text(card.title,style=Type.title(15),color=Pal.Ink); if(card.description.isNotBlank()) Text(card.description,style=Type.body(13),color=Pal.Muted); Text(runCatching { java.net.URI(card.url).host }.getOrDefault(card.url),style=Type.body(12),color=Pal.Link,modifier=Modifier.padding(top=4.dp)) }
        }
        SayCard.Browser -> BrowserPreview(active)
        is SayCard.Media -> Unit
    }
}
private fun connectorTitle(id: String)=mapOf("qq-mail" to "QQ 邮箱","gmail" to "Gmail","github" to "GitHub","tavily" to "Tavily","weread" to "微信读书","wind" to "Wind AI")[id] ?: id

@Composable
private fun Attachments(list: List<Attachment>, active: Boolean) {
    if (list.isEmpty()) return
    val c = ctx()
    val scope = rememberCoroutineScope()
    list.forEach { a ->
        when (a.kind) {
            "image" -> RemoteImage(a.path, Modifier.sizeIn(maxWidth = 220.dp, maxHeight = 260.dp).clip(RoundedCornerShape(14.dp)).tap { Nav.open(Route.Image(a.path)) })
            "voice" -> VoiceRow(a, active)
            else -> Row(
                Modifier.widthIn(max = 260.dp).clip(RoundedCornerShape(14.dp)).background(Pal.Card)
                    .tap { scope.launch { runCatching { openFile(c, a.path, a.name) }.onFailure { Chat.error.value = "打不开：${it.message}" } } }
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.AutoMirrored.Outlined.InsertDriveFile, null, tint = Pal.Ink, modifier = Modifier.size(24.dp))
                Text(a.name, fontSize = Type.Secondary, color = Pal.Ink, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 10.dp))
            }
        }
    }
}

@Composable
private fun VoiceRow(a: Attachment, active: Boolean) {
    val c = ctx()
    val playing = VoicePlayer.playing.value == a.path
    DisposableEffect(a.path, active) {
        if (!active && VoicePlayer.playing.value == a.path) VoicePlayer.stop()
        onDispose { if (VoicePlayer.playing.value == a.path) VoicePlayer.stop() }
    }
    Column(Modifier.widthIn(min = 180.dp, max = 260.dp).clip(RoundedCornerShape(14.dp)).background(Pal.Card).padding(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(34.dp).gold().tap(active) { VoicePlayer.toggle(c, a.path) }, contentAlignment = Alignment.Center) {
                Icon(if (playing) Icons.Rounded.Pause else Icons.Rounded.PlayArrow, if (playing) "暂停" else "播放", tint = Pal.GoldInk, modifier = Modifier.size(20.dp))
            }
            Text("语音笔记", fontSize = Type.Secondary, fontWeight = FontWeight.Medium, color = Pal.Ink, modifier = Modifier.padding(start = 10.dp))
        }
        val t = a.transcript
        Text(
            t ?: "正在转文字…", fontSize = Type.Secondary, lineHeight = Type.SecondaryLine, color = if (t == null) Pal.Faint else Pal.Ink,
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
