package com.xiamu.agent

import org.json.*
import org.junit.Assert.*
import org.junit.Test

class V08ProtocolTest {
    private fun json(s: String)=JSONObject(s)
    private fun bubble(used: Boolean=false)=historyItem(json("""{"role":"assistant","id":"say-1","text":"选一个","ts":10,"optionsUsed":$used,"options":[{"id":"0","label":"豆豆"},{"id":"1","label":"小豆","reply":"就叫小豆"}]}""")) as ChatItem.Assistant
    private fun goal()=json("""{"name":"运动","path":"data/goals/运动.md","title":"每周运动","domain":"健康","cadence":"0 8 * * 1","due":"2026-12-31","status":"进行中","progress":25,"body":"## 计划\n运动三次\n## 步骤\n- [x] 计划\n## 记录\n已完成一次","nextCheckin":"2026-10-19T00:00:00.000Z"}""")
    private fun post(date: String,name: String)=json("""{"path":"data/feed/$date/$name.md","date":"$date","title":"$name","source":"演示来源","url":"https://example.test/news","published":"$date 09:00","icon":"📰","image":"data/feed/$date/cover.jpg","body":"正文"}""")
    private fun page(posts: List<JSONObject>,next: String?=null)=FeedPage.from(JSONObject().put("days",JSONArray(posts.map { it.getString("date") }.distinct())).put("items",JSONArray(posts)).put("next",next ?: JSONObject.NULL))

