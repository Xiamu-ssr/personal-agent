package com.xiamu.agent

import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsTopHeight
import androidx.compose.foundation.layout.windowInsetsBottomHeight
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.snapshotFlow
import com.xiamu.agent.ui.ConversationScrollState
import com.xiamu.agent.ui.Pal
import kotlinx.coroutines.flow.distinctUntilChanged
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.xiamu.agent.device.DeviceService
import com.xiamu.agent.media.VoicePlayer
import com.xiamu.agent.ui.AgentTheme
import com.xiamu.agent.ui.ChatScreen
import com.xiamu.agent.ui.Dock
import com.xiamu.agent.ui.DouScreen
import com.xiamu.agent.ui.LoginScreen
import com.xiamu.agent.ui.MemoryScreen
import com.xiamu.agent.ui.Nav
import com.xiamu.agent.ui.OnboardingScreen
import com.xiamu.agent.ui.RoutePage
import com.xiamu.agent.ui.Session
import com.xiamu.agent.ui.TasksScreen
import com.xiamu.agent.ui.TodayScreen
import com.xiamu.agent.ui.Voice
import com.xiamu.agent.ui.VoiceOverlay
import com.xiamu.agent.ui.canvasBackground

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT),
        )
        setContent { AgentTheme { Root() } }
    }
}

@Composable
private fun Root() {
    val loggedIn = Session.loggedIn.value
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val ctx = LocalContext.current
    DisposableEffect(lifecycle, loggedIn) {
        fun start() {
            if (loggedIn) {
                Chat.connect()
                DeviceService.start(ctx, reregister = true)
            }
        }
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> start()
                Lifecycle.Event.ON_STOP -> {
                    Chat.disconnect()
                    Voice.cancel()
                    VoicePlayer.stop()
                }
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) start()
        onDispose {
            lifecycle.removeObserver(observer)
            Chat.disconnect()
            Voice.cancel()
            VoicePlayer.stop()
        }
    }
    when {
        !loggedIn -> LoginScreen()
        !Session.onboarded.value -> OnboardingScreen()
        else -> MainScreens()
    }
}

@Composable
internal fun MainScreens() {
    val tab = Nav.tab.intValue
    val route = Nav.stack.lastOrNull()
    val chatList = rememberLazyListState()
    val chatScroll = remember { ConversationScrollState() }
    val pager = rememberPagerState(initialPage = SwipePages.page(tab, Nav.todaySegment.intValue)) { SwipePages.count }
    LaunchedEffect(tab, Nav.todaySegment.intValue, route) {
        val target = SwipePages.page(tab, Nav.todaySegment.intValue)
        if (route == null && pager.settledPage != target && !pager.isScrollInProgress) pager.animateScrollToPage(target)
    }
    LaunchedEffect(pager) {
        snapshotFlow { pager.settledPage }.distinctUntilChanged().collect { page ->
            Nav.tab.intValue = SwipePages.tab(page)
            if (page == 1 || page == 2) Nav.todaySegment.intValue = page - 1
        }
    }
    var dockHeight by remember { mutableIntStateOf(0) }
    val bottom = with(LocalDensity.current) { dockHeight.toDp() }

    BackHandler(route != null || tab != 0 || Voice.mode.value != null) {
        when {
            Voice.mode.value != null -> Voice.cancel()
            route != null -> Nav.back()
            else -> Nav.home(0)
        }
    }
    Box(Modifier.fillMaxSize().canvasBackground()) {
        if (route != null) key(route) { RoutePage(route) }
        else {
            HorizontalPager(state = pager, modifier = Modifier.fillMaxSize(), key = { it }) { page ->
                when (page) {
                    0 -> ChatScreen(chatList, bottom, chatScroll)
                    1, 2 -> TodayScreen(bottom, segment = page - 1)
                    3 -> TasksScreen(bottom)
                    4 -> MemoryScreen(bottom)
                }
            }
            // Paint the margins and system insets too; lists reserve this entire height.
            Box(
                Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(Pal.Background)
                    .onSizeChanged { dockHeight = it.height }
                    .navigationBarsPadding().imePadding().padding(horizontal = 14.dp, vertical = 8.dp),
            ) { Dock() }
        }
        Box(
            Modifier.align(Alignment.TopCenter).fillMaxWidth().windowInsetsTopHeight(WindowInsets.statusBars)
                .background(Pal.Background),
        )
        Box(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth().windowInsetsBottomHeight(WindowInsets.navigationBars)
                .background(Pal.Background),
        )
        VoiceOverlay()
    }
}
