package com.xiamu.agent.media

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.ActivityNotFoundException
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import com.xiamu.agent.Api
import com.xiamu.agent.Prefs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.security.MessageDigest
import java.util.Locale

internal fun fileCacheKey(server: String, path: String): String = MessageDigest.getInstance("SHA-256")
    .digest("$server\n$path".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

suspend fun cacheFile(context: Context, path: String): File {
    val file = File(context.cacheDir, "open/${fileCacheKey(Api.accountIdentity(), path)}/${path.substringAfterLast('/')}")
    Api.download(path, file)
    return file
}

internal fun fileMime(path: String, mime: String): String = mime.substringBefore(';').trim().takeIf { it.isNotBlank() && it != "application/octet-stream" }
    ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(path.substringAfterLast('.', "").lowercase(Locale.ROOT))
    ?: "application/octet-stream"

suspend fun openSystemFile(context: Context, path: String, title: String, mime: String = "", share: Boolean = false) {
    val file = cacheFile(context, path)
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
    val type = fileMime(path, mime)
    fun send() = Intent(Intent.ACTION_SEND).setType(type).putExtra(Intent.EXTRA_STREAM, uri)
        .apply { clipData = ClipData.newUri(context.contentResolver, title, uri) }.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, type)
        .apply { clipData = ClipData.newUri(context.contentResolver, title, uri) }.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    try { context.startActivity(Intent.createChooser(if (share) send() else view, title)) }
    catch (_: ActivityNotFoundException) {
        if (share) throw IllegalStateException("手机上没有能分享这个文件的应用")
        try { context.startActivity(Intent.createChooser(send(), title)) }
        catch (_: ActivityNotFoundException) { throw IllegalStateException("手机上没有能打开这个文件的应用") }
    }
}

suspend fun saveFile(context: Context, path: String, destination: android.net.Uri) {
    val file = cacheFile(context, path)
    withContext(Dispatchers.IO) {
        val output = context.contentResolver.openOutputStream(destination) ?: error("文件不可用")
        output.use { out -> file.inputStream().use { input -> input.copyTo(out) } }
    }
}