    @Test fun firstChatInternalTriggerIsNotPresentedAsUserSpeech() { assertNull(historyItem(json("""{"role":"user","source":"onboarding","text":"[第一次聊天] 设备：android"}"""))); assertNotNull(historyItem(json("""{"role":"user","source":"app","text":"你好"}"""))) }
    @Test fun activityHistoryPreservesToolStepsOutsideMainChat() {
        val h=ActivityHistory.from(json("""{"id":"a","title":"本地活动","status":"done","items":[{"kind":"prompt","from":"user","text":"查资料","time":10},{"kind":"tool","tool":"Read","text":"读一份文件","time":11},{"kind":"result","text":"已经读完","time":12}]}"""))
        assertEquals(1,h.steps.size); assertEquals("Read",h.steps[0].tool); assertTrue(h.prompts[0].isUser)
    }
    @Test fun parsesEverySupportedSayCard() {
        val cards=sayCards(json("""{"cards":[{"type":"connector","id":"qq-mail"},{"type":"goal","name":"运动"},{"type":"link","url":"https://example.test","title":"示例","description":"摘要","image":"https://example.test/image.png"},{"type":"image","path":"data/library/media/a.png"},{"type":"video","path":"data/library/media/a.mp4"},{"type":"audio","path":"data/library/media/a.aac"},{"type":"file","path":"data/library/artifacts/a/report.pdf"},{"type":"device","capability":"health"}]}"""))
        assertEquals(8,cards.size); assertEquals("health",(cards.last() as SayCard.Device).capability)
        assertEquals(listOf("image","video","audio","file"),cards.filterIsInstance<SayCard.Media>().map { it.file.kind })
    }
    @Test fun invalidCardsDoNotHideValidNeighbors() {
        val cards=sayCards(json("""{"cards":[{"type":"unrecognized"},{"type":"link","url":"javascript:alert(1)"},{"type":"file","path":"system/settings.json"},{"type":"image","path":"data/../../private.png"},{"type":"connector"},{"type":"goal","name":""},{"type":"device","capability":"health"}]}"""))
        assertEquals(listOf(SayCard.Device("health")),cards)
    }
    @Test fun absentLinkTitleUsesUrlAndUnsafeCoverIsRemoved() {
        val card=sayCards(json("""{"cards":[{"type":"link","url":"https://example.test","image":"file:///private/photo.png"}]}""" )).single() as SayCard.Link
        assertEquals(card.url,card.title); assertNull(card.image)
    }
    @Test fun cardAndMarkdownMediaAreDeduplicatedByPath() {
        val m=historyItem(json("""{"role":"assistant","id":"s","cards":[{"type":"image","path":"data/library/media/a.png"},{"type":"image","path":"data/library/media/a.png"}],"media":[{"kind":"image","path":"data/library/media/a.png"},{"kind":"audio","path":"data/library/media/b.aac"}]}""")) as ChatItem.Assistant
        assertEquals(2,m.displayMedia.size)
    }
    @Test fun optionsDefaultReplyToLabelAndKeepIds() { val m=bubble(); assertEquals("豆豆",m.options[0].reply); assertEquals("就叫小豆",m.options[1].reply); assertEquals("1",m.options[1].id) }
    @Test fun unknownHistoryRoleIsNotRenderedAsAChatBubble() { assertNull(historyItem(json("""{"role":"tool","text":"raw result"}"""))); assertNull(historyItem(json("""{"role":"card","title":"旧卡片"}"""))) }
    @Test fun multipleSayCallsRemainSeparateAndRepeatedIdReplaces() {
        val c=Conversation(); c.say(bubble()); c.say(bubble().copy(id="say-2",text="再说一句")); c.say(bubble().copy(text="更新"))
        assertEquals(2,c.items.size); assertEquals("更新",(c.items.first() as ChatItem.Assistant).text)
    }
    @Test fun turnEndNeverCreatesOrDuplicatesABubbleAndDoesNotDeclareIdle() {
        val c=Conversation(); c.status(true); c.say(bubble()); c.endTurn(); c.endTurn(); assertEquals(1,c.items.size); assertTrue(c.busy)
    }
    @Test fun busyInterjectionHttpReceiptAndEchoUseOneServerId() {
        val c=Conversation(); c.status(true); c.user(ChatItem.User("补充",ts=2,id="u")); c.user(ChatItem.User("补充",ts=2,id="u"))
        assertEquals(1,c.items.size); assertTrue(c.busy)
    }
    @Test fun choosingDisablesWholeGroupUntilServerReply() { val c=Conversation(); c.say(bubble()); assertTrue(c.choose("say-1","0")); assertFalse(c.choose("say-1","1")); assertFalse((c.items[0] as ChatItem.Assistant).optionsUsed) }
    @Test fun consumedOptionsRemainDisabledAfterDuplicateSayAndReconnect() {
        val c=Conversation(); c.say(bubble()); c.optionsUsed("say-1"); c.say(bubble()); assertFalse(c.choose("say-1","1")); c.hello(listOf(bubble(true)),false,AvatarStatus("waiting")); assertFalse(c.choose("say-1","0"))
    }
    @Test fun optionsUsedArrivingBeforeBubbleStillDisablesIt() { val c=Conversation(); c.optionsUsed("say-1"); c.say(bubble()); assertTrue((c.items[0] as ChatItem.Assistant).optionsUsed) }
    @Test fun failedChoiceCanRetryButConsumedChoiceCannot() { val c=Conversation(); c.say(bubble()); c.choose("say-1","0"); c.choiceFailed("say-1"); assertTrue(c.choose("say-1","1")); c.optionsUsed("say-1"); c.choiceFailed("say-1"); assertFalse(c.choose("say-1","0")) }
    @Test fun historyRefreshCannotResurrectConsumedOptions() { val c=Conversation(); c.say(bubble()); c.optionsUsed("say-1"); c.replaceHistory(listOf(bubble())); assertTrue((c.items[0] as ChatItem.Assistant).optionsUsed) }
    @Test fun invalidOptionIdDoesNotLockGroup() { val c=Conversation(); c.say(bubble()); assertFalse(c.choose("say-1","no")); assertTrue(c.choose("say-1","0")) }
    @Test fun sayKeepsProcessIdThroughHistoryMerge() { val c=Conversation(); c.say(bubble().copy(activityId="round")); c.replaceHistory(listOf(bubble())); assertEquals("round",(c.items.single() as ChatItem.Assistant).activityId) }
    @Test fun backgroundAvatarIsIndependentOfMainBusy() { val c=Conversation(); c.avatar(AvatarStatus("working","在看邮件")); c.status(false); assertEquals("working",c.avatar.state); assertEquals("在看邮件",c.avatar.text) }
    @Test fun fiveAvatarStatesAndFallbackParse() { AvatarStatus.states.forEach { assertEquals(it,AvatarStatus.from(JSONObject().put("state",it)).state) }; assertEquals("idle",AvatarStatus.from(JSONObject().put("state","unknown")).state) }
    @Test fun feedPagingAppendsWholeDaysAndDeduplicatesPaths() {
        val first=page(listOf(post("2026-10-15","1000-a"),post("2026-10-15","0900-b")),"2026-10-15")
        val older=page(listOf(post("2026-10-15","0900-b"),post("2026-10-14","0900-c")))
        val result=FeedTimeline().apply(first,false).apply(older,true)
        assertEquals(3,result.items.size); assertEquals(listOf("2026-10-15","2026-10-15","2026-10-14"),result.items.map { it.date }); assertNull(result.next)
    }
    @Test fun feedRefreshReplacesOldPageAndKeepsServerOrder() { val result=FeedTimeline().apply(page(listOf(post("2026-10-13","0900-old"))),false).apply(page(listOf(post("2026-10-15","0900-new"))),false); assertEquals(1,result.items.size); assertTrue(result.items[0].path.contains("new")) }
    @Test fun repeatedFeedCursorIsRejected() { val t=FeedTimeline(next="2026-10-15"); assertThrows(IllegalArgumentException::class.java) { t.apply(page(emptyList(),"2026-10-15"),true) } }
    @Test fun feedDateMustBeValid() { assertThrows(Exception::class.java) { FeedPost.from(post("2026-99-32","invalid")) } }
    @Test fun feedRedDotClearsWhenEnteredAndDoesNotReappearForDuplicateEvent() { val f=FeedInbox(); f.receive(listOf("a","b")); assertTrue(f.unread); f.enter(); assertFalse(f.unread); f.leave(); f.receive(listOf("a","b")); assertFalse(f.unread); f.receive(listOf("c")); assertTrue(f.unread) }
    @Test fun feedEventsWhileVisibleAreReadImmediately() { val f=FeedInbox(true); f.enter(); f.receive(listOf("a")); assertFalse(f.unread); f.leave(); f.receive(listOf("b")); assertTrue(f.unread) }
    @Test fun feedKnownPathsSurviveRestartWithoutFalseUnread() { val first=FeedInbox(); first.receive(listOf("a","b")); first.enter(); val restored=FeedInbox(false,first.knownPaths); restored.receive(listOf("a","b")); assertFalse(restored.unread); restored.receive(listOf("c")); assertTrue(restored.unread) }
    @Test fun unreadSurvivesRestartUntilFeedIsEntered() { val f=FeedInbox(true,setOf("a")); f.receive(listOf("a")); assertTrue(f.unread); f.enter(); assertFalse(f.unread) }
    @Test fun emptyFeedEventNeverCreatesDot() { val f=FeedInbox(); f.receive(listOf("","")); assertFalse(f.unread) }
    @Test fun feedSettingsAllowOvernightAndEnforceIntervalsAndTimes() { FeedSettings(true,30,"23:00","07:00","偏好").validate(); listOf(FeedSettings(true,20,"07:00","23:00",""),FeedSettings(true,30,"25:00","23:00",""),FeedSettings(true,30,"07:00","07:00","")).forEach { assertThrows(IllegalArgumentException::class.java) { it.validate() } } }
    @Test fun goalsPreservePlanStepsRecordsAndNextCheckin() { val g=Goal.from(goal()); assertEquals(25,g.progress); assertTrue(g.body.contains("## 记录")); assertEquals("2026-10-19T00:00:00.000Z",g.nextCheckin) }
    @Test fun pausedGoalNullNextCheckinIsNotAStringNull() { assertNull(Goal.from(goal().put("status","暂停").put("nextCheckin",JSONObject.NULL)).nextCheckin) }
    @Test fun goalsRejectInvalidStatusAndProgress() { listOf(goal().put("status","started"),goal().put("progress",101),goal().put("progress",-1)).forEach { assertThrows(IllegalArgumentException::class.java) { Goal.from(it) } } }
    @Test fun goalPathCannotEscapeData() { assertThrows(IllegalArgumentException::class.java) { Goal.from(goal().put("path","data/../system/file")) } }
    @Test fun ideasKeepRevisionAndVerbatimReply() { val i=Ideas.from(json("""{"revision":"rev-2","groups":[{"name":"健康","items":[{"id":"idea-1","icon":"🌱","title":"散步","description":"每天十分钟","reply":"帮我安排饭后散步"}]}]}""")); assertEquals("rev-2",i.revision); assertEquals("帮我安排饭后散步",i.groups[0].items[0].reply) }
    @Test fun librarySortsNewestFirstAndKeepsDocuments() { val l=Library.from(json("""{"artifacts":[{"name":"文档","path":"data/library/artifacts/a/index.md","kind":"document","mtime":1,"files":[]},{"name":"页面","path":"data/library/artifacts/b/index.html","kind":"page","mtime":2,"thumbnail":"/api/library/thumbnail?path=test","files":[]}],"media":[{"path":"data/library/media/a.png","kind":"image","mtime":1},{"path":"data/library/media/b.png","kind":"image","mtime":2}]}""")); assertEquals("页面",l.artifacts[0].name); assertTrue(l.media[0].path.endsWith("b.png")) }
    @Test fun healthNoLongerRequiresWeeklyAndMissingMetricsStayNull() { val h=HealthData.from(json("""{"days":[{"date":"2026-10-15","steps":1234}],"records":[],"note":"演示数据"}"""),java.time.LocalDate.of(2026,10,15)); assertEquals(7,h.days.size); assertNull(h.today.sleepMinutes); assertEquals(1234.0,h.today.steps!!,.001) }
}
