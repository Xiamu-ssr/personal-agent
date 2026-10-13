package com.xiamu.agent

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.net.URLEncoder

class AgentProtocolTest {
    private fun settings() = JSONObject("""{"model":"haiku","permissionMode":"auto","models":[{"id":"haiku","label":"Haiku","note":"消耗约 1×"},{"id":"mimo","label":"MiMo","note":"消耗约 2×"}],"permissionModes":[{"id":"auto","label":"自动","note":"拦下危险操作"},{"id":"bypassPermissions","label":"完全放行","note":"什么都不拦"}]}""")
    private fun history(status: String = "running") = JSONObject("""{"id":"任务 /A?","title":"整理采购资料","status":"$status","items":[{"kind":"prompt","from":"agent","text":"整理采购资料","time":1791675360000},{"kind":"text","text":"先核对已有记录。","time":"2026-10-11T07:36:00+08:00"},{"kind":"tool","text":"读取 data/memory/总档.md","tool":"Read","time":1791675360000},{"kind":"result","text":"## 结果\n\n**交期已核对**","time":1791675360000}]}""")
    private fun media() = JSONArray("""[{"path":"data/files/演示 1.mp4","name":"演示视频","kind":"video","mime":"video/mp4","size":4294967296},{"path":"data/files/chart.png","name":"报价曲线","kind":"image","mime":"image/png","size":20311}]""")
    private fun brief(cards: Int = 2) = JSONObject().put("date","2026-10-11").put("name","晨报").put("time","2026-10-11T07:36:00+08:00")
        .put("path","data/briefs/2026-10-11/晨报.html").put("cards",JSONArray((1..cards).map { JSONObject().put("html","<!doctype html><html><head><style>h1{color:blue}</style></head><body><section class='card'>卡片 $it</section></body></html>") }))

