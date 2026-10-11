package com.xiamu.agent

import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.xiamu.agent.device.DeviceService
import com.xiamu.agent.device.HealthAccess
import com.xiamu.agent.device.StepCounter
import com.xiamu.agent.ui.*
import org.json.JSONObject

/** Debug only: every HTTP / WS request goes to an in-process loopback fake service. */
class V4ReviewActivity : ComponentActivity() {
    lateinit var fixture: V4Fixture
        private set
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        DeviceService.stop(this)
        Chat.reset(); Draft.reset(); clearCache(); Voice.cancel()
        val scenario=intent.getStringExtra("scenario") ?: "today"
        fixture=V4Fixture(this,scenario)
        Prefs.server=fixture.url; Prefs.token="local-v4-fixture"; Prefs.onboarded=true
        Nav.briefPath.value=null
        Nav.home(when(scenario) { "today","today-empty","sites" -> 1; "tasks" -> 2; "memory","memory-empty" -> 3; "dou","diaries" -> 4; else -> 0 })
        when(scenario) {
            "settings" -> Nav.open(Route.Settings)
            "connectors" -> Nav.open(Route.Connectors(1))
            "local" -> Nav.open(Route.Connectors(0))
            "devices" -> Nav.open(Route.Devices)
            "diaries" -> Nav.open(Route.Diaries)
        }
        enableEdgeToEdge(statusBarStyle=SystemBarStyle.light(Color.TRANSPARENT,Color.TRANSPARENT),navigationBarStyle=SystemBarStyle.light(Color.TRANSPARENT,Color.TRANSPARENT))
        setContent { AgentTheme {
            if(scenario=="health-fallback") Screen { Column(Modifier.fillMaxSize().statusBarsPadding().padding(24.dp)) {
                Text("本地健康能力检查",color=Pal.Ink)
                val (result,error)=load("health-diagnostic",cacheValue=false) { HealthAccess.read(this@V4ReviewActivity,JSONObject()) }
                Text("Health Connect：${if(HealthAccess.available(this@V4ReviewActivity)) "可用" else "不可用"}",color=Pal.Muted)
                if(result != null) {
                    Text("来源：${result.optString("source")}",color=Pal.Ink,modifier=Modifier.padding(top=20.dp))
                    Text(result.optString("note"),color=Pal.Muted)
                    Text("返回 ${result.optJSONArray("items")?.length() ?: 0} 天数据",color=Pal.Muted)
                    Text(StepCounter.note(this@V4ReviewActivity),color=Pal.Muted)
                }
                if(error.isNotBlank()) ErrorNote(error)
            } }
            else MainScreens()
        } }
    }
    override fun onStart() { super.onStart(); Chat.connect() }
    override fun onStop() { Chat.disconnect(); super.onStop() }
    override fun onDestroy() {
        Chat.reset(); Draft.reset(); Prefs.token=""; fixture.close()
        super.onDestroy()
    }
}
