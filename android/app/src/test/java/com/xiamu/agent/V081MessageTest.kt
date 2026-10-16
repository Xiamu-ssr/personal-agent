package com.xiamu.agent

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class V081MessageTest {
    private data class Pick(val id: Int,val name: String,val kind: String)
    private val image=Pick(1,"sprout.png","image")
    private val file=Pick(2,"plan.pdf","file")
    private val quote=FeedQuote("data/feed/2026-10-15/0900-demo.md","给一天留一点空白","☕","豆豆演示")
    @Test fun attachmentStripKeepsImagesAndFilesInSelectionOrder() {
        val state=AttachmentDraft<Pick>().add(listOf(image,file,image.copy(id=3)))
        assertEquals(listOf("image","file","image"),state.items.map { it.kind })
        assertEquals(listOf(1,3),state.remove(listOf(file)).items.map { it.id })
    }
    @Test fun threeImagesWithSameNameCanBeRemovedIndividually() {
        val state=AttachmentDraft<Pick>().add((1..3).map { image.copy(id=it) })
        assertEquals(3,state.items.size)
        assertEquals(listOf(1,3),state.remove(listOf(state.items[1])).items.map { it.id })
    }
    @Test fun completingUploadDoesNotRemoveNewlySelectedFiles() {
        val captured=AttachmentDraft<Pick>().add(listOf(image,file))
        val edited=captured.add(listOf(image.copy(id=3)))
        assertEquals(listOf(3),edited.remove(captured.items).items.map { it.id })
        assertEquals(2,captured.items.size)
    }
    @Test fun repeatedPickerResultDoesNotAddTheSameSelectionTwice() {
        assertEquals(listOf(image),AttachmentDraft<Pick>().add(listOf(image,image)).items)
    }
    @Test fun doubleSendIsBlockedAndNetworkRetryKeepsUuid() {
        val gate=SendAttempt();val first=gate.begin("message+files")!!
        UUID.fromString(first)
        assertNull(gate.begin("message+files"));assertTrue(gate.sending)
        gate.failed();assertEquals(first,gate.begin("message+files"))
    }
    @Test fun nextIdenticalMessageAfterSuccessGetsAnotherUuid() {
        val gate=SendAttempt();val first=gate.begin("hello")
        gate.accepted();assertFalse(gate.sending);assertNotEquals(first,gate.begin("hello"))
    }
    @Test fun editingTextAttachmentsOrQuoteAfterFailureCreatesAnotherRequest() {
        val gate=SendAttempt();var previous=gate.begin("hello|1|feed-a")
        for(key in listOf("hello there|1|feed-a","hello there|1,2|feed-a","hello there|1,2|feed-b")) {
            gate.failed();val next=gate.begin(key);assertNotEquals(previous,next);previous=next
        }
    }
    @Test fun independentMainAndSideDraftsCannotShareClientIds() {
        assertNotEquals(SendAttempt().begin("same"),SendAttempt().begin("same"))
    }
    @Test fun definitiveHttpFailureReleasesTheCachedErrorRequestId() {
        val gate=SendAttempt();val first=gate.begin("same")
        gate.failed(retryable=false);assertNotEquals(first,gate.begin("same"))
    }
    @Test fun emptyQuoteMetadataIsPreservedAsTheServerSnapshot() {
        val parsed=FeedQuote.from(quote.json().put("emoji","").put("source",""))!!
        assertEquals("",parsed.emoji);assertEquals("",parsed.source)
    }
    @Test fun discussionUsesFeedbackAndAllowsEmptyText() {
        val request=OutgoingMessage("",emptyList(),"request-id",quote);val body=request.json()
        assertEquals("/api/feed/feedback",request.path);assertEquals("discuss",body.getString("action"))
        assertEquals(quote.path,body.getString("path"));assertEquals("",body.getString("text"))
        assertEquals("request-id",body.getString("clientId"));assertFalse(body.has("attachments"))
    }
    @Test fun cancellingQuoteRestoresAnOrdinarySendPayload() {
        val cancelled=OutgoingMessage("我想试试",emptyList(),"id",quote).copy(quote=null)
        assertEquals("/api/send",cancelled.path);assertFalse(cancelled.json().has("action"));assertFalse(cancelled.json().has("path"))
        assertEquals("我想试试",cancelled.json().getString("text"))
    }
    @Test fun normalMessageIncludesAttachmentsAndClientId() {
        val request=OutgoingMessage("看一下",listOf(Attachment("data/uploads/day/plan.pdf","plan.pdf","file")),"id")
        assertEquals("/api/send",request.path);assertEquals(1,request.json().getJSONArray("attachments").length())
        assertEquals("id",request.json().getString("clientId"))
    }
    @Test fun userQuoteParsesWithVerbatimEmojiTitleAndSource() {
        val item=historyItem(JSONObject().put("role","user").put("id","u").put("text","试一试").put("quote",quote.json())) as ChatItem.User
        assertEquals(quote,item.quote);assertEquals("试一试",item.text)
    }
    @Test fun invalidQuoteDoesNotHideTheUserMessage() {
        for(j in listOf(quote.json().put("kind","goal"),quote.json().put("path","data/../system/file"),quote.json().put("path","data/goals/a.md"),quote.json().put("title",""))) {
            val item=historyItem(JSONObject().put("role","user").put("text","保留正文").put("quote",j)) as ChatItem.User
            assertNull(item.quote);assertEquals("保留正文",item.text)
        }
    }
    @Test fun sayBubbleKeepsItsProcessActivityId() {
        val item=historyItem(JSONObject("""{"role":"assistant","id":"say","activityId":"turn","text":"写好的正文"}""")) as ChatItem.Assistant
        assertEquals("写好的正文",item.text);assertEquals("turn",item.activityId)
    }
    @Test fun reconnectFillsMissingMessagesAndDeduplicatesById() {
        val first=ChatItem.Assistant("第一句",ts=1,id="s1");val missing=ChatItem.Assistant("离线时的回复",ts=2,id="s2")
        val c=Conversation();c.say(first);c.disconnected();repeat(2) { c.hello(listOf(first,missing),false,AvatarStatus()) }
        assertEquals(listOf("s1","s2"),c.items.filterIsInstance<ChatItem.Assistant>().map { it.id })
    }
    @Test fun snapshotCannotEraseLiveMessageArrivingDuringRequest() {
        val first=ChatItem.Assistant("第一句",ts=1,id="s1")
        val c=Conversation();c.say(first);c.say(ChatItem.Assistant("刚收到",ts=3,id="s3"))
        c.replaceHistory(listOf(first,ChatItem.Assistant("补漏",ts=2,id="s2")))
        assertEquals(listOf("s1","s2","s3"),c.items.filterIsInstance<ChatItem.Assistant>().map { it.id })
    }
    @Test fun identicalTextWithDifferentServerIdsIsNeverCollapsed() {
        val c=Conversation();c.user(ChatItem.User("好的",ts=1,id="u1"));c.user(ChatItem.User("好的",ts=2,id="u2"))
        c.replaceHistory(c.items.toList());assertEquals(2,c.items.size)
    }
    @Test fun repeatedReceiptAndHistoryKeepOneUserQuote() {
        val user=ChatItem.User("试试",ts=1,id="u",quote=quote)
        val c=Conversation();c.user(user);c.user(user);c.replaceHistory(listOf(user));assertEquals(listOf(user),c.items)
    }
    @Test fun staleReconnectHistoryCannotReenableOptions() {
        val bubble=ChatItem.Assistant("选一个",ts=1,id="say",options=listOf(SayOption("a","开始","开始")))
        val c=Conversation();c.say(bubble);c.optionsUsed("say");c.hello(listOf(bubble),false,AvatarStatus())
        assertTrue((c.items.single() as ChatItem.Assistant).optionsUsed);assertFalse(c.choose("say","a"))
    }
    @Test fun logoutClearsIdsAndConsumedStateBeforeAnotherServer() {
        val c=Conversation();c.say(ChatItem.Assistant("回复",id="s"));c.optionsUsed("s");c.clear()
        assertTrue(c.items.isEmpty());c.say(ChatItem.Assistant("新服务器",id="s"));assertFalse((c.items.single() as ChatItem.Assistant).optionsUsed)
    }
    @Test fun activitySummaryParsesForRunningAndFinishedWork() {
        val page=ActivitiesPage.from(JSONObject("""{"running":[{"id":"r","label":"处理中","title":"处理中","summary":"正在读取演示资料","started":30}],"recent":[{"id":"a","title":"安排轻量运动","summary":"读取安排并给出散步建议","status":"done","ts":20,"outputs":[]}],"next":null}"""))
        assertEquals("正在读取演示资料",page.running.single().summary)
        assertEquals("读取安排并给出散步建议",page.recent.single().summary)
    }
    @Test fun summaryUpdateReplacesSameActivityWithoutChangingChronology() {
        val initial=ActivityRecord("a","处理中",ActivityStatus.Done,20,emptyList())
        val newer=ActivityRecord("b","检查资料",ActivityStatus.Done,30,emptyList())
        val event=ActivityTitleUpdate.from(JSONObject("""{"t":"activity","phase":"updated","id":"a","title":"安排轻量运动","summary":"读取安排并给出散步建议"}"""))!!
        val timeline=ActivitiesTimeline().apply(ActivitiesPage(emptyList(),listOf(newer,initial),null),false)
            .updated(listOf(event))
        assertEquals(listOf("b","a"),timeline.recent.map { it.id });assertEquals(2,timeline.recent.size)
        assertEquals(20L,timeline.recent.last().ts);assertEquals(event.title,timeline.recent.last().title);assertEquals(event.summary,timeline.recent.last().summary)
        assertEquals(initial.status,timeline.recent.last().status)
    }
    @Test fun absentActivitySummaryIsEmptyWithoutInventingARecord() {
        val item=ActivityRecord.from(JSONObject("""{"id":"a","title":"处理中","status":"done","ts":1,"outputs":[]}"""))
        assertEquals("",item.summary)
    }
    @Test fun onlyTitleUpdateEventsArePresentationPatches() {
        assertNull(ActivityTitleUpdate.from(JSONObject("""{"t":"activity_step","phase":"updated","id":"a","title":"读资料"}""")))
        assertNull(ActivityTitleUpdate.from(JSONObject("""{"t":"activity","phase":"done","id":"a","title":"读资料"}""")))
        assertNull(ActivityTitleUpdate.from(JSONObject("""{"t":"activity","phase":"updated","id":"","summary":"已读取"}""")))
    }
    @Test fun runningTitleUpdateDoesNotFinishOrRestartWork() {
        val running=RunningActivity("a","处理中",15)
        val patch=ActivityTitleUpdate.from(JSONObject("""{"t":"activity","phase":"updated","id":"a","title":"整理资料","summary":"已读总档","status":"done","ts":99}"""))!!
        val timeline=ActivitiesTimeline(running=listOf(running)).updated(listOf(patch))
        assertEquals(listOf(running.copy(label="整理资料",summary="已读总档")),timeline.running)
        assertTrue(timeline.recent.isEmpty())
    }
    @Test fun unknownActivityUpdateDoesNotInventRowsOrAffectPagination() {
        val original=ActivitiesTimeline(recent=listOf(ActivityRecord("a","已有活动",ActivityStatus.Done,20,listOf("data/a.md"))),next=20)
        assertEquals(original,original.updated(listOf(ActivityTitleUpdate("other","纯聊天","不该制造一行"))))
    }
    @Test fun partialUpdateCanClearSummaryWithoutErasingTitleOrOutputs() {
        val original=ActivityRecord("a","整理资料",ActivityStatus.Error,20,listOf("data/a.md"),summary="旧摘要")
        val patch=ActivityTitleUpdate.from(JSONObject("""{"t":"activity","phase":"updated","id":"a","summary":""}"""))!!
        assertNull(patch.title)
        assertEquals(original.copy(summary=""),ActivitiesTimeline(recent=listOf(original)).updated(listOf(patch)).recent.single())
    }
    @Test fun titlePatchWinsOverAnHttpSnapshotRequestedBeforeTheEvent() {
        val old=ActivityRecord("a","处理中",ActivityStatus.Done,20,emptyList())
        val update=ActivityTitleUpdate("a","安排轻量运动","已读取本周安排")
        val timeline=ActivitiesTimeline().apply(ActivitiesPage(emptyList(),listOf(old),10),false).updated(listOf(update))
        assertEquals("安排轻量运动",timeline.recent.single().title)
        assertEquals("已读取本周安排",timeline.recent.single().summary)
        assertEquals(10L,timeline.next)
    }

}
