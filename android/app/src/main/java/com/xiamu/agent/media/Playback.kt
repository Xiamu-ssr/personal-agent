package com.xiamu.agent.media

/** All players claim the same slot before preparing or starting. Called on the main thread. */
class PlaybackSlot {
    private var owner: Any? = null
    private var stop: (() -> Unit)? = null

    fun claim(next: Any, onStop: () -> Unit) {
        if (owner === next) return
        val previous = stop
        owner = next
        stop = onStop
        previous?.invoke()
    }

    fun release(current: Any) {
        if (owner === current) { owner = null; stop = null }
    }

    fun stop() {
        val previous = stop
        owner = null; stop = null
        previous?.invoke()
    }
}

internal val playback = PlaybackSlot()
