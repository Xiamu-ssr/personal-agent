package com.xiamu.agent

import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.xiamu.agent.device.DeviceService
import com.xiamu.agent.ui.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class V5ReviewActivity : ComponentActivity() {
    lateinit var fixture: V5Fixture
        private set
    private var scenario = "today"
    private var startedAt = 0L
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        DeviceService.stop(this)
        Chat.reset(); Draft.reset(); clearCache(); Voice.cancel()
        fixture = V5Fixture()
        Prefs.server = fixture.url; Prefs.token = "local-v5-fixture"; Prefs.onboarded = true
        Nav.briefPath.value = null
        scenario = intent.getStringExtra("scenario") ?: "today"
        Nav.home(when (scenario) { "today" -> 1; "tasks", "running", "done" -> 2; else -> 0 })
        when (scenario) {
            "settings" -> Nav.open(Route.Settings)
            "models" -> Nav.open(Route.RuntimeSettings())
            "permissions" -> Nav.open(Route.RuntimeSettings(permissions = true))
            "running" -> Nav.open(Route.TaskDetail("running-purchase","整理采购资料"))
            "done" -> Nav.open(Route.TaskDetail("done-morning","晨报已生成",fixture.briefPath))
        }
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.light(Color.TRANSPARENT,Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.light(Color.TRANSPARENT,Color.TRANSPARENT))
        setContent { AgentTheme { MainScreens() } }
    }
    override fun onStart() { super.onStart(); startedAt = android.os.SystemClock.uptimeMillis(); Chat.connect() }
    override fun onStop() {
        Chat.disconnect()
        if (scenario == "running") {
            val reads = fixture.requests.filter { it.path == "/api/tasks/running-purchase/history" }
            val out = File(getExternalFilesDir(null),"v0.5.0").apply { mkdirs() }
            File(out,"task-polling-real.json").writeText(JSONObject().put("historyRequests",reads.size)
                .put("processId",android.os.Process.myPid())
                .put("clock","SystemClock.uptimeMillis")
                .put("visibleDurationMs",android.os.SystemClock.uptimeMillis()-startedAt)
                .put("requestTimesMs",JSONArray(reads.map { it.at-startedAt }))
                .put("intervalsMs",JSONArray(reads.zipWithNext { a,b -> b.at-a.at }))
                .put("nanoIntervalsMs",JSONArray(reads.zipWithNext { a,b -> b.nanoMs-a.nanoMs })).toString(2))
        }
        super.onStop()
    }
    override fun onDestroy() { Chat.reset(); Draft.reset(); Prefs.token = ""; fixture.close(); super.onDestroy() }
}
