package com.xiamu.agent

import android.content.SharedPreferences
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.lang.reflect.Proxy
import java.util.concurrent.TimeUnit

class LoginTest {
    private val values = mutableMapOf<String, String>()
    private val preferencesField = Prefs::class.java.getDeclaredField("sp").apply { isAccessible = true }
    private var previousPreferences: Any? = null

    @Before fun useInMemoryPreferences() {
        previousPreferences = preferencesField.get(null)
        // Exercise the production preference getter/setter without Android or a device.
        val editor = Proxy.newProxyInstance(javaClass.classLoader, arrayOf(SharedPreferences.Editor::class.java)) { proxy, method, args ->
            when (method.name) {
                "putString" -> { values[args!![0] as String] = args[1] as String; proxy }
                "apply" -> null
                else -> error("Unexpected editor call: ${method.name}")
            }
        }
        val preferences = Proxy.newProxyInstance(javaClass.classLoader, arrayOf(SharedPreferences::class.java)) { _, method, args ->
            when (method.name) {
                "getString" -> values[args!![0] as String] ?: args[1]
                "edit" -> editor
                else -> error("Unexpected preference call: ${method.name}")
            }
        }
        preferencesField.set(null, preferences)
    }

    @After fun restorePreferences() { preferencesField.set(null, previousPreferences) }

    @Test fun noSavedAddressRequiresLoginEvenWithAnExistingToken() {
        values["token"] = "fixture-existing-token"
        assertEquals("", Prefs.server)
        assertFalse(Prefs.configured)
        assertNull(Api.serverUri())
        assertNull(Api.wsRequest("app"))
        assertNull(Api.wsRequest("device"))
        val error = assertThrows(IllegalArgumentException::class.java) { Api.fileUrl("data/sites/example/index.html") }
        assertEquals("请填写云端地址", error.message)
    }

    @Test fun anExistingSavedAddressAndTokenRemainConfigured() {
        values["server"] = "https://example.invalid/agent"
        values["token"] = "fixture-existing-token"
        assertEquals("https://example.invalid/agent", Prefs.server)
        assertTrue(Prefs.configured)
        assertEquals("https://example.invalid/agent/api/state", Api.url("/api/state"))
        assertEquals("/agent/ws", Api.wsRequest("app")!!.url.encodedPath)
    }

    @Test fun blankLoginIsRejectedBeforeChangingTheSavedAccount() {
        values["server"] = "https://example.invalid/agent"
        values["token"] = "fixture-existing-token"
        for (address in listOf("", " ", "\n\t ")) {
            for (password in listOf("123456", "fixture-token")) {
                val error = assertThrows(IllegalArgumentException::class.java) { runBlocking { Api.login(address, password) } }
                assertEquals("请填写云端地址", error.message)
            }
        }
        assertEquals("https://example.invalid/agent", Prefs.server)
        assertEquals("fixture-existing-token", Prefs.token)
    }

    @Test fun invalidAddressesDoNotProduceWebSocketOrPreviewUrls() {
        for (address in listOf("", "\n\t ", "/agent", "https://", "https://user:secret@example.invalid/agent", "https://example.invalid/agent?other=1")) {
            values["server"] = address
            assertNull(Api.serverUri())
            assertNull(Api.wsRequest("app"))
            assertThrows(IllegalArgumentException::class.java) { Api.url("/api/state") }
        }
    }

    @Test fun tokenLoginSavesTheUserAddressAfterSuccess() {
        MockWebServer().use { service ->
            service.enqueue(MockResponse().setBody("""{"busy":false}"""))
            service.start()
            val address = service.url("/agent").toString()
            runBlocking { Api.login(" $address/// ", "fixture-token") }
            assertEquals(address, Prefs.server)
            assertEquals("fixture-token", Prefs.token)
            assertTrue(Prefs.configured)
            val request = service.takeRequest(1, TimeUnit.SECONDS)!!
            assertEquals("/agent/api/state", request.path)
            assertEquals("Bearer fixture-token", request.getHeader("Authorization"))
        }
    }

    @Test fun pairingLoginAlsoSavesTheUserAddressAfterSuccess() {
        MockWebServer().use { service ->
            service.enqueue(MockResponse().setBody("""{"token":"fixture-paired-token"}"""))
            service.enqueue(MockResponse().setBody("""{"busy":false}"""))
            service.start()
            val address = service.url("/agent").toString()
            runBlocking { Api.login(address, "123456") }
            assertEquals(address, Prefs.server)
            assertEquals("fixture-paired-token", Prefs.token)
            assertTrue(Prefs.configured)
            val pair = service.takeRequest(1, TimeUnit.SECONDS)!!
            assertEquals("/agent/api/pair", pair.path)
            assertNull(pair.getHeader("Authorization"))
            val state = service.takeRequest(1, TimeUnit.SECONDS)!!
            assertEquals("/agent/api/state", state.path)
            assertEquals("Bearer fixture-paired-token", state.getHeader("Authorization"))
        }
    }
}
