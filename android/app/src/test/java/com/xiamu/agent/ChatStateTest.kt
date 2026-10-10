package com.xiamu.agent

import org.junit.Assert.*
import org.junit.Test

class ChatStateTest {
    private val quote = BackgroundTask("quote", "报价简报", 1000)
    private val files = BackgroundTask("files", "核对资料", 2000)

    @Test fun snapshotReplacesDeduplicatesAndClears() {
        val book = TaskBook()
        book.started(quote)
        book.snapshot(listOf(files, files.copy(description = "资料目录")))
        assertEquals(listOf(files.copy(description = "资料目录")), book.tasks)
        book.snapshot(emptyList())
        book.started(files)
        assertTrue(book.tasks.isEmpty())
        book.started(BackgroundTask("new", "新任务", 3000))
        assertEquals(listOf("new"), book.tasks.map { it.id })
    }

    @Test fun startedIsIdempotentAndProgressDoesNotInventTasks() {
        val book = TaskBook()
        book.started(quote)
        book.started(quote.copy(description = "整理报价", startedAt = 0))
        book.update("quote", "生成简报")
        book.update("unknown", "迟到的进度")
        assertEquals(listOf(quote.copy(description = "生成简报")), book.tasks)
    }

    @Test fun endedNotificationCannotBeUndoneByLateStartedOrProgress() {
        for (status in listOf("completed", "failed", "stopped")) {
            val book = TaskBook()
            book.notification("quote", status)
            book.started(quote)
            book.update("quote", "迟到的进度")
            assertTrue(book.tasks.isEmpty())
            book.snapshot(listOf(quote))
            assertEquals(listOf(quote), book.tasks)
        }
    }

    @Test fun terminalPatchOnlyRemovesItsOwnTask() {
        for (status in listOf("completed", "failed", "killed")) {
            val book = TaskBook()
            book.snapshot(listOf(quote, files))
            book.update("quote", status = status)
            book.notification("quote", "completed")
            book.started(quote)
            assertEquals(listOf(files), book.tasks)
        }
    }

    @Test fun acceptedStopWaitsForNotificationOrSnapshot() {
        val book = TaskBook()
        book.snapshot(listOf(quote, files))
        assertTrue(book.requestStop("quote"))
        assertFalse(book.requestStop("quote"))
        book.stopResult("quote", true)
        book.snapshot(listOf(quote, files))
        assertTrue(book.tasks.first().stopping)
        assertFalse(book.tasks.last().stopping)
        assertEquals(2, book.tasks.size)
        book.notification("quote", "stopped")
        assertEquals(listOf(files), book.tasks)
        assertTrue(book.requestStop("files"))
        book.snapshot(emptyList())
        assertTrue(book.tasks.isEmpty())
    }

    @Test fun rejectedStopRestoresButtonAndAllowsRetry() {
        val book = TaskBook()
        book.started(quote)
        book.requestStop("quote")
        book.stopResult("quote", false, taskStopError("task_stop_failed", "SDK failed"))
        assertFalse(book.tasks.single().stopping)
        assertEquals("停止任务失败，请稍后再试", book.tasks.single().error)
        assertTrue(book.requestStop("quote"))
        assertEquals("", book.tasks.single().error)
        assertEquals("任务已经结束", taskStopError("task_ended"))
        assertEquals("主会话暂时不可用，请稍后再试", taskStopError("session_unavailable"))
        assertEquals("稍后再试", taskStopError("other", "稍后再试"))
    }

    @Test fun queuedEchoPreservesStateAndUserTurnsAdvanceInOrder() {
        val chat = Conversation()
        chat.status(true, "task_result")
        chat.sent("第一条", emptyList(), 1)
        chat.sent("第二条", emptyList(), 2)
        chat.user("第一条", "app", emptyList(), 3)
        chat.user("第二条", "app", emptyList(), 3)
        assertFalse((chat.items.first() as ChatItem.User).pending)
        assertTrue((chat.items.first() as ChatItem.User).queued)
        chat.status(false)
        chat.status(true, "schedule")
        assertTrue(chat.items.filterIsInstance<ChatItem.User>().all { it.queued })
        chat.endTurn("已安排", "", 4)
        chat.status(false)
        chat.status(true, "user")
        assertEquals(listOf(false, true), chat.items.filterIsInstance<ChatItem.User>().map { it.queued })
        chat.status(true, "user")
        assertTrue(chat.items.filterIsInstance<ChatItem.User>().last().queued)
        chat.endTurn("第一条的回复", "", 5)
        chat.status(false)
        chat.status(true, "user")
        assertTrue(chat.items.filterIsInstance<ChatItem.User>().none { it.queued })
    }

