package com.xiamu.agent

import org.json.JSONObject

data class SettingsOption(val id: String, val label: String, val note: String) {
    companion object {
        fun from(j: JSONObject) = SettingsOption(j.getString("id"), j.getString("label"), j.getString("note")).also {
            require(it.id.isNotBlank() && it.label.isNotBlank()) { "选项缺少名称" }
        }
    }
}

data class ModelSelection(val provider: String,val id: String) {
    fun json() = JSONObject().put("provider",provider).put("id",id)
    companion object {
        fun from(j: JSONObject) = ModelSelection(j.getString("provider"),j.getString("id")).also {
            require(it.provider.isNotBlank() && it.id.isNotBlank()) { "模型缺少服务或 ID" }
        }
    }
}

data class ProviderModel(val id: String,val name: String,val note: String = "") {
    companion object {
        fun from(j: JSONObject) = ProviderModel(j.getString("id"),j.getString("name"),j.optString("note")).also {
            require(it.id.isNotBlank() && it.name.isNotBlank()) { "模型缺少名称或 ID" }
        }
    }
}

data class ProviderPreset(val id: String,val name: String,val protocol: String,val baseUrl: String,val hint: String,val models: List<ProviderModel>) {
    fun draft() = ProviderDraft(name,baseUrl,models,protocol=protocol)
    companion object {
        fun from(j: JSONObject) = ProviderPreset(j.getString("id"),j.getString("name"),j.getString("protocol"),
            j.getString("baseUrl"),j.getString("hint"),j.getJSONArray("models").objects().map(ProviderModel::from)).also {
            require(it.id.isNotBlank() && it.name.isNotBlank() && it.protocol in listOf("anthropic","openai") && normalizedBaseUrl(it.baseUrl)!=null) { "供应商预设不完整" }
            require(it.models.size in 1..20 && it.models.map { m -> m.id }.distinct().size==it.models.size) { "预设模型不完整" }
        }
    }
}

data class ModelProvider(val id: String,val name: String,val builtin: Boolean,val protocol: String,
    val models: List<ProviderModel>,val baseUrl: String? = null,val keyHint: String? = null) {
    val maskedKey: String get() = keyHint?.takeIf { it.isNotBlank() }?.let { if(it.all { c -> c=='•' }) "••••" else "••••${it.takeLast(4)}" }.orEmpty()
    companion object {
        fun from(j: JSONObject): ModelProvider {
            val builtin=j.getBoolean("builtin")
            return ModelProvider(j.getString("id"),j.getString("name"),builtin,j.getString("protocol"),
                j.getJSONArray("models").objects().map(ProviderModel::from),
                if(builtin) null else j.optString("baseUrl").takeIf { !j.isNull("baseUrl") && it.isNotBlank() },
                if(builtin) null else j.optString("keyHint").takeIf { !j.isNull("keyHint") && it.isNotBlank() }?.takeLast(4)).also {
                require(it.id.isNotBlank() && it.name.isNotBlank() && it.protocol in listOf("anthropic","openai") && it.models.isNotEmpty()) { "模型服务格式不完整" }
                require(it.models.map { m -> m.id }.distinct().size==it.models.size) { "模型 ID 重复" }
            }
        }
    }
}

data class AgentSettings(val model: ModelSelection, val providers: List<ModelProvider>,val providerPresets: List<ProviderPreset> = emptyList()) {
    val modelLabel: String get() = providers.firstOrNull { it.id==model.provider }?.models?.firstOrNull { it.id==model.id }?.name.orEmpty()
    companion object {
        fun from(j: JSONObject) = AgentSettings(ModelSelection.from(j.getJSONObject("model")),j.getJSONArray("providers").objects().map(ModelProvider::from),
            j.optJSONArray("providerPresets")?.objects()?.map(ProviderPreset::from).orEmpty()).also {
            require(it.providers.map { p -> p.id }.distinct().size==it.providers.size) { "模型服务 ID 重复" }
            require(it.providerPresets.map { p -> p.id }.distinct().size==it.providerPresets.size) { "供应商预设 ID 重复" }
            require(j.getString("kernel")=="openclaw" && it.providers.any { p -> p.id==it.model.provider && p.models.any { m -> m.id==it.model.id } }) { "请升级云端至豆豆 1.0" }
        }
    }
}
