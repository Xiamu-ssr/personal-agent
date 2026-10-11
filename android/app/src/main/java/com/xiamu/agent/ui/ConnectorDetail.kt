package com.xiamu.agent.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xiamu.agent.connectors.AccountDraft
import com.xiamu.agent.connectors.CloudConnectors
import com.xiamu.agent.connectors.ConnectorAccount
import com.xiamu.agent.connectors.ConnectorField
import com.xiamu.agent.connectors.ConnectorGateway
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
fun ConnectorDetailScreen(route: Route.ConnectorDetail, gateway: ConnectorGateway = CloudConnectors) {
    val (data, loadError) = connectionData(gateway)
    val connector = data?.connector(route.connector.name) ?: route.connector
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf("") }
    var deleting by remember { mutableStateOf<ConnectorAccount?>(null) }
    var deleteError by remember { mutableStateOf("") }
    Screen {
        Column(Modifier.fillMaxSize()) {
            SubHeader(connector.title, Nav::back)
            LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp)) {
                item {
                    Row(Modifier.padding(bottom = 12.dp), horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        ConnectorLogo(connector.name, 60.dp)
                        Column(Modifier.weight(1f)) {
                            Text(connector.title, fontSize = 27.sp, fontWeight = FontWeight.Bold, color = Pal.Ink)
                            Text(connector.description, fontSize = 13.sp, lineHeight = 20.sp, color = Pal.Muted, modifier = Modifier.padding(top = 5.dp))
                        }
                    }
                }
                if (loadError.isNotBlank() || error.isNotBlank()) item { ErrorNote(error.ifBlank { loadError }) }
                item { SectionTitle("账号") { Text("${connector.accounts.size} 个", fontSize = 12.sp, color = Pal.Muted) } }
                if (connector.accounts.isEmpty()) item {
                    Column(Modifier.fillMaxWidth().card().padding(28.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(if (connector.fields == null) "账号表单即将支持" else "还没有添加账号",
                            fontSize = 15.sp, fontWeight = FontWeight.Medium, color = Pal.Ink)
                        Text(if (connector.fields == null) "敬请期待" else "添加后，豆豆就能使用这个服务",
                            fontSize = 13.sp, lineHeight = 20.sp, color = Pal.Muted, modifier = Modifier.padding(top = 8.dp))
                    }
                }
                connector.accounts.forEach { account ->
                    item(key = account.id) {
                        Column(Modifier.padding(bottom = 12.dp).fillMaxWidth().card().padding(horizontal = 18.dp, vertical = 16.dp)) {
                            Text(account.label, fontSize = 16.sp, lineHeight = 23.sp, fontWeight = FontWeight.Medium, color = Pal.Ink)
                            Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                                StatusDot(if (account.status == "ok") Pal.Online else Pal.Danger)
                                Text(if (account.status == "ok") "已连接" else "连接异常", fontSize = 12.sp, color = if (account.status == "ok") Pal.Muted else Pal.Danger)
                                if (account.checkedAt > 0) Text("· ${ago(account.checkedAt)}验证", fontSize = 11.sp, color = Pal.Faint)
                            }
                            if (account.status != "ok") Text(account.error?.takeIf { it.isNotBlank() } ?: "尚未通过验证", fontSize = 13.sp, lineHeight = 20.sp,
                                color = Pal.Danger, modifier = Modifier.padding(top = 8.dp))
                            Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.End) {
                                if (connector.fields != null) TextButton(enabled = busy == null, onClick = { Nav.open(Route.ConnectorForm(connector, account)) }) { Text("编辑", color = Pal.Link) }
                                TextButton(enabled = busy == null, onClick = {
                                    if (busy == null) {
                                        busy = account.id
                                        error = ""
                                        scope.launch {
                                            try { gateway.test(connector.name, account.id) }
                                            catch (e: Exception) { if (e is CancellationException) throw e; error = e.message ?: "验证失败" }
                                            finally { busy = null; connectionsChanged() }
                                        }
                                    }
                                }) { Text(if (busy == account.id && deleting == null) "正在测试…" else "重新测试", color = Pal.Link) }
                                TextButton(enabled = busy == null, onClick = { deleting = account; deleteError = "" }) { Text("删除", color = Pal.Danger) }
                            }
                        }
                    }
                }
            }
            Column(Modifier.navigationBarsPadding().fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp)) {
                when {
                    connector.fields == null -> FooterNote("账号表单即将支持")
                    !connector.multiAccount && connector.accounts.isNotEmpty() -> FooterNote("这个连接器支持一个账号，可以编辑或删除后重新添加")
                    else -> GoldButton("添加账号", Modifier.fillMaxWidth(), enabled = busy == null) { Nav.open(Route.ConnectorForm(connector)) }
                }
            }
        }
    }
    deleting?.let { account ->
        RemovalDialog("删除账号", "删除「${account.label}」？删除后，豆豆将无法继续读取这个账号。", "删除", busy != null, deleteError,
            onDismiss = { deleting = null }, onConfirm = {
                if (busy == null) {
                    busy = account.id
                    scope.launch {
                        try { gateway.delete(connector.name, account.id); deleting = null; connectionsChanged() }
                        catch (e: Exception) { if (e is CancellationException) throw e; deleteError = e.message ?: "删除失败" }
                        finally { busy = null }
                    }
                }
            },
        )
    }
}

