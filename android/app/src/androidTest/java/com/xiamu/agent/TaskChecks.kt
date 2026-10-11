package com.xiamu.agent

import android.content.Intent
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class TaskChecks {
    @get:Rule val compose = createEmptyComposeRule()
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private fun review(scenario: String, block: (ActivityScenario<TaskReviewActivity>) -> Unit) {
        ActivityScenario.launch<TaskReviewActivity>(Intent(context, TaskReviewActivity::class.java).putExtra("scenario", scenario)).use { activity ->
            compose.waitUntil(8000) { Chat.connected.value }
            compose.waitForIdle()
            assertTrue(Prefs.server.startsWith("http://127.0.0.1:"))
            block(activity)
            activity.onActivity { assertTrue(it.fixture.unexpected.isEmpty()) }
        }
    }

    private fun emit(activity: ActivityScenario<TaskReviewActivity>, json: String) {
        activity.onActivity { it.fixture.emit(JSONObject(json)) }
    }

    @Test fun busyComposerStillSendsAndQueuedBubblesAdvance() = review("queued") { activity ->
        compose.waitUntil(5000) { Chat.items.filterIsInstance<ChatItem.User>().any { it.queued } }
        compose.onNodeWithTag("composer").assertIsEnabled().performTextReplacement("这条也排队")
        compose.onNodeWithContentDescription("发送").performClick()
        compose.waitUntil(5000) { Chat.items.filterIsInstance<ChatItem.User>().count { it.queued && !it.pending } == 2 }
        activity.onActivity {
            val message = it.fixture.received.single { m -> m.optString("t") == "send" }
            assertEquals("这条也排队", message.getString("text"))
            assertTrue(it.fixture.received.none { m -> m.optString("t") == "interrupt" })
        }
        emit(activity, """{"t":"turn_end","text":"当前回复完成"}""")
        emit(activity, """{"t":"status","busy":false}""")
        emit(activity, """{"t":"status","busy":true,"reason":"user"}""")
        compose.waitUntil(5000) { Chat.items.filterIsInstance<ChatItem.User>().count { it.queued } == 1 }
        assertEquals("这条也排队", Chat.items.filterIsInstance<ChatItem.User>().single { it.queued }.text)
    }

    @Test fun spontaneousResultRendersWithoutUserAndBusyWaitsForStatus() = review("busy-task-result") { activity ->
        compose.waitUntil(5000) { Chat.reason.value == "task_result" && Chat.streaming.value.isNotBlank() }
        compose.onNodeWithText("豆豆正在处理子任务结果…").assertExists()
        assertTrue(Chat.items.none { it is ChatItem.User })
        emit(activity, """{"t":"turn_end","text":"简报已完成，请查看今日。"}""")
        compose.waitUntil(5000) { Chat.items.filterIsInstance<ChatItem.Assistant>().any { it.text == "简报已完成，请查看今日。" } }
        assertTrue(Chat.busy.value)
        assertEquals("", Chat.streaming.value)
        emit(activity, """{"t":"job","phase":"done","label":"报价简报","title":"报价简报 · 今日","outputs":["data/briefs/2026-10-11/报价简报.json"],"ok":true,"taskId":"quote"}""")
        compose.waitUntil(5000) { Chat.items.filterIsInstance<ChatItem.Card>().any { it.title == "报价简报 · 今日" } }
        compose.onNodeWithText("报价简报 · 今日").assertExists()
        emit(activity, """{"t":"status","busy":false}""")
        compose.waitUntil(5000) { !Chat.busy.value }
        compose.onNodeWithTag("interrupt").assertDoesNotExist()
        assertEquals(listOf("files"), Chat.tasks.map { it.id })
    }

    @Test fun scheduledTurnHasAlarmLineAndItsOwnBusyLabel() = review("busy-schedule") { _ ->
        compose.waitUntil(5000) { Chat.reason.value == "schedule" }
        compose.onNodeWithText("豆豆正在安排定时任务…").assertExists()
        compose.onNodeWithText("晨报时间到了").assertExists()
        compose.onAllNodesWithTag("schedule-message").assertCountEquals(1)
        compose.onAllNodesWithTag("user-message").assertCountEquals(0)
        compose.onNodeWithTag("composer").assertIsEnabled()
    }

    @Test fun perTaskStopOnlyAffectsTargetAndWaitsForFinalNotification() = review("background") { activity ->
        compose.onNodeWithTag("background-tasks").performClick()
        compose.onNodeWithTag("stop-task:quote").performClick()
        compose.waitUntil(5000) { Chat.tasks.firstOrNull { it.id == "quote" }?.stopping == true }
        compose.onNodeWithTag("stop-task:quote").assertIsNotEnabled()
        compose.onNodeWithTag("stop-task:files").assertIsEnabled()
        compose.onNodeWithText("停止中…").assertExists()
        compose.waitUntil(5000) { var received = false; activity.onActivity { received = it.fixture.received.any { m -> m.optString("t") == "stop_task" } }; received }
        activity.onActivity {
            assertEquals(2, Chat.tasks.size)
            val stops = it.fixture.received.filter { m -> m.optString("t") == "stop_task" }
            assertEquals(listOf("quote"), stops.map { m -> m.getString("id") })
            assertTrue(it.fixture.received.none { m -> m.optString("t") == "interrupt" })
        }
        emit(activity, """{"t":"task","phase":"notification","id":"quote","status":"stopped","background":true}""")
        compose.waitUntil(5000) { Chat.tasks.size == 1 }
        assertEquals("files", Chat.tasks.single().id)
        compose.onNodeWithText("后台还有 1 个任务在跑").assertExists()
        compose.onNodeWithTag("stop-task:quote").assertDoesNotExist()
    }

    @Test fun failedStopRestoresButtonWithChineseReason() = review("background") { activity ->
        activity.onActivity { it.fixture.failStop = true }
        compose.onNodeWithTag("background-tasks").performClick()
        compose.onNodeWithTag("stop-task:quote").performClick()
        compose.waitUntil(5000) { Chat.tasks.first { it.id == "quote" }.error.isNotBlank() }
        compose.onNodeWithTag("stop-task:quote").assertIsEnabled()
        compose.onAllNodesWithText("停止任务失败，请稍后再试").onFirst().assertExists()
        activity.onActivity { it.fixture.failStop = false }
        compose.onNodeWithTag("stop-task:quote").performClick()
        compose.waitUntil(5000) { Chat.tasks.first { it.id == "quote" }.stopping }
        assertEquals(2, Chat.tasks.size)
        emit(activity, """{"t":"task","phase":"snapshot","tasks":[]}""")
        compose.waitUntil(5000) { Chat.tasks.isEmpty() }
        compose.onNodeWithTag("background-tasks").assertDoesNotExist()
    }

    @Test fun historyAndLiveScheduleMessagesAreGrayAndCardsRemain() = review("alarm") { _ ->
        compose.waitUntil(5000) { Chat.items.filterIsInstance<ChatItem.Alarm>().size == 2 }
        compose.onAllNodesWithTag("schedule-message").assertCountEquals(2)
        compose.onNodeWithText("晨报时间到了").assertExists()
        compose.onNodeWithText("报价简报时间到了").assertExists()
        compose.onNodeWithText("晨报 · 今日资讯").assertExists()
        compose.onAllNodesWithTag("user-message").assertCountEquals(0)
        assertTrue(Chat.items.none { it is ChatItem.User })
    }

    @Test fun interruptLeavesBackgroundTasksRunning() = review("busy-task-result") { activity ->
        compose.waitUntil(5000) { Chat.busy.value }
        compose.onNodeWithTag("interrupt").performClick()
        compose.waitUntil(5000) { !Chat.busy.value }
        assertEquals(listOf("files"), Chat.tasks.map { it.id })
        activity.onActivity {
            assertEquals(1, it.fixture.received.count { m -> m.optString("t") == "interrupt" })
            assertTrue(it.fixture.received.none { m -> m.optString("t") == "stop_task" })
        }
    }

    @Test fun reconnectUsesHelloInsteadOfOldBusyOrStoppingState() = review("background") { activity ->
        compose.onNodeWithTag("background-tasks").performClick()
        compose.onNodeWithTag("stop-task:quote").performClick()
        emit(activity, """{"t":"status","busy":true,"reason":"task_result"}""")
        emit(activity, """{"t":"delta","text":"旧连接的文字"}""")
        activity.onActivity {
            it.fixture.reconnectHello = JSONObject("""{"t":"hello","busy":false,"tasks":[{"id":"fresh","description":"恢复后的任务","startedAt":1}],"history":[]}""")
            it.fixture.drop()
        }
        compose.waitUntil(10000) { Chat.connected.value && Chat.tasks.map { it.id } == listOf("fresh") }
        assertFalse(Chat.busy.value)
        assertEquals("", Chat.reason.value)
        assertEquals("", Chat.streaming.value)
        assertFalse(Chat.tasks.single().stopping)
        activity.onActivity { assertEquals(2, it.fixture.connections.get()) }
    }

    @Test fun lateStateResponseCannotResurrectCompletedTasks() = review("background") { activity ->
        var before = 0
        activity.onActivity { before = it.fixture.stateRequests.get(); it.fixture.delayState = true; Chat.refreshRunning() }
        compose.waitUntil(5000) { var requested = false; activity.onActivity { requested = it.fixture.stateRequests.get() > before }; requested }
        emit(activity, """{"t":"task","phase":"snapshot","tasks":[]}""")
        compose.waitUntil(5000) { Chat.tasks.isEmpty() }
        Thread.sleep(1600)
        compose.waitForIdle()
        assertTrue(Chat.tasks.isEmpty())
        compose.onNodeWithTag("background-tasks").assertDoesNotExist()
    }

    @Test fun taskWireEventsMergeByIdAndIgnoreAmbientWork() = review("background") { activity ->
        emit(activity, """{"t":"task","phase":"snapshot","tasks":[{"id":"one","description":"初始任务","startedAt":10}]}""")
        emit(activity, """{"t":"task","phase":"started","id":"one","description":"更新描述","startedAt":10,"background":true}""")
        emit(activity, """{"t":"task","phase":"started","id":"ambient","description":"维护任务","background":false}""")
        emit(activity, """{"t":"task","phase":"progress","id":"unknown","description":"未知任务","background":true}""")
        compose.waitUntil(5000) { Chat.tasks.size == 1 && Chat.tasks.single().description == "更新描述" }
        assertEquals("one", Chat.tasks.single().id)
        emit(activity, """{"t":"task","phase":"updated","id":"one","patch":{"status":"killed"},"background":true}""")
        emit(activity, """{"t":"task","phase":"started","id":"one","description":"迟到的事件","startedAt":10,"background":true}""")
        compose.waitUntil(5000) { Chat.tasks.isEmpty() }
    }
}