    @Test fun settingsPreserveCatalogNotesAndSelectedIds() {
        val result = AgentSettings.from(settings())
        assertEquals("haiku",result.model)
        assertEquals("auto",result.permissionMode)
        assertEquals(listOf("消耗约 1×","消耗约 2×"),result.models.map { it.note })
        assertEquals("完全放行",result.permissionModes.last().label)
        assertEquals("Haiku",result.modelLabel)
    }
    @Test fun settingsParseSameResponseAfterBothChoicesChange() {
        val result = AgentSettings.from(settings().put("model","mimo").put("permissionMode","bypassPermissions"))
        assertEquals("MiMo",result.modelLabel)
        assertEquals("完全放行",result.permissionLabel)
    }
    @Test fun settingsRequireTheCurrentContractAndNotes() {
        assertThrows(Exception::class.java) { AgentSettings.from(JSONObject("""{"model":"haiku"}""")) }
        val missing = settings().apply { getJSONArray("models").getJSONObject(0).remove("note") }
        assertThrows(Exception::class.java) { AgentSettings.from(missing) }
        assertThrows(Exception::class.java) { AgentSettings.from(settings().put("model","unknown")) }
    }
    @Test fun historyPreservesAllKindsToolSummaryAndMarkdown() {
        val result = TaskHistory.from(history())
        assertEquals("任务 /A?",result.id)
        assertEquals(1,result.prompts.size)
        assertEquals(2,result.steps.size)
        assertEquals("读取 data/memory/总档.md",result.steps.last().text)
        assertEquals("Read",result.steps.last().tool)
        assertEquals("## 结果\n\n**交期已核对**",result.results.single().text)
    }
    @Test fun historySupportsAllFourTerminalAndRunningStates() {
        TaskStatus.entries.forEach { assertEquals(it,TaskHistory.from(history(it.wire)).status) }
        assertThrows(Exception::class.java) { TaskHistory.from(history("completed")) }
    }
    @Test fun completedTaskResultPreservesOrderedMediaAndMarkdown() {
        val input = history("done").apply { getJSONArray("items").getJSONObject(3).put("media",media()) }
        val result = TaskHistory.from(input).results.single()
        assertEquals("## 结果\n\n**交期已核对**",result.text)
        assertEquals(listOf("video","image"),result.media.map { it.kind })
        assertEquals(ReplyMedia("data/files/演示 1.mp4","演示视频","video","video/mp4",4294967296),result.media.first())
        assertEquals(ReplyMedia("data/files/chart.png","报价曲线","image","image/png",20311),result.media.last())
    }
    @Test fun oldTaskResultsWithoutMediaRemainMarkdown() {
        val result = TaskHistory.from(history("done")).results.single()
        assertEquals("## 结果\n\n**交期已核对**",result.text)
        assertTrue(result.media.isEmpty())
    }
    @Test fun nonResultTaskEntriesIgnoreMedia() {
        val input = history("done").apply { getJSONArray("items").objects().forEach { it.put("media",media()) } }
        val result = TaskHistory.from(input)
        assertEquals(setOf(TaskItemKind.Prompt,TaskItemKind.Text,TaskItemKind.Tool),result.items.filter { it.kind != TaskItemKind.Result }.map { it.kind }.toSet())
        assertTrue(result.items.filter { it.kind != TaskItemKind.Result }.all { it.media.isEmpty() })
        assertEquals(2,result.results.single().media.size)
    }
    @Test fun unfinishedFailedAndStoppedTasksIgnoreResultMedia() {
        for (status in listOf(TaskStatus.Running,TaskStatus.Error,TaskStatus.Stopped)) {
            val input = history(status.wire).apply { getJSONArray("items").getJSONObject(3).put("media",media()) }
            val result = TaskHistory.from(input).results.single()
            assertTrue(status.wire,result.media.isEmpty())
            assertEquals("## 结果\n\n**交期已核对**",result.text)
        }
    }
    @Test fun historyTimeHandlesBothExplicitIsoAndEpochValues() {
        val result = TaskHistory.from(history())
        assertEquals(result.items[0].time,result.items[1].time)
        assertNull(result.prompts.single().tool)
    }
    @Test fun historyRejectsMissingIdAndUnknownItemKinds() {
        assertThrows(Exception::class.java) { TaskHistory.from(history().put("id","")) }
        val malformed = history().apply { getJSONArray("items").getJSONObject(0).put("kind","raw_tool_args") }
        assertThrows(Exception::class.java) { TaskHistory.from(malformed) }
    }
    @Test fun resultBriefLinksAreDecodedWithoutOpeningOtherOutputs() {
        assertEquals("data/briefs/2026-10-11/晨 报.html",briefPathInText("[看简报](data/briefs/2026-10-11/%E6%99%A8%20%E6%8A%A5.html)"))
        assertEquals("data/briefs/2026-10-11/晨报.html",briefPathInText("已保存 `data/briefs/2026-10-11/晨报.html`。"))
        assertNull(briefPathInText("data/sites/example/index.html"))
        assertNull(briefPathInText("data/briefs/../private.html"))
    }
    @Test fun htmlBriefPreservesIndependentDocumentsAndAllowsSixCards() {
        val input = brief(6)
        val result = BriefDocument.from(input)!!
        assertEquals(6,result.cards.size)
        assertEquals(input.getJSONArray("cards").getJSONObject(0).getString("html"),result.cards.first().html)
        assertNull(BriefDocument.from(brief(7)))
        assertNull(BriefDocument.from(brief(0)))
    }
    @Test fun removedJsonBriefFormatIsNotAccepted() {
        assertNull(BriefDocument.from(brief().put("path","data/briefs/2026-10-11/晨报.json")))
        val removed = brief().apply { remove("cards"); put("brief",JSONObject().put("v",1)) }
        assertNull(BriefDocument.from(removed))
    }
    @Test fun promptNavigationDecodesChineseAndPunctuationExactlyOnce() {
        val text = "帮我排顺序：采购 + 周报 & 休息\n保留 100%"
        assertEquals(text,BriefNavigation.prompt("doudou://prompt?text="+URLEncoder.encode(text,"UTF-8")))
        assertEquals("%E4%B8%AD",BriefNavigation.prompt("doudou://prompt?text=%25E4%25B8%25AD"))
    }
    @Test fun promptNavigationRejectsOtherSchemesFramesAndMalformedUrls() {
        listOf("https://example.com/", "intent://prompt?text=a", "file:///private", "javascript:alert(1)",
            "doudou://prompt.evil?text=a", "doudou://prompt/path?text=a", "doudou://other?text=a",
            "doudou://prompt?text=", "doudou://prompt?text=%20", "doudou://prompt?text=%ZZ",
            "doudou://prompt?text=a&text=b", "doudou://prompt?text=a#fragment", "doudou://prompt").forEach {
            assertNull(it,BriefNavigation.prompt(it))
        }
        assertNull(BriefNavigation.prompt("doudou://prompt?text=a",mainFrame = false))
    }
    @Test fun onlyInlineDataResourcesAreAllowed() {
        assertTrue(BriefNavigation.inlineResource("data:image/svg+xml,<svg/>"))
        listOf("https://example.com/image.png","http://127.0.0.1/","file:///android_asset/a.js","content://secret","blob:https://example.com/a").forEach {
            assertFalse(it,BriefNavigation.inlineResource(it))
        }
    }
}
