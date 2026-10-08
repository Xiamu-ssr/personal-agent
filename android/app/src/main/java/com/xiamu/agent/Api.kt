package com.xiamu.agent

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

object Api {
    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .pingInterval(25, TimeUnit.SECONDS)
        .build()

    val authHeader: Map<String, String> get() = mapOf("Authorization" to "Bearer ${Prefs.token}")

    fun url(path: String) = Prefs.server + path

    fun fileUrl(dataPath: String) =
        url("/files/" + dataPath.split("/").joinToString("/") { URLEncoder.encode(it, "UTF-8").replace("+", "%20") })

    fun wsRequest(role: String): Request {
        val base = Prefs.server.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://")
        return Request.Builder().url("$base/ws?role=$role").header("Authorization", "Bearer ${Prefs.token}").build()
    }

    private fun req(path: String) = Request.Builder().url(url(path)).header("Authorization", "Bearer ${Prefs.token}")

    suspend fun getText(path: String): String = withContext(Dispatchers.IO) {
        http.newCall(req(path).build()).execute().use { r ->
            if (!r.isSuccessful) throw ApiError(r.code, r.body?.string().orEmpty())
            r.body!!.string()
        }
    }

    suspend fun getJson(path: String): JSONObject = JSONObject(getText(path))

    suspend fun postJson(path: String, body: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        val rb = body.toString().toRequestBody("application/json".toMediaType())
        http.newCall(req(path).post(rb).build()).execute().use { r ->
            val s = r.body?.string().orEmpty()
            if (!r.isSuccessful) throw ApiError(r.code, s)
            if (s.isBlank()) JSONObject() else JSONObject(s)
        }
    }

    suspend fun tree(dir: String): List<Entry> {
        val j = getJson("/api/tree?dir=" + URLEncoder.encode(dir, "UTF-8"))
        val arr = j.getJSONArray("entries")
        return (0 until arr.length()).map {
            val e = arr.getJSONObject(it)
            Entry(e.getString("name"), e.getBoolean("dir"), e.optLong("size"), e.optLong("mtime"))
        }
    }

    suspend fun readFile(dataPath: String): String = getText(fileUrl(dataPath).removePrefix(Prefs.server))

    data class Entry(val name: String, val dir: Boolean, val size: Long, val mtime: Long)

    class ApiError(val code: Int, body: String) : Exception(if (code == 401) "token 不对" else "HTTP $code $body")
}
