package com.xiamu.agent.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Matrix
import android.graphics.SurfaceTexture
import android.net.Uri
import android.view.Surface
import android.view.TextureView
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.outlined.Audiotrack
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Fullscreen
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material.icons.outlined.Movie
import androidx.compose.material.icons.outlined.PictureAsPdf
import androidx.compose.material.icons.rounded.Pause
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.xiamu.agent.FileOpening
import com.xiamu.agent.MediaPresentation
import com.xiamu.agent.ReplyMedia
import com.xiamu.agent.fileOpening
import com.xiamu.agent.formatFileSize
import com.xiamu.agent.mediaIntersectsViewport
import com.xiamu.agent.media.Images
import com.xiamu.agent.media.ReplyPlayer
import com.xiamu.agent.media.openSystemFile
import com.xiamu.agent.media.saveFile
import com.xiamu.agent.playbackTime
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun MediaViews(media: List<ReplyMedia>, active: Boolean = true) {
    if (media.isEmpty()) return
    Column(Modifier.fillMaxWidth().padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        media.forEachIndexed { index, item -> key(index, item) {
            when (item.presentation()) {
                MediaPresentation.Image -> MediaImage(item)
                MediaPresentation.Video, MediaPresentation.Audio -> MediaPlayback(item, active)
                MediaPresentation.File -> MediaFileCard(item)
            }
        } }
    }
}

private class FileActions(private val context: Context, val media: ReplyMedia, private val scope: CoroutineScope) {
    var busy by mutableStateOf(false)
        private set
    var error by mutableStateOf("")
        private set
    private fun run(block: suspend () -> Unit) {
        if (busy) return
        busy = true; error = ""
        scope.launch {
            try { block() }
            catch (e: CancellationException) { throw e }
            catch (_: Exception) { error = "文件不可用" }
            finally { busy = false }
        }
    }
    fun open() = run { openFile(context, media.path, media.name, media.mime) }
    fun external(share: Boolean = false) = run { openSystemFile(context, media.path, media.name, media.mime, share) }
    fun save(uri: Uri) = run { saveFile(context, media.path, uri) }
}

@Composable
private fun fileActions(media: ReplyMedia): FileActions {
    val context = ctx()
    val scope = rememberCoroutineScope()
    return remember(media, context, scope) { FileActions(context, media, scope) }
}

@Composable
private fun ActionsMenu(actions: FileActions) {
    var expanded by remember { mutableStateOf(false) }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(actions.media.mime)) { uri ->
        if (uri != null) actions.save(uri)
    }
    Box {
        MediaIcon(Icons.Outlined.MoreHoriz, "文件操作", !actions.busy) { expanded = true }
        DropdownMenu(expanded, onDismissRequest = { expanded = false }) {
            DropdownMenuItem(text = { Text("用其他应用打开") }, onClick = { expanded = false; actions.external() })
            DropdownMenuItem(text = { Text("分享") }, onClick = { expanded = false; actions.external(share = true) })
            DropdownMenuItem(text = { Text("另存为") }, onClick = { expanded = false; save.launch(actions.media.path.substringAfterLast('/')) })
        }
    }
}

@Composable
private fun ActionNote(actions: FileActions) {
    if (actions.busy || actions.error.isNotBlank()) Text(if (actions.busy) "正在读取文件…" else actions.error,
        fontSize = Type.Label, color = if (actions.busy) Pal.Muted else Pal.Danger, modifier = Modifier.padding(top = 4.dp))
}

@Composable
private fun MediaIcon(icon: ImageVector, label: String, enabled: Boolean = true, onClick: () -> Unit) {
    Box(Modifier.size(40.dp).clip(CircleShape).background(Pal.Quiet).tap(enabled, onClick), contentAlignment = Alignment.Center) {
        Icon(icon, label, tint = if (enabled) Pal.Ink else Pal.Faint, modifier = Modifier.size(22.dp))
    }
}

