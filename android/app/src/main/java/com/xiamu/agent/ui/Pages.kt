package com.xiamu.agent.ui

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceError
import android.webkit.WebResourceResponse
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.xiamu.agent.Api
import com.xiamu.agent.Chat
import com.xiamu.agent.Prefs
import com.xiamu.agent.FileOpening
import com.xiamu.agent.fileOpening
import com.xiamu.agent.connectors.ConnectorInfo
import com.xiamu.agent.connectors.ConnectorAccount
import com.xiamu.agent.media.Images
import com.xiamu.agent.media.openSystemFile
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/** Pages pushed on top of the tabs. */
sealed interface Route {
    data object Settings : Route
    data object Server : Route
    data object Appearance : Route
    data object Health : Route
    data object Soul : Route
    data object Memory : Route
    data class GoalDetail(val name: String) : Route
    data class FeedDetail(val quote: com.xiamu.agent.ChatQuote) : Route
    data class IdeaDetail(val quote: com.xiamu.agent.ChatQuote) : Route
    data object ModelSettings : Route
    data class ProviderForm(val id: String? = null) : Route
    data class ActivityDetail(val id: String,val title: String) : Route
    data class SideChat(val id: String? = null) : Route
    data class Connectors(val tab: Int = 1,val device: String? = null) : Route
    data class ConnectorDetail(val connector: ConnectorInfo) : Route
    data class ConnectorForm(val connector: ConnectorInfo,val account: ConnectorAccount? = null) : Route
    data object Devices : Route
    data object Skills : Route
    data class Web(val title: String,val path: String) : Route
    data class Doc(val title: String,val path: String,val pointers: Boolean = false,val editable: Boolean = false) : Route
    data class Image(val path: String) : Route
    data class Pdf(val title: String,val path: String) : Route
}
object Nav {
    val tab=mutableIntStateOf(0)
    val stack=mutableStateListOf<Route>()
    val console=mutableStateOf(false)
    val drawer=mutableStateOf(false)
    val feedSettings=mutableStateOf(false)
    val feedTarget=mutableStateOf<com.xiamu.agent.ChatQuote?>(null)
    fun showQuote(quote: com.xiamu.agent.ChatQuote) {
        if(quote.kind == "feed") { home(1); feedTarget.value=quote }
        else { home(2); open(Route.IdeaDetail(quote)) }
    }
    fun open(r: Route) { console.value=false; drawer.value=false; stack.add(r) }
    fun back() { stack.removeLastOrNull() }
    fun home(tab: Int) { stack.clear(); console.value=false; drawer.value=false; this.tab.intValue=tab }
    fun sideChat(id: String? = null) { home(0); open(Route.SideChat(id)) }
    fun createdSideChat(id: String) { if(stack.lastOrNull()==Route.SideChat()) stack[stack.lastIndex]=Route.SideChat(id) }
}

/** Last good value per key, so going back to a page shows something instantly while it refreshes. */
private val cache = HashMap<String, Any?>()

/** Load something from the server; reload when data/ changes. */
@Composable
fun <T> load(key: String, cacheValue: Boolean = true, revision: Int = 0, block: suspend () -> T): Pair<T?, String> {
    @Suppress("UNCHECKED_CAST")
    var value by remember(key) { mutableStateOf(if (cacheValue) cache[key] as T? else null) }
    var err by remember(key) { mutableStateOf("") }
    LaunchedEffect(key, Chat.filesVersion.intValue, revision) {
        runCatching { block() }
            .onSuccess { value = it; err = ""; if (cacheValue) cache[key] = it }
            .onFailure { if (it is CancellationException) throw it; err = it.message ?: "出错了" }
    }
    return value to err
}

fun clearCache() = cache.clear()
fun invalidateCache(key: String) { cache.remove(key) }

@Composable
fun RoutePage(r: Route) {
    when (r) {
        is Route.Web -> WebPage(r)
        is Route.Doc -> DocPage(r)
        is Route.Image -> ImagePage(r.path)
        is Route.Pdf -> PdfPage(r)
        Route.Settings -> SettingsScreen()
        Route.Server -> ServerScreen()
        Route.Appearance -> AppearanceScreen()
        Route.Health -> HealthScreen()
        Route.Soul -> SoulScreen()
        Route.Memory -> MemoryScreen(0.dp)
        is Route.GoalDetail -> GoalDetailScreen(r.name)
        is Route.FeedDetail -> FeedDetailScreen(r.quote)
        is Route.IdeaDetail -> IdeaDetailScreen(r.quote)
        Route.ModelSettings -> ModelSettingsScreen()
        is Route.ProviderForm -> ProviderFormScreen(r.id)
        is Route.ActivityDetail -> ActivityDetailScreen(r)
        is Route.SideChat -> SideChatScreen(r)
        is Route.Connectors -> ConnectorsScreen(r)
        is Route.ConnectorDetail -> ConnectorDetailScreen(r)
        is Route.ConnectorForm -> ConnectorFormScreen(r)
        Route.Devices -> DevicesScreen()
        Route.Skills -> SkillsScreen()
    }
}

