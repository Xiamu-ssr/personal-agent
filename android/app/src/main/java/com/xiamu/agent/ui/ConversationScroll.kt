package com.xiamu.agent.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ArrowDownward
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.xiamu.agent.ChatScrollRules
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

class ConversationScrollState {
    var rules by mutableStateOf(ChatScrollRules())
    var initialized = false
    var count = 0
    var sentVersion = 0
    var programmatic = false
    var userScrolling = false
}

/** Layout growth and IME resize consult the position from the last user gesture. */
@Composable
fun BindConversationScroll(list: LazyListState, state: ConversationScrollState, count: Int, content: Any?, sent: Int, bottomInset: Any? = null) {
    LaunchedEffect(list, state) {
        list.interactionSource.interactions.collect { if (it is DragInteraction.Start) state.userScrolling = true }
    }
    LaunchedEffect(list, state) {
        snapshotFlow { Triple(list.isScrollInProgress, list.canScrollForward, list.layoutInfo) }.collect { (scrolling, forward, layout) ->
            if (!state.programmatic && state.userScrolling) {
                val last = layout.visibleItemsInfo.lastOrNull()
                val average = layout.visibleItemsInfo.map { it.size }.average().takeIf { it.isFinite() } ?: 0.0
                val below = if (last == null) 0 else ((layout.totalItemsCount - last.index - 1) * average +
                    (last.offset + last.size + layout.afterContentPadding - layout.viewportEndOffset).coerceAtLeast(0)).toInt()
                state.rules = state.rules.userPosition(!forward, below, layout.viewportEndOffset - layout.viewportStartOffset)
                if (!scrolling) state.userScrolling = false
            }
        }
    }
    LaunchedEffect(count, content, sent, bottomInset) {
        val initial = !state.initialized
        if (state.initialized) state.rules = state.rules.messages(count - state.count)
        val sentNow = sent != state.sentVersion
        if (sentNow) state.rules = state.rules.sent()
        state.count = count; state.sentVersion = sent; state.initialized = true
        if ((state.rules.contentChanged() && !state.userScrolling) || initial || sentNow) {
            state.programmatic = true
            try {
                // Wait for the new item/viewport to be laid out, including after an IME resize.
                withFrameNanos { }
                val last = list.layoutInfo.totalItemsCount - 1
                if (last >= 0) {
                    if (initial) list.scrollToItem(last, Int.MAX_VALUE / 2)
                    else list.animateScrollToItem(last, Int.MAX_VALUE / 2)
                }
            } finally { state.programmatic = false }
        }
    }
}

@Composable
fun ReturnToBottom(list: LazyListState, state: ConversationScrollState, modifier: Modifier = Modifier) {
    val scope = rememberCoroutineScope()
    if (!state.rules.showReturn) return
    Box(modifier.size(48.dp).background(Pal.Card, CircleShape).tap {
        state.rules = state.rules.returned()
        scope.launch {
            state.programmatic = true
            try { list.animateScrollToItem((list.layoutInfo.totalItemsCount - 1).coerceAtLeast(0), Int.MAX_VALUE / 2) }
            finally { state.programmatic = false }
        }
    }.testTag("return-bottom"), contentAlignment = Alignment.Center) {
        Icon(Icons.Rounded.ArrowDownward, "回到底部", tint = Pal.Ink, modifier = Modifier.size(22.dp))
        if (state.rules.unread > 0) Text(state.rules.unread.toString(), style = Type.body(11), color = Pal.Ink,
            modifier = Modifier.align(Alignment.TopEnd).background(Pal.Quiet, CircleShape).padding(horizontal = 5.dp, vertical = 2.dp).testTag("unread-count"))
    }
}
