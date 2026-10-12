package com.xiamu.agent

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.xiamu.agent.device.DeviceService
import com.xiamu.agent.ui.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class V6ReviewActivity : ComponentActivity() {
    lateinit var fixture: V6Fixture
        private set
    private var scenario = "today"
    private val launchId = java.util.UUID.randomUUID().toString()
    val taskDraft = MessageDraft("running-purchase")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        DeviceService.stop(this)
        Chat.reset(); Draft.reset(); clearCache(); Voice.cancel()
        fixture = V6Fixture(assets.open("v06/brief-base.css").bufferedReader().use { it.readText() })
        Prefs.server = fixture.url; Prefs.token = "local-v6-fixture"; Prefs.onboarded = true
        intent.getStringExtra("skin")?.let { SkinState.select(Skin.from(it)) }
        Nav.briefPath.value = null; Nav.todaySegment.intValue = 0
        scenario = intent.getStringExtra("scenario") ?: "today"
        Nav.home(when (scenario) { "today" -> 1; "tasks", "running" -> 2; "memory", "health" -> 3; else -> 0 })
        when (scenario) {
            "skins" -> Nav.open(Route.Skins)
            "settings" -> Nav.open(Route.Settings)
            "running" -> Nav.open(Route.TaskDetail("running-purchase", "样品与交期"))
            "health" -> Nav.open(Route.Health)
        }
        enableEdgeToEdge()
        setContent { AgentTheme {
            if (scenario == "running") androidx.compose.foundation.layout.Box { TaskDetailScreen(Route.TaskDetail("running-purchase", "样品与交期"), taskDraft); VoiceOverlay() }
            else MainScreens()
        } }
    }
    override fun onStart() { super.onStart(); Chat.connect() }
    override fun onStop() {
        Chat.disconnect()
        val out = File(getExternalFilesDir(null), "v0.6.0").apply { mkdirs() }
        val reads = fixture.requests.filter { it.path == "/api/tasks/running-purchase/history" }
        if (scenario == "running") File(out, "task-polling-real.json").writeText(JSONObject().put("launchId", launchId).put("processId", android.os.Process.myPid()).put("clock", "System.nanoTime")
            .put("requests", reads.size)
            .put("intervalsMs", JSONArray(reads.zipWithNext { a,b -> b.nanoMs-a.nanoMs })).toString(2))
        super.onStop()
    }
    override fun onDestroy() { Chat.reset(); Draft.reset(); Prefs.token = ""; fixture.close(); super.onDestroy() }
}
