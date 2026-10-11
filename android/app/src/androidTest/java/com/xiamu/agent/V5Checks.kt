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

@RunWith(AndroidJUnit4::class)
class V5Checks {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val testName = TestName()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private lateinit var activity: V5ReviewActivity
    private val out get() = File(context.getExternalFilesDir(null), "v0.5.0").apply { mkdirs() }
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
    private fun webs(): List<OfflineBriefWebView> {
        val result = ArrayList<OfflineBriefWebView>()
        instrumentation.runOnMainSync {
            fun visit(view: View) {
                if (view is OfflineBriefWebView && view.active) result.add(view)
                if (view is ViewGroup) (0 until view.childCount).forEach { visit(view.getChildAt(it)) }
            }
            visit(activity.window.decorView)
        }
        return result
    }
    private fun eval(web: OfflineBriefWebView, script: String): String {
        val done = CountDownLatch(1); var result = "null"
        instrumentation.runOnMainSync { web.evaluateJavascript(script) { result = it; done.countDown() } }
        assertTrue("卡片脚本没有返回",done.await(3,TimeUnit.SECONDS))
        return result
    }
    private fun waitWeb(id: String): OfflineBriefWebView {
        val deadline = SystemClock.uptimeMillis() + 20000
        while (SystemClock.uptimeMillis() < deadline) {
            // WebView measurements arrive outside Compose's test clock. Apply them before reading sizes.
            compose.waitForIdle()
            webs().firstOrNull { it.height > 2 && eval(it,"!!document.getElementById('$id')") == "true" }?.let { return it }
            Thread.sleep(100)
        }
        fail("没有加载卡片 $id；活动 WebView 高度：${webs().map { it.height }}")
        error("unreachable")
    }
    private fun location(view: View): IntArray = IntArray(2).also { instrumentation.runOnMainSync { view.getLocationOnScreen(it) } }
    private fun touch(x: Float, startY: Float, endY: Float = startY, duration: Long = 250) {
        val start = SystemClock.uptimeMillis()
        fun event(action: Int, y: Float) { MotionEvent.obtain(start,SystemClock.uptimeMillis(),action,x,y,0).also {
            it.source = InputDevice.SOURCE_TOUCHSCREEN
            assertTrue(instrumentation.uiAutomation.injectInputEvent(it,true)); it.recycle()
        } }
        event(MotionEvent.ACTION_DOWN,startY)
        if (endY != startY) (1..10).forEach { index -> Thread.sleep(duration/10); event(MotionEvent.ACTION_MOVE,startY+(endY-startY)*index/10) }
        else Thread.sleep(60)
        event(MotionEvent.ACTION_UP,endY)
    }
    private fun clickDom(web: OfflineBriefWebView, id: String) {
        val rect = JSONArray(eval(web,"(function(){var r=document.getElementById('$id').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2,innerWidth]})()"))
        val scale = web.width/rect.getDouble(2)
        val pos = location(web)
        touch((pos[0]+rect.getDouble(0)*scale).toFloat(),(pos[1]+rect.getDouble(1)*scale).toFloat())
    }

    @Test fun htmlMulticardsMeasureAndRealButtonSendsToChat() = review("today") {
        val first = waitWeb("overview")
        waitWeb("focus")
        var measure = JSONArray()
        compose.waitUntil(5000) {
            measure = JSONArray(eval(first,"[document.documentElement.scrollHeight,innerWidth]"))
            abs(first.height - measure.getDouble(0)*first.width/measure.getDouble(1)) < 4
        }
        compose.waitUntil(5000) { webs().size in 2..3 }
        shot("brief-multicard")
        evidence("brief-height",JSONObject().put("cssHeight",measure.getDouble(0)).put("viewHeightPixels",first.height).put("visibleWebViews",webs().size))
        clickDom(first,"prompt")
        compose.waitUntil(5000) { Nav.tab.intValue == 0 && activity.fixture.messages.any { it.optString("t") == "send" } }
        assertEquals("帮我把今天的事排个顺序",activity.fixture.messages.single().getString("text"))
        compose.waitUntil(5000) { Chat.items.filterIsInstance<ChatItem.User>().any { it.text == "帮我把今天的事排个顺序" } }
        compose.waitUntil(5000) { webs().isEmpty() }
        shot("brief-button-chat")
    }

