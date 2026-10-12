package com.xiamu.agent.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xiamu.agent.BackgroundTask
import com.xiamu.agent.Chat
import com.xiamu.agent.replyLabel
import kotlinx.coroutines.delay

@Composable
internal fun ReplyActivity() {
    if (!Chat.busy.value) return
    Row(Modifier.fillMaxWidth().padding(start = 8.dp, end = 4.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(Modifier.size(12.dp), color = Pal.Gold, strokeWidth = 1.5.dp)
        Text(replyLabel(Chat.reason.value), fontSize = Type.Label, color = Pal.Muted, maxLines = 1,
            overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 8.dp).weight(1f))
        Row(Modifier.clip(RoundedCornerShape(14.dp)).background(Pal.Quiet).tap { Chat.interrupt() }
            .padding(horizontal = 10.dp, vertical = 7.dp).testTag("interrupt"), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Rounded.Stop, null, tint = Pal.QuietText, modifier = Modifier.size(14.dp))
            Text("停止回复", fontSize = Type.Tiny, color = Pal.QuietText, modifier = Modifier.padding(start = 4.dp))
        }
    }
}

@Composable
internal fun BackgroundTasks() {
    val tasks = Chat.tasks
    if (tasks.isEmpty()) return
    var open by remember { mutableStateOf(false) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(open) { while (open) { now = System.currentTimeMillis(); delay(1000) } }
    Column(Modifier.fillMaxWidth().padding(bottom = 8.dp).clip(RoundedCornerShape(18.dp)).background(Pal.Background)) {
        Row(Modifier.fillMaxWidth().tap { open = !open }.padding(horizontal = 12.dp, vertical = 10.dp).testTag("background-tasks"),
            verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(Modifier.size(12.dp), color = Pal.Gold, strokeWidth = 1.5.dp)
            Text("后台还有 ${tasks.size} 个任务在跑", fontSize = Type.Label, color = Pal.Ink, modifier = Modifier.padding(start = 9.dp).weight(1f))
            Icon(if (open) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, if (open) "收起后台任务" else "展开后台任务",
                tint = Pal.Muted, modifier = Modifier.size(18.dp))
        }
        AnimatedVisibility(open) {
            Column(Modifier.heightIn(max = 230.dp).verticalScroll(rememberScrollState()).padding(start = 12.dp, end = 12.dp, bottom = 6.dp)) {
                tasks.forEach { task ->
                    Hairline()
                    Column(Modifier.fillMaxWidth().padding(vertical = 10.dp).testTag("task:${task.id}")) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Column(Modifier.weight(1f)) {
                                Text(task.description, fontSize = Type.Secondary, lineHeight = Type.SecondaryLine, color = Pal.Ink, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                Text("已运行 ${elapsed(task.startedAt, now)}", fontSize = Type.Tiny, color = Pal.Muted, modifier = Modifier.padding(top = 3.dp))
                            }
                            TaskStopButton(task)
                        }
                        if (task.error.isNotBlank()) Text(task.error, fontSize = Type.Tiny, lineHeight = Type.SecondaryLine, color = Pal.Danger, modifier = Modifier.padding(top = 6.dp))
                    }
                }
            }
        }
    }
}

@Composable
internal fun TaskStopButton(task: BackgroundTask) {
    Row(Modifier.clip(RoundedCornerShape(14.dp)).background(Pal.Quiet).tap(!task.stopping) { Chat.stopTask(task.id) }
        .padding(horizontal = 12.dp, vertical = 8.dp).testTag("stop-task:${task.id}")
        .semantics { contentDescription = "停止${task.description}" }, verticalAlignment = Alignment.CenterVertically) {
        if (task.stopping) CircularProgressIndicator(Modifier.padding(end = 6.dp).size(10.dp), color = Pal.Muted, strokeWidth = 1.dp)
        Text(if (task.stopping) "停止中…" else "停止", fontSize = Type.Label, fontWeight = FontWeight.Medium, color = if (task.stopping) Pal.Faint else Pal.QuietText)
    }
}
