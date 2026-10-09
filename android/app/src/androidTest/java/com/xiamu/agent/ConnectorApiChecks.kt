package com.xiamu.agent

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.net.InetAddress
import java.net.ServerSocket

@RunWith(AndroidJUnit4::class)
class ConnectorApiChecks {
    private data class Request(val line: String, val headers: Map<String, String>, val body: String)

    private fun BufferedInputStream.line(): String {
        val out = ByteArrayOutputStream()
        while (true) {
            val c = read()
            if (c < 0 || c == 10) break
            if (c != 13) out.write(c)
        }
        return out.toString("UTF-8")
    }

    @Test fun endpointsUseExpectedMethodsBodiesAndErrors() = runBlocking {
        val fixture = InstrumentationRegistry.getInstrumentation().targetContext.assets.open("connectors.json").bufferedReader().use { it.readText() }
        val replies = listOf(200 to fixture, 201 to "{}", 200 to "{}", 200 to "{}", 204 to "", 204 to "",
            400 to """{"error":"授权码不对"}""", 409 to """{"error":"设备在线"}""")
        val server = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1")).apply { soTimeout = 5000 }
        val previousServer = Prefs.server
        val previousToken = Prefs.token
        val requests = mutableListOf<Request>()
        val serving = async(Dispatchers.IO) {
            replies.forEach { (status, body) ->
                server.accept().use { socket ->
                    socket.soTimeout = 5000
                    val input = BufferedInputStream(socket.getInputStream())
                    val first = input.line()
                    val headers = mutableMapOf<String, String>()
                    while (true) {
                        val line = input.line()
                        if (line.isEmpty()) break
                        headers[line.substringBefore(':').lowercase()] = line.substringAfter(':').trim()
                    }
                    val bytes = ByteArray(headers["content-length"]?.toInt() ?: 0)
                    DataInputStream(input).readFully(bytes)
                    requests += Request(first, headers, bytes.toString(Charsets.UTF_8))
                    val reply = body.toByteArray(Charsets.UTF_8)
                    socket.getOutputStream().write("HTTP/1.1 $status Fixture\r\nContent-Type: application/json\r\nContent-Length: ${reply.size}\r\nConnection: close\r\n\r\n".toByteArray() + reply)
                }
            }
        }
        try {
            assertFalse(Prefs.configured)
            Prefs.server = "http://127.0.0.1:${server.localPort}"
            Prefs.token = "fixture-local"
            assertTrue(Api.getJson("/api/connectors").getJSONObject("cloud").getJSONArray("catalog").getJSONObject(0).has("fields"))
            Api.addConnectorAccount("email", JSONObject().put("address", "fixture@qq.com"))
            Api.updateConnectorAccount("email", "qq1", JSONObject().put("label", "Work"))
            Api.testConnectorAccount("email", "qq1")
            Api.deleteConnectorAccount("mail /box", "a+b /")
            Api.removeDevice("offline /device")
            try { Api.addConnectorAccount("email", JSONObject()); fail("应返回校验错误") }
            catch (e: Api.ApiError) { assertEquals(400, e.code); assertEquals("授权码不对", e.message) }
            try { Api.removeDevice("online"); fail("应返回在线冲突") }
            catch (e: Api.ApiError) { assertEquals(409, e.code) }
            serving.await()
            assertEquals(listOf(
                "GET /api/connectors HTTP/1.1", "POST /api/connectors/email/accounts HTTP/1.1", "PUT /api/connectors/email/accounts/qq1 HTTP/1.1",
                "POST /api/connectors/email/accounts/qq1/test HTTP/1.1", "DELETE /api/connectors/mail%20%2Fbox/accounts/a%2Bb%20%2F HTTP/1.1",
                "DELETE /api/devices/offline%20%2Fdevice HTTP/1.1", "POST /api/connectors/email/accounts HTTP/1.1", "DELETE /api/devices/online HTTP/1.1",
            ), requests.map { it.line })
            assertTrue(requests.all { it.headers["authorization"] == "Bearer fixture-local" })
            assertEquals("fixture@qq.com", JSONObject(requests[1].body).getJSONObject("values").getString("address"))
            assertFalse(JSONObject(requests[2].body).getJSONObject("values").has("password"))
        } finally {
            Prefs.server = previousServer
            Prefs.token = previousToken
            server.close()
            serving.cancel()
        }
    }
}
