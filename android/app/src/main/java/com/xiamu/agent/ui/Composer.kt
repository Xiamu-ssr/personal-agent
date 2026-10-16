package com.xiamu.agent.ui

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.CalendarToday
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Keyboard
import androidx.compose.material.icons.outlined.KeyboardVoice
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.PersonOutline
import androidx.compose.material.icons.outlined.PhotoCamera
import androidx.compose.material.icons.outlined.UploadFile
import androidx.compose.material.icons.rounded.ArrowUpward
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.xiamu.agent.Api
import com.xiamu.agent.Attachment
import com.xiamu.agent.Chat
import com.xiamu.agent.AttachmentDraft
import com.xiamu.agent.FeedPost
import com.xiamu.agent.FeedQuote
import com.xiamu.agent.OutgoingMessage
import com.xiamu.agent.SendAttempt
import org.json.JSONObject
import org.json.JSONArray
import com.xiamu.agent.media.Recorder
import com.xiamu.agent.media.compressImage
import com.xiamu.agent.media.displayName
import com.xiamu.agent.media.readBytes
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Something picked in the composer, uploaded only when the message is sent. */
data class Picked(val id: Long, val name: String, val kind: String, val uri: Uri? = null, val file: File? = null)

/** The draft is shared by every tab's input box. */
open class MessageDraft(private val taskId: String? = null,private val sendMessage: (suspend (String,List<Attachment>,String) -> Boolean)? = null) {
    val text = mutableStateOf("")
    private val selection = mutableStateOf(AttachmentDraft<Picked>())
    val picked get() = selection.value.items
    val quote = mutableStateOf<FeedQuote?>(null)
    val focusVersion = mutableIntStateOf(0)
    val sending = mutableStateOf(false)
    val voiceMode = mutableStateOf(false)
    val note = mutableStateOf("")
    val sentVersion = mutableIntStateOf(0)

    private val MAX_UPLOAD = 20 * 1024 * 1024
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var transfer: Job? = null
    private val uploaded = mutableMapOf<Long, Attachment>()
    private val attempt = SendAttempt()

    fun add(p: Picked) { selection.value = selection.value.add(listOf(p)) }
    fun discuss(post: FeedPost) {
        quote.value = FeedQuote.from(post)
        voiceMode.value = false
        focusVersion.intValue++
        Nav.home(0)
    }

    private suspend fun upload(ctx: Context, p: Picked): Attachment {
        uploaded[p.id]?.let { return it }
        val (name, bytes) = when {
            p.kind == "image" && p.uri != null -> p.name.substringBeforeLast('.') + ".jpg" to compressImage(ctx, p.uri)
            p.file != null -> p.name to withContext(Dispatchers.IO) { p.file.readBytes() }
            else -> p.name to readBytes(ctx, p.uri!!)
        }
        if (bytes.size > MAX_UPLOAD) throw IllegalStateException("「${p.name}」太大了，上限 20MB")
        val j = Api.upload(name, bytes)
        return Attachment(j.getString("path"), j.optString("name", name), p.kind).also { uploaded[p.id] = it }
    }

    /** Wait for the cloud receipt; failed uploads and sends retain the same selection and UUID. */
    fun send(ctx: Context, text: String = this.text.value.trim(), extra: List<Picked> = emptyList(), includeDraft: Boolean = true, onDone: () -> Unit = {}): Boolean {
        val discussion = if(includeDraft) quote.value else null
        // Feed feedback accepts text. An existing attachment draft stays intact while discussing.
        val files = (if (includeDraft && discussion==null) picked.toList() else emptyList()) + extra
        if (sending.value || (text.isBlank() && files.isEmpty() && discussion==null)) { onDone(); return false }
        val key=JSONObject().put("text",text).put("files",JSONArray(files.map { it.id })).put("quote",discussion?.path).toString()
        val clientId=attempt.begin(key) ?: return false
        if (taskId == null && sendMessage == null) Nav.home(0)
        sending.value = true
        transfer = scope.launch {
            try {
                val atts = files.map { upload(ctx, it) }
                val accepted = if(sendMessage!=null) sendMessage.invoke(text,atts,clientId) else if (taskId == null) Chat.send(OutgoingMessage(text,atts,clientId,discussion)) else { Api.sendToActivity(taskId, text, atts,clientId); true }
                if (accepted) {
                    attempt.accepted()
                    sentVersion.intValue++
                    if (includeDraft && text == this@MessageDraft.text.value.trim()) this@MessageDraft.text.value = ""
                    if(discussion!=null && quote.value==discussion) quote.value=null
                    files.forEach(::remove)
                } else {
                    attempt.failed()
                    extra.forEach(::add)
                    say("连接断开了，附件已保留，请重试")
                }
            } catch (e: CancellationException) {
                attempt.failed()
                throw e
            } catch (e: Exception) {
                // The cloud caches definitive HTTP errors too. A new submission may retry them.
                attempt.failed(retryable=e !is Api.ApiError || e.code==0)
                extra.forEach(::add)
                say("没发出去：${e.message}")
            } finally {
                sending.value = false
                onDone()
            }
        }
        return true
    }

