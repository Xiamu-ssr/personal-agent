package com.xiamu.agent.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.coroutineScope
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.xiamu.agent.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun TaskDetailScreen(route: Route.TaskDetail, draft: MessageDraft = remember(route.id) { MessageDraft(route.id) }) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var history by remember(route.id) { mutableStateOf<TaskHistory?>(null) }
    var loadError by remember { mutableStateOf("") }
    var revision by remember { mutableIntStateOf(0) }
    val list = rememberLazyListState()
    val scroll = remember(route.id) { ConversationScrollState() }
    val ime = WindowInsets.ime.getBottom(LocalDensity.current)
    LaunchedEffect(draft.sentVersion.intValue) { if (draft.sentVersion.intValue > 0) revision++ }
    DisposableEffect(route.id, revision, lifecycle) {
        val job = lifecycle.coroutineScope.launch {
            lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                var poll = true
                while (true) {
                    try {
                        val latest = Api.taskHistory(route.id)
                        history = latest; loadError = ""
                        poll = latest.status == TaskStatus.Running
                    } catch (e: CancellationException) { throw e }
                    catch (e: Exception) { loadError = e.message ?: "任务记录加载失败" }
                    if (!poll) break
                    delay(3000)
                }
            }
        }
        onDispose { job.cancel() }
    }
    DisposableEffect(draft) { onDispose { draft.reset(); Voice.cancel() } }
    val data = history
    BindConversationScroll(list, scroll, data?.items?.count { it.kind != TaskItemKind.Tool } ?: 0,
        data?.items, draft.sentVersion.intValue, ime)
    Screen {
        Column(Modifier.fillMaxSize().navigationBarsPadding().imePadding()) {
            SubHeader("任务详情", Nav::back)
            Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(data?.title ?: route.title, style = Type.title(17), color = Pal.Ink, modifier = Modifier.weight(1f))
                data?.let { Tag(it.status.label, if (it.status == TaskStatus.Error) Pal.Danger else Pal.Link) }
            }
            Box(Modifier.weight(1f).fillMaxWidth()) {
                LazyColumn(state = list, modifier = Modifier.fillMaxSize().testTag("task-history"),
                    contentPadding = PaddingValues(horizontal = 20.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    if (data == null && loadError.isBlank()) item { Loading() }
                    itemsIndexed(data?.items.orEmpty(), key = { index, item -> "${item.kind}:${item.time}:$index" }) { index, item ->
                        when {
                            item.kind == TaskItemKind.Tool -> ToolRow(item.tool ?: "工具", item.text, tag = "task-tool:$index")
                            item.isUser -> ChatRow(ChatItem.User(item.text, item.attachments, ts = item.time, id = "task:$index"))
                            else -> Column {
                                if (index == 0 && item.isInstruction) Text("豆豆交代的", style = Type.body(12), color = Pal.Muted,
                                    modifier = Modifier.padding(bottom = 6.dp).testTag("task-instruction"))
                                ChatRow(ChatItem.Assistant(item.text, ts = item.time))
                            }
                        }
                    }
                    if (loadError.isNotBlank()) item {
                        ErrorNote(loadError)
                        QuietButton("重新加载") { revision++ }
                    }
                }
                ReturnToBottom(list, scroll, Modifier.align(Alignment.BottomEnd).padding(16.dp))
            }
            Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp).card().padding(10.dp).testTag("task-composer")) {
                MessageComposer(draft, "接着聊这个任务…")
            }
        }
    }
}
