package com.xiamu.agent

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId

class V6RulesTest {
    @Test fun skinDefaultsToSilverAndPersistsSelectionAcrossNewInstances() {
        var saved: String? = null
        val first = SkinPreference({ saved }, { saved = it })
        assertEquals(Skin.Silver, first.current)
        Skin.entries.forEach { skin ->
            assertEquals(skin, first.select(skin))
            assertEquals(skin.id, saved)
            assertEquals(skin, SkinPreference({ saved }, { saved = it }).current)
        }
    }
    @Test fun invalidLocalSkinResolvesToDefaultAndPalettesHaveSpecifiedColors() {
        assertEquals(Skin.Silver, Skin.from("system"))
        assertEquals(0xFF0F1216, Skin.Night.colors.background)
        assertEquals(0xFFFBF8F2, Skin.Paper.colors.card)
        assertEquals(0xFF4A78A8, Skin.Silver.colors.accent)
    }
    @Test fun bottomMessagesAndStreamingContinueFollowingWithNoUnread() {
        val state = ChatScrollRules().messages(3)
        assertTrue(state.contentChanged())
        assertEquals(0, state.unread)
        assertFalse(state.showReturn)
    }
    @Test fun historyMessagesDoNotFollowAndAccumulateUnread() {
        val state = ChatScrollRules().userPosition(false, 1500, 1000).messages(2).messages(1)
        assertFalse(state.contentChanged())
        assertEquals(3, state.unread)
        assertTrue(state.showReturn)
    }
    @Test fun keyboardKeepsBottomAndLeavesHistoryPositionUntouched() {
        assertTrue(ChatScrollRules().keyboardOpened())
        val history = ChatScrollRules().userPosition(false, 2500, 1000)
        assertFalse(history.keyboardOpened())
        assertFalse(history.atBottom)
        assertTrue(history.farFromBottom)
    }
    @Test fun returnAndSendResetUnreadAndResumeFollowing() {
        val history = ChatScrollRules().userPosition(false, 1500, 1000).messages(4)
        assertEquals(ChatScrollRules(), history.returned())
        assertEquals(ChatScrollRules(), history.sent())
        assertEquals(0, history.userPosition(true, 0, 1000).unread)
    }
    @Test fun returnAppearsAfterOneScreenAndNewMessagesDoNotBecomeNegative() {
        val close = ChatScrollRules().userPosition(false, 500, 1000)
        assertFalse(close.showReturn)
        assertTrue(close.messages(1).showReturn)
        assertEquals(0, close.messages(-4).unread)
        assertTrue(close.userPosition(false, 1000, 1000).showReturn)
    }
    @Test fun swipeOrderHasTodaySegmentsBeforeTheAdjacentTabs() {
        assertEquals(listOf(0, 1, 1, 2, 3), (0..4).map(SwipePages::tab))
        assertEquals(1, SwipePages.page(1, 0))
        assertEquals(2, SwipePages.page(1, 1))
        assertEquals(3, SwipePages.next(2, 1))
        assertEquals(0, SwipePages.next(1, -1))
        assertEquals(4, SwipePages.page(3, 0))
    }
    @Test fun pagerEdgesBounceWithoutWrapping() {
        assertEquals(0, SwipePages.next(0, -1))
        assertEquals(4, SwipePages.next(4, 1))
    }
    private val today = LocalDate.of(2026, 10, 12)
    private val zone = ZoneId.of("Asia/Shanghai")
    private fun job(id: String, offset: Long) = JobRecord(id, id, TaskStatus.Done,
        today.minusDays(offset).atStartOfDay(zone).toInstant().toEpochMilli(), emptyList(), null)
    @Test fun jobsGroupByLocalCalendarIncludingExactlySixDaysAgo() {
        val groups = groupJobs(listOf(job("old", 7), job("week", 6), job("today", 0), job("yesterday", 1)), today, zone)
        assertEquals(listOf(JobGroup.Today, JobGroup.Week, JobGroup.Older), groups.keys.toList())
        assertEquals(listOf("yesterday", "week"), groups[JobGroup.Week]!!.map { it.id })
        assertEquals("old", groups[JobGroup.Older]!!.single().id)
    }
    @Test fun jobDatesUseCalendarBoundariesAcrossDaylightSaving() {
        val dstZone = ZoneId.of("America/New_York")
        val day = LocalDate.of(2026, 11, 3)
        val date = day.minusDays(6).atStartOfDay(dstZone).toInstant().toEpochMilli()
        assertEquals(JobGroup.Week, groupJobs(listOf(job("dst", 0).copy(ts = date)), day, dstZone).keys.single())
    }
    @Test fun paginationKeepsRunningDeduplicatesAndEndsAtNull() {
        val running = Running("active", "整理", 123)
        val first = JobsTimeline().apply(JobsPage(listOf(running), listOf(job("a", 0), job("b", 1)), 11), false)
        val second = first.apply(JobsPage(emptyList(), listOf(job("b", 1), job("c", 7)), null), true)
        assertEquals(listOf(running), second.running)
        assertEquals(listOf("a", "b", "c"), second.recent.map { it.id })
        assertNull(second.next)
    }
    @Test fun jobsParseStatusAndNextWithServerIds() {
        val page = JobsPage.from(JSONObject("""{"running":[{"id":"run","label":"整理","started":123}],"recent":[{"id":"old","label":"旧任务","title":"原始说明","status":"stopped","ok":false,"ts":999,"outputs":[]}],"next":800}"""))
        assertEquals(800L, page.next)
        assertEquals(TaskStatus.Stopped, page.recent.single().status)
        assertEquals("原始说明", page.recent.single().title)
    }
    @Test fun taskHistoryMapsAgentInstructionUserAttachmentsAndMarkdownInOrder() {
        val history = TaskHistory.from(JSONObject("""{"id":"id","title":"资料","status":"running","items":[{"kind":"prompt","from":"agent","text":"整理资料","time":1},{"kind":"tool","tool":"Read","text":"工具详情","time":2},{"kind":"text","text":"**正在核对**","time":3},{"kind":"prompt","from":"user","text":"","time":4,"attachments":[{"path":"data/uploads/photo.jpg","name":"照片.jpg","kind":"image"},{"path":"data/uploads/plan.pdf","name":"计划.pdf","kind":"file"},{"path":"data/uploads/note.aac","name":"语音.aac","kind":"voice"}]},{"kind":"result","text":"# 已完成","time":5}]}"""))
        assertTrue(history.items.first().isInstruction)
        assertFalse(history.items.first().isUser)
        val user = history.items[3]
        assertTrue(user.isUser)
        assertEquals(listOf("image", "file", "voice"), user.attachments.map { it.kind })
        assertEquals("Read", history.items[1].tool)
        assertEquals("**正在核对**", history.items[2].text)
        assertEquals("# 已完成", history.items.last().text)
    }
    @Test fun promptWithoutSourceIsRejectedInsteadOfBeingTreatedAsUser() {
        assertTrue(runCatching { TaskHistoryItem.from(JSONObject("""{"kind":"prompt","text":"旧字段","time":1}""")) }.isFailure)
    }
    private fun health(days: JSONArray = JSONArray()) = JSONObject().put("syncedAt", JSONObject.NULL).put("device", JSONObject.NULL)
        .put("note", JSONObject.NULL).put("days", days).put("weekly", JSONArray()).put("records", JSONArray())
    private fun day(date: LocalDate, sleep: Any = JSONObject.NULL, hr: Any = JSONObject.NULL, hrv: Any = JSONObject.NULL, steps: Any = JSONObject.NULL) =
        JSONObject().put("date", date.toString()).put("sleepMinutes", sleep).put("restingHr", hr).put("hrv", hrv).put("steps", steps)
    @Test fun healthAlignsSevenDaysEndingTodayWithMissingSlots() {
        val data = HealthData.from(health(JSONArray().put(day(today, sleep = 432)).put(day(today.minusDays(3), steps = 8200))), today)
        assertEquals(7, data.days.size)
        assertEquals(today.minusDays(6), data.days.first().date)
        assertEquals(today, data.days.last().date)
        assertEquals(8200.0, data.days[3].steps)
        assertNull(data.days[4].steps)
        assertEquals("7 小时 12 分", sleepLabel(data.today.sleepMinutes))
    }
    @Test fun nullMetricsDisplayDashesAndRealZeroStaysZero() {
        val data = HealthData.from(health(JSONArray().put(day(today, steps = 0))), today)
        assertEquals("--", sleepLabel(data.today.sleepMinutes))
        assertEquals("--", healthNumber(data.today.restingHr))
        assertEquals("--", healthNumber(data.today.hrv))
        assertEquals("0", healthNumber(data.today.steps))
    }
    @Test fun healthSyncUsesNoteOrLocalTimeAndDevice() {
        val json = health().put("syncedAt", "2026-10-12T01:08:00Z").put("device", "测试手机")
        assertEquals("上次同步 09:08 · 测试手机", HealthData.from(json, today).syncLabel(zone))
        assertEquals("手机不在线", HealthData.from(json.put("note", "手机不在线"), today).syncLabel(zone))
    }
    @Test fun healthWeeklyPathsAndRecordPreviewsRemainNativeData() {
        val json = health().put("weekly", JSONArray("""[{"name":"健康周报","path":"data/briefs/2026-09-28/健康周报.html","date":"2026-09-28","range":"9月22日–9月28日","summary":"睡眠更规律"}]"""))
            .put("records", JSONArray("""[{"path":"data/memory/health/profile.md","title":"健康档案","updated":null,"preview":"第一行\n第二行"}]"""))
        val data = HealthData.from(json, today)
        assertTrue(isBriefPath(data.weekly.single().path))
        assertNull(data.records.single().updated)
        assertEquals("第一行\n第二行", data.records.single().preview)
    }
    @Test fun skinAttributeExistsBeforeAnyHeadScriptAndReplacesExistingValue() {
        val document = briefWithSkin("<!doctype html><html lang='zh' data-skin=\"silver\"><head><script>window.firstSkin=document.documentElement.dataset.skin</script></head></html>", Skin.Night)
        assertTrue(document.indexOf("data-skin=\"night\"") < document.indexOf("<script>"))
        assertFalse(document.contains("data-skin=\"silver\""))
        assertTrue(document.contains("lang='zh'"))
    }
    @Test fun healthNewMarkerClearsAfterOpeningAndReturnsForUpdatedDate() {
        val seen = today.minusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
        assertTrue(healthEntryIsNew(today.toString(), seen, zone))
        assertFalse(healthEntryIsNew(today.minusDays(2).toString(), seen, zone))
        assertFalse(healthEntryIsNew(null, seen, zone))
    }

}