    fun remove(p: Picked) {
        selection.value = selection.value.remove(listOf(p))
        uploaded.remove(p.id)
        p.file?.delete()
    }

    fun reset() {
        transfer?.cancel()
        picked.toList().forEach(::remove)
        uploaded.clear()
        attempt.reset()
        quote.value=null
        sentVersion.intValue = 0
        text.value = ""; note.value = ""; voiceMode.value = false; sending.value = false
    }

    fun say(text: String) {
        note.value = text
    }
}

object Draft : MessageDraft()

enum class VoiceMode { Hold, Note }

/** Recording state shared by the composer and the overlay drawn above everything. */
object Voice {
    val mode = mutableStateOf<VoiceMode?>(null)
    val cancelArmed = mutableStateOf(false)
    val elapsed = mutableLongStateOf(0)
    val levels = mutableStateListOf<Float>()
    val busy = mutableStateOf("")
    private var recorder: Recorder? = null
    private var draft: MessageDraft = Draft
    private var transcription: Job? = null

    fun start(ctx: Context, m: VoiceMode, target: MessageDraft = Draft): Boolean {
        draft = target
        if (mode.value != null || busy.value.isNotBlank()) return false
        val r = recorder ?: Recorder(ctx.applicationContext).also { recorder = it }
        if (!r.start()) {
            draft.say("麦克风打不开")
            return false
        }
        levels.clear(); elapsed.longValue = 0; cancelArmed.value = false
        mode.value = m
        return true
    }

    fun tick() {
        val r = recorder ?: return
        elapsed.longValue = r.elapsedMs
        levels.add(r.level)
        if (levels.size > 36) levels.removeAt(0)
    }

    fun stop(): File? = recorder?.stop().also { mode.value = null }
    fun cancel() {
        recorder?.cancel()
        transcription?.cancel()
        busy.value = ""
        mode.value = null
    }

    /** Released the hold-to-talk button: transcribe, then send the text as a message. */
    fun finishHold(ctx: Context, scope: CoroutineScope, cancel: Boolean) {
        if (cancel) return cancel()
        val f = stop() ?: return draft.say("说话时间太短")
        busy.value = "正在转文字…"
        transcription = scope.launch {
            try {
                val text = Api.transcribe(f)
                if (text.isBlank()) draft.say("没听清，再说一次")
                else if (!draft.send(ctx, text, includeDraft = false)) draft.text.value = listOf(draft.text.value, text).filter { it.isNotBlank() }.joinToString("\n")
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                draft.say("转文字失败：${e.message}")
            } finally {
                f.delete()
                busy.value = ""
            }
        }
    }

    /** Voice note: upload the recording as a voice attachment and send right away; the cloud transcribes it. */
    fun finishNote(ctx: Context) {
        val f = stop() ?: return draft.say("录音太短")
        val name = "语音笔记-" + SimpleDateFormat("HHmmss", Locale.CHINA).format(Date()) + ".aac"
        busy.value = "正在发送语音笔记…"
        draft.send(ctx, "", listOf(Picked(System.nanoTime(), name, "voice", file = f)), includeDraft = false) { busy.value = "" }
    }
}

private fun hasPerm(ctx: Context, p: String) = ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun Dock(modifier: Modifier = Modifier) {
    val ime=WindowInsets.isImeVisible
    Column(modifier.fillMaxWidth(), horizontalAlignment=Alignment.CenterHorizontally) {
        if(Nav.tab.intValue==0) Box(Modifier.fillMaxWidth().padding(bottom=10.dp)) { MessageComposer(Draft,"消息") }
        if(!ime) MainNavBar()
    }
}

