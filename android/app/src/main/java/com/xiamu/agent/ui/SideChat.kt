package com.xiamu.agent.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.xiamu.agent.*
import kotlinx.coroutines.delay

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SideChatScreen(route: Route.SideChat) {
    val session=remember(route.id) { route.id?.let(SideChats::session) }
    val draft=remember(route.id) { MessageDraft(sendMessage={text,attachments,clientId ->
        if(route.id==null) {
            val id=Api.createSideChat(text,attachments,clientId)
            Chat.activityVersion.intValue++
            Nav.createdSideChat(id)
        } else {
            Api.sendToActivity(route.id,text,attachments,clientId)
            session?.refresh()
        }
        true
    }) }
    val lifecycle=LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(session,lifecycle,Chat.connected.value) {
        if(session!=null) lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while(true) { session.refresh(); delay(if(session.busy.value) 3000 else 10000) }
        }
    }
    DisposableEffect(draft) { onDispose { draft.reset(); Voice.cancel() } }
    val list=rememberLazyListState()
    val scroll=remember { ConversationScrollState() }
    var dockHeight by remember { mutableIntStateOf(0) }
    val bottom=with(LocalDensity.current) { dockHeight.toDp() }
    val ime=WindowInsets.isImeVisible
    Box(Modifier.fillMaxSize().background(Pal.Background).statusBarsPadding()) {
        ChatScreen(list,bottom,scroll,items=session?.items ?: emptyList(),error=session?.error?.value.orEmpty(),
            sentVersion=draft.sentVersion.intValue,
            emptyText=if(route.id==null) "想单独聊点什么？" else if(session?.loaded?.value==true) "从这里接着聊。" else "正在打开旁聊…",
            onChoose={message,option -> session?.choose(message,option)})
        Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(Pal.Background).onSizeChanged { dockHeight=it.height }
            .navigationBarsPadding().imePadding().padding(horizontal=16.dp,vertical=8.dp)) {
            Column(Modifier.fillMaxWidth(),horizontalAlignment=Alignment.CenterHorizontally) {
                Box(Modifier.fillMaxWidth().padding(bottom=10.dp)) { MessageComposer(draft,"消息") }
                if(!ime) MainNavBar()
            }
        }
        HomeHeader(sideChat=true)
    }
}
