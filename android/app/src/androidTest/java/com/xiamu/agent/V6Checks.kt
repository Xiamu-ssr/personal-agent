package com.xiamu.agent

import android.content.Intent
import android.graphics.Bitmap
import android.os.SystemClock
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
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
class V6Checks {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val name = TestName()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private lateinit var activity: V6ReviewActivity
    private val out get() = File(context.getExternalFilesDir(null), "v0.6.0").apply { mkdirs() }
    private val screen get() = context.resources.displayMetrics
    private val visible = SemanticsMatcher("on screen") { it.boundsInRoot.overlaps(Rect(0f, 0f, screen.widthPixels.toFloat(), screen.heightPixels.toFloat())) }
    private fun tag(value: String) = compose.onAllNodesWithTag(value).filterToOne(visible)
    private fun text(value: String) = compose.onAllNodesWithText(value).filterToOne(visible)
    private fun waitTag(value: String) = compose.waitUntil(10000) { compose.onAllNodesWithTag(value).fetchSemanticsNodes().any { visible.matches(it) } }
    private fun waitText(value: String) = compose.waitUntil(10000) { compose.onAllNodesWithText(value).fetchSemanticsNodes().any { visible.matches(it) } }
    private fun review(scenario: String, block: () -> Unit) {
        ActivityScenario.launch<V6ReviewActivity>(Intent(context, V6ReviewActivity::class.java).putExtra("scenario", scenario).putExtra("skin", "silver")).use { state ->
            state.onActivity { activity = it }
            compose.waitUntil(10000) { Chat.connected.value && Chat.items.size >= 40 }
            assertTrue(Prefs.server.startsWith("http://127.0.0.1:"))
            try { block() } catch (failure: Throwable) {
                shot("failure-${name.methodName}")
                evidence("failure-${name.methodName}", JSONObject().put("error", failure.message).put("tab", Nav.tab.intValue).put("segment", Nav.todaySegment.intValue)
                    .put("requests", JSONArray(activity.fixture.requests.map { JSONObject().put("method", it.method).put("path", it.path) })))
                throw failure
            }
            assertTrue("Undefined fixture requests: ${activity.fixture.unexpected}", activity.fixture.unexpected.isEmpty())
        }
    }
    private fun shot(value: String) {
        compose.waitForIdle(); instrumentation.waitForIdleSync(); Thread.sleep(250)
        val bitmap = instrumentation.uiAutomation.takeScreenshot()
        File(out, "$value.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
    }
    private fun evidence(value: String, json: JSONObject) { File(out, "$value.json").writeText(json.toString(2)) }
    private fun webs(): List<OfflineBriefWebView> {
        val result = ArrayList<OfflineBriefWebView>()
        instrumentation.runOnMainSync {
            fun visit(view: View) {
                if (view is OfflineBriefWebView && view.active) {
                    val xy = IntArray(2); view.getLocationOnScreen(xy)
                    if (xy[0] < screen.widthPixels && xy[0] + view.width > 0) result.add(view)
                }
                if (view is ViewGroup) (0 until view.childCount).forEach { visit(view.getChildAt(it)) }
            }
            visit(activity.window.decorView)
        }
        return result
    }
    private fun eval(web: OfflineBriefWebView, script: String): String {
        val latch = CountDownLatch(1); var value = "null"
        instrumentation.runOnMainSync { web.evaluateJavascript(script) { value = it; latch.countDown() } }
        assertTrue(latch.await(3, TimeUnit.SECONDS)); return value
    }
    private fun waitWeb(id: String): OfflineBriefWebView {
        val deadline = SystemClock.uptimeMillis() + 15000
        while (SystemClock.uptimeMillis() < deadline) {
            compose.waitForIdle()
            webs().firstOrNull { it.height > 2 && eval(it, "!!document.getElementById('$id')") == "true" }?.let { return it }
            Thread.sleep(80)
        }
        error("Card did not load: $id")
    }
    private fun location(view: View): IntArray = IntArray(2).also { instrumentation.runOnMainSync { view.getLocationOnScreen(it) } }
    private fun touch(x1: Float, y1: Float, x2: Float = x1, y2: Float = y1, duration: Long = 350) {
        val start = SystemClock.uptimeMillis()
        fun event(action: Int, x: Float, y: Float) {
            val event = MotionEvent.obtain(start, SystemClock.uptimeMillis(), action, x, y, 0)
            event.source = InputDevice.SOURCE_TOUCHSCREEN
            assertTrue(instrumentation.uiAutomation.injectInputEvent(event, true)); event.recycle()
        }
        event(MotionEvent.ACTION_DOWN, x1, y1)
        if (x1 != x2 || y1 != y2) (1..12).forEach { i -> Thread.sleep(duration/12); event(MotionEvent.ACTION_MOVE, x1+(x2-x1)*i/12, y1+(y2-y1)*i/12) }
        else Thread.sleep(50)
        event(MotionEvent.ACTION_UP, x2, y2)
        Thread.sleep(300); compose.waitForIdle()
    }
    private fun clickDom(web: OfflineBriefWebView, id: String) {
        // DOM probes can change scrollHeight. Wait for the animated native card to catch up.
        compose.waitUntil(6000) {
            val size = JSONArray(eval(web, "[document.documentElement.scrollHeight,innerWidth]"))
            abs(web.height - size.getDouble(0)*web.width/size.getDouble(1)) < 4
        }
        val rect = JSONArray(eval(web, "(function(){var r=document.getElementById('$id').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2,innerWidth]})()"))
        val xy = location(web); val scale = web.width / rect.getDouble(2)
        touch((xy[0]+rect.getDouble(0)*scale).toFloat(), (xy[1]+rect.getDouble(1)*scale).toFloat())
    }
    private fun position(tag: String) = this.tag(tag).fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value()
    private fun keyboardVisible(): Boolean { var shown = false; instrumentation.runOnMainSync { shown = activity.window.decorView.rootWindowInsets?.isVisible(android.view.WindowInsets.Type.ime()) == true }; return shown }

    @Test fun allSkinsPersistAndSixNativeScreensMatchHtmlSkinAtDocumentStart() = review("skins") {
        waitTag("skin:silver")
        shot("settings-skins")
        val checks = JSONArray()
        Skin.entries.forEach { skin ->
            if (Nav.stack.isEmpty()) instrumentation.runOnMainSync { Nav.open(Route.Skins) }
            waitTag("skin:${skin.id}")
            tag("skin:${skin.id}").performClick()
            compose.runOnIdle { Prefs.init(context); SkinState.restore(); assertEquals(skin, SkinState.current.value) }
            tag("skin:${skin.id}").assertIsSelected()
            instrumentation.runOnMainSync { Nav.home(1); Nav.todaySegment.intValue = 0 }
            val web = waitWeb("overview")
            compose.waitUntil(5000) { eval(web, "window.firstSkin") == "\"${skin.id}\"" }
            val dims = JSONArray(eval(web, "[document.documentElement.scrollHeight,innerWidth]"))
            compose.waitUntil(5000) { abs(web.height-dims.getDouble(0)*web.width/dims.getDouble(1)) < 4 }
            shot("today-${skin.id}")
            checks.put(JSONObject().put("skin", skin.id).put("documentStartSkin", eval(web,"window.firstSkin")).put("cardBackground",eval(web,"getComputedStyle(document.getElementById('overview')).backgroundColor")))
            instrumentation.runOnMainSync { Nav.home(0) }
            waitTag("chat-list"); Thread.sleep(350)
            shot("chat-${skin.id}")
        }
        evidence("skins", JSONObject().put("checks", checks).put("localPersistence", true))
    }
    @Test fun cardsUseFullHeightAndNativeSwipesFollowTheRequiredOrder() = review("today") {
        waitWeb("overview")
        tag("today-list").performScrollToKey("${activity.fixture.briefPath}:1")
        val web = waitWeb("long")
        val dims = JSONArray(eval(web, "[document.documentElement.scrollHeight,innerWidth]"))
        compose.waitUntil(5000) { abs(web.height-dims.getDouble(0)*web.width/dims.getDouble(1)) < 4 }
        assertTrue(web.height > screen.heightPixels*.75)
        assertTrue(web.height <= screen.heightPixels*2)
        val before = location(web)[1]
        touch(screen.widthPixels*.5f, screen.heightPixels*.6f, y2 = screen.heightPixels*.32f)
        assertTrue(abs(location(web)[1]-before) > 100)
        assertEquals("0",eval(web,"document.scrollingElement.scrollTop"))
        shot("brief-full-height")
        val sequence = JSONArray().put("今日·简报")
        touch(screen.widthPixels*.82f, screen.heightPixels*.42f, screen.widthPixels*.18f, screen.heightPixels*.42f)
        compose.waitUntil(5000) { Nav.tab.intValue == 1 && Nav.todaySegment.intValue == 1 }; sequence.put("今日·站点")
        touch(screen.widthPixels*.82f, screen.heightPixels*.42f, screen.widthPixels*.18f, screen.heightPixels*.42f)
        compose.waitUntil(5000) { Nav.tab.intValue == 2 }; sequence.put("任务")
        touch(screen.widthPixels*.82f, screen.heightPixels*.42f, screen.widthPixels*.18f, screen.heightPixels*.42f)
        compose.waitUntil(5000) { Nav.tab.intValue == 3 }; sequence.put("记忆")
        repeat(4) { touch(screen.widthPixels*.18f, screen.heightPixels*.42f, screen.widthPixels*.82f, screen.heightPixels*.42f) }
        compose.waitUntil(5000) { Nav.tab.intValue == 0 }
        evidence("brief-gestures", JSONObject().put("fullHeightPixels",web.height).put("cssHeight",dims.getDouble(0)).put("internalScrollTop",0).put("sequence",sequence).put("returnedToChat",true))
    }
    @Test fun offlineCardStillBlocksRequestsAndActualButtonSendsChinesePrompt() = review("today") {
        val web = waitWeb("overview")
        val probe = activity.fixture.url+"/blocked-probe"
        eval(web,"""(function(){fetch('$probe').catch(function(){});window.open('$probe');var f=document.createElement('iframe');f.src='doudou://prompt?text=iframe';document.body.appendChild(f);return true})()""")
        Thread.sleep(200)
        assertTrue(activity.fixture.requests.none { it.path.startsWith("/blocked-") })
        assertTrue(activity.fixture.messages.isEmpty())
        clickDom(web, "prompt")
        compose.waitUntil(5000) { activity.fixture.messages.any { it.optString("t") == "send" } }
        assertEquals("帮我把今天的事排个顺序", activity.fixture.messages.single().getString("text"))
        compose.waitUntil(5000) { Chat.items.filterIsInstance<ChatItem.User>().any { it.text == "帮我把今天的事排个顺序" && !it.pending } }
        shot("brief-prompt-chat")
    }
    @Test fun historyStaysPutForMessagesAndKeyboardThenReturnsAndSendingFollows() = review("chat") {
        waitTag("chat-list"); Thread.sleep(500)
        repeat(3) { touch(screen.widthPixels*.5f, screen.heightPixels*.30f, y2 = screen.heightPixels*.73f) }
        waitTag("return-bottom")
        val before = position("chat-list")
        activity.fixture.reply("新的回复一"); activity.fixture.reply("新的回复二")
        compose.waitUntil(5000) { Chat.items.filterIsInstance<ChatItem.Assistant>().any { it.text == "新的回复二" } }
        assertTrue(abs(position("chat-list")-before) < .15f)
        compose.onNodeWithTag("unread-count", useUnmergedTree = true).assertTextEquals("2")
        tag("composer").performClick()
        compose.waitUntil(5000) { keyboardVisible() }
        assertTrue(abs(position("chat-list")-before) < .15f)
        instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        compose.waitUntil(5000) { !keyboardVisible() }
        shot("chat-return-bottom")
        tag("return-bottom").performClick()
        compose.waitUntil(5000) { compose.onAllNodesWithTag("return-bottom").fetchSemanticsNodes().isEmpty() }
        waitText("新的回复二")
        tag("composer").performClick()
        compose.waitUntil(5000) { keyboardVisible() }
        text("新的回复二").assertIsDisplayed()
        instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        compose.waitUntil(5000) { !keyboardVisible() }
        repeat(3) { touch(screen.widthPixels*.5f, screen.heightPixels*.30f, y2 = screen.heightPixels*.73f) }
        waitTag("return-bottom")
        tag("composer").performTextReplacement("发送后回到底部")
        compose.onNodeWithContentDescription("发送").performClick()
        waitText("发送后回到底部")
        compose.waitUntil(5000) { compose.onAllNodesWithTag("return-bottom").fetchSemanticsNodes().isEmpty() }
        evidence("chat-scroll", JSONObject().put("historyPositionBefore",before).put("unreadBeforeReturn",2).put("keyboardPreservedHistory",true).put("keyboardKeptBottom",true).put("sendReturnedBottom",true))
    }
    @Test fun groupedJobsLoadTheNextCursorThroughTheList() = review("tasks") {
        waitText("进行中"); waitText("今天"); waitText("近 7 天"); waitText("更早")
        shot("tasks-grouped")
        tag("jobs-list").performScrollToIndex(9)
        compose.waitUntil(5000) { activity.fixture.queries.any { it.contains("before=") } }
        tag("jobs-list").performScrollToIndex(44)
        waitText("历史任务 44")
        shot("tasks-paginated")
        assertEquals(1, activity.fixture.queries.count { it.contains("before=") })
        evidence("jobs-pagination", JSONObject().put("olderRequests",1).put("lastTask","old-44").put("cursorUsed",true))
    }
    @Test fun taskUsesSharedMessagesToolsComposerAndAttachmentSendWithFailuresPreserved() = review("running") {
        waitText("豆豆交代的"); waitText("样品规格.pdf")
        compose.onAllNodesWithText("读取供应商资料，核对样品规格与数量。").assertCountEquals(0)
        tag("task-tool:1").performClick()
        waitText("读取供应商资料，核对样品规格与数量。")
        shot("task-detail")
        val at = position("task-history")
        compose.waitUntil(7500) { activity.fixture.requests.count { it.path.endsWith("running-purchase/history") } >= 3 }
        assertTrue(abs(position("task-history")-at) < .15f)
        tag("composer").performTextReplacement("把交期放在前面")
        activity.fixture.failSend = true
        compose.onNodeWithContentDescription("发送").performClick()
        waitText("没发出去：本地续聊失败，输入已保留")
        tag("composer").assertTextEquals("把交期放在前面")
        activity.fixture.failSend = false
        compose.onNodeWithContentDescription("发送").performClick()
        compose.waitUntil(5000) { activity.fixture.requests.count { it.path.endsWith("running-purchase/send") } == 2 }
        val first = JSONObject(activity.fixture.requests.last { it.path.endsWith("running-purchase/send") }.body)
        assertEquals("把交期放在前面", first.getString("text"))
        // Seed local picked files; the actual shared composer performs all uploads and task sending.
        instrumentation.runOnMainSync {
            listOf("image", "file", "voice").forEachIndexed { i, kind ->
                val file = File(context.cacheDir, "fixture-$kind.bin").apply { writeText("local-$kind") }
                activity.taskDraft.picked.add(Picked(5000L+i, file.name, kind, file = file))
            }
        }
        compose.waitUntil(5000) { !activity.taskDraft.sending.value }
        compose.onNodeWithContentDescription("发送").performClick()
        compose.waitUntil(5000) { activity.fixture.requests.count { it.path == "/api/upload" } == 3 }
        compose.waitUntil(5000) { activity.fixture.requests.count { it.path.endsWith("running-purchase/send") } == 3 }
        val send = JSONObject(activity.fixture.requests.last { it.path.endsWith("running-purchase/send") }.body)
        assertEquals("",send.getString("text"))
        assertEquals(listOf("image","file","voice"),send.getJSONArray("attachments").objects().map { it.getString("kind") })
        assertTrue(activity.fixture.messages.none { it.optString("t") == "send" })
        activity.fixture.complete("running-purchase")
        waitText("已完成")
        val times = activity.fixture.requests.filter { it.path.endsWith("running-purchase/history") }
        evidence("task-contract",JSONObject().put("historyReads",times.size).put("initialIntervalsMs",JSONArray(times.take(3).zipWithNext { a,b -> b.nanoMs-a.nanoMs }))
            .put("attachmentKinds",JSONArray(send.getJSONArray("attachments").objects().map { it.getString("kind") })).put("mainChatSends",0).put("positionPreserved",true))
    }
    @Test fun healthRendersNullsSyncsAndOpensOldWeeklyBriefAndMemoryRecord() = review("health") {
        waitText("健康基线")
        tag("health-metric:心率变异性").onChildren().filter(hasText("--")).assertCountEquals(1)
        shot("health")
        compose.onNodeWithContentDescription("同步健康").performClick()
        compose.waitUntil(5000) { activity.fixture.requests.any { it.path == "/api/health/sync" && it.method == "POST" } }
        waitText("上次同步 09:18 · 测试手机")
        compose.waitUntil(5000) { activity.fixture.requests.count { it.path == "/api/health" } >= 2 }
        val range = "${activity.fixture.day.minusDays(20).monthValue}月${activity.fixture.day.minusDays(20).dayOfMonth}日–${activity.fixture.day.minusDays(14).monthValue}月${activity.fixture.day.minusDays(14).dayOfMonth}日"
        text(range).performClick()
        waitWeb("weekly")
        shot("health-weekly")
        assertTrue(activity.fixture.requests.any { it.path == "/api/briefs/item" })
        instrumentation.runOnMainSync { Nav.back() }
        waitText("健康基线")
        text("健康基线").performClick()
        waitText("健康档案")
        shot("health-record")
        evidence("health-contract", JSONObject().put("nullDisplayedAsDashes",true).put("syncPost",true).put("refreshedGet",true).put("weeklyOlderThan7Days",true).put("recordMarkdown",true))
    }
}
