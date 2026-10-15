package com.xiamu.agent.ui

import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Shield

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.outlined.Palette
import androidx.compose.material.icons.outlined.PersonOutline
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Apps
import androidx.compose.material.icons.outlined.BatteryChargingFull
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.Cloud
import androidx.compose.material.icons.outlined.ContentPaste
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.Extension
import androidx.compose.material.icons.outlined.FavoriteBorder
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.LaptopMac
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.Memory
import androidx.compose.material.icons.outlined.NotificationsNone
import androidx.compose.material.icons.outlined.PhoneAndroid
import androidx.compose.material.icons.outlined.Place
import androidx.compose.material.icons.outlined.Sms
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import android.webkit.CookieManager
import com.xiamu.agent.Api
import com.xiamu.agent.BuildConfigInfo
import com.xiamu.agent.Chat
import com.xiamu.agent.Prefs
import com.xiamu.agent.device.Capabilities
import com.xiamu.agent.device.Capability
import com.xiamu.agent.device.DeviceService
import com.xiamu.agent.device.HealthAccess
import kotlinx.coroutines.launch

/** Whether we hold a token; flipping it swaps the whole UI between login and the app. */
object Session {
    val loggedIn = mutableStateOf(Prefs.configured)

    fun logout(ctx: android.content.Context) {
        Prefs.token = ""
        Chat.reset()
        Voice.cancel()
        Draft.reset()
        com.xiamu.agent.media.Images.clear()
        com.xiamu.agent.media.VoicePlayer.stop()
        CookieManager.getInstance().removeAllCookies(null)
        DeviceService.stop(ctx)
        java.io.File(ctx.cacheDir, "site-previews").deleteRecursively()
        java.io.File(ctx.cacheDir, "connector-icons").deleteRecursively()
        clearCache()
        Nav.home(0)
        loggedIn.value = false
    }
}

fun capIcon(name: String): ImageVector = when (name) {
    "battery" -> Icons.Outlined.BatteryChargingFull
    "notify" -> Icons.Outlined.NotificationsNone
    "location" -> Icons.Outlined.Place
    "calendar_events" -> Icons.Outlined.CalendarMonth
    "sms" -> Icons.Outlined.Sms
    "clipboard_write", "clipboard_read" -> Icons.Outlined.ContentPaste
    "health" -> Icons.Outlined.FavoriteBorder
    "frontmost_app" -> Icons.Outlined.Apps
    "shortcuts" -> Icons.Outlined.Bolt
    "folder" -> Icons.Outlined.Folder
    else -> Icons.Outlined.Extension
}

fun deviceIcon(kind: String): ImageVector = when (kind) {
    "mac" -> Icons.Outlined.LaptopMac
    "cloud" -> Icons.Outlined.Cloud
    else -> Icons.Outlined.PhoneAndroid
}

// ---------- 登录 ----------

@Composable
fun LoginScreen() {
    val scope = rememberCoroutineScope()
    var server by remember { mutableStateOf(Prefs.server) }
    var password by remember { mutableStateOf("") }
    var shown by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val ready = server.isNotBlank() && password.isNotBlank() && !busy
    fun login() {
        if (!ready) return
        busy = true
        error = ""
        scope.launch {
            runCatching { Api.login(server.trim(), password) }
                .onSuccess { Session.loggedIn.value = true }
                .onFailure { error = it.message ?: "登录失败" }
            busy = false
        }
    }
    Screen {
        Column(
            Modifier.fillMaxSize().statusBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp),
        ) {
            Spacer(Modifier.height(56.dp))
            Avatar(76.dp)
            Text("登录豆豆", fontSize = Type.Large, fontFamily = Type.titleFamily, fontWeight = FontWeight.Bold, color = Pal.Ink, modifier = Modifier.padding(top = 26.dp))
            Text("你的个人 agent，住在你自己的云主机上", fontSize = Type.Secondary, color = Pal.Muted, modifier = Modifier.padding(top = 8.dp))
            Column(Modifier.padding(top = 32.dp).fillMaxWidth().card(radius = 24.dp).padding(horizontal = 20.dp)) {
                LoginField("云端地址", server, { server = it }, "https://你的服务器/agent", KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next))
                Hairline()
                LoginField(
                    "配对码", password, { password = it }, "6 位配对码",
                    KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                    KeyboardActions(onDone = { login() }),
                    if (shown) VisualTransformation.None else PasswordVisualTransformation(),
                ) {
                    Icon(
                        if (shown) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility, if (shown) "隐藏" else "显示",
                        tint = Pal.Faint, modifier = Modifier.size(20.dp).tap { shown = !shown },
                    )
                }
            }
            if (error.isNotBlank()) ErrorNote(error)
            GoldButton(if (busy) "正在登录…" else "登录", Modifier.fillMaxWidth().padding(top = if (error.isBlank()) 24.dp else 4.dp), ready) { login() }
            Text("没有配对码？在已登录的设备上：设置 → 生成配对码", fontSize = Type.Label, color = Pal.Faint,
                modifier = Modifier.fillMaxWidth().padding(top = 16.dp, bottom = 32.dp), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        }
    }
}

