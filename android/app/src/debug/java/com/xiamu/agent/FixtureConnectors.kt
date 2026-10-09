package com.xiamu.agent

import android.content.Context
import com.xiamu.agent.connectors.ConnectorGateway
import com.xiamu.agent.connectors.connectionsFromJson
import kotlinx.coroutines.delay
import org.json.JSONArray
import org.json.JSONObject

/** Debug-only, entirely in memory. No socket, token, chat or device registration. */
class FixtureConnectors(context: Context, val scenario: String) : ConnectorGateway {
    private val json = JSONObject(context.assets.open("connectors.json").bufferedReader().use { it.readText() })
    private val cloud = json.getJSONObject("cloud")
    private val email = cloud.getJSONArray("catalog").getJSONObject(0)
    var saves = 0
        private set
    var tests = 0
        private set
    var deletions = 0
        private set
    var removals = 0
        private set
    var lastValues: JSONObject? = null
        private set
    var lastEditedId: String? = null
        private set

    init {
        if (scenario in setOf("detail-multi", "detail-error") || scenario.startsWith("form-edit")) {
            val saved = JSONObject(context.assets.open("connector-accounts.json").bufferedReader().use { it.readText() }).getJSONArray("accounts")
            val accounts = if (scenario == "form-edit-custom") JSONArray().put(saved.getJSONObject(2))
                else JSONArray().put(saved.getJSONObject(0)).put(saved.getJSONObject(1))
            if (scenario == "form-edit-legacy") accounts.objects().forEach { it.remove("values") }
            if (scenario == "detail-error") accounts.remove(0)
            email.put("accounts", accounts)
            cloud.put("installed", JSONArray().put(email)).put("catalog", JSONArray())
        }
        if (scenario == "legacy") email.remove("fields")
        if (scenario == "form-custom") fields().first { it.optString("key") == "preset" }.put("default", "custom")
        if (scenario == "form-failed" || scenario == "form-validating") {
            fields().first { it.optString("key") == "address" }.put("default", "fixture@qq.com")
            fields().first { it.optString("key") == "password" }.put("default", "fixture-invalid")
        }
    }

    private fun fields() = email.optJSONArray("fields").objects()
    override suspend fun list() = connectionsFromJson(JSONObject(json.toString()))

    override suspend fun save(name: String, id: String?, values: JSONObject) {
        saves++
        lastValues = JSONObject(values.toString())
        lastEditedId = id
        delay(if (scenario == "form-validating") 15_000 else 300)
        if (scenario == "form-failed" || scenario == "form-validating") throw Api.ApiError(400, """{"error":"授权码不对，请重新生成后再试"}""")
        val accounts = email.optJSONArray("accounts") ?: JSONArray()
        fun savedValues(previous: JSONObject? = null) = JSONObject(previous?.toString() ?: "{}").apply {
            val secrets = fields().filter { it.optString("type") == "secret" }.map { it.optString("key") }.toSet()
            values.keys().forEach { key -> put(key, if (key in secrets) "••••" else values.get(key)) }
        }
        if (id == null) {
            accounts.put(JSONObject().put("id", "local-${accounts.length() + 1}").put("label", values.optString("label").ifBlank { values.optString("address") })
                .put("status", "ok").put("error", JSONObject.NULL).put("checkedAt", 0).put("values", savedValues()))
        } else accounts.objects().first { it.optString("id") == id }.apply {
            val updated = savedValues(optJSONObject("values"))
            if (values.has("label")) put("label", values.getString("label").ifBlank { updated.optString("address") })
            if (scenario != "form-edit-legacy") put("values", updated)
            put("status", "ok").put("error", JSONObject.NULL)
        }
        email.put("accounts", accounts)
        cloud.put("installed", JSONArray().put(email)).put("catalog", JSONArray())
    }

    override suspend fun test(name: String, id: String) {
        tests++
        delay(300)
        email.getJSONArray("accounts").objects().first { it.optString("id") == id }.put("status", "ok").put("error", JSONObject.NULL)
    }

    override suspend fun delete(name: String, id: String) {
        deletions++
        delay(300)
        val remaining = email.getJSONArray("accounts").objects().filter { it.optString("id") != id }
        email.put("accounts", JSONArray(remaining))
        if (remaining.isEmpty()) cloud.put("installed", JSONArray()).put("catalog", JSONArray().put(email))
    }

    override suspend fun removeDevice(id: String) {
        removals++
        delay(300)
        if (scenario == "devices-conflict") {
            json.getJSONArray("devices").objects().first { it.optString("id") == id }.put("online", true)
            throw Api.ApiError(409, """{"error":"online"}""")
        }
        json.put("devices", JSONArray(json.getJSONArray("devices").objects().filter { it.optString("id") != id }))
    }
}
