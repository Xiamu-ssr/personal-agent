package com.xiamu.agent

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Response
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.URI
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

object Api {
    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .pingInterval(25, TimeUnit.SECONDS)
        .build()

    private val slow: OkHttpClient = http.newBuilder().writeTimeout(120, TimeUnit.SECONDS).readTimeout(120, TimeUnit.SECONDS).build()

    val authHeader: Map<String, String> get() = mapOf("Authorization" to "Bearer ${Prefs.token}")

    internal fun serverUri(server: String = Prefs.server): URI? {
        val parsed = server.toHttpUrlOrNull() ?: return null
        if (parsed.query != null || parsed.fragment != null || parsed.username.isNotEmpty() || parsed.password.isNotEmpty()) return null
        return parsed.toUri()
    }

    fun url(path: String): String {
        val server = Prefs.server
        require(server.isNotBlank()) { "请填写云端地址" }
        require(serverUri(server) != null) { "账号请填写完整的云端地址" }
        return server + path
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8").replace("+", "%20")

    /** `/files/<path under the repo root>`, each segment URL-encoded. Paths look like `data/briefs/...`. */
    fun filePath(dataPath: String) = "/files/" + dataPath.split("/").joinToString("/") { enc(it) }
    fun fileUrl(dataPath: String) = url(filePath(dataPath))

    fun wsRequest(role: String): Request? {
        val base = serverUri()?.toASCIIString()?.trimEnd('/')
            ?.replaceFirst("https://", "wss://")?.replaceFirst("http://", "ws://") ?: return null
        return Request.Builder().url("$base/ws?role=$role").header("Authorization", "Bearer ${Prefs.token}").build()
    }

    private fun req(path: String) = Request.Builder().url(url(path)).header("Authorization", "Bearer ${Prefs.token}")

    private suspend fun <T> fetch(r: Request, client: OkHttpClient, read: (Response) -> T): T = suspendCancellableCoroutine { cont ->
        val call = client.newCall(r)
        cont.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (cont.isActive) cont.resumeWithException(ApiError(0, ""))
            }
            override fun onResponse(call: Call, response: Response) {
                response.use { res ->
                    try {
                        if (!res.isSuccessful) throw ApiError(res.code, res.body?.string().orEmpty())
                        val value = read(res)
                        if (cont.isActive) cont.resume(value)
                    } catch (e: Exception) {
                        if (cont.isActive) cont.resumeWithException(if (e is IOException) ApiError(0, "") else e)
                    }
                }
            }
        })
    }

    private suspend fun call(r: Request, client: OkHttpClient = http): String = fetch(r, client) { it.body?.string().orEmpty() }

    suspend fun getText(path: String): String = call(req(path).build())
    suspend fun getJson(path: String): JSONObject = JSONObject(getText(path))
    suspend fun postJson(path: String, body: JSONObject = JSONObject()): JSONObject =
        call(req(path).post(body.toString().toRequestBody("application/json".toMediaType())).build()).let { if (it.isBlank()) JSONObject() else JSONObject(it) }

    suspend fun putJson(path: String, body: JSONObject): JSONObject =
        call(req(path).put(body.toString().toRequestBody("application/json".toMediaType())).build()).let { if (it.isBlank()) JSONObject() else JSONObject(it) }

    private fun accountsPath(name: String, id: String? = null) =
        "/api/connectors/${enc(name)}/accounts" + if (id == null) "" else "/${enc(id)}"

    suspend fun addConnectorAccount(name: String, values: JSONObject): JSONObject =
        postJson(accountsPath(name), JSONObject().put("values", values))

    suspend fun updateConnectorAccount(name: String, id: String, values: JSONObject): JSONObject =
        putJson(accountsPath(name, id), JSONObject().put("values", values))

    suspend fun testConnectorAccount(name: String, id: String): JSONObject = postJson(accountsPath(name, id) + "/test")
    suspend fun deleteConnectorAccount(name: String, id: String) { call(req(accountsPath(name, id)).delete().build()) }
    suspend fun removeDevice(id: String) { call(req("/api/devices/${enc(id)}").delete().build()) }

    private suspend fun postRaw(path: String, body: RequestBody): JSONObject = JSONObject(call(req(path).post(body).build(), slow))

    /** Raw bytes into data/uploads/<date>/. Returns `{path, name, size}`. */
    suspend fun upload(name: String, bytes: ByteArray): JSONObject =
        postRaw("/api/upload?name=" + enc(name), bytes.toRequestBody("application/octet-stream".toMediaType()))

    suspend fun upload(name: String, file: File): JSONObject = upload(name, withContext(Dispatchers.IO) { file.readBytes() })

    /** Hold-to-talk: audio in, text out; the server keeps nothing. */
    suspend fun transcribe(file: File, format: String = "aac"): String =
        postRaw("/api/transcribe?format=$format", withContext(Dispatchers.IO) {
            require(file.length() <= 10 * 1024 * 1024) { "录音太大了，上限 10MB" }
            file.readBytes()
        }.toRequestBody("application/octet-stream".toMediaType()))
            .optString("text").trim()

    suspend fun bytes(dataPath: String): ByteArray = fetch(req(filePath(dataPath)).build(), http) { it.body?.bytes() ?: byteArrayOf() }

    suspend fun connectorIcon(name: String): ByteArray = fetch(req("/api/connectors/${enc(name)}/icon").build(), http) { it.body?.bytes() ?: byteArrayOf() }

    suspend fun briefs(): List<BriefDocument> = getJson("/api/briefs?days=7").optJSONArray("items").objects()
        .mapNotNull(BriefDocument::from).sortedByDescending { it.time }

    suspend fun briefItem(path: String): BriefDocument = BriefDocument.from(getJson("/api/briefs/item?path=${enc(path)}"))
        ?.also { require(it.path == path) } ?: error("简报内容无法读取")
    suspend fun jobs(before: Long? = null): JobsPage = JobsPage.from(getJson("/api/jobs?limit=30" + (before?.let { "&before=$it" } ?: "")))
    suspend fun health(): HealthData = HealthData.from(getJson("/api/health"))
    suspend fun syncHealth(): HealthData = HealthData.from(postJson("/api/health/sync", JSONObject()))

    suspend fun settings(): AgentSettings = AgentSettings.from(getJson("/api/settings"))
    suspend fun saveSettings(model: String? = null, permissionMode: String? = null): AgentSettings {
        require(model != null || permissionMode != null)
        val body = JSONObject()
        model?.let { body.put("model", it) }
        permissionMode?.let { body.put("permissionMode", it) }
        return AgentSettings.from(putJson("/api/settings", body))
    }

    suspend fun taskHistory(id: String): TaskHistory = TaskHistory.from(getJson("/api/tasks/${enc(id)}/history")).also {
        require(it.id == id) { "返回的任务不匹配，请重试" }
    }
    suspend fun sendToTask(id: String, text: String, attachments: List<Attachment> = emptyList()) {
        require(text.isNotBlank() || attachments.isNotEmpty())
        val body = JSONObject().put("text", text)
        if (attachments.isNotEmpty()) body.put("attachments", JSONArray(attachments.map { it.toJson() }))
        val result = postJson("/api/tasks/${enc(id)}/send", body)
        check(result.getBoolean("ok") && result.getString("id") == id) { "任务续聊发送失败，请重试" }
    }

    suspend fun profile(): AvatarChoice = AvatarChoice.from(getJson("/api/profile").optJSONObject("avatar"))
    suspend fun saveProfile(choice: AvatarChoice) {
        putJson("/api/profile", JSONObject().put("avatar", JSONObject().put("shape", choice.shape).put("palette", choice.palette)))
    }

    suspend fun download(dataPath: String, dest: File) {
        val b = bytes(dataPath)
        withContext(Dispatchers.IO) { dest.parentFile?.mkdirs(); dest.writeBytes(b) }
    }

    suspend fun tree(dir: String): List<Entry> {
        val arr = getJson("/api/tree?dir=" + enc(dir)).getJSONArray("entries")
        return (0 until arr.length()).map {
            val e = arr.getJSONObject(it)
            Entry(e.getString("name"), e.getBoolean("dir"), e.optLong("size"), e.optLong("mtime"))
        }
    }

    /** Missing directories are just empty. */
    suspend fun treeOrEmpty(dir: String): List<Entry> = try {
        tree(dir)
    } catch (e: ApiError) {
        if (e.code == 404) emptyList() else throw e
    }

    suspend fun readFile(dataPath: String): String = getText(filePath(dataPath))

    suspend fun firstChatTime(): Long? = firstChatTime(getJson("/api/state"))

    internal fun firstChatTime(state: JSONObject): Long? =
        if (state.isNull("firstChat")) null else state.optLong("firstChat").takeIf { it > 0 }

    /**
     * 账号 = server URL, 密码 = 6-digit pairing code or the raw token. On success the token is saved;
     * on failure the previous login is left untouched.
     */
    suspend fun login(server: String, password: String): JSONObject {
        val base = server.trim().trimEnd('/')
        require(base.isNotBlank()) { "请填写云端地址" }
        require(serverUri(base) != null) { "账号请填写完整的云端地址" }
        val pw = password.trim()
        val token = if (pw.matches(Regex("\\d{6}"))) {
            val body = JSONObject().put("code", pw).toString().toRequestBody("application/json".toMediaType())
            JSONObject(call(Request.Builder().url("$base/api/pair").post(body).build())).getString("token")
        } else pw
        val state = JSONObject(call(Request.Builder().url("$base/api/state").header("Authorization", "Bearer $token").build()))
        Prefs.server = base
        Prefs.token = token
        return state
    }

    data class Entry(val name: String, val dir: Boolean, val size: Long, val mtime: Long)

    class ApiError(val code: Int, body: String) : Exception(
        runCatching { JSONObject(body).optString("error") }.getOrNull()?.ifBlank { null }
            ?: when (code) {
                0 -> "连不上云端，检查网络和地址"
                401 -> "密码不对"
                404 -> "找不到"
                else -> "出错了（HTTP $code）"
            },
    )
}

fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }
fun JSONArray?.strings(): List<String> = if (this == null) emptyList() else (0 until length()).map { optString(it) }
