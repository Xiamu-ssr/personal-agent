package com.xiamu.agent

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AutoStories
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Dashboard
import androidx.compose.material.icons.outlined.Psychology
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.TaskAlt
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.xiamu.agent.device.DeviceService
import com.xiamu.agent.ui.AgentTheme
import com.xiamu.agent.ui.BoardScreen
import com.xiamu.agent.ui.ChatScreen
import com.xiamu.agent.ui.DiaryScreen
import com.xiamu.agent.ui.MemoryScreen
import com.xiamu.agent.ui.OnboardingScreen
import com.xiamu.agent.ui.Page
import com.xiamu.agent.ui.PageView
import com.xiamu.agent.ui.SettingsScreen
import com.xiamu.agent.ui.TasksScreen
import com.xiamu.agent.ui.connectionLabel

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { AgentTheme { Root() } }
    }
}

private data class Tab(val label: String, val icon: ImageVector)

private val tabs = listOf(
    Tab("聊天", Icons.Outlined.ChatBubbleOutline),
    Tab("看板", Icons.Outlined.Dashboard),
    Tab("任务", Icons.Outlined.TaskAlt),
    Tab("记忆", Icons.Outlined.Psychology),
    Tab("日记", Icons.Outlined.AutoStories),
)

@Composable
private fun Root() {
    var ready by remember { mutableStateOf(Prefs.configured && Prefs.onboarded) }
    if (!ready) {
        OnboardingScreen(onDone = { ready = true })
        return
    }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val obs = LifecycleEventObserver { _, e ->
            if (e == Lifecycle.Event.ON_START) Chat.connect()
            if (e == Lifecycle.Event.ON_STOP) Chat.disconnect()
        }
        lifecycle.addObserver(obs)
        onDispose { lifecycle.removeObserver(obs) }
    }
    MainScaffold()
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MainScaffold() {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    var tab by rememberSaveable { mutableIntStateOf(0) }
    var page by remember { mutableStateOf<Page?>(null) }
    var settings by remember { mutableStateOf(false) }

    DisposableEffect(Unit) {
        DeviceService.start(ctx)
        onDispose { }
    }

    BackHandler(enabled = page != null || settings) {
        if (page != null) page = null else settings = false
    }

    page?.let {
        PageView(it, onClose = { page = null })
        return
    }
    if (settings) {
        SettingsScreen(onClose = { settings = false })
        return
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Box {
                        Text(if (tab == 0) "豆豆" else tabs[tab].label, fontWeight = FontWeight.SemiBold)
                    }
                },
                actions = {
                    Text(connectionLabel(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
                    IconButton(onClick = { settings = true }) { Icon(Icons.Outlined.Settings, "设置") }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
        bottomBar = {
            NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
                tabs.forEachIndexed { i, t ->
                    NavigationBarItem(
                        selected = tab == i,
                        onClick = { tab = i },
                        icon = { Icon(t.icon, t.label) },
                        label = { Text(t.label) },
                        colors = NavigationBarItemDefaults.colors(indicatorColor = MaterialTheme.colorScheme.primaryContainer),
                    )
                }
            }
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { pad ->
        Box(Modifier.padding(pad)) {
            val open: (Page) -> Unit = { page = it }
            when (tab) {
                0 -> ChatScreen(open)
                1 -> BoardScreen(open)
                2 -> TasksScreen()
                3 -> MemoryScreen(open)
                4 -> DiaryScreen(open)
            }
        }
    }
}