/** The WebView sends the token as the pa_token cookie so a site's own CSS/JS/images load too. */
@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun WebPage(r: Route.Web) {
    val base = Api.serverUri()
    if (base == null) {
        Screen {
            Column {
                SubHeader(r.title, Nav::back)
                ErrorNote(if (Prefs.server.isBlank()) "请填写云端地址" else "云端地址不对")
            }
        }
        return
    }
    var web by remember { mutableStateOf<WebView?>(null) }
    var canBack by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(true) }
    BackHandler(canBack) { web?.goBack() }
    Screen {
        Column(Modifier.fillMaxSize()) {
            SubHeader(r.title, Nav::back) { FileMenu(r.path,r.title) }
            if (error.isNotBlank()) ErrorNote(error)
            Box(Modifier.weight(1f).fillMaxWidth().navigationBarsPadding().padding(top = 4.dp).clipToBounds().background(Pal.Card)) {
                AndroidView(
                    modifier = Modifier.fillMaxSize().clipToBounds(),
                    factory = { ctx ->
                        WebView(ctx).apply {
                            settings.javaScriptEnabled = true
                            settings.domStorageEnabled = true
                            settings.loadWithOverviewMode = true
                            settings.useWideViewPort = true
                            webViewClient = object : WebViewClient() {
                                override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                                    loading = true
                                    error = ""
                                }
                                override fun onPageFinished(view: WebView, url: String?) { loading = false }
                                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                                    val uri = request.url
                                    if (uri.scheme !in setOf("http", "https") || uri.host != base.host || uri.port != base.port) {
                                        openBrowser(ctx, uri.toString())
                                        return true
                                    }
                                    return false
                                }
                                override fun onReceivedError(view: WebView, request: WebResourceRequest, e: WebResourceError) {
                                    if (request.isForMainFrame) { loading = false; error = "页面加载失败，请返回重试" }
                                }
                                override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                                    if (request.isForMainFrame) error = "页面加载失败（${response.statusCode}），请返回重试"
                                }
                                override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                                    canBack = view.canGoBack()
                                }
                            }
                            val secure = if (base.scheme == "https") "; Secure" else ""
                            CookieManager.getInstance().setCookie(
                                "${base.scheme}://${base.authority}",
                                "pa_token=${URLEncoder.encode(Prefs.token, "UTF-8")}; Path=${base.path.ifBlank { "/" }}; HttpOnly; SameSite=Lax$secure",
                            ) { if (web === this) loadUrl(Api.fileUrl(r.path), Api.authHeader) }
                            web = this
                        }
                    },
                    onRelease = { it.stopLoading(); it.destroy(); web = null },
                )
                if (loading) Loading(Modifier.align(Alignment.Center))
            }
        }
    }
}

@Composable
private fun DocPage(r: Route.Doc) {
    val scope=androidx.compose.runtime.rememberCoroutineScope()
    val (document,err)=load("doc:${r.path}") { if(r.path.startsWith("memory/") || r.path in listOf("SOUL.md","USER.md","MEMORY.md")) Api.getJson("/api/memory/item?path=${Api.encode(r.path)}").optString("text") else Api.readFile(r.path) }
    var text by remember(document) { mutableStateOf(document.orEmpty()) }
    var editing by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf("") }
    Screen { Column(Modifier.fillMaxSize().navigationBarsPadding()) {
        SubHeader(r.title,Nav::back)
        if(r.editable) RowActions(if(editing) "取消编辑" else "编辑") { editing=!editing }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(20.dp)) {
            when {
                document==null && err.isBlank() -> Loading()
                document==null -> ErrorNote(err)
                editing -> androidx.compose.material3.OutlinedTextField(text,{text=it},modifier=Modifier.fillMaxWidth(),minLines=12)
                else -> SelectionContainer { Markdown(document.orEmpty(),onPointer=if(r.pointers) { p->Nav.open(memoryDoc(p)) } else null) }
            }
            if(note.isNotBlank()) ErrorNote(note)
        }
        if(editing) GoldButton(if(saving) "正在保存…" else "保存",Modifier.fillMaxWidth().padding(20.dp),!saving) {
            saving=true
            scope.launch {
                try { Api.putJson("/api/memory/item?path=${Api.encode(r.path)}",org.json.JSONObject().put("text",text)); invalidateCache("doc:${r.path}"); Chat.filesVersion.intValue++; editing=false }
                catch(e: kotlinx.coroutines.CancellationException) { throw e }
                catch(e: Exception) { note=e.message ?: "保存失败" }
                finally { saving=false }
            }
        }
    } }
}

fun memoryDoc(rel: String) = Route.Doc(rel.substringAfterLast('/').removeSuffix(".md"), "memory/$rel", pointers = true)

