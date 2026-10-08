package com.xiamu.agent.ui

import android.annotation.SuppressLint
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.xiamu.agent.Api
import com.xiamu.agent.Chat
import com.xiamu.agent.device.DeviceService
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

val Accent = Color(0xFF6B5BD6)

@Composable
fun AgentTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = lightColorScheme(
            primary = Accent,
            primaryContainer = Color(0xFFE9E5FB),
            onPrimaryContainer = Color(0xFF2C2366),
            background = Color(0xFFF7F5F0),
            surface = Color(0xFFFFFFFF),
            surfaceVariant = Color(0xFFF0EEE8),
            outline = Color(0xFF9A968E),
        ),
        content = content,
    )
}

/** Something opened full-screen on top of the tabs. */
sealed class Page(val title: String) {
    class Web(title: String, val dataPath: String) : Page(title)
    class Doc(title: String, val dataPath: String) : Page(title)
}

@Composable
fun connectionLabel(): String {
    val app = Chat.connected.value
    val dev = DeviceService.online.value
    return when {
        !app -> "连接中…"
        dev -> "在线 · 本机已接入"
        else -> "在线"
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PageView(page: Page, onClose: () -> Unit) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(page.title, maxLines = 1) },
                navigationIcon = { IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") } },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { pad ->
        Box(Modifier.padding(pad).fillMaxSize()) {
            when (page) {
                is Page.Web -> WebPage(page.dataPath)
                is Page.Doc -> DocPage(page.dataPath)
            }
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun WebPage(dataPath: String) {
    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { ctx ->
            WebView(ctx).apply {
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                webViewClient = WebViewClient()
                loadUrl(Api.fileUrl(dataPath), Api.authHeader)
            }
        },
    )
}

@Composable
fun DocPage(dataPath: String) {
    var text by remember { mutableStateOf<String?>(null) }
    var err by remember { mutableStateOf("") }
    LaunchedEffect(dataPath, Chat.filesVersion.value) {
        runCatching { Api.readFile(dataPath) }.onSuccess { text = it }.onFailure { err = it.message ?: "读不到" }
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp)) {
        when {
            text != null -> SelectionContainer { Markdown(text!!) }
            err.isNotBlank() -> Text(err, color = MaterialTheme.colorScheme.error)
            else -> Loading()
        }
    }
}

@Composable
fun Loading() {
    Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(strokeWidth = 2.dp)
    }
}

@Composable
fun Empty(text: String) {
    Box(Modifier.fillMaxWidth().padding(48.dp), contentAlignment = Alignment.Center) {
        Text(text, color = MaterialTheme.colorScheme.outline)
    }
}

/** Just enough Markdown for memory files and chat: headings, lists, quotes, **bold**, `code`. */
@Composable
fun Markdown(src: String, modifier: Modifier = Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        var inCode = false
        val code = StringBuilder()
        for (raw in src.lines()) {
            if (raw.trimStart().startsWith("```")) {
                if (inCode) {
                    Text(
                        code.toString().trimEnd(), fontFamily = FontFamily.Monospace, fontSize = 12.sp,
                        modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp)).padding(10.dp),
                    )
                    code.clear()
                }
                inCode = !inCode
                continue
            }
            if (inCode) {
                code.appendLine(raw)
                continue
            }
            val line = raw.trimEnd()
            when {
                line.isBlank() -> Box(Modifier.padding(2.dp))
                line.startsWith("#") -> {
                    val level = line.takeWhile { it == '#' }.length
                    Text(inline(line.drop(level).trim()), fontWeight = FontWeight.SemiBold,
                        fontSize = when (level) { 1 -> 20.sp; 2 -> 17.sp; else -> 15.sp }, modifier = Modifier.padding(top = 6.dp))
                }
                line.trimStart().startsWith("- ") || line.trimStart().startsWith("* ") -> {
                    val indent = line.length - line.trimStart().length
                    Text(inline("•  " + line.trimStart().drop(2)), modifier = Modifier.padding(start = (indent * 6).dp), lineHeight = 22.sp)
                }
                line.startsWith(">") -> Text(inline(line.drop(1).trim()), color = MaterialTheme.colorScheme.outline,
                    modifier = Modifier.padding(start = 8.dp))
                line.startsWith("|") -> Text(line, fontFamily = FontFamily.Monospace, fontSize = 12.sp)
                else -> Text(inline(line), lineHeight = 22.sp)
            }
        }
    }
}

fun inline(s: String): AnnotatedString = buildAnnotatedString {
    var i = 0
    while (i < s.length) {
        when {
            s.startsWith("**", i) && s.indexOf("**", i + 2) > 0 -> {
                val end = s.indexOf("**", i + 2)
                withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(s.substring(i + 2, end)) }
                i = end + 2
            }
            s[i] == '`' && s.indexOf('`', i + 1) > 0 -> {
                val end = s.indexOf('`', i + 1)
                withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = Color(0xFFEFEDE7))) { append(s.substring(i + 1, end)) }
                i = end + 1
            }
            else -> {
                append(s[i]); i++
            }
        }
    }
}

private val dayFmt = SimpleDateFormat("M月d日 HH:mm", Locale.CHINA)
fun timeLabel(ms: Long): String = dayFmt.format(Date(ms))
