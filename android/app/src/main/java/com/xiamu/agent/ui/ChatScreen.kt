package com.xiamu.agent.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.outlined.Article
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xiamu.agent.Chat
import com.xiamu.agent.ChatItem

@Composable
fun ChatScreen(open: (Page) -> Unit) {
    val items = Chat.items
    val streaming = Chat.streaming.value
    val busy = Chat.busy.value
    val list = rememberLazyListState()
    val extra = if (busy || streaming.isNotBlank()) 1 else 0

    LaunchedEffect(items.size, streaming.length, busy) {
        val n = items.size + extra
        if (n > 0) list.animateScrollToItem(n - 1)
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        if (Chat.error.value.isNotBlank()) {
            Text(
                Chat.error.value, color = MaterialTheme.colorScheme.error, fontSize = 12.sp,
                modifier = Modifier.fillMaxWidth().background(Color(0xFFFFF0EE)).padding(horizontal = 16.dp, vertical = 6.dp),
            )
        }
        LazyColumn(
            state = list,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (items.isEmpty() && !busy) {
                item { Empty("跟豆豆说点什么吧。\n它会记住重要的事。") }
            }
            itemsIndexed(items) { _, it -> ChatRow(it, open) }
            if (extra == 1) {
                item { Streaming(streaming, Chat.toolHint.value) }
            }
        }
        Composer(busy)
    }
}

@Composable
private fun ChatRow(item: ChatItem, open: (Page) -> Unit) {
    when (item) {
        is ChatItem.User -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Surface(color = MaterialTheme.colorScheme.primary, shape = RoundedCornerShape(18.dp, 18.dp, 4.dp, 18.dp)) {
                SelectionContainer {
                    Text(item.text, color = Color.White, modifier = Modifier.widthIn(max = 300.dp).padding(horizontal = 14.dp, vertical = 10.dp))
                }
            }
        }
        is ChatItem.Assistant -> Bubble { SelectionContainer { Markdown(item.text) } }
        is ChatItem.Card -> Surface(
            color = MaterialTheme.colorScheme.surface,
            shape = RoundedCornerShape(14.dp),
            shadowElevation = 1.dp,
            modifier = Modifier.fillMaxWidth().clickable(enabled = item.path != null) {
                open(Page.Web(item.title, item.path!!))
            },
        ) {
            Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(36.dp).background(MaterialTheme.colorScheme.primaryContainer, CircleShape), contentAlignment = Alignment.Center) {
                    Icon(Icons.Outlined.Article, null, tint = MaterialTheme.colorScheme.primary)
                }
                Column(Modifier.padding(start = 12.dp)) {
                    Text(item.title, fontWeight = FontWeight.SemiBold)
                    Text("点开看", fontSize = 12.sp, color = MaterialTheme.colorScheme.outline)
                }
            }
        }
        is ChatItem.Note -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
            Text(
                item.text, fontSize = 11.sp, color = MaterialTheme.colorScheme.outline,
                modifier = Modifier.background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(10.dp)).padding(horizontal = 10.dp, vertical = 3.dp),
            )
        }
    }
}

@Composable
private fun Bubble(content: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth()) {
        Surface(color = MaterialTheme.colorScheme.surface, shape = RoundedCornerShape(18.dp, 18.dp, 18.dp, 4.dp), shadowElevation = 0.5.dp) {
            Box(Modifier.widthIn(max = 320.dp).padding(horizontal = 14.dp, vertical = 10.dp)) { content() }
        }
        Spacer(Modifier.weight(1f))
    }
}

@Composable
private fun Streaming(text: String, hint: String) {
    Bubble {
        Column {
            if (text.isNotBlank()) Markdown(text)
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = if (text.isNotBlank()) 6.dp else 0.dp)) {
                CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp)
                Text(hint.ifBlank { if (text.isBlank()) "在想" else "" }, fontSize = 12.sp, color = MaterialTheme.colorScheme.outline,
                    modifier = Modifier.padding(start = 8.dp))
            }
        }
    }
}

@Composable
private fun Composer(busy: Boolean) {
    var text by rememberSaveable { mutableStateOf("") }
    Surface(color = MaterialTheme.colorScheme.background) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp), verticalAlignment = Alignment.Bottom) {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("发消息给豆豆") },
                maxLines = 6,
                shape = RoundedCornerShape(22.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    unfocusedContainerColor = MaterialTheme.colorScheme.surface,
                    focusedContainerColor = MaterialTheme.colorScheme.surface,
                    unfocusedBorderColor = Color(0xFFE2DED6),
                ),
            )
            val canSend = text.isNotBlank()
            IconButton(
                onClick = {
                    if (canSend) {
                        Chat.send(text.trim()); text = ""
                    } else if (busy) Chat.interrupt()
                },
                modifier = Modifier.padding(start = 6.dp, bottom = 4.dp).size(48.dp)
                    .background(if (canSend || busy) MaterialTheme.colorScheme.primary else Color(0xFFD9D5CC), CircleShape),
            ) {
                Icon(if (!canSend && busy) Icons.Filled.Stop else Icons.AutoMirrored.Filled.Send, if (busy && !canSend) "停下" else "发送", tint = Color.White)
            }
        }
    }
}