@Composable
fun ConnectorFormScreen(route: Route.ConnectorForm, gateway: ConnectorGateway = CloudConnectors) {
    val connector = route.connector
    val editing = route.account != null
    val draft = remember(route) { AccountDraft(connector, editing, route.account) }
    val values = remember(route) { mutableStateMapOf<String, String>().apply { putAll(draft.initial) } }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val fields = connector.fields.orEmpty().filter { it.visible(values) }
    BackHandler(busy) { }
    Screen {
        Column(Modifier.fillMaxSize().imePadding()) {
            SubHeader(if (editing) "编辑账号" else "添加账号") { if (!busy) Nav.back() }
            LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(start = 20.dp, end = 20.dp, bottom = 20.dp)) {
                item {
                    BigTitle(if (editing) "编辑账号" else "添加${connector.title}账号", route.account?.label ?: connector.description)
                    if (editing) FooterNote("授权码不修改请留空，保存时会重新验证。")
                }
                item {
                    if (connector.fields == null) EmptyNote("账号表单即将支持")
                    else CardList(Modifier.padding(top = 14.dp)) {
                        fields.forEachIndexed { i, field ->
                            if (i > 0) Hairline()
                            AccountField(field, values[field.key].orEmpty(), values, editing, !busy) { values[field.key] = it; error = "" }
                        }
                    }
                }
                if (error.isNotBlank()) item { ErrorNote(error) }
            }
            if (connector.fields != null) Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 20.dp, vertical = 12.dp)) {
                GoldButton(if (busy) "正在验证…" else if (editing) "保存并验证" else "验证并添加", Modifier.fillMaxWidth(),
                    enabled = !busy && (!editing || values.values.any { it.isNotBlank() }),
                ) {
                    if (!busy) {
                        focus.clearFocus()
                        keyboard?.hide()
                        busy = true
                        error = ""
                        scope.launch {
                            try {
                                gateway.save(connector.name, route.account?.id, draft.payload(values.toMap()))
                                connectionsChanged()
                                Nav.back()
                            } catch (e: Exception) { if (e is CancellationException) throw e; error = e.message ?: "验证失败" }
                            finally { busy = false }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun AccountField(field: ConnectorField, value: String, values: Map<String, String>, editing: Boolean, enabled: Boolean, onChange: (String) -> Unit) {
    var shown by remember(field.key) { mutableStateOf(false) }
    var expanded by remember(field.key) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(vertical = 16.dp)) {
        Text(field.label, fontSize = 13.sp, fontWeight = FontWeight.Medium, color = Pal.Ink, modifier = Modifier.padding(bottom = 9.dp))
        if (field.type == "select") {
            if (field.options.size <= 3 && field.options.isNotEmpty()) {
                SegTabs(field.options.map { it.label }, field.options.indexOfFirst { it.value == value }, Modifier.testTag("field:${field.key}")) {
                    if (enabled) onChange(field.options[it].value)
                }
            } else Box {
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Pal.Field).tap(enabled) { expanded = true }
                    .padding(horizontal = 14.dp, vertical = 13.dp).testTag("field:${field.key}"), verticalAlignment = Alignment.CenterVertically) {
                    Text(field.options.firstOrNull { it.value == value }?.label ?: "请选择",
                        fontSize = 14.sp, color = if (value.isBlank()) Pal.Faint else Pal.Ink, modifier = Modifier.weight(1f))
                    Icon(Icons.Outlined.KeyboardArrowDown, null, tint = Pal.Muted, modifier = Modifier.size(20.dp))
                }
                DropdownMenu(expanded, { expanded = false }, containerColor = Pal.CardSolid, shape = RoundedCornerShape(18.dp)) {
                    field.options.forEach { option ->
                        DropdownMenuItem(text = { Text(option.label, fontSize = 14.sp, color = if (option.value == value) Pal.GoldInk else Pal.Ink) },
                            onClick = { if (enabled) onChange(option.value); expanded = false })
                    }
                }
            }
        } else {
            val secret = field.type == "secret"
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Pal.Field).border(1.dp, Color(0x267589A0), RoundedCornerShape(14.dp))
                .padding(start = 14.dp, end = if (secret) 8.dp else 14.dp), verticalAlignment = Alignment.CenterVertically) {
                BasicTextField(
                    value, onChange, enabled = enabled, singleLine = true, textStyle = TextStyle(fontSize = 14.sp, color = Pal.Ink),
                    cursorBrush = SolidColor(Pal.Gold), modifier = Modifier.weight(1f).padding(vertical = 14.dp).testTag("field:${field.key}"),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = if (secret) false else null,
                        keyboardType = when { secret -> KeyboardType.Password; field.type == "number" -> KeyboardType.Decimal; else -> KeyboardType.Text }, imeAction = ImeAction.Next),
                    visualTransformation = if (secret && !shown) PasswordVisualTransformation() else VisualTransformation.None,
                    decorationBox = { inner ->
                        Box {
                            if (value.isEmpty()) Text(when { editing && secret -> "不修改请留空"; else -> field.placeholder }, fontSize = 14.sp, color = Pal.Faint)
                            inner()
                        }
                    },
                )
                if (secret) Icon(if (shown) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility, if (shown) "隐藏${field.label}" else "显示${field.label}",
                    tint = Pal.Muted, modifier = Modifier.size(36.dp).tap(enabled) { shown = !shown }.padding(8.dp))
            }
        }
        val help = field.help(values)
        if (help.isNotBlank()) Text(help, fontSize = 11.sp, lineHeight = 17.sp, color = Pal.Muted, modifier = Modifier.padding(top = 8.dp))
    }
}

@Composable
internal fun RemovalDialog(title: String, message: String, action: String, busy: Boolean, error: String, blocked: Boolean = false, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(title, fontSize = 21.sp, fontWeight = FontWeight.SemiBold, color = Pal.Ink) },
        text = { Column { Text(message, fontSize = 14.sp, lineHeight = 22.sp, color = Pal.Muted); if (error.isNotBlank()) ErrorNote(error) } },
        confirmButton = { TextButton(enabled = !busy && !blocked, onClick = onConfirm) { Text(if (busy) "正在${action}…" else action, color = if (busy || blocked) Pal.Faint else Pal.Danger) } },
        dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text(if (blocked) "知道了" else "取消", color = if (busy) Pal.Faint else Pal.Muted) } },
        containerColor = Pal.CardSolid, shape = RoundedCornerShape(24.dp),
    )
}
