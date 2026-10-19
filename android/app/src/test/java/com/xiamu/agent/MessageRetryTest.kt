package com.xiamu.agent

import android.content.SharedPreferences
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.lang.reflect.Proxy
import java.util.concurrent.TimeUnit

class MessageRetryTest {
    private val values=mutableMapOf("token" to "local-message-fixture")
    private val field=Prefs::class.java.getDeclaredField("sp").apply { isAccessible=true }
    private var previous: Any?=null
    @Before fun fixturePreferences() {
        previous=field.get(null)
        field.set(null,Proxy.newProxyInstance(javaClass.classLoader,arrayOf(SharedPreferences::class.java)) { _,method,args ->
            when(method.name) { "getString" -> values[args!![0] as String] ?: args[1]; else -> error("Unexpected ${method.name}") }
        })
    }
    @After fun restore() { field.set(null,previous) }
    private fun lostReceipt(path: String, send: suspend (String) -> Unit) {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
            server.enqueue(MockResponse().setBody("""{"ok":true,"id":"activity-id","chatType":"side"}"""))
            server.start();values["server"]=server.url("/").toString().trimEnd('/')
            val id=SendAttempt().begin("payload")!!;runBlocking { send(id) }
            val first=server.takeRequest(2,TimeUnit.SECONDS)!!;val retry=server.takeRequest(2,TimeUnit.SECONDS)!!
            assertEquals(path,first.path);assertEquals(path,retry.path)
            assertEquals(first.body.clone().readUtf8(),retry.body.clone().readUtf8())
            assertEquals(id,JSONObject(retry.body.readUtf8()).getString("clientId"));assertEquals(2,server.requestCount)
        }
    }
    @Test fun mainSendRetriesWithIdenticalClientId() = lostReceipt("/api/send") { id -> Api.postMessage("/api/send",OutgoingMessage("主聊天",emptyList(),id).json());Unit }
    @Test fun sideCreationRetriesWithIdenticalClientId() = lostReceipt("/api/side-chats") { id -> assertEquals("activity-id",Api.createSideChat("旁聊",emptyList(),id)) }
    @Test fun sideContinuationRetriesWithIdenticalClientId() = lostReceipt("/api/activities/activity-id/send") { id -> Api.sendToActivity("activity-id","继续",emptyList(),id) }
    @Test fun discussionRetriesWithIdenticalClientId() = lostReceipt("/api/send") { id ->
        val m=OutgoingMessage("",emptyList(),id,ChatQuote("feed","演示","🌱","来源",path="data/feed/2026-10-15/a.md"));Api.postMessage(m.path,m.json());Unit
    }
}
