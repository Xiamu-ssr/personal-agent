package com.xiamu.agent.media

import android.content.Context
import android.app.Application
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.util.LruCache
import androidx.compose.runtime.mutableStateOf
import com.xiamu.agent.Api
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File

/** AAC (ADTS) at 16 kHz mono: small, and what /api/transcribe takes as format=aac. */
class Recorder(ctx: Context) {
    private val app = ctx.applicationContext as Application
    private var rec: MediaRecorder? = null
    private var file: File? = null
    private var startedAt = 0L

    val elapsedMs: Long get() = if (rec == null) 0 else System.currentTimeMillis() - startedAt

    /** 0..1, for the little waveform. */
    val level: Float get() = runCatching { (rec?.maxAmplitude ?: 0) / 20000f }.getOrDefault(0f).coerceIn(0f, 1f)

    fun start(): Boolean {
        cancel()
        val f = File(app.cacheDir, "voice/${System.currentTimeMillis()}.aac").apply { parentFile?.mkdirs() }
        val r = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(app) else @Suppress("DEPRECATION") MediaRecorder()
        return try {
            r.setAudioSource(MediaRecorder.AudioSource.MIC)
            r.setOutputFormat(MediaRecorder.OutputFormat.AAC_ADTS)
            r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            r.setAudioSamplingRate(16_000)
            r.setAudioChannels(1)
            r.setAudioEncodingBitRate(32_000)
            r.setOutputFile(f.absolutePath)
            r.prepare()
            r.start()
            rec = r; file = f; startedAt = System.currentTimeMillis()
            true
        } catch (e: Exception) {
            r.release(); f.delete()
            false
        }
    }

    /** Returns the recording, or null if it was too short to be worth sending. */
    fun stop(minMs: Long = 700): File? {
        val r = rec ?: return null
        val f = file
        val ms = elapsedMs
        rec = null; file = null
        val ok = runCatching { r.stop() }.isSuccess
        r.release()
        if (!ok || ms < minMs) {
            f?.delete()
            return null
        }
        return f
    }

    fun cancel() {
        rec?.let { runCatching { it.stop() }; it.release() }
        file?.delete()
        rec = null; file = null
    }
}

fun displayName(ctx: Context, uri: Uri): String =
    ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst()) c.getString(0) else null
    } ?: uri.lastPathSegment?.substringAfterLast('/') ?: "file"

suspend fun readBytes(ctx: Context, uri: Uri): ByteArray = withContext(Dispatchers.IO) {
    ctx.contentResolver.openInputStream(uri)?.use { input ->
        ByteArrayOutputStream().use { out ->
            val buffer = ByteArray(8192)
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                require(out.size() + n <= 20 * 1024 * 1024) { "文件太大了，上限 20MB" }
                out.write(buffer, 0, n)
            }
            out.toByteArray()
        }
    } ?: throw IllegalArgumentException("文件读不到了，请重新选择")
}

/** Long edge ≤ [maxEdge] px, JPEG. ImageDecoder also applies the EXIF rotation from camera photos. */
suspend fun compressImage(ctx: Context, uri: Uri, maxEdge: Int = 1600): ByteArray = withContext(Dispatchers.IO) {
    val bmp = ImageDecoder.decodeBitmap(ImageDecoder.createSource(ctx.contentResolver, uri)) { dec, info, _ ->
        val w = info.size.width
        val h = info.size.height
        val scale = maxEdge.toFloat() / maxOf(w, h)
        if (scale < 1f) dec.setTargetSize((w * scale).toInt().coerceAtLeast(1), (h * scale).toInt().coerceAtLeast(1))
        dec.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
    }
    ByteArrayOutputStream().use { out ->
        bmp.compress(Bitmap.CompressFormat.JPEG, 85, out)
        bmp.recycle()
        out.toByteArray()
    }
}

/** Authenticated thumbnails for chat bubbles; small in-memory cache. */
object Images {
    private val cache = object : LruCache<String, Bitmap>(24 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }

    fun cached(path: String, maxEdge: Int): Bitmap? = cache.get("$path@$maxEdge")
    fun clear() = cache.evictAll()

    suspend fun load(path: String, maxEdge: Int): Bitmap? {
        cached(path, maxEdge)?.let { return it }
        val bytes = runCatching { Api.bytes(path) }.getOrNull() ?: return null
        return withContext(Dispatchers.Default) {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            var sample = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxEdge) sample *= 2
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
        }?.also { cache.put("$path@$maxEdge", it) }
    }
}

/** One voice note plays at a time. */
object VoicePlayer {
    val playing = mutableStateOf<String?>(null)
    private var mp: MediaPlayer? = null

    fun toggle(ctx: Context, path: String) {
        val same = playing.value == path
        stop()
        if (same) return
        val p = MediaPlayer()
        mp = p
        playing.value = path
        try {
            p.setDataSource(ctx, Uri.parse(Api.fileUrl(path)), Api.authHeader)
            p.setOnPreparedListener { it.start() }
            p.setOnCompletionListener { stop() }
            p.setOnErrorListener { _, _, _ -> stop(); true }
            p.prepareAsync()
        } catch (e: Exception) {
            stop()
        }
    }

    fun stop() {
        mp?.let { runCatching { it.stop() }; it.release() }
        mp = null
        playing.value = null
    }
}
