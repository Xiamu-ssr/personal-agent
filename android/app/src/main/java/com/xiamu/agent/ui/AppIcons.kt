package com.xiamu.agent.ui

import android.content.Intent
import android.graphics.BitmapFactory
import android.provider.CalendarContract
import android.provider.Settings
import android.provider.Telephony
import android.net.Uri
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.graphics.drawable.toBitmap
import com.xiamu.agent.Api
import com.xiamu.agent.Prefs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.security.MessageDigest

internal fun cacheKey(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }

/** Official connector bytes from the same authenticated service; no invented brand drawings. */
@Composable
fun ConnectorLogo(name: String, size: Dp = 36.dp) {
    val c = ctx()
    val server = Prefs.server
    val (bitmap, _) = load("connector-logo:$server:$name") {
        withContext(Dispatchers.IO) {
            val file = File(c.cacheDir, "connector-icons/${cacheKey("$server/$name")}.png")
            val cached = if (file.exists()) BitmapFactory.decodeFile(file.path) else null
            cached ?: run {
                val bytes = Api.connectorIcon(name)
                val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: error("图标无法读取")
                file.parentFile?.mkdirs(); file.writeBytes(bytes)
                decoded
            }
        }
    }
    if (bitmap != null) Image(bitmap.asImageBitmap(), null, Modifier.size(size))
    else IconTile(connectorIcon(name), Pal.Link, size)
}

/** Resolve the actual calendar/SMS/settings/Health Connect app installed on this phone. */
@Composable
fun SystemCapabilityIcon(name: String) {
    val c = ctx()
    val icon = remember(name) {
        val pm = c.packageManager
        val packages = when (name) {
            "sms" -> listOfNotNull(Telephony.Sms.getDefaultSmsPackage(c), "com.google.android.apps.messaging", "com.android.mms")
            "calendar_events" -> listOf("com.google.android.calendar", "com.android.calendar")
            "health" -> listOf("com.google.android.apps.healthdata", "com.google.android.healthconnect.controller", "com.android.healthconnect.controller")
            "clipboard_write" -> listOf("com.google.android.inputmethod.latin", "com.android.inputmethod.latin")
            else -> listOf("com.android.settings")
        }
        val intent = when (name) {
            "calendar_events" -> Intent(Intent.ACTION_VIEW, CalendarContract.CONTENT_URI.buildUpon().appendPath("time").build())
            "sms" -> Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:"))
            else -> Intent(Settings.ACTION_SETTINGS)
        }
        packages.firstNotNullOfOrNull { runCatching { pm.getApplicationIcon(it).toBitmap(96, 96) }.getOrNull() }
            ?: runCatching { pm.resolveActivity(intent, 0)?.loadIcon(pm)?.toBitmap(96, 96) }.getOrNull()
    }
    if (icon != null) Image(icon.asImageBitmap(), null, Modifier.size(36.dp))
    else IconTile(capIcon(name), Pal.Link)
}