/** Identical input/attachments/actions in the main thread and every task. */
@Composable
fun MessageComposer(draft: MessageDraft, hint: String) {
    val note = draft.note.value
    LaunchedEffect(note) { if (note.isNotBlank()) { delay(3500); draft.note.value = "" } }
    Column(Modifier.fillMaxWidth()) {
        AnimatedVisibility(note.isNotBlank()) {
            Text(note, fontSize = Type.Secondary, color = Pal.Danger, modifier = Modifier.padding(start = 12.dp, bottom = 8.dp))
        }
        draft.quote.value?.let { quote ->
            FeedQuoteCard(quote,Modifier.fillMaxWidth().padding(bottom=8.dp),onCancel={if(!draft.sending.value) draft.quote.value=null})
            if(draft.picked.isNotEmpty()) Text("附件保留在草稿中",style=Type.body(11),color=Pal.Muted,modifier=Modifier.padding(start=12.dp,bottom=6.dp))
        }
        if (draft.quote.value==null && draft.picked.isNotEmpty()) PickedRow(draft)
        InputPill(draft, hint)
    }
}

@Composable
private fun PickedRow(draft: MessageDraft) {
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(top=4.dp,bottom = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        draft.picked.forEach { p ->
            Box {
                Row(
                    Modifier.height(64.dp).then(if(p.kind=="image") Modifier.width(64.dp) else Modifier.widthIn(min=156.dp,max=204.dp))
                        .clip(RoundedCornerShape(14.dp)).background(Pal.Card).border(.5.dp,Pal.Line,RoundedCornerShape(14.dp))
                        .padding(end = if(p.kind=="image") 0.dp else 24.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (p.kind == "image" && (p.uri != null || p.file != null)) LocalThumb(p.uri ?: Uri.fromFile(p.file))
                    else Box(Modifier.size(46.dp), contentAlignment = Alignment.Center) {
                        Icon(Icons.AutoMirrored.Outlined.InsertDriveFile, null, tint = Pal.Ink, modifier = Modifier.size(22.dp))
                    }
                    if (p.kind != "image") Text(p.name, fontSize = Type.Label, color = Pal.Ink, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 130.dp))
                }
                if (!draft.sending.value) {
                    Box(
                        Modifier.align(Alignment.TopEnd).size(26.dp).padding(3.dp).clip(CircleShape).background(Pal.Ink)
                            .tap { draft.remove(p) },
                        contentAlignment = Alignment.Center,
                    ) { Icon(Icons.Outlined.Close, "移除 ${p.name}", tint = Pal.Background, modifier = Modifier.size(13.dp)) }
                }
            }
        }
    }
}

@Composable
private fun LocalThumb(uri: Uri) {
    val c = ctx()
    var bmp by remember(uri) { mutableStateOf<Bitmap?>(null) }
    LaunchedEffect(uri) {
        bmp = withContext(Dispatchers.IO) {
            runCatching {
                ImageDecoder.decodeBitmap(ImageDecoder.createSource(c.contentResolver, uri)) { d, info, _ ->
                    val s = 160f / maxOf(info.size.width, info.size.height)
                    if (s < 1) d.setTargetSize((info.size.width * s).toInt().coerceAtLeast(1), (info.size.height * s).toInt().coerceAtLeast(1))
                }
            }.getOrNull()
        }
    }
    Box(Modifier.size(64.dp).background(Pal.Background)) {
        bmp?.let { Image(it.asImageBitmap(), null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize()) }
    }
}