    @Test fun longCardScrollsInternallyAndOffscreenWebViewIsReleased() = review("today") {
        waitWeb("overview")
        compose.onNodeWithTag("today-list").performScrollToKey("${activity.fixture.briefPath}:2")
        val long = waitWeb("long")
        val dimensions = JSONArray(eval(long,"[document.documentElement.scrollHeight,innerWidth]"))
        assertTrue(dimensions.getDouble(0)*long.width/dimensions.getDouble(1) > long.height)
        assertTrue(long.height <= context.resources.displayMetrics.heightPixels*.75f+2)
        shot("brief-long-before")
        val before = location(long)
        touch(before[0]+long.width*.5f,before[1]+long.height*.65f,before[1]+long.height*.2f)
        compose.waitUntil(5000) { eval(long,"document.scrollingElement.scrollTop").toDouble() > 100 }
        val outerDelta = location(long)[1]-before[1]
        assertTrue("长卡片手势滚动了外层列表",abs(outerDelta) <= 3)
        shot("brief-long-scrolled")
        evidence("brief-internal-scroll",JSONObject().put("viewHeightPixels",long.height).put("cssDocumentHeight",dimensions.getDouble(0))
            .put("scrollTop",eval(long,"document.scrollingElement.scrollTop").toDouble()).put("outerListMovedPixels",outerDelta))
        val yesterday = "data/briefs/${activity.fixture.day.minusDays(1)}/晚报.html:1"
        compose.onNodeWithTag("today-list").performScrollToKey(yesterday)
        val last = waitWeb("evening-notes")
        // Wait for the placeholder's actual layout height, then move the old row fully offscreen.
        val screenHeight = context.resources.displayMetrics.heightPixels.toFloat()
        compose.waitUntil(5000) {
            last.height > screenHeight*.74f &&
                compose.onNodeWithTag("brief-card:$yesterday").fetchSemanticsNode().size.height > screenHeight*.74f
        }
        touch(4f,screenHeight*.68f,screenHeight*.25f,300)
        compose.waitUntil(5000) { !long.active || eval(long,"!!document.getElementById('long')") == "false" }
        evidence("brief-recycled",JSONObject().put("oldCardActive",long.active)
            .put("oldCardStillBound",if (long.active) eval(long,"!!document.getElementById('long')") else "false")
            .put("activeWebViews",webs().size))
    }

    @Test fun offlineCardBlocksRequestsPopupsNavigationAndAllowsInlineImages() = review("today") {
        val web = waitWeb("overview")
        val probe = activity.fixture.url+"/blocked-probe"
        val socket = activity.fixture.url.replace("http://","ws://")+"/blocked-websocket"
        eval(web,"""(function(){var a=document.createElement('a');a.id='external';a.href='$probe';a.textContent='外部页面';document.body.appendChild(a);a.click();window.open('$probe');fetch('$probe').catch(function(){});var image=new Image();image.src='$probe';try{new WebSocket('$socket')}catch(e){};var frame=document.createElement('iframe');frame.src='doudou://prompt?text=iframe';document.body.appendChild(frame);var i=document.createElement('img');i.id='inline';i.src='data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="8" height="8"%3E%3Crect width="8" height="8" fill="blue"/%3E%3C/svg%3E';document.body.appendChild(i);return true})()""")
        compose.waitUntil(5000) { eval(web,"document.getElementById('inline').naturalWidth") == "8" }
        Thread.sleep(300)
        assertTrue(activity.fixture.requests.none { it.path.startsWith("/blocked-") })
        assertTrue(activity.fixture.messages.isEmpty())
        assertEquals(1,Nav.tab.intValue)
        assertEquals("true",eval(web,"!!document.getElementById('overview')"))
        evidence("brief-offline",JSONObject().put("blockedProbeRequests",0).put("unexpectedPromptMessages",0).put("inlineSvgWidth",8))
    }

    @Test fun scrollKeepsWebViewsBounded() = review("today") {
        waitWeb("overview")
        var maximum = 0
        val size = context.resources.displayMetrics
        repeat(4) { touch(4f,size.heightPixels*.7f,size.heightPixels*.28f,300); Thread.sleep(180); maximum=maxOf(maximum,webs().size) }
        repeat(4) { touch(4f,size.heightPixels*.28f,size.heightPixels*.7f,300); Thread.sleep(180); maximum=maxOf(maximum,webs().size) }
        assertTrue("离屏 WebView 没有回收",maximum <= 3)
        evidence("scroll-view-count",JSONObject().put("swipes",8).put("maxAttachedWebViews",maximum))
    }

