package com.xiamu.agent

import org.json.JSONObject

data class SettingsOption(val id: String, val label: String, val note: String) {
    companion object {
        fun from(j: JSONObject) = SettingsOption(j.getString("id"), j.getString("label"), j.getString("note")).also {
            require(it.id.isNotBlank() && it.label.isNotBlank()) { "选项缺少名称" }
        }
    }
}

data class AgentSettings(val model: String, val permissionMode: String, val models: List<SettingsOption>, val permissionModes: List<SettingsOption>) {
    val modelLabel: String get() = models.firstOrNull { it.id == model }?.label.orEmpty()
    val permissionLabel: String get() = permissionModes.firstOrNull { it.id == permissionMode }?.label.orEmpty()

    companion object {
        fun from(j: JSONObject) = AgentSettings(j.getString("model"), j.getString("permissionMode"),
            j.getJSONArray("models").objects().map(SettingsOption::from),
            j.getJSONArray("permissionModes").objects().map(SettingsOption::from)).also {
            require(it.models.any { option -> option.id == it.model } && it.permissionModes.any { option -> option.id == it.permissionMode }) { "当前选项不在设置列表中" }
        }
    }
}
