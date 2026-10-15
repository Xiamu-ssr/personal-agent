package com.xiamu.agent

import com.xiamu.agent.media.PlaybackSlot
import com.xiamu.agent.media.fileCacheKey
import com.xiamu.agent.ui.inline
import androidx.compose.ui.text.LinkAnnotation
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.Locale

class ReplyMediaTest {
    private fun outputs() = JSONArray("""[
        {"path":"data/library/media/2026-10-13/睡眠 图.png","name":"睡眠曲线","kind":"image","mime":"image/png","size":20311},
        {"path":"data/library/media/2026-10-13/demo 1.mp4","name":"演示视频","kind":"video","mime":"video/mp4","size":1834201},
        {"path":"data/library/media/2026-10-13/meeting.m4a","name":"会议录音","kind":"audio","mime":"audio/mp4","size":4294967296},
        {"path":"data/library/media/2026-10-13/report.pdf","name":"报告","kind":"file","mime":"application/pdf","size":1048576}
    ]""")
    private fun event() = JSONObject().put("t", "say").put("role","assistant").put("id","media-say").put("text", "**结果**\n[报告](data/library/media/2026-10-13/report.pdf)").put("media", outputs())
    private fun history() = event().apply { remove("t"); put("role", "assistant"); put("ts", 1791580800000) }

    @Test fun sayPreservesOrderedMediaAndEveryField() {
        val chat = Conversation()
        val input = event()
        chat.say(historyItem(input.put("ts",123)) as ChatItem.Assistant)
        val result = chat.items.single() as ChatItem.Assistant
        assertEquals(input.getString("text"), result.text)
        assertEquals(123L, result.ts)
        assertEquals(listOf("image", "video", "audio", "file"), result.media.map { it.kind })
        assertEquals(ReplyMedia("data/library/media/2026-10-13/睡眠 图.png", "睡眠曲线", "image", "image/png", 20311), result.media.first())
        assertEquals(4294967296L, result.media[2].size)
    }

    @Test fun helloHistoryUsesTheSocketHistoryParser() {
        val hello = JSONObject().put("history", JSONArray().put(history()).put(JSONObject().put("role", "user").put("text", "你好")))
        val chat = Conversation()
        chat.hello(hello.optJSONArray("history").objects().mapNotNull(::historyItem), false, AvatarStatus())
        val assistant = chat.items.first() as ChatItem.Assistant
        assertEquals(1791580800000L, assistant.ts)
        assertEquals(replyMedia(event()), assistant.media)
        assertTrue(chat.items.last() is ChatItem.User)
    }

    @Test fun historyRefreshKeepsMediaAndPendingUsers() {
        val chat = Conversation()
        chat.sent("稍后处理", emptyList(), 1)
        chat.replaceHistory(listOf(historyItem(history())!!))
        assertEquals(4, (chat.items.first() as ChatItem.Assistant).media.size)
        assertTrue((chat.items.last() as ChatItem.User).pending)
    }

    @Test fun deltasStayTextOnlyUntilSay() {
        val chat = Conversation()
        chat.status(true)
        chat.delta("media-say","草稿")
        assertEquals("草稿", chat.streaming)
        assertTrue(chat.items.isEmpty())
        chat.say(historyItem(event()) as ChatItem.Assistant)
        assertEquals(4, (chat.items.single() as ChatItem.Assistant).media.size)
        assertEquals("", chat.streaming)
        assertTrue(chat.busy)
    }

    @Test fun olderAssistantHistoryHasNoMedia() {
        val input = JSONObject("""{"role":"assistant","text":"## 老记录","ts":12}""")
        assertEquals(ChatItem.Assistant("## 老记录", 12), historyItem(input))
    }

    @Test fun missingEmptyNullAndMalformedArraysDoNotAffectText() {
        for (media in listOf(null, JSONObject.NULL, JSONArray(), "bad", JSONArray().put(42).put(JSONObject.NULL))) {
            val input = JSONObject().put("role", "assistant").put("text", "正文").put("media", media)
            assertEquals(ChatItem.Assistant("正文"), historyItem(input))
        }
    }

    @Test fun unknownKindIsAFileEvenWithAnImageExtension() {
        val input = outputs().getJSONObject(0).put("kind", "future-preview")
        val media = ReplyMedia.from(input)!!
        assertEquals("file", media.kind)
        assertEquals(MediaPresentation.File, media.presentation())
        assertEquals("image/png", media.mime)
    }

    @Test fun blankNameUsesTheFileNameAndMissingMetadataIsUsable() {
        val media = ReplyMedia.from(JSONObject().put("path", "data/library/media/录音.m4a").put("name", "").put("size", -1))!!
        assertEquals("录音.m4a", media.name)
        assertEquals("file", media.kind)
        assertEquals("application/octet-stream", media.mime)
        assertEquals(0L, media.size)
    }