@Composable
private fun MediaFileCard(media: ReplyMedia, notice: String = "") {
    val actions = fileActions(media)
    val opening = fileOpening(media.path, media.mime)
    val icon = when {
        media.kind == "video" -> Icons.Outlined.Movie
        media.kind == "audio" -> Icons.Outlined.Audiotrack
        opening == FileOpening.Pdf -> Icons.Outlined.PictureAsPdf
        opening == FileOpening.Image -> Icons.Outlined.Image
        opening in setOf(FileOpening.Markdown, FileOpening.Web) -> Icons.Outlined.Description
        else -> Icons.AutoMirrored.Outlined.InsertDriveFile
    }
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Pal.Card)
        .testTag("media-file:${media.path}").tap(!actions.busy, actions::open).padding(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconTile(icon, Pal.Ink, 38.dp)
            Column(Modifier.padding(horizontal = 10.dp).weight(1f)) {
                Text(media.name, fontSize = Type.Secondary, fontWeight = FontWeight.Medium, color = Pal.Ink, maxLines = 2, overflow = TextOverflow.Ellipsis)
                val type = media.path.substringAfterLast('/').substringAfterLast('.', "").uppercase().ifBlank { "文件" }
                val how = if (opening == FileOpening.System) "用其他应用打开" else "App 内打开"
                Text("$type · ${formatFileSize(media.size)} · $how", fontSize = Type.Tiny, color = Pal.Muted, modifier = Modifier.padding(top = 3.dp))
            }
            ActionsMenu(actions)
        }
        if (notice.isNotBlank()) Text(notice, fontSize = Type.Label, color = Pal.Muted, modifier = Modifier.padding(top = 6.dp))
        ActionNote(actions)
    }
}

@Composable
private fun MediaImage(media: ReplyMedia) {
    var bitmap by remember(media) { mutableStateOf<Bitmap?>(Images.cached(media.path, 720)) }
    var failed by remember(media) { mutableStateOf(false) }
    LaunchedEffect(media) {
        if (bitmap == null) { bitmap = Images.load(media.path, 720); failed = bitmap == null }
    }
    if (failed) { MediaFileCard(media, "文件不可用"); return }
    val actions = fileActions(media)
    Column(Modifier.fillMaxWidth().testTag("media-image:${media.path}")) {
        val image = bitmap
        val ratio = if (image == null) 4f / 3f else image.width.toFloat() / image.height.coerceAtLeast(1)
        val width = if (ratio >= 1f) 240.dp else (240 * ratio).dp
        val height = if (ratio >= 1f) (240 / ratio).dp else 240.dp
        Box(Modifier.size(width, height).clip(RoundedCornerShape(14.dp)).background(Pal.Card)
            .tap(image != null) { Nav.open(Route.Image(media.path)) }, contentAlignment = Alignment.Center) {
            if (image == null) CircularProgressIndicator(Modifier.size(22.dp), color = Pal.Gold, strokeWidth = 2.dp)
            else Image(image.asImageBitmap(), media.name, Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
        }
        Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(media.name, fontSize = Type.Label, color = Pal.Muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            ActionsMenu(actions)
        }
        ActionNote(actions)
    }
}

@Composable
private fun MediaPlayback(media: ReplyMedia, active: Boolean) {
    val context = ctx()
    val view = LocalView.current
    var onScreen by remember(media) { mutableStateOf(false) }
    val canPlay = active && onScreen
    val player = remember(media, context) { ReplyPlayer(context, media) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(player, lifecycle, canPlay) {
        if (!canPlay) player.release()
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP || event == Lifecycle.Event.ON_DESTROY) player.release()
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); player.release() }
    }
    LaunchedEffect(player, canPlay, player.playing) {
        while (canPlay && player.playing) { delay(250); player.tick() }
    }
    Column(Modifier.fillMaxWidth().onGloballyPositioned { coordinates ->
        val bounds = coordinates.boundsInWindow()
        onScreen = bounds.width > 0 && mediaIntersectsViewport(bounds.top, bounds.bottom, view.height)
    }) {
        when (media.presentation(player.failed)) {
            MediaPresentation.File -> MediaFileCard(media, "此格式无法播放，可用其他应用打开")
            MediaPresentation.Video -> MediaVideo(media, player, canPlay)
            else -> MediaAudio(media, player, canPlay)
        }
    }
}

@Composable
private fun PlaybackButton(player: ReplyPlayer, active: Boolean) {
    if (player.loading) Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(Modifier.size(22.dp), color = Pal.Gold, strokeWidth = 2.dp)
    } else MediaIcon(if (player.playing) Icons.Rounded.Pause else Icons.Rounded.PlayArrow,
        if (player.playing) "暂停" else "播放", active, player::toggle)
}

@Composable
private fun SeekBar(player: ReplyPlayer, modifier: Modifier = Modifier) {
    var dragging by remember { mutableStateOf<Float?>(null) }
    Slider(value = dragging ?: player.position.toFloat().coerceAtMost(player.duration.toFloat()),
        onValueChange = { dragging = it }, onValueChangeFinished = { dragging?.let { player.seek(it.toInt()) }; dragging = null },
        valueRange = 0f..player.duration.coerceAtLeast(1).toFloat(), enabled = player.duration > 0 && !player.loading,
        colors = SliderDefaults.colors(thumbColor = Pal.Ink, activeTrackColor = Pal.Ink, inactiveTrackColor = Pal.Line), modifier = modifier)
}

