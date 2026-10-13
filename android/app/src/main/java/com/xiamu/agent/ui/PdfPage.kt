package com.xiamu.agent.ui

import android.graphics.Bitmap
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import com.xiamu.agent.media.cacheFile
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

private data class PdfImage(val bitmap: Bitmap, val pages: Int)

private suspend fun renderPdf(file: File, index: Int): PdfImage = withContext(Dispatchers.IO) {
    ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
        PdfRenderer(descriptor).use { renderer ->
            require(renderer.pageCount > 0)
            renderer.openPage(index.coerceIn(0, renderer.pageCount - 1)).use { page ->
                val scale = minOf(2f, 2048f / maxOf(page.width, page.height).coerceAtLeast(1))
                val bitmap = Bitmap.createBitmap((page.width * scale).toInt().coerceAtLeast(1),
                    (page.height * scale).toInt().coerceAtLeast(1), Bitmap.Config.ARGB_8888)
                try {
                    bitmap.eraseColor(android.graphics.Color.WHITE)
                    page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                    PdfImage(bitmap, renderer.pageCount)
                } catch (e: Exception) { bitmap.recycle(); throw e }
            }
        }
    }
}

@Composable
internal fun PdfPage(route: Route.Pdf) {
    val context = ctx()
    var file by remember(route.path) { mutableStateOf<File?>(null) }
    var page by remember(route.path) { mutableIntStateOf(0) }
    var image by remember(route.path) { mutableStateOf<PdfImage?>(null) }
    var pages by remember(route.path) { mutableIntStateOf(0) }
    var failed by remember(route.path) { mutableStateOf(false) }
    LaunchedEffect(route.path) {
        try { file = cacheFile(context, route.path) }
        catch (e: CancellationException) { throw e }
        catch (_: Exception) { failed = true }
    }
    LaunchedEffect(file, page) {
        val source = file ?: return@LaunchedEffect
        image = null; failed = false
        try { image = renderPdf(source, page).also { pages = it.pages } }
        catch (e: CancellationException) { throw e }
        catch (_: Exception) { failed = true }
    }
    var scale by remember(page) { mutableFloatStateOf(1f) }
    var dx by remember(page) { mutableFloatStateOf(0f) }
    var dy by remember(page) { mutableFloatStateOf(0f) }
    val transform = rememberTransformableState { zoom, pan, _ ->
        scale = (scale * zoom).coerceIn(1f, 5f); dx += pan.x; dy += pan.y
    }
    Screen {
        Column(Modifier.fillMaxSize().navigationBarsPadding()) {
            SubHeader(route.title, Nav::back)
            Box(Modifier.weight(1f).fillMaxWidth().background(Pal.Card), contentAlignment = Alignment.Center) {
                val current = image
                when {
                    failed -> Text("文件不可用", fontSize = Type.Body, color = Pal.Muted)
                    current == null -> Loading()
                    else -> Image(current.bitmap.asImageBitmap(), "第 ${page + 1} 页", contentScale = ContentScale.Fit,
                        modifier = Modifier.fillMaxSize().transformable(transform).graphicsLayer {
                            scaleX = scale; scaleY = scale; translationX = dx; translationY = dy
                        })
                }
            }
            Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween) {
                Text("上一页", fontSize = Type.Body, color = if (page > 0) Pal.Link else Pal.Faint,
                    modifier = Modifier.tap(page > 0 && image != null) { page-- }.padding(10.dp))
                Text(if (pages == 0) "PDF" else "${page + 1} / $pages", fontSize = Type.Label, color = Pal.Muted)
                Text("下一页", fontSize = Type.Body, color = if (page + 1 < pages) Pal.Link else Pal.Faint,
                    modifier = Modifier.tap(page + 1 < pages && image != null) { page++ }.padding(10.dp))
            }
        }
    }
}
