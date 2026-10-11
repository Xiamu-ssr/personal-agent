package com.xiamu.agent.ui

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.os.Message
import android.view.MotionEvent
import android.view.ViewGroup
import android.webkit.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.xiamu.agent.BriefNavigation
import com.xiamu.agent.HtmlBriefCard
import org.json.JSONArray
import java.io.ByteArrayInputStream
import java.util.UUID

/** A separate offline origin per card. The response body is the server HTML, unchanged. */
@SuppressLint("SetJavaScriptEnabled")
internal class OfflineBriefWebView(context: Context) : WebView(context) {
    @Volatile private var documentUrl = ""
    @Volatile private var documentHtml = ""
    private var onPrompt: ((String) -> Unit)? = null
    private var onHeight: ((Float) -> Unit)? = null
    private var loaded = false
    var active = false
        private set
    private var previousY = 0f
    private var released = false
    private val measure = Runnable {
        if (active && !released) evaluateJavascript("[document.documentElement.scrollHeight, window.innerWidth]") { value ->
            if (active && !released) runCatching {
                val dimensions = JSONArray(value)
                val cssHeight = dimensions.getDouble(0)
                val cssWidth = dimensions.getDouble(1)
                if (cssWidth > 0 && cssHeight > 0 && width > 0) onHeight?.invoke((cssHeight * width / cssWidth / resources.displayMetrics.density).toFloat())
            }
        }
    }

    init {
        setBackgroundColor(android.graphics.Color.TRANSPARENT)
        isHorizontalScrollBarEnabled = false
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = false
            allowFileAccess = false
            allowContentAccess = false
            blockNetworkLoads = true
            blockNetworkImage = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            cacheMode = WebSettings.LOAD_NO_CACHE
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(true)
            setSupportZoom(false)
            useWideViewPort = true
            loadWithOverviewMode = true
            // This origin only has in-memory content; never perform online reputation lookups.
            safeBrowsingEnabled = false
        }
        webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                if (request.isForMainFrame && request.method == "GET" && request.url.toString() == documentUrl) {
                    return WebResourceResponse("text/html", "UTF-8", 200, "OK", mapOf(
                        "Content-Security-Policy" to "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
                        "Cache-Control" to "no-store",
                    ), ByteArrayInputStream(documentHtml.toByteArray(Charsets.UTF_8)))
                }
                if (BriefNavigation.inlineResource(request.url.toString())) return null
                return WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(byteArrayOf()))
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (active) BriefNavigation.prompt(request.url.toString(), request.isForMainFrame)?.let { onPrompt?.invoke(it) }
                return true
            }
            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) { removeCallbacks(measure) }
            override fun onPageFinished(view: WebView, url: String?) {
                if (active && url == documentUrl) { loaded = true; postOnAnimation(measure); postDelayed(measure, 250) }
            }
        }
        webChromeClient = object : WebChromeClient() {
            override fun onCreateWindow(view: WebView, dialog: Boolean, userGesture: Boolean, resultMsg: Message) = false
            override fun onPermissionRequest(request: PermissionRequest) { request.deny() }
            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) { callback.invoke(origin, false, false) }
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean { callback.onReceiveValue(null); return true }
            override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult): Boolean { result.cancel(); return true }
            override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean { result.cancel(); return true }
            override fun onJsPrompt(view: WebView, url: String, message: String, defaultValue: String?, result: JsPromptResult): Boolean { result.cancel(); return true }
        }
        setDownloadListener { _, _, _, _, _ -> }
    }

    fun bind(html: String, prompt: (String) -> Unit, height: (Float) -> Unit) {
        val resuming = !active
        active = true; onPrompt = prompt; onHeight = height; onResume()
        if (documentHtml != html) {
            stopLoading(); removeCallbacks(measure); loaded = false
            documentHtml = html
            documentUrl = "https://card-${UUID.randomUUID()}.invalid/brief"
            scrollTo(0,0)
            // The exact document is served locally, including the CSP response header.
            loadUrl(documentUrl)
        } else if (resuming) {
            if (loaded) postOnAnimation(measure) else loadUrl(documentUrl)
        }
    }

    fun deactivate() { active = false; removeCallbacks(measure); stopLoading(); onPause(); onPrompt = null; onHeight = null }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> { previousY = event.y; parent?.requestDisallowInterceptTouchEvent(canScrollVertically(-1) || canScrollVertically(1)) }
            MotionEvent.ACTION_MOVE -> {
                val direction = if (event.y > previousY) -1 else 1
                parent?.requestDisallowInterceptTouchEvent(canScrollVertically(direction))
                previousY = event.y
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> parent?.requestDisallowInterceptTouchEvent(false)
        }
        return super.onTouchEvent(event)
    }

    fun release() {
        if (released) return
        released = true; deactivate()
        (parent as? ViewGroup)?.removeView(this)
        destroy()
    }
}

/** Visible items load HTML; lazy-list deactivation pauses views for reuse, final release destroys them. */
@Composable
internal fun HtmlBriefCardView(card: HtmlBriefCard, cardKey: String, visible: Boolean, savedHeight: Dp?, onMeasured: (Dp) -> Unit) {
    val c = ctx()
    val maximum = LocalConfiguration.current.screenHeightDp.dp * .75f
    val density = LocalDensity.current
    var height by remember(card.html) { mutableStateOf<Dp?>(null) }
    var measured by remember(card.html) { mutableStateOf(false) }
    var view by remember { mutableStateOf<OfflineBriefWebView?>(null) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, view) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) view?.onPause()
            if (event == Lifecycle.Event.ON_START) view?.onResume()
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    val displayHeight = (height ?: savedHeight ?: 180.dp).coerceAtMost(maximum)
    Box(Modifier.fillMaxWidth().padding(bottom = 16.dp).height(displayHeight).card(radius = 24.dp).clip(RoundedCornerShape(24.dp)).testTag("brief-card:$cardKey")) {
        if (visible) {
            AndroidView(
                modifier = Modifier.fillMaxWidth().height(if (measured) displayHeight else 1.dp),
                factory = { context -> OfflineBriefWebView(context) },
                update = { web ->
                    view = web
                    web.bind(card.html,
                    prompt = { prompt -> Draft.send(c, prompt, includeDraft = false) },
                    height = { measuredHeight ->
                        val next = with(density) { measuredHeight.dp.roundToPx().toDp() }.coerceIn(1.dp, maximum)
                        height = next
                        measured = true
                        onMeasured(next)
                    },
                    )
                },
                onReset = { it.deactivate(); view = null; measured = false },
                onRelease = { it.release(); view = null; measured = false },
            )
        } else Spacer(Modifier.fillMaxSize())
    }
}