    @Test fun identicalMessagesMatchPendingEchoesInSubmissionOrder() {
        val chat = Conversation()
        val voice = Attachment("data/uploads/note.aac", "笔记", "voice")
        chat.status(true, "task_result")
        chat.sent("相同文字", listOf(voice), 1)
        chat.sent("相同文字", listOf(voice), 2)
        chat.user("相同文字", "app", listOf(voice.copy(transcript = "第一份转写")), 3)
        chat.endTurn("结果", "", 4)
        chat.status(false)
        chat.status(true, "user")
        chat.user("相同文字", "app", listOf(voice.copy(transcript = "第二份转写")), 5)
        val users = chat.items.filterIsInstance<ChatItem.User>()
        assertEquals(listOf(false, true), users.map { it.queued })
        assertEquals(listOf("第一份转写", "第二份转写"), users.map { it.attachments.single().transcript })
        assertTrue(users.none { it.pending })
    }

    @Test fun idleMessageIsNormalAndEarlySecondSendUsesEchoBusyState() {
        val chat = Conversation()
        chat.sent("现在就发", emptyList(), 1)
        chat.user("现在就发", "app", emptyList(), 2)
        assertEquals(ChatItem.User("现在就发", ts = 2), chat.items.single())
        chat.sent("紧接着发送", emptyList(), 3)
        chat.status(true, "user")
        chat.user("紧接着发送", "app", emptyList(), 4)
        assertTrue(chat.items.filterIsInstance<ChatItem.User>().last().queued)
    }

    @Test fun queueUsesServerEchoOrderAcrossDevices() {
        val chat = Conversation()
        chat.status(true, "task_result")
        chat.sent("本机消息", emptyList(), 1)
        chat.user("其他设备先到的消息", "app", emptyList(), 2)
        chat.user("本机消息", "app", emptyList(), 3)
        chat.endTurn("结果", "", 4)
        chat.status(false)
        chat.status(true, "user")
        val users = chat.items.filterIsInstance<ChatItem.User>()
        assertTrue(users.first().queued)
        assertFalse(users.last().queued)
    }

    @Test fun onlyScheduleSourceIsRenderedAsAlarm() {
        val text = "[定时] 该出「晨报」了\n\n不要显示这一段任务说明"
        assertEquals(ChatItem.Alarm("晨报时间到了", 7), incomingUser(text, "schedule", ts = 7))
        assertTrue(incomingUser(text, "app") is ChatItem.User)
        assertEquals("定时任务时间到了", alarmLabel("[定时]"))
        val chat = Conversation()
        chat.status(true, "schedule")
        chat.user(text, "schedule", emptyList(), 8)
        assertTrue(chat.items.single() is ChatItem.Alarm)
    }

    @Test fun taskResultTurnNeedsNoUserAndWaitsForNativeIdle() {
        val chat = Conversation()
        chat.background.started(quote)
        chat.status(true, "task_result")
        chat.delta("简报")
        chat.delta("已完成")
        assertEquals("简报已完成", chat.streaming)
        chat.endTurn("简报已完成", "", 9)
        assertEquals(listOf(ChatItem.Assistant("简报已完成", 9)), chat.items)
        assertTrue(chat.busy)
        assertTrue(chat.turnClosed)
        chat.status(false)
        assertFalse(chat.busy)
        assertEquals(listOf(quote), chat.background.tasks)
    }

    @Test fun idleBeforeResultDoesNotLoseDeltasOrMakeReplyBusyAgain() {
        val chat = Conversation()
        chat.status(true, "task_result")
        chat.delta("后台结果")
        chat.status(false)
        assertEquals("后台结果", chat.streaming)
        chat.endTurn(null, "", 10)
        assertEquals(ChatItem.Assistant("后台结果", 10), chat.items.single())
        assertFalse(chat.busy)
    }

    @Test fun newRoundClearsPreviousStreamingAndToolState() {
        val chat = Conversation()
        chat.status(true, "user")
        chat.delta("上一轮未完成的文字")
        chat.tool("在翻资料")
        chat.status(false)
        chat.status(true, "task_result")
        assertEquals("", chat.streaming)
        assertEquals("", chat.toolHint)
        assertEquals("豆豆正在处理子任务结果…", replyLabel(chat.reason))
        assertEquals("豆豆正在安排定时任务…", replyLabel("schedule"))
        assertEquals("豆豆正在回复…", replyLabel("other"))
    }

    @Test fun helloAndDisconnectRemoveGhostBusyTasksAndStopRequests() {
        val chat = Conversation()
        chat.status(true, "task_result")
        chat.background.started(quote)
        chat.background.requestStop("quote")
        chat.delta("旧连接文字")
        chat.disconnected()
        assertFalse(chat.busy)
        assertEquals("", chat.streaming)
        assertTrue(chat.background.tasks.isEmpty())
        chat.hello(listOf(ChatItem.Assistant("历史文字")), false, "task_result", listOf(files))
        assertFalse(chat.busy)
        assertEquals("", chat.reason)
        assertEquals(listOf(files), chat.background.tasks)
        chat.background.requestStop("files")
        chat.hello(emptyList(), true, "", listOf(files))
        assertTrue(chat.busy)
        assertFalse(chat.background.tasks.single().stopping)
        chat.hello(emptyList(), false, "", emptyList())
        assertTrue(chat.background.tasks.isEmpty())
    }
}