    @Test fun modelChoiceUsesGetPutAndRetainsSelectionOnFailure() = review("models") {
        waitText("Claude Haiku 5.5")
        compose.onNodeWithTag("setting:anthropic/claude-haiku-5.5").assertIsSelected()
        compose.onNodeWithText("消耗约 1×").assertExists()
        compose.onNodeWithTag("setting:xiaomi/mimo-v2.6-pro").performClick()
        compose.waitUntil(5000) { activity.fixture.snapshotSettings().getString("model") == "xiaomi/mimo-v2.6-pro" }
        compose.waitUntil(5000) { compose.onNodeWithTag("setting:xiaomi/mimo-v2.6-pro").fetchSemanticsNode().config.getOrElse(SemanticsProperties.Selected) { false } }
        compose.onNodeWithTag("setting:xiaomi/mimo-v2.6-pro").assertIsSelected()
        val put = activity.fixture.requests.single { it.method == "PUT" }
        assertEquals(setOf("model"),JSONObject(put.body).keys().asSequence().toSet())
        shot("settings-models")
        activity.fixture.failSettings = true
        compose.onNodeWithTag("setting:z-ai/glm-5.3-flashx").performClick()
        waitText("本地保存失败，请重试")
        compose.onNodeWithTag("setting:xiaomi/mimo-v2.6-pro").assertIsSelected()
        instrumentation.runOnMainSync { Nav.home(0); Nav.open(Route.Settings) }
        waitText("MiMo V2.6 Pro")
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

    @Test fun runningHistoryPollsAtThreeSecondsAndStepsStartCollapsed() = review("running") {
        waitText("进行中")
        compose.onNodeWithText("读取 data/memory/总档.md").assertDoesNotExist()
        shot("task-running")
        compose.onNodeWithTag("task-steps-toggle").performClick()
        waitText("读取 data/memory/总档.md")
        shot("task-running-steps")
        val before = activity.fixture.requests.count { it.path.endsWith("/running-purchase/history") }
        // The lifecycle timer uses real elapsed time, independently of Compose's animation clock.
        compose.waitUntil(5000) { activity.fixture.requests.count { it.path.endsWith("/running-purchase/history") } > before }
        activity.fixture.complete("running-purchase")
        waitText("已完成")
        waitText("已补充完成")
        val count = activity.fixture.requests.count { it.path.endsWith("/running-purchase/history") }
        Thread.sleep(3100)
        assertEquals(count,activity.fixture.requests.count { it.path.endsWith("/running-purchase/history") })
    }

    @Test fun completedTaskOpensFromListShowsBriefAndContinuesSameTask() = review("tasks") {
        waitText("晨报已生成")
        compose.onNodeWithText("晨报已生成").performClick()
        waitText("已完成")
        waitText("晨报已整理")
        compose.onNodeWithText("[晨报](${activity.fixture.briefPath})").assertDoesNotExist()
        compose.onNodeWithText("晨报").assertExists()
        compose.onNodeWithText("读取 data/memory/总档.md").assertDoesNotExist()
        shot("task-completed")
        compose.onNodeWithTag("task-open-brief").performScrollTo().performClick()
        waitWeb("overview")
        assertEquals(1,Nav.tab.intValue)
        instrumentation.runOnMainSync { Nav.home(2) }
        waitText("晨报已生成")
        compose.onNodeWithText("晨报已生成").performClick()
        waitText("已完成")
        val message = "把采购交期放在最前面，再补一版。"
        compose.onNodeWithTag("task-reply").performTextReplacement(message)
        activity.fixture.failSend = true
        compose.onNodeWithTag("task-send").performClick()
        waitText("本地续聊失败，输入已保留")
        compose.onNodeWithTag("task-reply").assertTextEquals(message)
        activity.fixture.failSend = false
        compose.onNodeWithTag("task-send").assertIsEnabled()
        compose.onNodeWithTag("task-send").performClick()
        waitText("已发送，豆豆会在后台接着做")
        waitText("进行中")
        val sends = activity.fixture.requests.filter { it.path.endsWith("/done-morning/send") }
        assertEquals(2,sends.size)
        assertEquals(message,JSONObject(sends.last().body).getString("text"))
        assertTrue(activity.fixture.messages.none { it.optString("t") == "send" })
        compose.onNodeWithTag("task-reply").assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText,AnnotatedString("")))
        shot("task-continuation-sent")
        activity.fixture.complete("done-morning")
        waitText("已完成")
        compose.onNodeWithText("已补充完成").performScrollTo()
        shot("task-continuation-result")
    }
}