@Composable
private fun InputPill(draft: MessageDraft, hint: String) {
    val c = ctx()
    val focus=remember { FocusRequester() }
    val keyboard=LocalSoftwareKeyboardController.current
    LaunchedEffect(draft.focusVersion.intValue) {
        if(draft.focusVersion.intValue>0) { focus.requestFocus(); keyboard?.show() }
    }
    var text by draft.text
    val sending = draft.sending.value
    var menu by remember { mutableStateOf(false) }
    var cameraPath by rememberSaveable { mutableStateOf<String?>(null) }

    fun add(uri: Uri, kind: String) {
        draft.add(Picked(System.nanoTime(), displayName(c, uri), kind, uri = uri))
    }

    val pickFile = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris -> uris.forEach { add(it, "file") } }
    val pickImages = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(9)) { uris -> uris.forEach { add(it, "image") } }
    val takePhoto = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val f = cameraPath?.let(::File)
        if (ok && f != null) draft.add(Picked(System.nanoTime(), f.name, "image", uri = Uri.fromFile(f), file = f))
        else f?.delete()
        cameraPath = null
    }
    fun launchCamera() {
        val f = File(c.cacheDir, "camera/IMG_${System.currentTimeMillis()}.jpg").apply { parentFile?.mkdirs() }
        cameraPath = f.absolutePath
        runCatching { takePhoto.launch(FileProvider.getUriForFile(c, "${c.packageName}.files", f)) }
            .onFailure { f.delete(); cameraPath = null; draft.say("手机上没有可用的相机") }
    }
    val cameraPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok) launchCamera() else draft.say("没有相机权限，去系统设置里打开")
    }
    var afterMic by remember { mutableStateOf<(() -> Unit)?>(null) }
    val micPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok) afterMic?.invoke() else draft.say("没有麦克风权限，去系统设置里打开")
        afterMic = null
    }
    fun withMic(block: () -> Unit) {
        if (hasPerm(c, Manifest.permission.RECORD_AUDIO)) block() else {
            afterMic = block
            micPerm.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp,max=144.dp).clip(RoundedCornerShape(24.dp)).background(Pal.Card).padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box {
            PillIcon(Icons.Outlined.Add, "添加", enabled = !sending && draft.quote.value==null) { menu = true }
            DropdownMenu(
                expanded = menu, onDismissRequest = { menu = false },
                shape = RoundedCornerShape(18.dp), containerColor = Pal.Card, shadowElevation = 6.dp,
            ) {
                MenuItem(Icons.Outlined.UploadFile, "上传文件") { menu = false; pickFile.launch(arrayOf("*/*")) }
                MenuItem(Icons.Outlined.PhotoCamera, "拍照") {
                    menu = false
                    if (hasPerm(c, Manifest.permission.CAMERA)) launchCamera() else cameraPerm.launch(Manifest.permission.CAMERA)
                }
                MenuItem(Icons.Outlined.Image, "图片") {
                    menu = false
                    pickImages.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                }
                MenuItem(Icons.Outlined.KeyboardVoice, "录制语音笔记") { menu = false; withMic { Voice.start(c, VoiceMode.Note, draft) } }
            }
        }
        if (draft.voiceMode.value) {
            HoldToTalk(draft, Modifier.weight(1f).padding(vertical = 5.dp))
        } else {
            BasicTextField(
                value = text, onValueChange = { text = it }, maxLines = 4,
                textStyle = TextStyle(fontSize = Type.Body, lineHeight = Type.BodyLine, color = Pal.Ink),
                cursorBrush = SolidColor(Pal.Gold),
                modifier = Modifier.weight(1f).padding(horizontal = 4.dp, vertical = 12.dp).focusRequester(focus).testTag("composer"),
                decorationBox = { inner ->
                    Box {
                        if (text.isEmpty()) Text(hint, fontSize = Type.Body, color = Pal.Faint, maxLines = 1)
                        inner()
                    }
                },
            )
        }
        val canSend = text.isNotBlank() || draft.picked.isNotEmpty() || draft.quote.value!=null
        when {
            sending -> Box(Modifier.padding(4.dp).size(36.dp).clip(CircleShape).background(Pal.Quiet), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(Modifier.size(18.dp), color = Pal.Muted, strokeWidth = 2.dp)
            }
            canSend -> Box(
                Modifier.padding(4.dp).size(36.dp).gold().tap { draft.send(c) },
                contentAlignment = Alignment.Center,
            ) { Icon(Icons.Rounded.ArrowUpward, "发送", tint = Pal.GoldInk, modifier = Modifier.size(20.dp)) }
            draft.voiceMode.value -> PillIcon(Icons.Outlined.Keyboard, "打字") { draft.voiceMode.value = false }
            else -> PillIcon(Icons.Outlined.Mic, "按住说话") { withMic { draft.voiceMode.value = true } }
        }
    }
}

@Composable
private fun PillIcon(icon: ImageVector, desc: String, enabled: Boolean = true, onClick: () -> Unit) {
    Box(Modifier.size(40.dp).clip(CircleShape).tap(enabled, onClick), contentAlignment = Alignment.Center) {
        Icon(icon, desc, tint = if (enabled) Pal.Icon else Pal.Faint, modifier = Modifier.size(22.dp))
    }
}