    @Test fun malformedPathsAreSkippedWithoutDiscardingGoodOutputs() {
        val bad = listOf("", "https://example.invalid/a.png", "/data/a.png", "workspace/a.png", "data/../a.png", "data/a/../../secret.png", "data/a\u0000.png")
        val input = event().put("media", JSONArray(bad.map { JSONObject().put("path", it) }).put(outputs().getJSONObject(0)))
        val chat = Conversation()
        chat.say(historyItem(input) as ChatItem.Assistant)
        assertEquals(1, (chat.items.single() as ChatItem.Assistant).media.size)
        assertEquals(input.getString("text"), (chat.items.single() as ChatItem.Assistant).text)
    }

    @Test fun errorAndPartialTurnsAndRecordsNeverAttachMedia() {
        for ((flag, value) in listOf("error" to "失败", "partial" to true)) {
            val chat = Conversation()
            chat.say(historyItem(event().put(flag,value)) as ChatItem.Assistant)
            assertTrue(chat.items.filterIsInstance<ChatItem.Assistant>().single().media.isEmpty())
            assertTrue((historyItem(history().put(flag, value)) as ChatItem.Assistant).media.isEmpty())
        }
    }

    @Test fun validRelativePathsInsideDataArePreservedAsDelivered() {
        for (path in listOf("data/library/media/../报告.pdf", "data//files/a.png", "data/library/media/a\\b.txt")) {
            assertEquals(path, ReplyMedia.from(JSONObject().put("path", path))!!.path)
        }
    }

    @Test fun mediaOnlyFinalMessageIsStillRetained() {
        val chat = Conversation()
        chat.say(historyItem(event().put("text","")) as ChatItem.Assistant)
        assertEquals(4, (chat.items.single() as ChatItem.Assistant).media.size)
    }

    @Test fun byteAndKilobyteLabelsUseBoundaries() {
        assertEquals("0 B", formatFileSize(-1))
        assertEquals("0 B", formatFileSize(0))
        assertEquals("1023 B", formatFileSize(1023))
        assertEquals("1 KB", formatFileSize(1024))
        assertEquals("1.5 KB", formatFileSize(1536))
    }

    @Test fun largeFileSizeDoesNotOverflowAnInt() {
        assertEquals("1 MB", formatFileSize(1024L * 1024))
        assertEquals("4 GB", formatFileSize(4294967296))
        assertEquals("1 TB", formatFileSize(1024L * 1024 * 1024 * 1024))
        assertEquals("8 EB", formatFileSize(Long.MAX_VALUE))
    }

    @Test fun sizeAndPlaybackLabelsDoNotDependOnPhoneLocale() {
        val old = Locale.getDefault()
        try {
            Locale.setDefault(Locale.GERMANY)
            assertEquals("1.5 KB", formatFileSize(1536))
            assertEquals("1:05", playbackTime(65000))
        } finally { Locale.setDefault(old) }
    }

    @Test fun everyKindMapsToItsOwnPresentation() {
        val values = outputs().objects().mapNotNull(ReplyMedia::from)
        assertEquals(listOf(MediaPresentation.Image, MediaPresentation.Video, MediaPresentation.Audio, MediaPresentation.File), values.map { it.presentation() })
    }

    @Test fun playbackFailureFallsBackOnlyForAudioAndVideo() {
        val values = outputs().objects().mapNotNull(ReplyMedia::from)
        assertEquals(listOf(MediaPresentation.Image, MediaPresentation.File, MediaPresentation.File, MediaPresentation.File), values.map { it.presentation(playbackFailed = true) })
    }

    @Test fun documentsAndImagesOpenInsideTheApp() {
        val expected = mapOf("MD" to FileOpening.Markdown, "markdown" to FileOpening.Markdown,
            "html" to FileOpening.Web, "htm" to FileOpening.Web, "txt" to FileOpening.Web,
            "csv" to FileOpening.Web, "json" to FileOpening.Web, "svg" to FileOpening.Web,
            "PDF" to FileOpening.Pdf, "PNG" to FileOpening.Image, "gif" to FileOpening.Image)
        expected.forEach { (extension, opening) -> assertEquals(extension, opening, fileOpening("data/library/media/a.$extension")) }
    }

    @Test fun mimeCanIdentifyDocumentsWithUnusualExtensions() {
        assertEquals(FileOpening.Pdf, fileOpening("data/library/media/document.bin", "application/pdf"))
        assertEquals(FileOpening.Markdown, fileOpening("data/library/media/document.bin", "text/markdown; charset=utf-8"))
        assertEquals(FileOpening.Web, fileOpening("data/library/media/document.bin", "text/plain"))
        assertEquals(FileOpening.Web, fileOpening("data/sites/example"))
    }

    @Test fun binaryFilesAndMediaCanOpenInSystemApps() {
        for (ext in listOf("zip", "xlsx", "docx", "mp4", "m4a", "opus", "flac", "bin")) {
            assertEquals(ext, FileOpening.System, fileOpening("data/library/media/document.$ext"))
        }
    }

    @Test fun fileUrlEncodesEachSegmentWithChineseAndSpaces() {
        val path = "data/library/media/2026-10-13/会议 demo 1.mp4"
        val encoded = "/files/data/library/media/2026-10-13/%E4%BC%9A%E8%AE%AE%20demo%201.mp4"
        assertEquals(encoded, Api.filePath(path))
        assertEquals("http://127.0.0.1:8080/agent$encoded", Api.fileUrl(path, "http://127.0.0.1:8080/agent"))
    }

