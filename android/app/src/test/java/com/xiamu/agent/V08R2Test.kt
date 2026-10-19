package com.xiamu.agent

import org.junit.Assert.*
import org.junit.Test
import org.json.JSONArray
import org.json.JSONObject

class V08R2Test {
    private fun post(body: String,url: String="https://example.test/article")=FeedPost("data/feed/2026-10-15/a.md","2026-10-15","标题","来源",url,"2026-10-15 09:00","📰",null,body)

    @Test fun bodyLinkSuppressesDuplicateSourceAction() {
        assertFalse(post("正文里有[原文](https://example.test/article)。").showOriginalLink)
        assertFalse(post("[设计手记](https://example.test/design)").showOriginalLink)
    }
    @Test fun plainBodyKeepsSourceAction() { assertTrue(post("没有链接的正文").showOriginalLink) }
    @Test fun missingSourceDoesNotOfferEmptyAction() { assertFalse(post("没有链接","").showOriginalLink) }
    @Test fun imagesAndCodeAreNotSourceLinks() {
        assertTrue(post("![配图](https://example.test/cover.png)").showOriginalLink)
        assertTrue(post("`[原文](https://example.test/article)`").showOriginalLink)
        assertTrue(post("```text\n[原文](https://example.test/article)\n```").showOriginalLink)
    }

    private fun sideMessage(room: String,id: String,role: String="assistant",text: String="旁聊正文")=JSONObject()
        .put("id",id).put("activityId",room).put("chatType","side").put("role",role).put("text",text).put("ts",10)
    private fun sideHistory(messages: List<JSONObject>)=JSONObject().put("id","side-a").put("title","读书计划")
        .put("chatType","side").put("status","done").put("messages",JSONArray(messages))
        .put("items",JSONArray().put(JSONObject().put("kind","tool").put("text","工具记录不应变成气泡")))

    @Test fun sideHistoryUsesMessagesWithoutDuplicatingSteps() {
        val h=SideChatHistory.from(sideHistory(listOf(sideMessage("side-a","u","user"),sideMessage("side-a","a"))))
        assertEquals(2,h.messages.size); assertEquals("读书计划",h.title); assertEquals(ActivityStatus.Done,h.status)
    }
    @Test fun sideHistoryPreservesCardsAndPermanentOptions() {
        val m=sideMessage("side-a","a").put("optionsUsed",true).put("options",JSONArray("""[{"id":"0","label":"继续"}]"""))
            .put("cards",JSONArray("""[{"type":"device","capability":"phone_use"}]"""))
        val bubble=SideChatHistory.from(sideHistory(listOf(m))).messages.single() as ChatItem.Assistant
        assertTrue(bubble.optionsUsed); assertEquals(listOf(SayCard.Device("phone_use")),bubble.cards)
    }
    @Test fun anotherRoomCannotEnterSideHistory() {
        assertThrows(IllegalArgumentException::class.java) { SideChatHistory.from(sideHistory(listOf(sideMessage("side-b","wrong")))) }
    }
    @Test fun mainActivityIsNotInterpretedAsSideChat() {
        assertThrows(IllegalArgumentException::class.java) { SideChatHistory.from(sideHistory(emptyList()).put("chatType","main")) }
    }
    @Test fun onlyExplicitlyScopedEventsRouteToSideChat() {
        assertEquals("side-a",sideChatEventId(sideMessage("side-a","a").put("t","activity_message")))
        assertEquals("side-b",sideChatEventId(sideMessage("side-b","a").put("t","options_used")))
        assertNull(sideChatEventId(JSONObject("""{"t":"options_used","messageId":"a"}""")))
        assertNull(sideChatEventId(JSONObject("""{"t":"say","activityId":"main-round"}""")))
    }
    @Test fun drawerFiltersNonSideActivitiesAndIncludesRunningSideChats() {
        val page=ActivitiesPage.from(JSONObject("""{"running":[{"id":"side-a","label":"正在单独聊","started":30,"chatType":"side"},{"id":"main","label":"主聊天","started":40}],"recent":[{"id":"side-a","title":"旧状态","status":"done","ts":10,"chatType":"side"},{"id":"feed","title":"动态","status":"done","ts":20},{"id":"side-b","title":"之前的旁聊","status":"done","ts":15,"chatType":"side"}],"next":1}"""))
        val result=sideChatEntries(ActivitiesTimeline().apply(page,false))
        assertEquals(listOf("side-a","side-b"),result.map { it.id }); assertEquals(ActivityStatus.Running,result.first().status)
    }
    @Test fun messagesArrivingDuringHttpLoadAreKeptWithoutDuplicates() {
        val old=ChatItem.User("第一句",id="u",ts=1); val arrived=ChatItem.Assistant("刚到的回复",id="a",ts=2)
        assertEquals(listOf(old,arrived),mergeSideMessages(listOf(old),listOf(old,arrived)))
    }
    @Test fun reconnectSnapshotCannotReenableOptionsConsumedWhileOffline() {
        val live=ChatItem.Assistant("选一个",id="a",options=listOf(SayOption("0","继续","继续")))
        val merged=mergeSideMessages(listOf(live.copy(optionsUsed=true)),listOf(live))
        val state=Conversation(); state.replaceHistory(merged)
        assertFalse(state.choose("a","0"))
    }
    @Test fun optionConsumptionAndBusyStateStayInsideEachConversation() {
        val bubble=ChatItem.Assistant("选一个",id="a",options=listOf(SayOption("0","继续","继续")))
        val main=Conversation(); val side=Conversation(); main.say(bubble); side.say(bubble)
        side.optionsUsed("a"); side.status(true)
        assertTrue(main.choose("a","0")); assertFalse(side.choose("a","0")); assertFalse(main.busy); assertTrue(side.busy)
    }
    @Test fun createAcknowledgementRequiresAcceptedSideId() {
        assertEquals("side-a",createdSideChatId(JSONObject("""{"ok":true,"id":"side-a","chatType":"side"}""")))
        assertThrows(IllegalArgumentException::class.java) { createdSideChatId(JSONObject("""{"ok":true,"id":"","chatType":"side"}""")) }
        assertThrows(IllegalArgumentException::class.java) { createdSideChatId(JSONObject("""{"ok":true,"id":"main","chatType":"main"}""")) }
    }
}