@Composable
private fun MenuItem(icon: ImageVector, label: String, onClick: () -> Unit) {
    DropdownMenuItem(
        text = { Text(label, fontSize = Type.Body, color = Pal.Ink) },
        leadingIcon = { Icon(icon, null, tint = Pal.Ink, modifier = Modifier.size(21.dp)) },
        onClick = onClick,
        modifier = Modifier.widthIn(min = 180.dp),
    )
}

@Composable
private fun HoldToTalk(draft: MessageDraft, modifier: Modifier) {
    val c = ctx()
    val scope = rememberCoroutineScope()
    val holding = Voice.mode.value == VoiceMode.Hold
    Box(
        modifier.height(38.dp).clip(RoundedCornerShape(19.dp))
            .then(if (holding) Modifier.gold(RoundedCornerShape(19.dp)) else Modifier.background(Pal.Card))
            .pointerInput(Unit) {
                awaitEachGesture {
                    val down = awaitFirstDown()
                    down.consume()
                    if (Voice.busy.value.isNotBlank() || !Voice.start(c, VoiceMode.Hold, draft)) return@awaitEachGesture
                    val cancelAt = 80.dp.toPx()
                    var cancel = false
                    try {
                        while (true) {
                            val ev = awaitPointerEvent()
                            val ch = ev.changes.firstOrNull { it.id == down.id } ?: break
                            cancel = down.position.y - ch.position.y > cancelAt
                            Voice.cancelArmed.value = cancel
                            ch.consume()
                            if (!ch.pressed) break
                        }
                        Voice.finishHold(c, scope, cancel)
                    } finally {
                        if (Voice.mode.value == VoiceMode.Hold) Voice.cancel()
                    }
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        val busy = Voice.busy.value
        Text(
            when {
                busy.isNotBlank() -> busy
                holding -> "松开 发送"
                else -> "按住 说话"
            },
            fontSize = Type.Body, fontWeight = FontWeight.Medium, color = if (holding) Pal.GoldInk else Pal.Ink,
        )
    }
}


@Composable
fun VoiceOverlay() {
    val mode = Voice.mode.value ?: return
    val c = ctx()
    LaunchedEffect(mode) {
        while (true) {
            Voice.tick()
            if (Voice.elapsed.longValue >= 10 * 60_000L) { Voice.cancel(); Draft.say("录音已到 10 分钟，请分段录制"); break }
            delay(100)
        }
    }
    val secs = Voice.elapsed.longValue / 1000
    val time = "%02d:%02d".format(secs / 60, secs % 60)
    Box(Modifier.fillMaxSize().background(Pal.Ink.copy(alpha = .3f)).then(if (mode == VoiceMode.Note) Modifier.tap {} else Modifier)) {
        Column(
            Modifier.align(Alignment.Center).padding(horizontal = 40.dp).fillMaxWidth().card(radius = 26.dp, color = Pal.Card)
                .padding(horizontal = 24.dp, vertical = 26.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(8.dp).background(Pal.Danger, CircleShape))
                Spacer(Modifier.width(8.dp))
                Text(if (mode == VoiceMode.Note) "正在录音 $time" else time, fontSize = Type.Body, fontWeight = FontWeight.Medium, color = Pal.Ink)
            }
            Waveform(Modifier.padding(vertical = 20.dp).fillMaxWidth().height(44.dp), if (Voice.cancelArmed.value) Pal.Danger else Pal.Gold)
            if (mode == VoiceMode.Hold) {
                Text(
                    if (Voice.cancelArmed.value) "松开手指，取消发送" else "松开发送 · 上滑取消",
                    fontSize = Type.Secondary, color = if (Voice.cancelArmed.value) Pal.Danger else Pal.Muted,
                )
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    SilverButton("取消", Modifier.weight(1f)) { Voice.cancel() }
                    GoldButton("完成", Modifier.weight(1f)) { Voice.finishNote(c) }
                }
            }
        }
    }
}

@Composable
private fun Waveform(modifier: Modifier, color: Color) {
    val levels = Voice.levels
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(3.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
        for (i in 0 until 36) {
            val v = levels.getOrNull(i - (36 - levels.size)) ?: 0f
            Box(Modifier.width(3.dp).fillMaxHeight(0.12f + 0.88f * v).clip(CircleShape).background(color.copy(alpha = 0.35f + 0.65f * v)))
        }
    }
}