@Composable
private fun MediaAudio(media: ReplyMedia, player: ReplyPlayer, active: Boolean) {
    val actions = fileActions(media)
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Pal.Card)
        .testTag("media-audio:${media.path}").padding(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PlaybackButton(player, active)
            Column(Modifier.weight(1f)) {
                Text(media.name, fontSize = Type.Secondary, fontWeight = FontWeight.Medium, color = Pal.Ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    SeekBar(player, Modifier.weight(1f).height(30.dp))
                    Text("${playbackTime(player.position)} / ${playbackTime(player.duration)}", fontSize = Type.Tiny, color = Pal.Muted)
                }
            }
            ActionsMenu(actions)
        }
        ActionNote(actions)
    }
}

@Composable
private fun MediaVideo(media: ReplyMedia, player: ReplyPlayer, active: Boolean) {
    var fullscreen by remember(media) { mutableStateOf(false) }
    LaunchedEffect(active) { if (!active) fullscreen = false }
    val actions = fileActions(media)
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Pal.Card).testTag("media-video:${media.path}")) {
        Box(Modifier.fillMaxWidth().aspectRatio(player.aspectRatio.coerceIn(.5f, 3f)).background(Pal.Background), contentAlignment = Alignment.Center) {
            if (!fullscreen) VideoSurface(player, Modifier.fillMaxSize())
            if (!player.prepared || fullscreen) {
                if (player.loading) CircularProgressIndicator(Modifier.size(26.dp), color = Pal.Gold, strokeWidth = 2.dp)
                else if (fullscreen) Text("全屏播放中", fontSize = Type.Label, color = Pal.Muted)
                else Icon(Icons.Outlined.Movie, media.name, tint = Pal.Muted, modifier = Modifier.size(48.dp))
            }
        }
        Column(Modifier.padding(10.dp)) {
            VideoControls(player, active)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(media.name, fontSize = Type.Secondary, color = Pal.Ink, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                MediaIcon(Icons.Outlined.Fullscreen, "全屏", active) { fullscreen = true }
                ActionsMenu(actions)
            }
            ActionNote(actions)
        }
    }
    if (fullscreen) Dialog(onDismissRequest = { fullscreen = false },
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Column(Modifier.fillMaxSize().background(Pal.Background).statusBarsPadding().navigationBarsPadding().padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(media.name, fontSize = Type.Body, color = Pal.Ink, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                MediaIcon(Icons.Outlined.Close, "退出全屏") { fullscreen = false }
            }
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                VideoSurface(player, Modifier.fillMaxSize())
                if (!player.prepared) {
                    if (player.loading) CircularProgressIndicator(Modifier.size(26.dp), color = Pal.Gold, strokeWidth = 2.dp)
                    else Icon(Icons.Outlined.Movie, null, tint = Pal.Muted, modifier = Modifier.size(64.dp))
                }
            }
            VideoControls(player, active)
        }
    }
}

@Composable
private fun VideoControls(player: ReplyPlayer, active: Boolean) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        PlaybackButton(player, active)
        SeekBar(player, Modifier.weight(1f))
        Text("${playbackTime(player.position)} / ${playbackTime(player.duration)}", fontSize = Type.Tiny, color = Pal.Muted)
    }
}

@Composable
private fun VideoSurface(player: ReplyPlayer, modifier: Modifier) {
    AndroidView(modifier = modifier, factory = { PlayerTexture(it, player) }, onRelease = { it.releaseSurface() },
        update = { it.keepScreenOn = player.playing; it.fit(player.aspectRatio) })
}

private class PlayerTexture(context: Context, private val player: ReplyPlayer) : TextureView(context), TextureView.SurfaceTextureListener {
    private var surface: Surface? = null
    private var ratio = 16f / 9f
    init { isOpaque = false; surfaceTextureListener = this }
    fun fit(nextRatio: Float = ratio) {
        ratio = nextRatio
        if (width == 0 || height == 0) return
        val boxRatio = width.toFloat() / height
        val sx = if (ratio < boxRatio) ratio / boxRatio else 1f
        val sy = if (ratio > boxRatio) boxRatio / ratio else 1f
        setTransform(Matrix().apply { setScale(sx, sy, width / 2f, height / 2f) })
    }
    override fun onSurfaceTextureAvailable(texture: SurfaceTexture, width: Int, height: Int) {
        surface = Surface(texture).also(player::attachSurface)
        fit()
    }
    override fun onSurfaceTextureSizeChanged(texture: SurfaceTexture, width: Int, height: Int) { fit() }
    override fun onSurfaceTextureDestroyed(texture: SurfaceTexture): Boolean { releaseSurface(); return true }
    override fun onSurfaceTextureUpdated(texture: SurfaceTexture) = Unit
    fun releaseSurface() {
        surface?.let { player.detachSurface(it); it.release() }
        surface = null; keepScreenOn = false
    }
}
