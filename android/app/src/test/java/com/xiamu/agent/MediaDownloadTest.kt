package com.xiamu.agent

import android.content.SharedPreferences
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okio.Buffer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.lang.reflect.Proxy
import java.util.concurrent.TimeUnit

class MediaDownloadTest {
    @get:Rule val files = TemporaryFolder()
    private val values = mutableMapOf<String, String>()
    private val preferencesField = Prefs::class.java.getDeclaredField("sp").apply { isAccessible = true }
    private var previousPreferences: Any? = null

    @Before fun useFixturePreferences() {
        previousPreferences = preferencesField.get(null)
        val preferences = Proxy.newProxyInstance(javaClass.classLoader, arrayOf(SharedPreferences::class.java)) { _, method, args ->
            when (method.name) {
                "getString" -> values[args!![0] as String] ?: args[1]
                else -> error("Unexpected preference call: ${method.name}")
            }
        }
        preferencesField.set(null, preferences)
        values["token"] = "local-media-fixture"
    }
    @After fun restorePreferences() { preferencesField.set(null, previousPreferences) }

    @Test fun downloadsUseBearerAndEncodedFileUrlsWithoutChangingBytes() {
        MockWebServer().use { server ->
            val payload = ByteArray(160 * 1024) { (it % 251).toByte() }
            server.enqueue(MockResponse().setBody(Buffer().write(payload)))
            server.start()
            values["server"] = server.url("/agent").toString()
            val destination = files.newFile("movie.mp4")
            runBlocking { Api.download("data/files/演示 1.mp4", destination) }
            val request = server.takeRequest(1, TimeUnit.SECONDS)!!
            assertEquals("/agent/files/data/files/%E6%BC%94%E7%A4%BA%201.mp4", request.path)
            assertEquals("Bearer local-media-fixture", request.getHeader("Authorization"))
            assertArrayEquals(payload, destination.readBytes())
            assertFalse(files.root.listFiles()!!.any { it.extension == "part" })
        }
    }

    @Test fun failedDownloadsKeepAnExistingCacheAndRemoveTemporaryFiles() {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(404).setBody("missing"))
            server.start()
            values["server"] = server.url("/").toString().trimEnd('/')
            val destination = files.newFile("report.pdf").apply { writeText("previous") }
            val failure = runCatching { runBlocking { Api.download("data/files/report.pdf", destination) } }.exceptionOrNull()
            assertTrue(failure is Api.ApiError)
            assertEquals(404, (failure as Api.ApiError).code)
            assertEquals("previous", destination.readText())
            assertEquals(listOf("report.pdf"), files.root.list()!!.toList())
        }
    }

    @Test fun interruptedResponsesNeverBecomeUsableCacheFiles() {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(Buffer().write(ByteArray(512 * 1024)))
                .setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY))
            server.start()
            values["server"] = server.url("/").toString().trimEnd('/')
            val destination = files.newFile("archive.zip").apply { writeText("previous") }
            assertNotNull(runCatching { runBlocking { Api.download("data/files/archive.zip", destination) } }.exceptionOrNull())
            assertEquals("previous", destination.readText())
            assertEquals(listOf("archive.zip"), files.root.list()!!.toList())
        }
    }

    @Test fun leavingDuringADownloadCancelsAndCleansUp() {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("new content").setBodyDelay(1, TimeUnit.SECONDS))
            server.start()
            values["server"] = server.url("/").toString().trimEnd('/')
            val destination = files.newFile("audio.m4a").apply { writeText("previous") }
            runBlocking {
                val download = launch { Api.download("data/files/audio.m4a", destination) }
                assertNotNull(withContext(Dispatchers.IO) { server.takeRequest(2, TimeUnit.SECONDS) })
                download.cancelAndJoin()
            }
            assertEquals("previous", destination.readText())
            assertEquals(listOf("audio.m4a"), files.root.list()!!.toList())
        }
    }
}
