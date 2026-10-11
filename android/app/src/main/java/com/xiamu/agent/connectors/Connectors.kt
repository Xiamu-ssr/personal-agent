package com.xiamu.agent.connectors

import com.xiamu.agent.Api
import com.xiamu.agent.Prefs
import com.xiamu.agent.objects
import org.json.JSONObject

data class FieldOption(val value: String, val label: String)

data class ConnectorField(
    val key: String,
    val label: String,
    val type: String,
    val placeholder: String,
    val defaultValue: String?,
    val options: List<FieldOption>,
    val showIf: Map<String, String>,
    val help: String,
) {
    fun visible(values: Map<String, String>) = showIf.all { (key, value) -> values[key] == value }
    fun help(values: Map<String, String>) = help
}

data class ConnectorAccount(val id: String, val label: String, val status: String, val error: String?, val checkedAt: Long, val values: Map<String, String> = emptyMap())

data class ConnectorInfo(
    val name: String,
    val title: String,
    val description: String,
    val icon: String,
    val enabled: Boolean,
    val fields: List<ConnectorField>?,
    val multiAccount: Boolean,
    val accounts: List<ConnectorAccount>,
)

data class ConnectedDevice(val id: String, val name: String, val kind: String, val online: Boolean, val lastSeen: Long, val caps: List<ConnectorInfo>)
data class Connections(
    val cloud: ConnectedDevice,
    val connected: List<ConnectorInfo>,
    val catalog: List<ConnectorInfo>,
    val others: List<ConnectedDevice>,
) {
    fun connector(name: String) = (connected + catalog).firstOrNull { it.name == name }
}

private fun JSONObject.stringMap() = keys().asSequence().associateWith { key -> opt(key)?.takeUnless { it == JSONObject.NULL }?.toString().orEmpty() }

fun connectorInfo(j: JSONObject, device: Boolean = false): ConnectorInfo {
    val fields = j.optJSONArray("fields")?.objects()?.map { f ->
        val help = f.opt("help")
        ConnectorField(
            f.optString("key"), f.optString("label"), f.optString("type", "text"), f.optString("placeholder"),
            f.opt("default")?.takeUnless { it == JSONObject.NULL }?.toString(),
            f.optJSONArray("options").objects().map { FieldOption(it.optString("value"), it.optString("label")) },
            f.optJSONObject("showIf")?.stringMap().orEmpty(), help as? String ?: "",
        )
    }
    val accounts = j.optJSONArray("accounts").objects().map {
        ConnectorAccount(it.optString("id"), it.optString("label"), it.optString("status"), it.opt("error") as? String, it.optLong("checkedAt"), it.optJSONObject("values")?.stringMap().orEmpty())
    }
    return ConnectorInfo(
        j.optString("name"), j.optString("title").ifBlank { j.optString("name") }, j.optString("description"), j.optString("icon"),
        if (device) j.optBoolean("enabled") else accounts.any { it.status == "ok" } || j.optString("status") == "on",
        fields, j.optBoolean("multiAccount", true), accounts,
    )
}

fun connectionsFromJson(j: JSONObject, localDeviceId: String = Prefs.deviceId): Connections {
    val cloud = j.optJSONObject("cloud") ?: JSONObject()
    return Connections(
        ConnectedDevice(cloud.optString("id", "cloud"), cloud.optString("name", "云电脑"), "cloud", cloud.optBoolean("online"), 0, emptyList()),
        cloud.optJSONArray("installed").objects().map { connectorInfo(it) },
        cloud.optJSONArray("catalog").objects().map { connectorInfo(it) },
        j.optJSONArray("devices").objects().filter { it.optString("id") != localDeviceId }.map {
            ConnectedDevice(it.optString("id"), it.optString("name"), it.optString("kind"), it.optBoolean("online"), it.optLong("lastSeen"),
                it.optJSONArray("capabilities").objects().map { c -> connectorInfo(c, device = true) })
        },
    )
}

interface ConnectorGateway {
    suspend fun list(): Connections
    suspend fun save(name: String, id: String?, values: JSONObject)
    suspend fun test(name: String, id: String)
    suspend fun delete(name: String, id: String)
    suspend fun removeDevice(id: String)
}

object CloudConnectors : ConnectorGateway {
    override suspend fun list() = connectionsFromJson(Api.getJson("/api/connectors"))
    override suspend fun save(name: String, id: String?, values: JSONObject) {
        if (id == null) Api.addConnectorAccount(name, values) else Api.updateConnectorAccount(name, id, values)
    }
    override suspend fun test(name: String, id: String) { Api.testConnectorAccount(name, id) }
    override suspend fun delete(name: String, id: String) { Api.deleteConnectorAccount(name, id) }
    override suspend fun removeDevice(id: String) { Api.removeDevice(id) }
}

class AccountDraft(val connector: ConnectorInfo, val editing: Boolean, account: ConnectorAccount? = null) {
    val initial = connector.fields.orEmpty().associate { field ->
        field.key to when {
            !editing -> field.defaultValue.orEmpty()
            field.type == "secret" -> ""
            else -> account?.values?.get(field.key).orEmpty()
        }
    }

    fun payload(values: Map<String, String>): JSONObject = JSONObject().apply {
        connector.fields.orEmpty().filter { it.visible(values) }.forEach { field ->
            val value = values[field.key].orEmpty()
            if (field.type == "secret" && (value.isBlank() || value == "••••")) return@forEach
            if (field.type == "number" && value.isNotBlank()) {
                val number = value.toBigDecimalOrNull() ?: throw IllegalArgumentException("${field.label}请填写数字")
                put(field.key, number)
            } else put(field.key, if (field.type == "secret") value else value.trim())
        }
    }
}
