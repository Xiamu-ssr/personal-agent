package com.xiamu.agent

import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsBottomHeight
import androidx.compose.foundation.layout.windowInsetsTopHeight
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import com.xiamu.agent.ui.AgentTheme
import com.xiamu.agent.ui.ChatScreen
import com.xiamu.agent.ui.Dock
import com.xiamu.agent.ui.Draft
import com.xiamu.agent.ui.Nav
import com.xiamu.agent.ui.canvasBackground

class TaskReviewActivity : ComponentActivity() {
    lateinit var fixture: TaskFixture
        private set

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT), navigationBarStyle = SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT))
        Chat.reset(); Draft.reset(); Nav.home(0)
        val scenario = intent.getStringExtra("scenario") ?: "background"
        fixture = TaskFixture(this, scenario)
        Prefs.server = fixture.url
        Prefs.token = "fixture"
        if (scenario == "queued") Draft.text.value = "再补充一条需要留意的事"
        setContent {
            AgentTheme {
                val list = rememberLazyListState()
                var dockHeight by remember { mutableIntStateOf(0) }
                val bottom = with(LocalDensity.current) { dockHeight.toDp() }
                Box(Modifier.fillMaxSize().canvasBackground()) {
                    ChatScreen(list, bottom)
                    Dock(Modifier.align(Alignment.BottomCenter).onSizeChanged { dockHeight = it.height }.navigationBarsPadding().imePadding()
                        .padding(horizontal = 14.dp, vertical = 8.dp))
                    Box(Modifier.align(Alignment.TopCenter).fillMaxWidth().windowInsetsTopHeight(WindowInsets.statusBars).background(androidx.compose.ui.graphics.Color(0xFFC9D3DF)))
                    Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().windowInsetsBottomHeight(WindowInsets.navigationBars).background(androidx.compose.ui.graphics.Color(0xFFEEF1F4)))
                }
            }
        }
    }

    override fun onStart() { super.onStart(); Chat.connect() }
    override fun onStop() { Chat.disconnect(); super.onStop() }
    override fun onDestroy() {
        Chat.reset(); Draft.reset()
        Prefs.token = ""
        fixture.close()
        super.onDestroy()
    }
}
