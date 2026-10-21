package com.xiamu.agent.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.test.platform.app.InstrumentationRegistry
import com.xiamu.agent.*
import com.xiamu.agent.device.DeviceService
import kotlinx.coroutines.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class PowerContentDeviceTest {
    @get:Rule val ui=createAndroidComposeRule<LayoutProbeActivity>()

    @Test fun decorativeAvatarIsStaticAndReactionsReleaseTheirVideoSurface() {
        var expressive by mutableStateOf(false)
        var state by mutableStateOf("working")
        ui.setContent { AgentTheme { Avatar(76.dp,state,expressive) } }
        ui.onNodeWithTag("avatar-video").assertDoesNotExist()
        ui.runOnIdle { expressive=true }
        ui.waitUntil(5000) { ui.onAllNodesWithTag("avatar-video").fetchSemanticsNodes().isNotEmpty() }
        ui.waitUntil(6000) { ui.onAllNodesWithTag("avatar-video").fetchSemanticsNodes().isEmpty() }
        ui.runOnIdle { state="error" }
        ui.waitUntil(5000) { ui.onAllNodesWithTag("avatar-video").fetchSemanticsNodes().isNotEmpty() }
        ui.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
        Thread.sleep(500)
        ui.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        ui.waitUntil(7000) { ui.onAllNodesWithTag("avatar-video").fetchSemanticsNodes().isEmpty() }
    }

    @Test fun wrappedTableCellsStayInSeparateRows() {
        val a="第一行：这是比较长的合成文本，用来检查三列表格会自动换行，而不会压住下一行。"
        val b="第二行：完整正文与来源可以放在这里，行高必须按实际文字确定。"
        ui.setContent { AgentTheme {
            Column(Modifier.width(340.dp).verticalScroll(rememberScrollState())) {
                Markdown("| 维度 | 第一项 | 第二项 |\n| --- | --- | --- |\n| 第一行 | $a | 合成内容 |\n| 第二行 | $b | 末行完整可读 |",fontSize=17)
            }
        } }
        val first=ui.onNodeWithText(a).getUnclippedBoundsInRoot()
        val next=ui.onNodeWithText(b).getUnclippedBoundsInRoot()
        assertTrue(first.bottom<=next.top)
        ui.onNode(hasScrollAction()).performScrollToNode(hasText("末行完整可读"))
        ui.onNodeWithText("末行完整可读").assertIsDisplayed()
    }

    @Test fun backgroundDeviceUsesServerPongsAndStillAnswersAuthorizedCalls():Unit = runBlocking {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        Prefs.init(context)
        val previous=Prefs.server to Prefs.token
        val oldBattery=Prefs.granted("battery")
        try {
            Prefs.server="http://127.0.0.1:18770";Prefs.token="local-synthetic-review";Prefs.setGranted("battery",true)
            val before=Api.getJson("/__review/state").getJSONObject("socketStats")
            DeviceService.start(context)
            withTimeout(15_000) { while(!DeviceService.online.value) delay(100) }
            ui.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
            delay(95_000)
            assertFalse(App.foreground)
            val response=Api.postJson("/__review/device-battery",JSONObject())
            assertTrue(response.toString(),response.getBoolean("ok"));assertNotNull(response.getJSONObject("data"))
            val after=Api.getJson("/__review/state").getJSONObject("socketStats")
            assertTrue(after.getInt("pongs")-before.getInt("pongs")>=1)
            assertEquals(before.getInt("clientPings"),after.getInt("clientPings"))
            assertTrue(DeviceService.online.value)
            ui.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        } finally {
            DeviceService.stop(context);Prefs.server=previous.first;Prefs.token=previous.second;Prefs.setGranted("battery",oldBattery)
        }
    }
}
