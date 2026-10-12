package com.xiamu.agent

/** Local appearance only; never sent to the server or inferred from system dark mode. */
enum class Skin(val id: String, val label: String, val colors: SkinColors) {
    Silver("silver", "银蓝", SkinColors(0xFFF3F5F8, 0xFFFFFFFF, 0xFF1E2733, 0xFF6B7686, 0xFFE3E7ED, 0xFF4A78A8, 0xFFE6EEF7, 0xFFB89A5E, 0xFF3E8E6A, 0xFFC2873A, 0xFF4A78A8)),
    Paper("paper", "纸墨", SkinColors(0xFFF5F0E6, 0xFFFBF8F2, 0xFF231F1A, 0xFF7A7065, 0xFFE6DDCD, 0xFFB4442E, 0xFFF3E3DA, 0xFF9C7A3C, 0xFF5B7F4E, 0xFFB0782C, 0xFF5E6F8C)),
    Night("night", "夜幕", SkinColors(0xFF0F1216, 0xFF181C22, 0xFFE6E8EB, 0xFF8C95A1, 0xFF262B33, 0xFF5CCFB0, 0xFF1E3330, 0xFFE0A54B, 0xFF5CCFB0, 0xFFE0A54B, 0xFF7BA7E0));
    companion object { fun from(id: String?) = entries.firstOrNull { it.id == id } ?: Silver }
}

data class SkinColors(val background: Long, val card: Long, val ink: Long, val secondary: Long,
    val line: Long, val accent: Long, val accentSoft: Long, val decoration: Long,
    val good: Long, val attention: Long, val info: Long)

/** Small injectable persistence boundary, also used by the JVM checks. */
class SkinPreference(private val read: () -> String?, private val write: (String) -> Unit) {
    val current: Skin get() = Skin.from(read())
    fun select(skin: Skin): Skin { write(skin.id); return current }
}
