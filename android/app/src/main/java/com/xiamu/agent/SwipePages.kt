package com.xiamu.agent

/** Today occupies two adjacent pager pages but one bottom tab. */
object SwipePages {
    const val count = 5
    fun tab(page: Int) = when (page) { 0 -> 0; 1, 2 -> 1; 3 -> 2; else -> 3 }
    fun page(tab: Int, todaySegment: Int) = when (tab) { 0 -> 0; 1 -> 1 + todaySegment.coerceIn(0, 1); 2 -> 3; else -> 4 }
    fun next(page: Int, direction: Int) = (page + direction).coerceIn(0, count - 1)
}