@Composable
private fun LoginField(
    label: String, value: String, onChange: (String) -> Unit, hint: String,
    keyboard: KeyboardOptions, actions: KeyboardActions = KeyboardActions.Default,
    visual: VisualTransformation = VisualTransformation.None, trailing: @Composable (() -> Unit)? = null,
) {
    Column(Modifier.fillMaxWidth().padding(vertical = 14.dp)) {
        Text(label, fontSize = Type.Label, color = Pal.Muted)
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 6.dp)) {
            BasicTextField(
                value, onChange, singleLine = true, keyboardOptions = keyboard, keyboardActions = actions, visualTransformation = visual,
                textStyle = TextStyle(fontSize = Type.Body, color = Pal.Ink), cursorBrush = SolidColor(Pal.Gold),
                modifier = Modifier.weight(1f),
                decorationBox = { inner -> Box { if (value.isEmpty()) Text(hint, fontSize = Type.Body, color = Pal.Faint); inner() } },
            )
            trailing?.invoke()
        }
    }
}

// ---------- 本机能力 ----------

@Composable
fun CapabilityRow(cap: Capability) {
    val c = ctx()
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var on by remember(permissionRevision.intValue) { mutableStateOf(cap.enabled(c)) }
    var denied by remember { mutableStateOf(false) }
    fun set(v: Boolean) {
        on = v
        Prefs.setGranted(cap.name, v)
        DeviceService.start(c, reregister = true)
    }
    DisposableEffect(lifecycle, cap) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                on = cap.enabled(c)
                if (on) denied = false
                if(cap.name == "health") scope.launch { runCatching { HealthAccess.refresh(c) }; on=cap.enabled(c) }
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    val health = rememberLauncherForActivityResult(HealthAccess.permissionContract) { result ->
        HealthAccess.updateGranted(result)
        val ok=cap.hasPermissions(c); denied=!ok; set(ok)
    }
    fun requestHealth() {
        if(cap.name == "health" && HealthAccess.available(c)) health.launch(HealthAccess.permissions(c))
    }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        val ok = cap.hasPermissions(c)
        denied = !ok
        set(ok)
        requestHealth()
    }
    ListRow(
        cap.title,
        if (denied) "系统权限被拒绝 · 点这里去系统设置打开" else cap.hint,
        leading = { SystemCapabilityIcon(cap.name) },
        subColor = if (denied) Pal.Danger else Pal.Muted, subLines = 2,
        onClick = if (denied) {
            { c.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", c.packageName, null))) }
        } else null,
        trailing = {
            GoldSwitch(on) { want ->
                if (!want) return@GoldSwitch set(false)
                val missing = cap.permissions.filter { ContextCompat.checkSelfPermission(c, it) != PackageManager.PERMISSION_GRANTED }
                if (missing.isEmpty()) { set(true); requestHealth() } else launcher.launch(missing.toTypedArray())
            }
        },
    )
}

@Composable
fun LocalCapabilities() {
    CardList {
        Capabilities.all.forEachIndexed { i, cap ->
            if (i > 0) Hairline()
            CapabilityRow(cap)
        }
    }
}

// ---------- 设置 ----------

