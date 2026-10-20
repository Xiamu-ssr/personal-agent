package com.xiamu.agent

import org.json.JSONArray
import org.json.JSONObject
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** Never print credentials through a draft, exception, or saved navigation state. */
class ProviderKey(private val value: String = "") {
    internal fun value() = value.trim()
    internal fun hasControlCharacters() = value.any { it=='\r' || it=='\n' || it=='\u0000' }
    override fun toString() = "[redacted]"
}

data class ProviderDraft(val name: String,val baseUrl: String,val models: List<ProviderModel>,val apiKey: ProviderKey = ProviderKey(),val protocol: String = "anthropic", val managementKey: ProviderKey = ProviderKey()) {
    fun validate(editing: Boolean): String? = when {
        protocol !in listOf("anthropic","openai") -> "请选择模型服务协议"
        !name.validProviderText(40) -> "名称请填 1–40 字，不含换行"
        normalizedBaseUrl(baseUrl)==null -> "Base URL 请填 http 或 https 地址，不带 query、hash 或账号密码"
        !editing && apiKey.value().isBlank() -> "请填写 API Key"
        managementKey.hasControlCharacters() -> "管理 Key 不能包含换行"
        apiKey.hasControlCharacters() -> "API Key 不能包含换行"
        models.size !in 1..20 -> "请添加 1–20 个模型"
        models.any { !it.id.validProviderText(200) } -> "模型 ID 请填 1–200 字，不含换行"
        models.any { !it.name.validProviderText(40) } -> "模型显示名请填 1–40 字，不含换行"
        models.map { it.id.trim() }.distinct().size!=models.size -> "同一服务的模型 ID 不能重复"
        else -> null
    }
    fun json(editing: Boolean): JSONObject {
        require(validate(editing)==null) { validate(editing).orEmpty() }
        return JSONObject().put("protocol",protocol).put("name",name.trim()).put("baseUrl",normalizedBaseUrl(baseUrl))
            .put("models",JSONArray().apply { models.forEach { put(JSONObject().put("id",it.id.trim()).put("name",it.name.trim())) } })
            .apply { managementKey.value().takeIf { it.isNotBlank() }?.let { put("managementKey",it) } }
            .apply { apiKey.value().takeIf { it.isNotBlank() }?.let { put("apiKey",it) } }
    }
}

private fun String.validProviderText(limit: Int): Boolean = trim().let { value ->
    value.codePointCount(0,value.length) in 1..limit && none { it=='\r' || it=='\n' || it=='\u0000' }
}

internal fun normalizedBaseUrl(value: String): String? = value.trim().toHttpUrlOrNull()
    ?.takeIf { it.query==null && it.fragment==null && it.username.isEmpty() && it.password.isEmpty() }
    ?.toString()?.trimEnd('/')

internal fun providerError(message: String?,key: ProviderKey): String {
    val text=message?.takeIf { it.isNotBlank() } ?: "测试失败，请稍后重试"
    return key.value().takeIf { it.isNotBlank() }?.let { text.replace(it,"[redacted]") } ?: text
}