@Composable
private fun ImagePage(path: String) {
    var bmp by remember { mutableStateOf(Images.cached(path, 2048)) }
    var failed by remember { mutableStateOf(false) }
    LaunchedEffect(path) { if (bmp == null) { bmp = Images.load(path, 2048); failed = bmp == null } }
    var scale by remember { mutableFloatStateOf(1f) }
    var dx by remember { mutableFloatStateOf(0f) }
    var dy by remember { mutableFloatStateOf(0f) }
    val state = rememberTransformableState { z, pan, _ ->
        scale = (scale * z).coerceIn(1f, 5f)
        dx += pan.x; dy += pan.y
    }
    Box(Modifier.fillMaxSize().background(Pal.Card)) {
        val b = bmp
        if (failed) Text("文件不可用", color = Pal.Ink, modifier = Modifier.align(Alignment.Center))
        else if (b == null) Loading(Modifier.align(Alignment.Center))
        else Image(
            b.asImageBitmap(), null, contentScale = ContentScale.Fit,
            modifier = Modifier.fillMaxSize().transformable(state)
                .graphicsLayer { scaleX = scale; scaleY = scale; translationX = dx; translationY = dy },
        )
        Box(
            Modifier.statusBarsPadding().padding(16.dp).size(40.dp).clip(CircleShape).background(Pal.Card).tap(onClick = Nav::back)
                .align(Alignment.TopStart),
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Outlined.Close, "关闭", tint = Pal.Icon) }
    }
}

/** Shared by the library, Markdown links and chat attachments. */
suspend fun openFile(ctx: Context, path: String, title: String = path.substringAfterLast('/'), mime: String = "") {
    when (fileOpening(path, mime)) {
        FileOpening.Markdown -> Nav.open(Route.Doc(title.removeSuffix(".md"), path))
        FileOpening.Image -> Nav.open(Route.Image(path))
        FileOpening.Web -> Nav.open(Route.Web(title, path))
        FileOpening.Pdf -> Nav.open(Route.Pdf(title, path))
        FileOpening.System -> openSystemFile(ctx, path, title, mime)
    }
}

fun openBrowser(ctx: Context, url: String) {
    runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
}

@Composable
fun ctx(): Context = LocalContext.current

// ---------- time ----------

private val hm = SimpleDateFormat("HH:mm", Locale.CHINA)
private val md = SimpleDateFormat("M月d日", Locale.CHINA)
private val weekNames = listOf("星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六")
val ymd = SimpleDateFormat("yyyy-MM-dd", Locale.CHINA)

fun clock(ms: Long): String = hm.format(Date(ms))

/** 今天 21:31 / 昨天 08:00 / 10月3日 07:30 */
fun whenLabel(ms: Long): String {
    val days = dayDiff(ms)
    return when (days) {
        0 -> "今天 ${clock(ms)}"
        1 -> "昨天 ${clock(ms)}"
        else -> "${md.format(Date(ms))} ${clock(ms)}"
    }
}

fun dayDiff(ms: Long): Int {
    fun startOf(t: Long) = Calendar.getInstance().apply { timeInMillis = t; set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0) }.timeInMillis
    return ((startOf(System.currentTimeMillis()) - startOf(ms)) / 86_400_000L).toInt()
}

/** "10月8日 · 星期四" */
fun dateWeek(d: Date = Date()): String {
    val c = Calendar.getInstance().apply { time = d }
    return "${md.format(d)} · ${weekNames[c.get(Calendar.DAY_OF_WEEK) - 1]}"
}

/** "2026-10-08" → "10月8日 · 星期四"; anything else comes back unchanged. */
fun dayTitle(ymdText: String): String = runCatching { ymd.parse(ymdText)!! }.map { d ->
    when (dayDiff(d.time)) {
        0 -> "今天 · " + dateWeek(d).substringAfter(" · ")
        1 -> "昨天 · " + dateWeek(d).substringAfter(" · ")
        else -> dateWeek(d)
    }
}.getOrDefault(ymdText)

fun ago(ms: Long): String {
    val m = (System.currentTimeMillis() - ms) / 60_000
    return when {
        m < 1 -> "刚刚"
        m < 60 -> "$m 分钟前"
        m < 60 * 24 -> "${m / 60} 小时前"
        else -> "${m / 60 / 24} 天前"
    }
}

fun elapsed(ms: Long, now: Long = System.currentTimeMillis()): String {
    val s = ((now - ms) / 1000).coerceAtLeast(0)
    return when {
        s < 60 -> "${s} 秒"
        s < 3600 -> "${s / 60} 分钟"
        else -> "${s / 3600} 小时 ${s / 60 % 60} 分"
    }
}

@Composable
fun FooterNote(text: String) {
    Text(text, fontSize = Type.Label, color = Pal.Faint, modifier = Modifier.fillMaxWidth().padding(top = 18.dp, start = 4.dp))
}
