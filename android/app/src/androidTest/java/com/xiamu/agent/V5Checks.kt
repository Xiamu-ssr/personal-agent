package com.xiamu.agent

import android.content.Intent
import android.graphics.Bitmap
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.text.AnnotatedString
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.xiamu.agent.ui.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.rules.TestName
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/** Settings regressions retained; brief/task UI coverage lives in V6Checks. */
@RunWith(AndroidJUnit4::class)
class V5Checks {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val testName = TestName()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private lateinit var activity: V5ReviewActivity
    private val out get() = File(context.getExternalFilesDir(null), "v0.6.0/runtime-settings").apply { mkdirs() }
    private fun review(scenario: String, block: () -> Unit) {
        ActivityScenario.launch<V5ReviewActivity>(Intent(context,V5ReviewActivity::class.java).putExtra("scenario",scenario)).use { state ->
            state.onActivity { activity = it }
            compose.waitUntil(10000) { Chat.connected.value }
            assertTrue(Prefs.server.startsWith("http://127.0.0.1:"))
            if (scenario == "today") {
                waitText("简报")
                compose.onNodeWithTag("today-list").performScrollToIndex(0)
            }
            try { block() }
            catch (failure: Throwable) {
                shot("failure-${testName.methodName}")
                evidence("failure-${testName.methodName}",JSONObject().put("requests",JSONArray(activity.fixture.requests.map {
                    JSONObject().put("method",it.method).put("path",it.path).put("body",it.body).put("at",it.at)
                })).put("navigationTab",Nav.tab.intValue).put("navigationStack",Nav.stack.map { it.toString() }.joinToString()))
                throw failure
            }
            assertTrue("本地假服务出现未定义请求：${activity.fixture.unexpected}",activity.fixture.unexpected.isEmpty())
        }
    }
    private fun waitText(text: String) = compose.waitUntil(10000) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }
    private fun shot(name: String) {
        compose.waitForIdle(); instrumentation.waitForIdleSync(); Thread.sleep(300)
        instrumentation.uiAutomation.takeScreenshot().let { bitmap ->
            File(out,"$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG,100,it) }; bitmap.recycle()
        }
    }
    private fun evidence(name: String, value: JSONObject) { File(out,"$name.json").writeText(value.toString(2)) }

    @Test fun modelChoiceUsesGetPutAndRetainsSelectionOnFailure() = review("models") {
        waitText("Claude Haiku 5.5")
        compose.onNodeWithTag("setting:anthropic/claude-haiku-5.5").assertIsSelected()
        compose.onNodeWithText("消耗约 1×").assertExists()
        compose.onNodeWithTag("setting:z-ai/glm-5.3-flash").performClick()
        compose.waitUntil(5000) { activity.fixture.snapshotSettings().getString("model") == "z-ai/glm-5.3-flash" }
        compose.waitUntil(5000) { compose.onNodeWithTag("setting:z-ai/glm-5.3-flash").fetchSemanticsNode().config.getOrElse(SemanticsProperties.Selected) { false } }
        compose.onNodeWithTag("setting:z-ai/glm-5.3-flash").assertIsSelected()
        val put = activity.fixture.requests.single { it.method == "PUT" }
        assertEquals(setOf("model"),JSONObject(put.body).keys().asSequence().toSet())
        shot("settings-models")
        activity.fixture.failSettings = true
        compose.onNodeWithTag("setting:z-ai/glm-5.3-flashx").performClick()
        waitText("本地保存失败，请重试")
        compose.onNodeWithTag("setting:z-ai/glm-5.3-flash").assertIsSelected()
        instrumentation.runOnMainSync { Nav.home(0); Nav.open(Route.Settings) }
        waitText("GLM 5.3 Flash")
        assertTrue(activity.fixture.requests.count { it.path == "/api/settings" && it.method == "GET" } >= 2)
        assertTrue(activity.fixture.messages.isEmpty())
    }

    @Test fun permissionChoiceIsSingleSelectAndSavesOnlyPermissionMode() = review("permissions") {
        waitText("自动")
        compose.onNodeWithTag("setting:auto").assertIsSelected()
        compose.onNodeWithTag("setting:bypassPermissions").performClick()
        compose.waitUntil(5000) { activity.fixture.snapshotSettings().getString("permissionMode") == "bypassPermissions" }
        compose.waitUntil(5000) { compose.onNodeWithTag("setting:bypassPermissions").fetchSemanticsNode().config.getOrElse(SemanticsProperties.Selected) { false } }
        compose.onNodeWithTag("setting:bypassPermissions").assertIsSelected()
        compose.onNodeWithText("什么都不拦").assertExists()
        assertEquals(setOf("permissionMode"),JSONObject(activity.fixture.requests.single { it.method == "PUT" }.body).keys().asSequence().toSet())
        shot("settings-permissions")
    }

}
