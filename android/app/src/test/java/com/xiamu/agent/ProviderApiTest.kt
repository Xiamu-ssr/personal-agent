package com.xiamu.agent

import android.content.SharedPreferences
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.lang.reflect.Proxy

class ProviderApiTest {
    private val key="sk-test-0000abcd"
    private val values=mutableMapOf("token" to "local-provider-fixture")
    private val field=Prefs::class.java.getDeclaredField("sp").apply { isAccessible=true }
    private var previous: Any?=null
    private lateinit var server: MockWebServer
    private fun draft(secret: String=key) = ProviderDraft("演示服务","https://example.test/",listOf(ProviderModel("shared-model","演示模型")),ProviderKey(secret))
    private fun responseProvider()=JSONObject(providerSettingsJson).getJSONArray("providers").getJSONObject(1)
    @Before fun setup() {
        previous=field.get(null)
        field.set(null,Proxy.newProxyInstance(javaClass.classLoader,arrayOf(SharedPreferences::class.java)) { _,method,args ->
            when(method.name) { "getString" -> values[args!![0] as String] ?: args[1]; else -> error("Unexpected ${method.name}") }
        })
        server=MockWebServer();server.start();values["server"]=server.url("/").toString().trimEnd('/')
    }
    @After fun teardown() { server.shutdown();field.set(null,previous) }
    @Test fun createPostsOneTestAndSaveRequest()=runBlocking {
        server.enqueue(MockResponse().setBody(JSONObject().put("provider",responseProvider()).toString()))
        val p=Api.saveProvider(null,draft());val request=server.takeRequest()
        assertEquals("POST",request.method);assertEquals("/api/providers",request.path)
        val body=JSONObject(request.body.readUtf8());assertEquals(key,body.getString("apiKey"));assertEquals("https://example.test",body.getString("baseUrl"))
        assertEquals("演示服务",p.name);assertFalse(p.toString().contains(key));assertEquals(1,server.requestCount)
    }
    @Test fun editPatchesAndOmitsUnchangedKey()=runBlocking {
        server.enqueue(MockResponse().setBody(JSONObject().put("provider",responseProvider()).toString()))
        Api.saveProvider("custom/demo",draft(""));val request=server.takeRequest()
        assertEquals("PATCH",request.method);assertEquals("/api/providers/custom%2Fdemo",request.path)
        assertFalse(JSONObject(request.body.readUtf8()).has("apiKey"))
    }
    @Test fun modelSelectionPutUsesTheProviderObject()=runBlocking {
        server.enqueue(MockResponse().setBody(providerSettingsJson))
        val selection=ModelSelection("custom-demo","shared-model");assertEquals(selection,Api.saveSettings(model=selection).model)
        val request=server.takeRequest();assertEquals("PUT",request.method);assertEquals("/api/settings",request.path)
        assertEquals(selection,ModelSelection.from(JSONObject(request.body.readUtf8()).getJSONObject("model")))
    }
    @Test fun standaloneProviderTestReturnsLatency()=runBlocking {
        server.enqueue(MockResponse().setBody("""{"ok":true,"ms":14}"""))
        assertEquals(14L,Api.testProvider("https://example.test",ProviderKey(key),"shared-model","openai"))
        val request=server.takeRequest();assertEquals("/api/providers/test",request.path);assertEquals("POST",request.method)
        assertEquals(key,JSONObject(request.body.readUtf8()).getString("apiKey"))
    }
    @Test fun deletingSelectedProviderShowsTheCloudPrompt()=runBlocking {
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":"先换到别的模型"}"""))
        val e=try { Api.deleteProvider("custom-demo");error("expected rejection") } catch(e: Api.ApiError) { e }
        assertEquals(409,e.code);assertEquals("先换到别的模型",e.message);assertEquals("DELETE",server.takeRequest().method)
    }
    @Test fun createErrorsAndTheirStackTracesCannotLogTheKey()=runBlocking {
        server.enqueue(MockResponse().setResponseCode(400).setBody(JSONObject().put("error","服务认证失败：$key").toString()))
        val e=try { Api.saveProvider(null,draft());error("expected rejection") } catch(e: Api.ApiError) { e }
        assertTrue(e.message!!.contains("服务认证失败"));assertFalse(e.stackTraceToString().contains(key));assertNull(e.cause)
    }
    @Test fun editErrorsRedactAReplacementKey()=runBlocking {
        server.enqueue(MockResponse().setResponseCode(400).setBody(JSONObject().put("error","替换 Key 失败：$key").toString()))
        val e=try { Api.saveProvider("custom-demo",draft());error("expected rejection") } catch(e: Api.ApiError) { e }
        assertFalse(e.toString().contains(key));assertFalse(e.stackTraceToString().contains(key))
    }
}