    @Test fun fileUrlPreservesLiteralReservedCharactersAndPercentSigns() {
        assertEquals("/files/data/library/media/a%2Bb%231%3F%2520.txt", Api.filePath("data/library/media/a+b#1?%20.txt"))
    }

    @Test fun markdownPathsDecodeOnceAndPreservePlusSigns() {
        assertEquals("data/library/media/会议 demo+1.mp4", markdownFilePath("<data/library/media/%E4%BC%9A%E8%AE%AE%20demo+1.mp4>"))
        assertEquals("data/library/media/%20.txt", markdownFilePath("data/library/media/%2520.txt"))
        assertEquals("data/library/media/100% complete.txt", markdownFilePath("data/library/media/100% complete.txt"))
    }

    @Test fun markdownLinksCannotEscapeData() {
        for (target in listOf("/data/a", "https://example.invalid/a", "workspace/a", "data/%2e%2e/a", "data/a%2f..%2f..%2fb")) {
            assertNull(target, markdownFilePath(target))
        }
    }

    @Test fun imageAndFileLinksInTheBodyRemainClickable() {
        val opened = mutableListOf<Pair<String, String>>()
        val text = inline("![图](data/library/media/a.png) [视频](<data/library/media/演示 1.mp4>)") { path, name -> opened.add(path to name) }
        assertEquals("图 视频", text.text)
        val links = text.getLinkAnnotations(0, text.length).map { it.item as LinkAnnotation.Clickable }
        assertEquals(listOf("data/library/media/a.png", "data/library/media/演示 1.mp4"), links.map { it.tag })
        links.forEach { it.linkInteractionListener!!.onClick(it) }
        assertEquals(listOf("data/library/media/a.png" to "图", "data/library/media/演示 1.mp4" to "视频"), opened)
    }

    @Test fun artifactLinksAreDecodedOnlyOnce() {
        val text = inline("[报告](<data/library/artifacts/报告/晨%20报%2520.html>)")
        assertEquals("报告", text.text)
        val link = text.getLinkAnnotations(0, text.length).single().item as LinkAnnotation.Clickable
        assertEquals("data/library/artifacts/报告/晨 报%20.html", link.tag)
        assertTrue(link.tag.startsWith("data/library/"))
    }

    @Test fun cacheKeysSeparateServersAndSameNamedFiles() {
        assertNotEquals(fileCacheKey("https://one.invalid", "data/library/media/a/report.pdf"), fileCacheKey("https://one.invalid", "data/library/media/b/report.pdf"))
        assertNotEquals(fileCacheKey("https://one.invalid", "data/library/media/a.pdf"), fileCacheKey("https://two.invalid", "data/library/media/a.pdf"))
        assertEquals(fileCacheKey("https://one.invalid", "data/library/media/a.pdf"), fileCacheKey("https://one.invalid", "data/library/media/a.pdf"))
    }

    @Test fun claimingANewPlayerStopsThePreviousOneBeforeItCanContinue() {
        val slot = PlaybackSlot()
        val first = Any(); val second = Any()
        val stopped = mutableListOf<String>()
        slot.claim(first) { stopped.add("audio"); slot.release(first) }
        slot.claim(second) { stopped.add("video"); slot.release(second) }
        assertEquals(listOf("audio"), stopped)
        slot.stop()
        assertEquals(listOf("audio", "video"), stopped)
    }

    @Test fun repeatingAClaimAndDisposingAnOldPlayerCannotStopTheNewPlayer() {
        val slot = PlaybackSlot()
        val first = Any(); val second = Any()
        var stops = 0
        slot.claim(first) { stops++ }
        slot.claim(first) { fail("A repeated claim must keep its existing callback") }
        assertEquals(0, stops)
        slot.claim(second) { stops++ }
        slot.release(first)
        slot.stop(); slot.stop()
        assertEquals(2, stops)
    }

    @Test fun disposingTheActivePlayerUnregistersItsStopCallback() {
        val slot = PlaybackSlot()
        val player = Any()
        slot.claim(player) { fail("Already released") }
        slot.release(player)
        slot.stop()
    }

    @Test fun offscreenPlayersInALongReplyDoNotStayActive() {
        assertTrue(mediaIntersectsViewport(50f, 200f, 800))
        assertTrue(mediaIntersectsViewport(-200f, 50f, 800))
        assertTrue(mediaIntersectsViewport(750f, 900f, 800))
        assertFalse(mediaIntersectsViewport(-200f, 0f, 800))
        assertFalse(mediaIntersectsViewport(800f, 900f, 800))
        assertFalse(mediaIntersectsViewport(0f, 0f, 800))
        assertFalse(mediaIntersectsViewport(0f, 100f, 0))
    }

    @Test fun playbackTimesHandleZeroMinutesAndHours() {
        assertEquals("0:00", playbackTime(-1))
        assertEquals("0:00", playbackTime(0))
        assertEquals("1:05", playbackTime(65000))
        assertEquals("1:01:01", playbackTime(3661000))
    }
}
