package com.xiamu.agent

/** A resize or a growing reply is not evidence that the user scrolled away. */
data class ChatScrollRules(val atBottom: Boolean = true, val unread: Int = 0, val farFromBottom: Boolean = false) {
    val showReturn: Boolean get() = farFromBottom || unread > 0
    fun userPosition(atBottom: Boolean, distanceBelow: Int, viewport: Int) =
        copy(atBottom = atBottom, unread = if (atBottom) 0 else unread,
            farFromBottom = !atBottom && distanceBelow >= viewport.coerceAtLeast(1))
    fun messages(count: Int) = if (atBottom) this else copy(unread = unread + count.coerceAtLeast(0))
    fun keyboardOpened(): Boolean = atBottom
    fun contentChanged(): Boolean = atBottom
    fun sent() = ChatScrollRules()
    fun returned() = ChatScrollRules()
}
