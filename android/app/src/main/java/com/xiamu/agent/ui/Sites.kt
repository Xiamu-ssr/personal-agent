package com.xiamu.agent.ui

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.BitmapFactory
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.content.ContextWrapper
import android.webkit.*
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xiamu.agent.Api
import com.xiamu.agent.Prefs
import kotlinx.coroutines.*
import java.io.File
import java.net.URI
import java.net.URLEncoder
import kotlin.coroutines.resume

data class SiteMetadata(val title: String, val description: String)

internal fun siteMetadata(html: String, fallback: String): SiteMetadata {
    fun plain(s: String) = android.text.Html.fromHtml(s, android.text.Html.FROM_HTML_MODE_LEGACY).toString().trim()
    val title = Regex("<title[^>]*>([\\s\\S]*?)</title>", RegexOption.IGNORE_CASE).find(html)?.groupValues?.get(1)?.let(::plain)?.ifBlank { null } ?: fallback
    val meta = Regex("<meta\\s[^>]*>", RegexOption.IGNORE_CASE).findAll(html).firstNotNullOfOrNull { tag ->
        val attrs = Regex("([\\w-]+)\\s*=\\s*([\"'])(.*?)\\2", RegexOption.IGNORE_CASE).findAll(tag.value)
            .associate { it.groupValues[1].lowercase() to it.groupValues[3] }
        if(attrs["name"].equals("description", true)) attrs["content"]?.let(::plain) else null
    }.orEmpty()
    return SiteMetadata(title, meta)
}

@Composable
fun SiteCard(entry: Api.Entry, modifier: Modifier = Modifier) {
    val c = ctx()
    val path = "data/sites/${entry.name}/index.html"
    val key = "${Prefs.server}:$path:${entry.mtime}"
    val (metadata, _) = load("site-meta:$key") { siteMetadata(Api.readFile(path),entry.name) }
    val (bitmap, _) = load("site-image:$key") {
        val file = File(c.cacheDir, "site-previews/${cacheKey(key)}.png")
        val cached = withContext(Dispatchers.IO) { if(file.exists()) BitmapFactory.decodeFile(file.path) else null }
        val bitmap = cached ?: captureSite(c, path)?.also { shot -> withContext(Dispatchers.IO) {
            file.parentFile?.mkdirs(); file.outputStream().use { shot.compress(Bitmap.CompressFormat.PNG, 100, it) }
        } }
        bitmap
    }
    val title = metadata?.title ?: entry.name
    Column(modifier.card(radius=22.dp).clip(RoundedCornerShape(22.dp)).tap { Nav.open(Route.Web(title, path)) }) {
        Box(Modifier.fillMaxWidth().aspectRatio(1.2f).background(Brush.linearGradient(listOf(Pal.Link,Pal.Link))), contentAlignment=Alignment.Center) {
            if(bitmap != null) Image(bitmap.asImageBitmap(), null, Modifier.fillMaxSize().testTag("site-thumbnail:$path"), contentScale=ContentScale.Crop, alignment=Alignment.TopCenter)
            else Text(title.take(1), fontSize = Type.Large, color=Pal.Card, fontWeight=FontWeight.SemiBold)
        }
        Column(Modifier.padding(14.dp), verticalArrangement=Arrangement.spacedBy(6.dp)) {
            Text(title, fontSize = Type.Body, fontWeight=FontWeight.SemiBold, color=Pal.Ink, maxLines=1, overflow=TextOverflow.Ellipsis)
            Text(metadata?.description.orEmpty(), fontSize = Type.Tiny, color=Pal.Muted, maxLines=1, overflow=TextOverflow.Ellipsis)
            Text("更新于 ${whenLabel(entry.mtime)}", fontSize = Type.Tiny, color=Pal.Faint)
        }
    }
}

/** Hidden WebView behind the opaque app canvas, with a phone viewport; destroyed after capture. */
@SuppressLint("SetJavaScriptEnabled")
internal suspend fun captureSite(context: android.content.Context, path: String): Bitmap? = withContext(Dispatchers.Main) {
    withTimeoutOrNull(12_000) {
        suspendCancellableCoroutine { cont ->
            val metrics = context.resources.displayMetrics
            val width = metrics.widthPixels
            val height = metrics.heightPixels
            val web = WebView(context)
            var owner: android.content.Context=context
            while(owner is ContextWrapper && owner !is Activity) owner=owner.baseContext
            val parent=(owner as? Activity)?.window?.decorView as? ViewGroup
            val handler=Handler(Looper.getMainLooper())
            var finished = false
            fun release() { web.stopLoading(); parent?.removeView(web); web.destroy() }
            fun finish(bitmap: Bitmap?) {
                if(finished) return
                finished = true
                if(cont.isActive) cont.resume(bitmap)
                release()
            }
            cont.invokeOnCancellation { handler.post { if(!finished) { finished=true; release() } } }
            web.settings.apply {
                javaScriptEnabled = true; domStorageEnabled = true; useWideViewPort = true; loadWithOverviewMode = true
                allowFileAccess = false; allowContentAccess = false
            }
            web.setLayerType(View.LAYER_TYPE_SOFTWARE, null)
            // Behind the opaque Compose canvas. Keeping a real viewport lets Chromium finish
            // layout; translating outside the window can pause its renderer indefinitely.
            parent?.addView(web,0,FrameLayout.LayoutParams(width,height))
            web.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY))
            web.layout(0,0,width,height)
            val base = URI(Prefs.server)
            web.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = request.url.host != base.host || request.url.port != base.port
                override fun onPageFinished(view: WebView, url: String?) {
                    handler.postDelayed({ if(!finished && cont.isActive) {
                        val bitmap = runCatching { Bitmap.createBitmap(width,height,Bitmap.Config.ARGB_8888).also { view.draw(Canvas(it)) } }.getOrNull()
                        finish(bitmap)
                    } }, 600)
                }
                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) { if(request.isForMainFrame) finish(null) }
                override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) { if(request.isForMainFrame) finish(null) }
            }
            val secure = if(base.scheme == "https") "; Secure" else ""
            CookieManager.getInstance().setCookie("${base.scheme}://${base.authority}",
                "pa_token=${URLEncoder.encode(Prefs.token,"UTF-8")}; Path=${base.path.ifBlank { "/" }}; HttpOnly; SameSite=Lax$secure") {
                if(!finished && cont.isActive) web.loadUrl(Api.fileUrl(path), Api.authHeader)
            }
        }
    }
}
