package com.xiamu.agent

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

internal val providerSettingsJson="""{"model":{"provider":"custom-demo","id":"shared-model"},"permissionMode":"auto","providers":[{"id":"zenmux","name":"ZenMux","builtin":true,"protocol":"anthropic","models":[{"id":"shared-model","name":"内置模型","note":"消耗约 1×"}]},{"id":"custom-demo","name":"演示服务","builtin":false,"protocol":"anthropic","baseUrl":"https://example.test","keyHint":"abcd","models":[{"id":"shared-model","name":"演示模型"}]}],"permissionModes":[{"id":"auto","label":"自动","note":"自动拦下危险操作"},{"id":"bypassPermissions","label":"完全放行","note":"完全放行"}]}"""

class ProviderSettingsTest {
    private val key="sk-test-0000abcd"
    private fun draft(name: String="演示服务",url: String="https://example.test",models: List<ProviderModel> = listOf(ProviderModel("demo-model","演示模型")),secret: String=key) = ProviderDraft(name,url,models,ProviderKey(secret))
    @Test fun providersAndScopedSelectionParse() {
        val settings=AgentSettings.from(JSONObject(providerSettingsJson))
        assertEquals(ModelSelection("custom-demo","shared-model"),settings.model)
        assertEquals("演示模型",settings.modelLabel)
        assertEquals(listOf("ZenMux","演示服务"),settings.providers.map { it.name })
        assertEquals("消耗约 1×",settings.providers.first().models.single().note)
        assertEquals("",settings.providers.last().models.single().note)
    }
    @Test fun modelSelectionUsesProviderAndIdInsteadOfAFlatString() {
        val model=ModelSelection("custom-demo","shared-model")
        assertEquals(setOf("provider","id"),model.json().keySet());assertEquals(model,ModelSelection.from(model.json()))
    }
    @Test fun sameModelIdInAnotherProviderIsAnotherSelection() {
        val j=JSONObject(providerSettingsJson).put("model",ModelSelection("zenmux","shared-model").json())
        assertEquals("内置模型",AgentSettings.from(j).modelLabel)
        assertNotEquals(ModelSelection("zenmux","shared-model"),ModelSelection("custom-demo","shared-model"))
    }
    @Test fun selectedModelMustBelongToTheSelectedProvider() {
        for(model in listOf(ModelSelection("missing","shared-model"),ModelSelection("custom-demo","missing")))
            assertThrows(IllegalArgumentException::class.java) { AgentSettings.from(JSONObject(providerSettingsJson).put("model",model.json())) }
    }
    @Test fun oldFlatModelShapeIsRejected() {
        assertThrows(org.json.JSONException::class.java) { AgentSettings.from(JSONObject(providerSettingsJson).put("model","shared-model")) }
    }
    @Test fun duplicateProviderOrModelIdsAreRejected() {
        val j=JSONObject(providerSettingsJson);j.getJSONArray("providers").put(j.getJSONArray("providers").getJSONObject(0))
        assertThrows(IllegalArgumentException::class.java) { AgentSettings.from(j) }
        val p=JSONObject(providerSettingsJson).getJSONArray("providers").getJSONObject(1)
        p.getJSONArray("models").put(p.getJSONArray("models").getJSONObject(0))
        assertThrows(IllegalArgumentException::class.java) { ModelProvider.from(p) }
    }
    @Test fun builtinProviderNeverExposesKeyOrBaseUrl() {
        val j=JSONObject(providerSettingsJson).getJSONArray("providers").getJSONObject(0).put("apiKey",key).put("keyHint",key).put("baseUrl","https://example.test")
        val p=ModelProvider.from(j)
        assertNull(p.baseUrl);assertNull(p.keyHint);assertEquals("",p.maskedKey);assertFalse(p.toString().contains(key))
    }
    @Test fun providerKeepsOnlyKeyTailAndIgnoresRawCredentialFields() {
        val j=JSONObject(providerSettingsJson).getJSONArray("providers").getJSONObject(1).put("apiKey",key).put("keyHint",key)
        val p=ModelProvider.from(j)
        assertEquals("abcd",p.keyHint);assertEquals("••••abcd",p.maskedKey);assertFalse(p.toString().contains(key))
        assertEquals("••••",ModelProvider.from(j.put("keyHint","••••")).maskedKey)
    }
    @Test fun providerNamesAreTrimmedAndBounded() {
        assertNotNull(draft(name=" ").validate(false));assertNotNull(draft(name="字".repeat(41)).validate(false))
        assertNull(draft(name="字".repeat(40)).validate(false));assertEquals("演示",draft(name=" 演示 ").json(false).getString("name"))
    }
    @Test fun limitsCountUnicodeCharactersAndRejectControlCharacters() {
        assertNull(draft(name="🌱".repeat(40)).validate(false));assertNotNull(draft(name="🌱".repeat(41)).validate(false))
        assertNotNull(draft(name="第一行\n第二行").validate(false));assertNotNull(draft(models=listOf(ProviderModel("demo\u0000model","模型"))).validate(false))
    }
    @Test fun baseUrlAllowsHttpHttpsAndPathsAndRemovesTrailingSlashes() {
        assertEquals("https://example.test/api",normalizedBaseUrl(" https://example.test/api/// "))
        assertEquals("http://127.0.0.1:18771",normalizedBaseUrl("http://127.0.0.1:18771/"))
        assertNotNull(normalizedBaseUrl("https://例子.测试/"))
    }
    @Test fun baseUrlRejectsInvalidSchemesQueriesFragmentsAndCredentials() {
        for(url in listOf("example.test","file:///tmp/a","https:///","https://example.test?x=1","https://example.test?","https://example.test#top","https://example.test#","https://a:b@example.test"))
            assertNotNull(url,draft(url=url).validate(false))
    }
    @Test fun modelCountIsOneThroughTwenty() {
        assertNotNull(draft(models=emptyList()).validate(false))
        assertNull(draft(models=(1..20).map { ProviderModel("model-$it","模型 $it") }).validate(false))
        assertNotNull(draft(models=(1..21).map { ProviderModel("model-$it","模型 $it") }).validate(false))
    }
    @Test fun modelIdIsRequiredAndBounded() {
        for(id in listOf(" ","a".repeat(201))) assertNotNull(draft(models=listOf(ProviderModel(id,"模型"))).validate(false))
        assertNull(draft(models=listOf(ProviderModel("a".repeat(200),"模型"))).validate(false))
    }
    @Test fun displayNameIsRequiredAndBounded() {
        for(name in listOf(" ","字".repeat(41))) assertNotNull(draft(models=listOf(ProviderModel("a",name))).validate(false))
        assertNull(draft(models=listOf(ProviderModel("a","字".repeat(40)))).validate(false))
    }
    @Test fun duplicateModelIdsAreCheckedAfterTrimming() {
        assertNotNull(draft(models=listOf(ProviderModel(" model ","一"),ProviderModel("model","二"))).validate(false))
    }
    @Test fun keyIsRequiredForCreationAndOptionalForEdit() {
        assertNotNull(draft(secret=" ").validate(false));assertNull(draft(secret=" ").validate(true))
        assertNotNull(draft(secret="sk-test\n0000abcd").validate(false));assertNotNull(draft(secret="sk-test-0000abcd\n").validate(true))
    }
    @Test fun editWithBlankKeyOmitsTheApiKeyField() {
        assertFalse(draft(secret=" ").json(true).has("apiKey"))
        assertEquals(key,draft().json(true).getString("apiKey"))
    }
    @Test fun savePayloadTrimsValuesAndDoesNotAllowProtocolChanges() {
        val j=draft(url="https://example.test/",models=listOf(ProviderModel(" a "," 模型 "))).json(false)
        assertEquals("https://example.test",j.getString("baseUrl"));assertEquals("a",j.getJSONArray("models").getJSONObject(0).getString("id"))
        assertFalse(j.has("protocol"));assertEquals(setOf("id","name"),j.getJSONArray("models").getJSONObject(0).keySet())
    }
    @Test fun credentialAndDraftDiagnosticsNeverPrintKey() {
        assertFalse(ProviderKey(key).toString().contains(key));assertFalse(draft().toString().contains(key))
        assertTrue(draft().toString().contains("[redacted]"))
    }
    @Test fun upstreamErrorRedactsCredentialButKeepsUsefulError() {
        assertEquals("认证失败 [redacted]",providerError("认证失败 $key",ProviderKey(key)))
        assertEquals("模型不存在",providerError("模型不存在",ProviderKey()))
        assertFalse(providerError("$key $key",ProviderKey(key)).contains(key))
    }
}
