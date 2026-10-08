package com.xiamu.agent.ui

import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.xiamu.agent.Api
import com.xiamu.agent.BuildConfigInfo
import com.xiamu.agent.Chat
import com.xiamu.agent.Prefs
import com.xiamu.agent.device.Capabilities
import com.xiamu.agent.device.Capability
import com.xiamu.agent.device.DeviceService
import kotlinx.coroutines.launch
import org.json.JSONObject
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType

/** Server URL + a 6-digit pairing code (or the raw token), checked live against /api/state. */
@Composable
private fun ConnectionFields(onOk: () -> Unit, okLabel: String) {
    val scope = rememberCoroutineScope()
    var server by remember { mutableStateOf(Prefs.server) }
    var token by remember { mutableStateOf(Prefs.token) }
    var code by remember { mutableStateOf("") }
    var useToken by remember { mutableStateOf(Prefs.token.isNotBlank()) }
    var status by remember { mutableStateOf("") }
    var checking by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        OutlinedTextField(server, { server = it }, label = { Text("云端地址") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        if (useToken) {
            OutlinedTextField(
                token, { token = it }, label = { Text("口令（AGENT_TOKEN）") }, singleLine = true,
                visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(),
            )
        } else {
            OutlinedTextField(
                code, { code = it.filter(Char::isDigit).take(6) }, label = { Text("6 位配对码") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword), modifier = Modifier.fillMaxWidth(),
            )
        }
        TextButton(onClick = { useToken = !useToken }) { Text(if (useToken) "用配对码" else "我有口令") }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Button(enabled = !checking && (if (useToken) token.isNotBlank() else code.length == 6), onClick = {
                val oldServer = Prefs.server
                val oldToken = Prefs.token
                Prefs.server = server
                checking = true
                scope.launch {
                    runCatching {
                        Prefs.token = if (useToken) token else Api.postJson("/api/pair", JSONObject().put("code", code)).getString("token")
                        Api.getJson("/api/state")
                    }.onSuccess {
                        status = "连上了 · ${it.optString("model").substringAfter('/')}"
                        token = Prefs.token
                        onOk()
                    }.onFailure {
                        status = "连不上：" + (it.message?.let { m -> runCatching { JSONObject(m.substringAfter(' ').substringAfter(' ')).optString("error") }.getOrNull()?.ifBlank { null } ?: m } ?: "")
                        Prefs.server = oldServer
                        Prefs.token = oldToken
                    }
                    checking = false
                }
            }) { Text(if (checking) "检查中…" else okLabel) }
            Text(status, fontSize = 12.sp, color = MaterialTheme.colorScheme.outline, modifier = Modifier.padding(start = 12.dp))
        }
    }
}

@Composable
private fun CapabilityRow(cap: Capability, onChange: () -> Unit) {
    val ctx = LocalContext.current
    var on by remember { mutableStateOf(Prefs.granted(cap.name)) }
    var note by remember { mutableStateOf("") }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        val ok = result.values.any { it }
        on = ok
        Prefs.setGranted(cap.name, ok)
        note = if (ok) "" else "系统权限没给，开不了"
        onChange()
    }
    Surface(color = MaterialTheme.colorScheme.surface, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(cap.title, fontWeight = FontWeight.Medium)
                Text(note.ifBlank { cap.hint ?: cap.description }, fontSize = 12.sp, color = MaterialTheme.colorScheme.outline)
            }
            Switch(checked = on, onCheckedChange = { want ->
                if (!want) {
                    on = false
                    Prefs.setGranted(cap.name, false)
                    onChange()
                    return@Switch
                }
                val missing = cap.permissions.filter { ContextCompat.checkSelfPermission(ctx, it) != PackageManager.PERMISSION_GRANTED }
                if (missing.isEmpty()) {
                    on = true
                    Prefs.setGranted(cap.name, true)
                    onChange()
                } else launcher.launch(missing.toTypedArray())
            })
        }
    }
}

@Composable
private fun CapabilityList() {
    val ctx = LocalContext.current
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Capabilities.all.forEach { cap ->
            CapabilityRow(cap) { DeviceService.start(ctx, reregister = true) }
        }
    }
}

@Composable
fun OnboardingScreen(onDone: () -> Unit) {
    var step by remember { mutableIntStateOf(if (Prefs.configured) 1 else 0) }
    Column(
        Modifier.fillMaxSize().statusBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Spacer(Modifier.height(24.dp))
        Text("豆豆", fontSize = 32.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
        if (step == 0) {
            Text("你的个人 agent，住在你自己的云主机上。先连上它。", color = MaterialTheme.colorScheme.outline)
            ConnectionFields(onOk = { step = 1 }, okLabel = "连接")
        } else {
            Text("给豆豆开哪些手脚？", fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
            Text("开了的，豆豆可以随时用；没开的，它碰不到。之后在设置里随时改。", fontSize = 13.sp, color = MaterialTheme.colorScheme.outline)
            CapabilityList()
            Button(onClick = { Prefs.onboarded = true; onDone() }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) { Text("开始聊天") }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(onClose: () -> Unit) {
    val ctx = LocalContext.current
    var name by remember { mutableStateOf(Prefs.deviceName) }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("设置") },
                navigationIcon = { IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") } },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { pad ->
        Column(
            Modifier.padding(pad).imePadding().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("这台手机的能力", fontWeight = FontWeight.SemiBold)
            Text(
                if (DeviceService.online.value) "已接入云端 · 设备名「${Prefs.deviceName}」" else "未接入（检查网络或口令）",
                fontSize = 12.sp, color = MaterialTheme.colorScheme.outline,
            )
            CapabilityList()
            OutlinedTextField(name, { name = it }, label = { Text("设备名（豆豆这样叫这台手机）") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            TextButton(onClick = { Prefs.deviceName = name; DeviceService.start(ctx, reregister = true) }) { Text("保存设备名") }

            Text("连接", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
            ConnectionFields(onOk = {
                Chat.disconnect(); Chat.connect()
                DeviceService.start(ctx, reregister = true)
            }, okLabel = "保存并重连")

            Text("版本 ${BuildConfigInfo.version(ctx)}", fontSize = 12.sp, color = MaterialTheme.colorScheme.outline, modifier = Modifier.padding(top = 16.dp))
        }
    }
}
