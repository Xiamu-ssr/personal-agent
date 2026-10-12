package com.xiamu.agent.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xiamu.agent.AgentSettings
import com.xiamu.agent.Api
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
fun RuntimeSettingsScreen(permissions: Boolean) {
    val scope = rememberCoroutineScope()
    var revision by remember { mutableIntStateOf(0) }
    val (loaded, loadError) = load("settings", revision = revision) { Api.settings() }
    var saved by remember { mutableStateOf<AgentSettings?>(null) }
    LaunchedEffect(loaded) { saved = loaded }
    var saving by remember { mutableStateOf<String?>(null) }
    var saveError by remember { mutableStateOf("") }
    val settings = saved ?: loaded
    val title = if (permissions) "权限" else "模型"
    SubPage("") {
        item { BigTitle(title) }
        when {
            settings == null && loadError.isBlank() -> item { Loading() }
            settings != null -> item {
                val options = if (permissions) settings.permissionModes else settings.models
                val selected = if (permissions) settings.permissionMode else settings.model
                Column(Modifier.fillMaxWidth().padding(top = 12.dp).card().selectableGroup().padding(horizontal = 18.dp)) {
                    options.forEachIndexed { index, option ->
                        if (index > 0) Hairline()
                        Row(Modifier.fillMaxWidth().selectable(selected = selected == option.id, enabled = saving == null, role = Role.RadioButton,
                            onClick = {
                                if (selected != option.id) {
                                    saving = option.id; saveError = ""
                                    scope.launch {
                                        try {
                                            saved = if (permissions) Api.saveSettings(permissionMode = option.id) else Api.saveSettings(model = option.id)
                                            invalidateCache("settings")
                                        } catch (e: CancellationException) { throw e }
                                        catch (e: Exception) { saveError = e.message ?: "保存失败，请重试" }
                                        finally { saving = null }
                                    }
                                }
                            }).padding(vertical = 18.dp).testTag("setting:${option.id}"), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(option.label, color = Pal.Ink, fontSize = Type.Body, fontWeight = FontWeight.Medium)
                                Text(option.note, color = Pal.Muted, fontSize = Type.Label, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.padding(top = 5.dp))
                            }
                            RadioButton(selected = selected == option.id, onClick = null, enabled = saving == null,
                                colors = RadioButtonDefaults.colors(selectedColor = Pal.Gold, unselectedColor = Pal.Faint))
                        }
                    }
                }
            }
        }
        if (loadError.isNotBlank()) item {
            ErrorNote(loadError)
            QuietButton("重新加载") { revision++ }
        }
        if (saveError.isNotBlank()) item { ErrorNote(saveError) }
        item { FooterNote(if (saving != null) "正在保存…" else "从下一轮开始生效") }
    }
}
