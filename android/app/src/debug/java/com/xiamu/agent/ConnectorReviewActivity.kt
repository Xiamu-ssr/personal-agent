package com.xiamu.agent

import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsBottomHeight
import androidx.compose.foundation.layout.windowInsetsTopHeight
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.xiamu.agent.ui.AgentTheme
import com.xiamu.agent.ui.ConnectorDetailScreen
import com.xiamu.agent.ui.ConnectorFormScreen
import com.xiamu.agent.ui.ConnectorsScreen
import com.xiamu.agent.ui.DevicesScreen
import com.xiamu.agent.ui.Nav
import com.xiamu.agent.ui.Route
import com.xiamu.agent.ui.canvasBackground
import com.xiamu.agent.ui.clearCache
import kotlinx.coroutines.runBlocking

class ConnectorReviewActivity : ComponentActivity() {
    lateinit var gateway: FixtureConnectors
        private set

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT), navigationBarStyle = SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT))
        Prefs.server = "http://127.0.0.1:1"
        Prefs.token = ""
        val scenario = intent.getStringExtra("scenario") ?: "detail-empty"
        gateway = FixtureConnectors(this, scenario)
        val connector = runBlocking { gateway.list() }.connector("email")!!
        clearCache()
        Nav.home(0)
        Nav.open(when {
            scenario.startsWith("devices") -> Route.Devices
            scenario == "cloud" || scenario == "legacy" -> Route.Connectors(1)
            else -> Route.ConnectorDetail(connector)
        })
        if (scenario.startsWith("form")) Nav.open(Route.ConnectorForm(connector, if (scenario.startsWith("form-edit")) connector.accounts.first() else null))
        setContent {
            AgentTheme {
                BackHandler { if (Nav.stack.size > 1) Nav.back() else finish() }
                Box(Modifier.fillMaxSize().canvasBackground()) {
                    val route = Nav.stack.lastOrNull()
                    if (route != null) key(route) {
                        when (route) {
                            is Route.ConnectorDetail -> ConnectorDetailScreen(route, gateway)
                            is Route.ConnectorForm -> ConnectorFormScreen(route, gateway)
                            is Route.Connectors -> ConnectorsScreen(route, gateway)
                            Route.Devices -> DevicesScreen(gateway)
                            else -> Unit
                        }
                    }
                    Box(Modifier.align(Alignment.TopCenter).fillMaxWidth().windowInsetsTopHeight(WindowInsets.statusBars).background(androidx.compose.ui.graphics.Color(0xFFC9D3DF)))
                    Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().windowInsetsBottomHeight(WindowInsets.navigationBars).background(androidx.compose.ui.graphics.Color(0xFFEEF1F4)))
                }
            }
        }
    }
}
