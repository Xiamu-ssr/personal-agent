package com.xiamu.agent

import android.content.Intent
import android.graphics.Bitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.xiamu.agent.ui.*
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class V4Checks {
    @get:Rule val compose=createEmptyComposeRule()
    private val instrumentation=InstrumentationRegistry.getInstrumentation()
    private val context=instrumentation.targetContext
    private fun review(scenario: String,block: (ActivityScenario<V4ReviewActivity>)->Unit) {
        ActivityScenario.launch<V4ReviewActivity>(Intent(context,V4ReviewActivity::class.java).putExtra("scenario",scenario)).use {
            waitText(when(scenario) { "today","today-empty" -> "简报"; "queue" -> "这条消息准备修改"; "tasks" -> "晨报已生成"; "memory","memory-empty" -> "我对 夏木 的了解"; "dou" -> "更换外观"; "diaries" -> "豆豆的日记"; "settings" -> "夏木 Pro"; "connectors" -> "QQ 邮箱"; "devices" -> "旧笔记本"; "local" -> "一键开启"; else -> "今日" })
            block(it)
            it.onActivity { activity -> assertTrue("假服务出现未定义请求：${activity.fixture.unexpected}",activity.fixture.unexpected.isEmpty()) }
        }
    }
    private fun waitText(text: String) { compose.waitUntil(10000) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() } }
    private fun shot(name: String) {
        compose.waitForIdle()
        instrumentation.waitForIdleSync()
        // The native compositor can trail Compose semantics by a frame during navigation/dialogs.
        Thread.sleep(400)
        val dir=File(context.getExternalFilesDir(null),"v0.4.0").apply { mkdirs() }
        instrumentation.uiAutomation.takeScreenshot().let { image -> File(dir,"$name.png").outputStream().use { image.compress(Bitmap.CompressFormat.PNG,100,it) }; image.recycle() }
    }
    private fun longPress(text: String) { compose.onNodeWithText(text).performTouchInput { longClick() } }

    @Test fun todayEmptyGetsTimeFromSchedule()=review("today-empty") {
        waitText("今天还没有简报 · 晨报 7:30")
        shot("today-empty")
    }
    @Test fun sitesUseOffscreenViewportCacheAndFailureFallback()=review("today") { activity ->
        compose.onNodeWithText("站点").performClick()
        waitText("采购进度")
        compose.waitUntil(16000) { compose.onAllNodesWithTag("site-thumbnail:data/sites/purchase/index.html",useUnmergedTree=true).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("样品、报价与交期，一眼看清").assertExists()
        compose.onNodeWithText("missing").assertExists()
        shot("today-sites")
        activity.onActivity { assertTrue(it.fixture.requests.any { r -> r.contains("/files/data/sites/purchase/index.html") }) }
        compose.onNodeWithText("采购进度").performClick()
        shot("site-webview")
    }
    @Test fun withdrawQueueUsesIdAndNeverWritesHistory()=review("queue") { activity ->
        shot("queue-before")
        longPress("这条消息准备撤回")
        shot("queue-menu")
        compose.onNodeWithText("撤回").performClick()
        compose.waitUntil(5000) { Chat.items.filterIsInstance<ChatItem.User>().none { it.id=="q-remove" } }
        shot("queue-removed")
        activity.onActivity {
            assertEquals("q-remove",it.fixture.messages.last().getString("id"))
            val history=runBlocking { Api.getJson("/api/history") }.getJSONArray("items").objects()
            assertTrue(history.none { row -> row.optString("id")=="q-remove" })
        }
    }
    @Test fun editQueuePreservesBubbleAndOnlyFinalTextEntersHistory()=review("queue") { activity ->
        longPress("这条消息准备修改")
        compose.onNodeWithText("修改").performClick()
        shot("queue-edit-dialog")
        compose.onAllNodes(hasSetTextAction()).onLast().performTextReplacement("先核对交期，再补齐样品")
        compose.onNodeWithText("保存").performClick()
        waitText("先核对交期，再补齐样品")
        shot("queue-edited")
        activity.onActivity {
            val request=it.fixture.messages.last()
            assertEquals("edit_queued",request.getString("t")); assertEquals("q-edit",request.getString("id"))
            it.fixture.beginQueued("q-remove"); it.fixture.beginQueued("q-edit")
            val item=runBlocking { Api.getJson("/api/history") }.getJSONArray("items").objects().first { row -> row.optString("id")=="q-edit" }
            assertEquals("先核对交期，再补齐样品",item.getString("text"))
        }
    }
    @Test fun tooLateQueueUpdateExplainsAndKeepsMessage()=review("queue") { activity ->
        activity.onActivity { it.fixture.tooLate=true }
        longPress("这条消息准备撤回")
        compose.onNodeWithText("撤回").performClick()
        waitText("豆豆已经在看这条了")
        compose.onNodeWithText("这条消息准备撤回").assertExists()
        shot("queue-too-late")
    }
    @Test fun reconnectRestoresEditedQueueAndHistoryRefreshDoesNotEraseIt()=review("queue") { activity ->
        Chat.editQueued("q-edit","重连后仍保留的最终文本")
        waitText("重连后仍保留的最终文本")
        activity.onActivity { Chat.disconnect(); Chat.connect() }
        compose.waitUntil(10000) { Chat.connected.value && Chat.items.filterIsInstance<ChatItem.User>().count { it.id=="q-edit" && it.text=="重连后仍保留的最终文本" && it.queued }==1 }
        var fixture: V4Fixture?=null
        activity.onActivity { fixture=it.fixture }
        compose.waitUntil(5000) { fixture!!.requests.count { it=="GET /api/history" }>=2 }
        compose.waitForIdle()
        compose.onNodeWithText("重连后仍保留的最终文本").assertExists()
        longPress("重连后仍保留的最终文本")
        compose.onNodeWithText("撤回").performClick()
        compose.waitUntil(5000) { Chat.items.filterIsInstance<ChatItem.User>().none { it.id=="q-edit" } }
        shot("queue-reconnected-removed")
    }
    @Test fun tasksCombineCurrentAndCompletedAndBriefJumpsToToday()=review("tasks") { activity ->
        compose.onNodeWithText("整理采购资料").assertExists()
        compose.onAllNodesWithText("任务").onFirst().assertExists()
        shot("tasks-combined")
        compose.onNodeWithTag("stop-task:purchase").performClick()
        compose.waitUntil(5000) { Chat.tasks.firstOrNull()?.stopping==true }
        assertEquals(1,Chat.tasks.size)
        shot("task-stopping")
        compose.onNodeWithText("晨报已生成").performClick()
        waitText("任务说明")
        compose.onNodeWithText("看简报").performScrollTo().performClick()
        waitText("简报")
        activity.onActivity { assertEquals(1,Nav.tab.intValue) }
    }
    @Test fun tasksScheduleHasTwoSegmentsAndRunsBriefAlarm()=review("tasks") { activity ->
        compose.onNodeWithText("定时").performClick()
        compose.onNodeWithText("每天 7:30").assertExists()
        compose.onAllNodesWithText("立即运行").assertCountEquals(2)
        compose.onNodeWithText("系统任务").assertExists()
        compose.onNodeWithText("为你推荐").assertDoesNotExist()
        shot("tasks-schedule")
        compose.onAllNodesWithText("立即运行").onFirst().performClick()
        waitText("已安排「晨报」，完成后会送到聊天和今日")
        activity.onActivity { assertTrue(it.fixture.requests.contains("POST /api/run")) }
    }
    @Test fun memoryHasFourHealthMetricsFoldersAndFullProfile()=review("memory") {
        waitText("6840")
        compose.onNodeWithText("61").assertExists()
        compose.onNodeWithText("42").assertExists()
        shot("memory-health")
        compose.onNodeWithText("语音笔记").performScrollTo()
        shot("memory-folders")
        compose.onNodeWithText("查看全部").performScrollTo().performClick()
        compose.onNodeWithText("沟通希望简明直接。",substring=true).assertExists()
        shot("memory-profile")
    }
    @Test fun memoryMissingHealthShowsDashesAndVoiceEmptyHint()=review("memory-empty") {
        waitText("还没有健康数据")
        compose.onAllNodesWithText("--",useUnmergedTree=true).assertCountEquals(4)
        shot("memory-no-health")
        compose.onNodeWithText("按住说话发的语音笔记会出现在这里").performScrollTo().assertIsDisplayed()
    }
    @Test fun avatarAllShapesAndPalettesRoundTripThroughProfile()=review("dou") { activity ->
        shot("dou-bean-mist")
        for((shape,label) in AvatarChoice.shapes) {
            if(shape=="bean") continue
            compose.onNodeWithText("更换外观").performClick()
            compose.onNodeWithText(label).performClick()
            compose.waitUntil(5000) { Appearance.choice.value.shape==shape }
            compose.onNodeWithText("完成").performClick()
            compose.waitUntil(5000) { compose.onAllNodesWithText("豆豆的外观").fetchSemanticsNodes().isEmpty() }
            shot("dou-$shape-mist")
        }
        for((palette,label) in AvatarChoice.palettes) {
            compose.onNodeWithText("更换外观").performClick()
            compose.onNodeWithText(label).performClick()
            compose.waitUntil(5000) { Appearance.choice.value.palette==palette }
            compose.onNodeWithText("完成").performClick()
            compose.waitUntil(5000) { compose.onAllNodesWithText("豆豆的外观").fetchSemanticsNodes().isEmpty() }
            activity.onActivity { assertEquals(palette,runBlocking { Api.profile() }.palette) }
        }
        activity.onActivity { assertEquals("cat",runBlocking { Api.profile() }.shape); assertTrue(it.fixture.requests.count { r -> r=="PUT /api/profile" }>=7) }
        compose.onNodeWithText("查看所有日记").performScrollTo().performClick()
        shot("diary-grid")
    }
    @Test fun membershipUsesUserCallAndFirstChatWithoutModelRow()=review("settings") {
        compose.onNodeWithText("模型").assertDoesNotExist()
        compose.onNodeWithText("陪伴第",substring=true).assertExists()
        shot("settings-membership")
    }
    @Test fun connectorCatalogOnlyShowsServicesAndCachesOfficialIcons()=review("connectors") { activity ->
        compose.onNodeWithText("网页搜索").assertDoesNotExist()
        compose.onNodeWithText("豆豆自建").assertDoesNotExist()
        compose.onNodeWithText("163 邮箱").assertExists()
        compose.onNodeWithText("Gmail").assertExists()
        compose.waitUntil(8000) { File(context.cacheDir,"connector-icons").listFiles()?.isNotEmpty()==true }
        shot("connectors-cloud")
        compose.onNodeWithText("QQ 邮箱").performClick()
        waitText("个人 QQ 邮箱")
        compose.onAllNodesWithText("重新测试").assertCountEquals(2)
        shot("connector-detail")
        compose.onAllNodesWithText("重新测试").onLast().performClick()
        compose.waitUntil(5000) { compose.onAllNodesWithText("连接异常").fetchSemanticsNodes().isEmpty() }
        activity.onActivity { assertTrue(it.fixture.requests.contains("POST /api/connectors/qq-mail/accounts/qq2/test")); assertTrue(it.fixture.iconRequests.get()>0) }
    }
    @Test fun connectorFailureKeepsValuesThenSuccessfulAddReturnsToAccounts()=review("connectors") { activity ->
        compose.onNodeWithText("163 邮箱").performClick()
        compose.onNodeWithText("添加账号").performClick()
        compose.onNodeWithTag("field:address").performTextInput("local@163.com")
        compose.onNodeWithTag("field:password").performTextInput("fixture-only")
        activity.onActivity { it.fixture.failSave=true }
        compose.onNodeWithText("验证并添加").performClick()
        waitText("授权码不对，请重新生成后再试")
        compose.onNodeWithTag("field:address").assertTextEquals("local@163.com")
        compose.onNodeWithContentDescription("显示授权码").performClick()
        compose.onNodeWithTag("field:password").assertTextEquals("fixture-only")
        compose.onNodeWithContentDescription("隐藏授权码").performClick()
        shot("connector-form-failure")
        activity.onActivity { it.fixture.failSave=false }
        compose.onNodeWithText("验证并添加").performClick()
        waitText("local@163.com")
        shot("connector-account-added")
        activity.onActivity { assertTrue(Nav.stack.last() is Route.ConnectorDetail) }
    }
    @Test fun connectorFormSelectShowIfAndNumberUseCommonPage()=review("connectors") { activity ->
        compose.onNodeWithText("表单选项示例").performScrollTo().performClick()
        compose.onNodeWithText("添加账号").performClick()
        compose.onNodeWithTag("field:host").assertDoesNotExist()
        compose.onNodeWithText("手动").performClick()
        compose.onNodeWithTag("field:host").assertExists()
        compose.onNodeWithTag("field:port").assertTextEquals("993")
        compose.onNodeWithTag("field:host").performTextInput("imap.example.com")
        shot("connector-select-form")
        compose.onNodeWithText("验证并添加").performClick()
        waitText("表单选项示例账号")
        activity.onActivity { assertTrue(it.fixture.requests.contains("POST /api/connectors/fixture-options/accounts")) }
    }
    @Test fun connectorSecretEditKeepsMaskedSecretAndDeleteNeedsConfirmation()=review("connectors") {
        compose.onNodeWithText("QQ 邮箱").performClick()
        waitText("个人 QQ 邮箱")
        compose.onAllNodesWithText("编辑").onFirst().performClick()
        compose.onNodeWithTag("field:address").assertTextEquals("fixture@qq.com")
        compose.onNodeWithTag("field:address").performTextReplacement("new@qq.com")
        compose.onNodeWithText("保存并验证").performClick()
        waitText("new@qq.com")
        val account=runBlocking { Api.getJson("/api/connectors") }.getJSONObject("cloud").getJSONArray("installed").objects().first { it.getString("name")=="qq-mail" }.getJSONArray("accounts").objects().first { it.getString("id")=="qq1" }
        assertEquals("••••",account.getJSONObject("values").getString("password"))
        compose.onAllNodesWithText("删除").onFirst().performClick()
        compose.onNodeWithText("取消").performClick()
        compose.onAllNodesWithText("删除").onFirst().performClick()
        compose.onAllNodesWithText("删除").onLast().performClick()
        compose.waitUntil(5000) { compose.onAllNodesWithText("工作 QQ 邮箱").fetchSemanticsNodes().isEmpty() }
    }
    @Test fun devicesOnlyRemoveOfflineAfterConfirmation()=review("devices") {
        compose.onAllNodesWithText("移除").assertCountEquals(1)
        compose.onNodeWithText("移除").performClick()
        shot("device-remove-confirmation")
        compose.onNodeWithText("取消").performClick()
        compose.onNodeWithText("移除").performClick()
        compose.onAllNodesWithText("移除").onLast().performClick()
        compose.waitUntil(5000) { compose.onAllNodesWithText("旧笔记本").fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithText("工作电脑").assertExists()
    }
    @Test fun localCapabilitiesHaveBatchButtonAndNoOpenUrl()=review("local") {
        assertEquals(setOf("battery","notify","location","calendar_events","sms","clipboard_write","health"),com.xiamu.agent.device.Capabilities.all.map { it.name }.toSet())
        compose.onNodeWithText("一键开启").assertExists()
        shot("connectors-local")
    }
}
