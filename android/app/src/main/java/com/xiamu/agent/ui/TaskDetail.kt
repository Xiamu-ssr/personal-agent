package com.xiamu.agent.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.coroutineScope
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.xiamu.agent.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun TaskDetailScreen(route: Route.TaskDetail) {
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var history by remember(route.id) { mutableStateOf<TaskHistory?>(null) }
    var loadError by remember { mutableStateOf("") }
    var sendError by remember { mutableStateOf("") }
    var revision by remember { mutableIntStateOf(0) }
    var expanded by rememberSaveable(route.id) { mutableStateOf(false) }
    var text by rememberSaveable(route.id) { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var notice by remember { mutableStateOf("") }
    val keyboard = LocalSoftwareKeyboardController.current
    val focus = LocalFocusManager.current
    val hostView = LocalView.current
    DisposableEffect(route.id, revision, lifecycle) {
        // Poll independently of Compose's rendering clock, including while this page is idle.
        val job = lifecycle.coroutineScope.launch {
          lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            var poll = false
            while (true) {
                try {
                    val latest = Api.taskHistory(route.id)
                    history = latest; loadError = ""
                    poll = latest.status == TaskStatus.Running
                }
                catch (e: CancellationException) { throw e }
                catch (e: Exception) { loadError = e.message ?: "任务记录加载失败" }
                if (!poll) break
                delay(3000)
            }
          }
        }
        onDispose { job.cancel() }
    }
    val submit: () -> Unit = {
        val message = text.trim()
        if (message.isNotBlank() && !sending) {
            sending = true; sendError = ""; notice = ""
            scope.launch {
                try {
                    Api.sendToTask(route.id, message)
                    if (text.trim() == message) text = ""
                    notice = "已发送，豆豆会在后台接着做"
                    revision++
                    // Native input methods must run on the view's thread, including in UI tests.
                    hostView.post { keyboard?.hide(); focus.clearFocus() }
                } catch (e: CancellationException) { throw e }
                catch (e: Exception) { sendError = e.message ?: "发送失败，请重试" }
                finally { sending = false }
            }
        }
    }
    Screen {
        Column(Modifier.fillMaxSize().navigationBarsPadding().imePadding()) {
            SubHeader("任务详情", Nav::back)
            LazyColumn(Modifier.weight(1f).fillMaxWidth().testTag("task-history"),
                contentPadding = PaddingValues(start = 20.dp, end = 20.dp, bottom = 24.dp)) {
                item {
                    BigTitle(history?.title ?: route.title)
                    history?.let { Tag(it.status.label, when (it.status) { TaskStatus.Error -> Pal.Danger; TaskStatus.Running -> Pal.GoldInk; else -> Pal.Link }) }
                }
                if (history == null && loadError.isBlank()) item { Loading() }
                history?.let { data ->
                    item { SectionTitle("任务说明") }
                    item {
                        Column(Modifier.fillMaxWidth().card().padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            if (data.prompts.isEmpty()) Text(data.title, color = Pal.Ink, fontSize = 15.sp)
                            data.prompts.forEachIndexed { index, prompt ->
                                if (index > 0) { Hairline(); Text("补充说明 · ${clock(prompt.time)}", color = Pal.Muted, fontSize = 11.sp) }
                                SelectionContainer { Markdown(prompt.text) }
                            }
                        }
                    }
                    item {
                        Row(Modifier.fillMaxWidth().padding(top = 20.dp).tap { expanded = !expanded }.padding(vertical = 10.dp).testTag("task-steps-toggle"),
                            verticalAlignment = Alignment.CenterVertically) {
                            Text("步骤 · ${data.steps.size}", color = Pal.Ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                            Icon(if (expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore,
                                if (expanded) "收起步骤" else "展开步骤", tint = Pal.Muted)
                        }
                    }
                    if (expanded) data.steps.forEachIndexed { index, step -> item(key = "step:$index") {
                        Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(clock(step.time), fontSize = 10.sp, color = Pal.Faint, modifier = Modifier.padding(end = 10.dp))
                            Text(step.text.lineSequence().firstOrNull { it.isNotBlank() }.orEmpty(), fontSize = 13.sp, color = Pal.Muted,
                                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        }
                    } }
                    item { SectionTitle("结果") }
                    if (data.results.isEmpty()) item { EmptyNote(if (data.status == TaskStatus.Running) "豆豆还在做，结果会出现在这里" else "还没有结果") }
                    data.results.forEachIndexed { index, result -> item(key = "result:$index") {
                        Box(Modifier.fillMaxWidth().padding(bottom = 12.dp).card().padding(18.dp)) { SelectionContainer { Markdown(result.text) } }
                    } }
                    val brief = data.briefPath ?: route.briefPath?.takeIf(::isBriefPath)
                    if (brief != null && data.results.isNotEmpty()) item {
                        SilverButton("看简报", Modifier.fillMaxWidth().testTag("task-open-brief")) { Nav.brief(brief) }
                    }
                }
                if (loadError.isNotBlank()) item {
                    ErrorNote(loadError)
                    QuietButton("重新加载") { revision++ }
                }
            }
            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 12.dp)) {
                if (sendError.isNotBlank()) ErrorNote(sendError)
                if (notice.isNotBlank()) Text(notice, color = Pal.GoldInk, fontSize = 12.sp, modifier = Modifier.padding(bottom = 8.dp))
                Row(Modifier.fillMaxWidth().card().padding(10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    BasicTextField(text, onValueChange = { text = it }, modifier = Modifier.weight(1f).heightIn(min = 44.dp)
                        .clip(RoundedCornerShape(14.dp)).background(Pal.Field).padding(12.dp).testTag("task-reply"),
                        textStyle = TextStyle(fontSize = 15.sp, color = Pal.Ink, lineHeight = 22.sp), cursorBrush = SolidColor(Pal.Gold), maxLines = 5,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send), keyboardActions = KeyboardActions(onSend = { submit() }),
                        decorationBox = { input -> if (text.isEmpty()) Text("接着聊这个任务…", fontSize = 14.sp, color = Pal.Faint); input() })
                    GoldButton(if (sending) "发送中…" else "发送", Modifier.width(76.dp).testTag("task-send"), enabled = !sending && text.isNotBlank(), onClick = submit)
                }
            }
        }
    }
}
