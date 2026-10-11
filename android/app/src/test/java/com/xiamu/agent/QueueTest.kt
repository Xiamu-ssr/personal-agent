package com.xiamu.agent

import org.junit.Assert.*
import org.junit.Test

class QueueTest {
    private fun queued(): Conversation = Conversation().apply { status(true,"task_result"); user("相同文字","app",emptyList(),1,"one"); user("相同文字","app",emptyList(),2,"two") }
    @Test fun queueUpdatesAreByIdAndRemovedEchoCannotAffectIdenticalText() {
        val chat=queued(); chat.queueUpdate("one","removed")
        assertEquals("two",(chat.items.single() as ChatItem.User).id)
        chat.queueUpdate("missing","removed"); assertEquals(1,chat.items.size)
    }
    @Test fun editingPreservesIdOrderAndAttachments() {
        val chat=queued(); chat.queueUpdate("two","edited","最终文本")
        assertEquals(listOf("相同文字","最终文本"),chat.items.filterIsInstance<ChatItem.User>().map { it.text })
        chat.status(false); chat.status(true,"user")
        assertEquals(listOf(false,true),chat.items.filterIsInstance<ChatItem.User>().map { it.queued })
    }
    @Test fun tooLateKeepsTextAndExplains() {
        val chat=queued(); assertEquals("豆豆已经在看这条了",chat.queueUpdate("one","too_late"))
        assertEquals(2,chat.items.size); assertFalse((chat.items.first() as ChatItem.User).queued)
    }
    @Test fun repeatedUserIdDoesNotMakeDuplicateBubble() {
        val chat=queued(); chat.user("相同文字","app",emptyList(),3,"two"); assertEquals(2,chat.items.size)
    }
    @Test fun helloRestoresQueuedIdsAndOrderWithoutDuplicatingHistory() {
        val chat=Conversation()
        val first=ChatItem.User("相同文字",ts=2,id="one")
        val second=ChatItem.User("相同文字",ts=3,id="two")
        chat.hello(listOf(ChatItem.User("旧文本",id="one")),true,"task_result",emptyList(),listOf(first,second))
        assertEquals(listOf("one","two"),chat.items.filterIsInstance<ChatItem.User>().map { it.id })
        assertTrue(chat.items.filterIsInstance<ChatItem.User>().all { it.queued && !it.pending })
        chat.status(false); chat.status(true,"user")
        assertEquals(listOf(false,true),chat.items.filterIsInstance<ChatItem.User>().map { it.queued })
    }
    @Test fun historyRefreshKeepsWaitingBubblesAndRecognizesDispatchedId() {
        val chat=queued()
        chat.sent("等回声",emptyList(),4)
        chat.replaceHistory(listOf(ChatItem.User("相同文字",id="one")))
        val users=chat.items.filterIsInstance<ChatItem.User>()
        assertEquals(3,users.size)
        assertFalse(users.first().queued)
        assertEquals("two",users[1].id); assertTrue(users[1].queued)
        assertTrue(users.last().pending)
    }
}