/** Issue a fresh one-time code for another device. */
@Composable
fun PairCode() {
    val scope = rememberCoroutineScope()
    var code by remember { mutableStateOf("") }
    var error by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(vertical = 14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconTile(Icons.Outlined.Key, Pal.Gold)
            Text("生成配对码", fontSize = Type.Body, fontWeight = FontWeight.Medium, color = Pal.Ink, modifier = Modifier.padding(start = 14.dp).weight(1f))
            QuietButton(if (busy) "生成中…" else if (code.isBlank()) "生成" else "换一个") {
                if (busy) return@QuietButton
                busy = true
                scope.launch {
                    runCatching { Api.postJson("/api/pair/new").getString("code") }
                        .onSuccess { code = it; error = "" }.onFailure { error = it.message ?: "失败" }
                    busy = false
                }
            }
        }
        if (code.isNotBlank()) {
            Text(
                code.chunked(3).joinToString(" "), fontSize = Type.Large, fontFamily = Type.titleFamily, fontWeight = FontWeight.SemiBold, color = Pal.GoldInk, letterSpacing = 4.sp,
                modifier = Modifier.padding(top = 14.dp, start = 50.dp),
            )
        }
        if (error.isNotBlank()) Text(error, fontSize = Type.Label, color = Pal.Danger, modifier = Modifier.padding(top = 8.dp, start = 50.dp))
        Text("24 小时内有效，只能用一次，会顶掉之前没用的码", fontSize = Type.Label, color = Pal.Muted, modifier = Modifier.padding(top = 8.dp, start = 50.dp))
    }
}

@Composable
fun SettingsScreen() {
    val c = ctx()
    val (state, _) = load("state") { Api.getJson("/api/state") }
    val (runtime, runtimeError) = load("settings") { Api.settings() }
    var notify by remember { mutableStateOf(Prefs.notifyMessages && NotificationManagerCompat.from(c).areNotificationsEnabled()) }
    var notifyDenied by remember { mutableStateOf(false) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                val allowed = NotificationManagerCompat.from(c).areNotificationsEnabled()
                notify = Prefs.notifyMessages && allowed
                notifyDenied = Prefs.notifyMessages && !allowed
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    val notifyPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        notify = ok
        Prefs.notifyMessages = ok
        notifyDenied = !ok
    }
    SubPage("设置") {

        item { SectionTitle("偏好") }
        item { CardList {
            ListRow("模型",runtime?.modelLabel ?: "正在读取",Icons.Outlined.AutoAwesome) { Nav.open(Route.RuntimeSettings()) }
            Hairline()
            ListRow("外观",when(ThemeState.preference.value) { "light"->"浅色"; "dark"->"深色"; else->"跟随系统" },Icons.Outlined.Palette) { Nav.open(Route.Appearance) }
        } }
        if (runtimeError.isNotBlank()) item { ErrorNote(runtimeError) }
        item { SectionTitle("能力与连接") }
        item {
            CardList {
                ListRow("连接应用", "本机、云端和其他设备的能力", Icons.Outlined.Hub, Pal.Ink) { Nav.open(Route.Connectors()) }
                Hairline()
                ListRow("设备", "设备与本机能力", Icons.Outlined.Devices, Pal.Ink) { Nav.open(Route.Devices) }
                Hairline()
                ListRow("技能", "豆豆整理好的常用做法", Icons.Outlined.Extension, Pal.Ink) { Nav.open(Route.Skills) }
            }
        }
        item { SectionTitle("通知") }
        item {
            CardList {
                ListRow("接收消息通知", if (notifyDenied) "系统通知权限被拒绝 · 点这里去系统设置打开" else "App 不在前台时，豆豆说话会发通知", Icons.Outlined.NotificationsNone,
                    Pal.Gold, subColor = if (notifyDenied) Pal.Danger else Pal.Muted, subLines = 2,
                    onClick = if (notifyDenied) { { c.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", c.packageName, null))) } } else null,
                    trailing = {
                    GoldSwitch(notify) { want ->
                        val needPerm = android.os.Build.VERSION.SDK_INT >= 33 &&
                            ContextCompat.checkSelfPermission(c, android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                        if (want && needPerm) notifyPerm.launch(android.Manifest.permission.POST_NOTIFICATIONS)
                        else { notify = want; Prefs.notifyMessages = want; notifyDenied = false }
                    }
                })
            }
        }
        item { SectionTitle("账号") }
        item {
            CardList {
                ListRow("云端地址", Prefs.server, Icons.Outlined.Cloud, Pal.Ink) { Nav.open(Route.Server) }
                Hairline()
                PairCode()
                Hairline()
                ListRow("退出登录", "清除这台手机上的口令，回到登录页", Icons.AutoMirrored.Outlined.Logout, Pal.Danger) { Session.logout(c) }
            }
        }
        item { FooterNote("版本 ${BuildConfigInfo.version(c)}") }
    }
}

@Composable
fun PillLink(text: String, onClick: () -> Unit) {
    Text(text, fontSize = Type.Secondary, color = Pal.Ink, modifier = Modifier.clip(CircleShape).tap(onClick = onClick).padding(vertical = 6.dp))
}
