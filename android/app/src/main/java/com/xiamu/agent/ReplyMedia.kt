package com.xiamu.agent

import org.json.JSONObject
import java.util.Locale
import java.net.URLDecoder

data class ReplyMedia(val path: String, val name: String, val kind: String, val mime: String, val size: Long) {
    fun presentation(playbackFailed: Boolean = false): MediaPresentation = when (kind) {
        "image" -> MediaPresentation.Image
        "video" -> if (playbackFailed) MediaPresentation.File else MediaPresentation.Video
        "audio" -> if (playbackFailed) MediaPresentation.File else MediaPresentation.Audio
        else -> MediaPresentation.File
    }

    companion object {
        fun from(j: JSONObject): ReplyMedia? {
            val path = j.optString("path")
            if (!isDataFile(path)) return null
            val kind = inferredMediaKind(path,j.optString("mime"),j.optString("kind"))
            return ReplyMedia(path, j.optString("name").ifBlank { path.substringAfterLast('/') }, kind,
                j.optString("mime").ifBlank { "application/octet-stream" }, j.optLong("size").coerceAtLeast(0))
        }
    }
}

fun inferredMediaKind(path:String,mime:String="",declared:String="file"):String {
    if(declared in setOf("image","video","audio"))return declared
    val ext=path.substringAfterLast('.',"").lowercase(Locale.ROOT)
    return when {
        mime.startsWith("image/") || ext in setOf("png","jpg","jpeg","gif","webp","heic","heif","avif","bmp","tif","tiff")->"image"
        mime.startsWith("video/") || ext in setOf("mp4","mov","m4v","webm","mkv","3gp")->"video"
        mime.startsWith("audio/") || ext in setOf("mp3","m4a","aac","wav","flac","ogg","opus","aif","aiff","alac")->"audio"
        else->"file"
    }
}

enum class MediaPresentation { Image, Video, Audio, File }
enum class FileOpening { Markdown, Image, Web, Pdf, System }

internal fun mediaIntersectsViewport(top: Float, bottom: Float, height: Int): Boolean =
    height > 0 && bottom > top && bottom > 0f && top < height

internal fun isDataFile(path: String): Boolean {
    if (!path.startsWith("data/") || '\u0000' in path) return false
    val parts = mutableListOf<String>()
    for (part in path.split('/')) when (part) {
        "", "." -> Unit
        ".." -> if (parts.isEmpty()) return false else parts.removeAt(parts.lastIndex)
        else -> parts.add(part)
    }
    return parts.firstOrNull() == "data" && parts.size > 1
}

internal fun markdownFilePath(target: String): String? {
    val raw = target.trim().removeSurrounding("<", ">")
    val path = runCatching { URLDecoder.decode(raw.replace("+", "%2B"), "UTF-8") }.getOrDefault(raw)
    return path.takeIf(::isDataFile)
}

internal fun replyMedia(j: JSONObject): List<ReplyMedia> =
    if (j.optBoolean("partial") || (j.opt("error") as? String).orEmpty().isNotBlank()) emptyList()
    else j.optJSONArray("media").objects().mapNotNull(ReplyMedia::from)

fun fileOpening(path: String, mime: String = ""): FileOpening {
    val ext = path.substringAfterLast('/').substringAfterLast('.', "").lowercase(Locale.ROOT)
    val type = mime.substringBefore(';').trim().lowercase(Locale.ROOT)
    return when {
        ext in setOf("md", "markdown") || type in setOf("text/markdown", "text/x-markdown") -> FileOpening.Markdown
        ext == "pdf" || type == "application/pdf" -> FileOpening.Pdf
        ext in setOf("png", "jpg", "jpeg", "gif", "webp") -> FileOpening.Image
        ext in setOf("html", "htm", "txt", "text", "log", "json", "csv", "svg", "xml", "xhtml") ||
            type.startsWith("text/") || type in setOf("application/xhtml+xml", "application/json", "image/svg+xml") || ext.isEmpty() -> FileOpening.Web
        else -> FileOpening.System
    }
}

fun formatFileSize(bytes: Long): String {
    val size = bytes.coerceAtLeast(0)
    if (size < 1024) return "$size B"
    val units = listOf("KB", "MB", "GB", "TB", "PB", "EB")
    var value = size.toDouble() / 1024
    var unit = 0
    while (value >= 1024 && unit < units.lastIndex) { value /= 1024; unit++ }
    return String.format(Locale.ROOT, "%.1f", value).removeSuffix(".0") + " ${units[unit]}"
}

fun playbackTime(milliseconds: Int): String {
    val seconds = milliseconds.coerceAtLeast(0) / 1000
    return if (seconds >= 3600) String.format(Locale.ROOT, "%d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60)
    else String.format(Locale.ROOT, "%d:%02d", seconds / 60, seconds % 60)
}
