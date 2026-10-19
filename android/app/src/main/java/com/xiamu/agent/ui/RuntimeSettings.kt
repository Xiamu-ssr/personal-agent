package com.xiamu.agent.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.xiamu.agent.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

internal fun runtimeSettingsChanged() {
    invalidateCache("settings")
    Chat.settingsVersion.intValue++
}

@Composable
fun RuntimeSettingsScreen(permissions: Boolean) {
    if(permissions) { SubPage("设备归属") { item { PermissionsPanel() } }; return }
    val scope=rememberCoroutineScope()
    var revision by remember { mutableIntStateOf(0) }
    val (loaded,loadError)=load("settings",revision=revision+Chat.settingsVersion.intValue) { Api.settings() }
    var saved by remember { mutableStateOf<AgentSettings?>(null) }
    LaunchedEffect(loaded) { saved=loaded }
    var saving by remember { mutableStateOf(false) }
    var saveError by remember { mutableStateOf("") }
    val settings=saved ?: loaded
    fun select(model: ModelSelection) {
        if(saving) return
        saving=true; saveError=""
        scope.launch {
            try { saved=Api.saveSettings(model); runtimeSettingsChanged() }
            catch(e: CancellationException) { throw e }
            catch(e: Exception) { saveError=e.message ?: "保存失败，请重试" }
            finally { saving=false }
        }
    }
    SubPage("") {
        item { BigTitle(if(permissions) "权限" else "模型") }
        if(settings==null && loadError.isBlank()) item { Loading() }
        settings?.let { current ->
            run {
                current.providers.forEach { provider ->
                    item(key="provider:${provider.id}") {
                        Row(Modifier.fillMaxWidth().padding(top=20.dp,bottom=10.dp),verticalAlignment=Alignment.CenterVertically) {
                            ProviderTile(provider.name)
                            Text(if(provider.builtin) "${provider.name}（内置）" else provider.name,style=Type.title(15),color=Pal.Ink,modifier=Modifier.weight(1f).padding(start=10.dp),maxLines=1,overflow=TextOverflow.Ellipsis)
                            if(!provider.builtin) TextButton(enabled=!saving,onClick={Nav.open(Route.ProviderForm(provider.id))}) { Text("编辑",color=Pal.Ink) }
                        }
                        Column(Modifier.fillMaxWidth().card().selectableGroup().padding(horizontal=18.dp)) {
                            provider.models.forEachIndexed { index,model ->
                                if(index>0) Hairline()
                                val selection=ModelSelection(provider.id,model.id)
                                ModelOptionRow(model.name,model.note.ifBlank { model.id },current.model==selection,!saving,"model:${provider.id}:${model.id}") {
                                    if(current.model!=selection) select(model=selection)
                                }
                            }
                        }
                    }
                }
                item { GoldButton("添加模型服务",Modifier.fillMaxWidth().padding(top=20.dp),enabled=!saving) { Nav.open(Route.ProviderForm()) } }
            }
        }
        if(loadError.isNotBlank()) item { ErrorNote(loadError); QuietButton("重新加载") { revision++ } }
        if(saveError.isNotBlank()) item { ErrorNote(saveError) }
        item { FooterNote(if(saving) "正在保存…" else "从下一轮开始生效") }
    }
}

@Composable
internal fun ProviderTile(name: String) {
    Box(Modifier.size(28.dp).background(Pal.Quiet,RoundedCornerShape(8.dp)),contentAlignment=Alignment.Center) {
        Text(name.take(1).uppercase(),style=Type.title(14),color=Pal.Ink)
    }
}

@Composable
private fun ModelOptionRow(title: String,note: String,selected: Boolean,enabled: Boolean,tag: String,onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().selectable(selected,enabled,Role.RadioButton,onClick).padding(vertical=10.dp).testTag(tag),verticalAlignment=Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title,style=Type.title(15),color=Pal.Ink,maxLines=1,overflow=TextOverflow.Ellipsis)
            Text(note,style=Type.body(12),color=Pal.Muted,maxLines=1,overflow=TextOverflow.Ellipsis,modifier=Modifier.padding(top=4.dp))
        }
        RadioButton(selected,onClick=null,enabled=enabled,colors=RadioButtonDefaults.colors(selectedColor=Pal.Accent,unselectedColor=Pal.Faint.copy(alpha=.6f)))
    }
}
