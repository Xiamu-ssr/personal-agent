package com.xiamu.agent.media

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.net.Uri
import android.view.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.xiamu.agent.Api
import com.xiamu.agent.ReplyMedia

class ReplyPlayer(context: Context, private val media: ReplyMedia) {
    private val app = context.applicationContext
    private val audio = app.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(if (media.kind == "video") AudioAttributes.CONTENT_TYPE_MOVIE else AudioAttributes.CONTENT_TYPE_MUSIC).build()
    private val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN).setAudioAttributes(attributes)
        .setOnAudioFocusChangeListener { change ->
            when (change) {
                AudioManager.AUDIOFOCUS_LOSS -> release()
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> pause()
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> runCatching { player?.setVolume(.2f, .2f) }
                AudioManager.AUDIOFOCUS_GAIN -> runCatching { player?.setVolume(1f, 1f) }
            }
        }.build()
    private var player: MediaPlayer? = null
    private var surface: Surface? = null
    private var wantsPlay = false
    var loading by mutableStateOf(false)
        private set
    var playing by mutableStateOf(false)
        private set
    var prepared by mutableStateOf(false)
        private set
    var failed by mutableStateOf(false)
        private set
    var position by mutableIntStateOf(0)
        private set
    var duration by mutableIntStateOf(0)
        private set
    var aspectRatio by mutableFloatStateOf(16f / 9f)
        private set

    fun attachSurface(next: Surface) {
        surface = next
        runCatching { player?.setSurface(next) }.onFailure { fail() }
        if (wantsPlay && player == null) prepare()
    }

    fun detachSurface(old: Surface) {
        if (surface !== old) return
        runCatching { player?.setSurface(null) }
        surface = null
    }

    fun toggle() {
        if (playing) pause()
        else if (!loading && !failed) {
            wantsPlay = true
            playback.claim(this, ::release)
            if (prepared) start() else if (media.kind != "video" || surface != null) prepare()
            else loading = true
        }
    }

    private fun prepare() {
        if (failed || player != null) return
        playback.claim(this, ::release)
        loading = true
        try {
            val p = MediaPlayer()
            player = p
            p.setAudioAttributes(attributes)
            p.setOnPreparedListener {
                if (player === it) {
                    loading = false; prepared = true
                    duration = it.duration.coerceAtLeast(0)
                    updateRatio(it.videoWidth, it.videoHeight)
                    if (position > 0) it.seekTo(position.coerceAtMost(duration))
                    if (wantsPlay) start()
                }
            }
            p.setOnVideoSizeChangedListener { current, width, height -> if (player === current) updateRatio(width, height) }
            p.setOnCompletionListener {
                if (player === it) { playing = false; wantsPlay = false; position = duration; audio.abandonAudioFocusRequest(focus) }
            }
            p.setOnErrorListener { current, _, _ -> if (player === current) fail(); true }
            p.setSurface(surface)
            p.setDataSource(app, Uri.parse(Api.fileUrl(media.path)), Api.authHeader)
            p.prepareAsync()
        } catch (_: Exception) { fail() }
    }

    private fun updateRatio(width: Int, height: Int) {
        if (width > 0 && height > 0) aspectRatio = width.toFloat() / height
    }

    private fun start() {
        val p = player ?: return
        if (!prepared) return
        if (audio.requestAudioFocus(focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) { wantsPlay = false; return }
        try {
            if (duration > 0 && position >= duration) { position = 0; p.seekTo(0) }
            p.start()
            playing = true; wantsPlay = false
        } catch (_: Exception) { fail() }
    }

    private fun pause() {
        if (!prepared || !playing) return
        runCatching { player?.pause(); position = player?.currentPosition?.coerceAtLeast(0) ?: position }
            .onFailure { fail() }
        playing = false; wantsPlay = false
        audio.abandonAudioFocusRequest(focus)
    }

    fun seek(to: Int) {
        position = to.coerceIn(0, duration)
        if (prepared) runCatching { player?.seekTo(position) }.onFailure { fail() }
    }

    fun tick() {
        if (prepared && playing) runCatching { position = player?.currentPosition?.coerceAtLeast(0) ?: position }.onFailure { fail() }
    }

    fun release() {
        val p = player
        if (prepared) position = runCatching { p?.currentPosition?.coerceAtLeast(0) }.getOrNull() ?: position
        player = null
        wantsPlay = false; loading = false; playing = false; prepared = false
        playback.release(this)
        audio.abandonAudioFocusRequest(focus)
        p?.apply {
            setOnPreparedListener(null); setOnCompletionListener(null); setOnErrorListener(null); setOnVideoSizeChangedListener(null)
            release()
        }
    }

    private fun fail() { release(); failed = true }
}
