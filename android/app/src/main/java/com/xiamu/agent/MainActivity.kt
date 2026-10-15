package com.xiamu.agent

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.*
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.*
import androidx.compose.ui.unit.dp
import androidx.lifecycle.*
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.xiamu.agent.device.DeviceService
import com.xiamu.agent.media.VoicePlayer
import com.xiamu.agent.ui.*

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) { super.onCreate(savedInstanceState); enableEdgeToEdge(); setContent { AgentTheme { Root() } } }
}
@Composable
private fun Root() {
    val loggedIn=Session.loggedIn.value
    val lifecycle=LocalLifecycleOwner.current.lifecycle
    val context=LocalContext.current
    DisposableEffect(lifecycle,loggedIn) {
        fun start() { if(loggedIn) { Chat.connect(); DeviceService.start(context,reregister=true) } }
        val observer=LifecycleEventObserver { _,event ->
            if(event==Lifecycle.Event.ON_START) start()
            if(event==Lifecycle.Event.ON_STOP) { Chat.disconnect(); Voice.cancel(); VoicePlayer.stop() }
        }
        lifecycle.addObserver(observer)
        if(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) start()
        onDispose { lifecycle.removeObserver(observer); Chat.disconnect(); Voice.cancel(); VoicePlayer.stop() }
    }
    if(loggedIn) MainScreens() else LoginScreen()
}
@Composable
internal fun MainScreens() {
    val tab=Nav.tab.intValue
    val route=Nav.stack.lastOrNull()
    val list=rememberLazyListState()
    val scroll=remember { ConversationScrollState() }
    var dockHeight by remember { mutableIntStateOf(0) }
    val bottom=with(LocalDensity.current) { dockHeight.toDp() }
    BackHandler(route!=null || tab!=0 || Voice.mode.value!=null || Nav.drawer.value || Nav.console.value) {
        when {
            Voice.mode.value!=null -> Voice.cancel()
            Nav.console.value -> Nav.console.value=false
            Nav.drawer.value -> Nav.drawer.value=false
            route!=null -> Nav.back()
            else -> Nav.home(0)
        }
    }
    Box(Modifier.fillMaxSize().background(Pal.Background)) {
        if(route!=null) key(route) { RoutePage(route) }
        else Box(Modifier.fillMaxSize().statusBarsPadding()) {
            Box(Modifier.fillMaxSize()) {
                when(tab) {
                    0 -> ChatScreen(list,bottom,scroll)
                    1 -> FeedScreen(bottom)
                    2 -> IdeasScreen(bottom)
                    3 -> GoalsScreen(bottom)
                    4 -> LibraryScreen(bottom)
                }
                Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(Pal.Background)
                    .onSizeChanged { dockHeight=it.height }.navigationBarsPadding().imePadding().padding(horizontal=16.dp,vertical=8.dp)) { Dock() }
            }
            HomeHeader()
        }
        if(Nav.console.value) AvatarConsole()
        if(Nav.feedSettings.value) FeedSettingsSheet()
        if(Nav.drawer.value) SideDrawer()
        VoiceOverlay()
    }
}
