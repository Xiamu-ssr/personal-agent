package com.xiamu.agent

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.delay
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

    val authHeader: Map<String, String> get() = mapOf("Authorization" to "Bearer ${Prefs.token}","X-Doudou-Protocol" to "2")

    internal fun serverUri(server: String = Prefs.server): URI? {
        val parsed = server.toHttpUrlOrNull() ?: return null
        if (parsed.query != null || parsed.fragment != null || parsed.username.isNotEmpty() || parsed.password.isNotEmpty()) return null
        return parsed.toUri()
    }

    fun url(path: String, server: String = Prefs.server): String {
        require(server.isNotBlank()) { "请填写云端地址" }
        require(serverUri(server) != null) { "账号请填写完整的云端地址" }
        return server + path
    }

    fun encode(s: String) = URLEncoder.encode(s, "UTF-8").replace("+", "%20")

    /** `/files/<path under the repo root>`, each segment URL-encoded. Paths begin with `data/`. */
    fun filePath(dataPath: String) = "/files/" + dataPath.split("/").joinToString("/") { encode(it) }
    fun fileUrl(dataPath: String, server: String = Prefs.server) = url(filePath(dataPath), server)

    fun wsRequest(role: String): Request? = socketRequest("/ws?role=$role")

    fun socketRequest(path: String): Request? {
        val base = serverUri()?.toASCIIString()?.trimEnd('/')
            ?.replaceFirst("https://", "wss://")?.replaceFirst("http://", "ws://") ?: return null
        return Request.Builder().header("X-Doudou-Protocol", "2").url("$base$path").header("Authorization", "Bearer ${Prefs.token}").build()
    }

    private fun req(path: String) = Request.Builder().header("X-Doudou-Protocol", "2").url(url(path)).header("Authorization", "Bearer ${Prefs.token}")

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

    /** Retry a lost transport response with exactly the same idempotent request body. */
    suspend fun postMessage(path: String, body: JSONObject): JSONObject {
        require(body.optString("clientId").isNotBlank())
        return try { postJson(path,body) } catch(e: ApiError) {
            if(e.code!=0) throw e
            delay(350)
            postJson(path,body)
        }
    }

    suspend fun putJson(path: String, body: JSONObject): JSONObject =
        call(req(path).put(body.toString().toRequestBody("application/json".toMediaType())).build()).let { if (it.isBlank()) JSONObject() else JSONObject(it) }

    private fun accountsPath(name: String, id: String? = null) =
        "/api/connectors/${encode(name)}/accounts" + if (id == null) "" else "/${encode(id)}"

    suspend fun addConnectorAccount(name: String, values: JSONObject): JSONObject =
        postJson(accountsPath(name), JSONObject().put("values", values))

    suspend fun updateConnectorAccount(name: String, id: String, values: JSONObject): JSONObject =
        putJson(accountsPath(name, id), JSONObject().put("values", values))

    suspend fun testConnectorAccount(name: String, id: String): JSONObject = postJson(accountsPath(name, id) + "/test")
    suspend fun deleteConnectorAccount(name: String, id: String) { call(req(accountsPath(name, id)).delete().build()) }
    suspend fun removeDevice(id: String) { call(req("/api/devices/${encode(id)}").delete().build()) }

    private suspend fun postRaw(path: String, body: RequestBody): JSONObject = JSONObject(call(req(path).post(body).build(), slow))

    /** Raw bytes into data/uploads/<date>/. Returns `{path, name, size}`. */
    suspend fun upload(name: String, bytes: ByteArray): JSONObject =
        postRaw("/api/upload?name=" + encode(name), bytes.toRequestBody("application/octet-stream".toMediaType()))

    suspend fun upload(name: String, file: File): JSONObject = upload(name, withContext(Dispatchers.IO) { file.readBytes() })

    /** Hold-to-talk: audio in, text out; the server keeps nothing. */
    suspend fun transcribe(file: File, format: String = "aac"): String =
        postRaw("/api/transcribe?format=$format", withContext(Dispatchers.IO) {
            require(file.length() <= 10 * 1024 * 1024) { "录音太大了，上限 10MB" }
            file.readBytes()
        }.toRequestBody("application/octet-stream".toMediaType()))
            .optString("text").trim()

    suspend fun bytes(dataPath: String): ByteArray = fetch(req(filePath(dataPath)).build(), http) { it.body?.bytes() ?: byteArrayOf() }

    suspend fun feed(before: String? = null): FeedPage = FeedPage.from(getJson("/api/feed?days=7" + (before?.let { "&before=${encode(it)}" } ?: "")))
    suspend fun feedItem(path: String): FeedPost = FeedPost.from(getJson("/api/feed/item?path=${encode(path)}"))
    suspend fun feedSettings() = FeedSettings.from(getJson("/api/feed/settings"))
    suspend fun saveFeedSettings(value: FeedSettings): FeedSettings { value.validate(); return FeedSettings.from(putJson("/api/feed/settings",value.json())) }
    suspend fun feedback(path: String,action: String) = postJson("/api/feed/feedback",JSONObject().put("path",path).put("action",action))
    suspend fun ideas() = Ideas.from(getJson("/api/ideas"))
    suspend fun goals() = getJson("/api/goals")
    suspend fun goal(name: String) = Goal.from(getJson("/api/goals/item?name=${encode(name)}"))
    suspend fun library() = Library.from(getJson("/api/library"))
    suspend fun activities(before: Long? = null) = ActivitiesPage.from(getJson("/api/activities?limit=30"+(before?.let { "&before=$it" } ?: "")))
    suspend fun health(): HealthData = HealthData.from(getJson("/api/health"))
    suspend fun syncHealth(): HealthData = HealthData.from(postJson("/api/health/sync"))
    suspend fun settings(): AgentSettings = AgentSettings.from(getJson("/api/settings"))
    suspend fun saveSettings(model: ModelSelection): AgentSettings = AgentSettings.from(putJson("/api/settings",JSONObject().put("model",model.json())))
    suspend fun saveProvider(id: String?,draft: ProviderDraft): ModelProvider = providerRequest(draft.apiKey) {
        val body=draft.json(editing=id!=null).toString().toRequestBody("application/json".toMediaType())
        val request=if(id==null) req("/api/providers").post(body) else req("/api/providers/${encode(id)}").patch(body)
        ModelProvider.from(JSONObject(call(request.build())).getJSONObject("provider"))
    }
    suspend fun testProvider(baseUrl: String,apiKey: ProviderKey,model: String, protocol: String): Long = providerRequest(apiKey) {
        val result=postJson("/api/providers/test",JSONObject().put("baseUrl",baseUrl).put("apiKey",apiKey.value()).put("model",model).put("protocol",protocol))
        check(result.optBoolean("ok")) { "测试失败，请稍后重试" }; result.getLong("ms")
    }
    suspend fun deleteProvider(id: String) { call(req("/api/providers/${encode(id)}").delete().build()) }
    private suspend fun <T> providerRequest(key: ProviderKey,block: suspend () -> T): T = try { block() }
        catch(e: kotlinx.coroutines.CancellationException) { throw e }
        catch(e: Exception) { throw ApiError((e as? ApiError)?.code ?: 0,JSONObject().put("error",providerError(e.message,key)).toString()) }
    suspend fun activityHistory(id: String) = ActivityHistory.from(getJson("/api/activities/${encode(id)}/history")).also { require(it.id==id) { "返回的活动不匹配" } }
    suspend fun sideChatHistory(id: String) = SideChatHistory.from(getJson("/api/activities/${encode(id)}/history")).also { require(it.id==id) { "返回的旁聊不匹配" } }
    suspend fun createSideChat(text: String,attachments: List<Attachment>,clientId: String): String = createdSideChatId(postMessage("/api/side-chats",OutgoingMessage(text,attachments,clientId).json()))
    suspend fun chooseSideOption(id: String,messageId: String,optionId: String) = postJson("/api/options/choose",JSONObject().put("activityId",id).put("messageId",messageId).put("optionId",optionId))
    suspend fun sendToActivity(id: String,text: String,attachments: List<Attachment>,clientId: String) {
        val result=postMessage("/api/activities/${encode(id)}/send",OutgoingMessage(text,attachments,clientId).json())
        check(result.optBoolean("ok") && result.optString("id")==id) { "续聊发送失败" }
    }
    suspend fun pathBytes(path: String): ByteArray = fetch(req(path).build(),http) { it.body?.bytes() ?: byteArrayOf() }

    suspend fun download(dataPath: String, dest: File) = withContext(Dispatchers.IO) {
        dest.parentFile?.mkdirs()
        val temp = File.createTempFile("download-", ".part", dest.parentFile)
        try {
            val request = Request.Builder().header("X-Doudou-Protocol", "2").url(fileUrl(dataPath)).apply { authHeader.forEach { (key, value) -> header(key, value) } }.build()
            fetch(request, http) { response ->
                val body = response.body ?: throw IOException("文件不可用")
                body.byteStream().use { input -> temp.outputStream().use { output -> input.copyTo(output) } }
            }
            coroutineContext.ensureActive()
            check(temp.renameTo(dest)) { "文件不可用" }
        } finally { temp.delete() }
    }

    suspend fun tree(dir: String): List<Entry> {
        val arr = getJson("/api/tree?dir=" + encode(dir)).getJSONArray("entries")
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
            JSONObject(call(Request.Builder().header("X-Doudou-Protocol", "2").url("$base/api/pair").post(body).build())).getString("token")
        } else pw
        val state = JSONObject(call(Request.Builder().header("X-Doudou-Protocol", "2").url("$base/api/state").header("Authorization", "Bearer $token").build()))
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
