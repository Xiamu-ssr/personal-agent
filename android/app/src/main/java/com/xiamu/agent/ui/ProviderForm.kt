package com.xiamu.agent.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.xiamu.agent.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
fun ProviderFormScreen(id: String?) {
    val editing=id!=null
    val scope=rememberCoroutineScope()
    val focus=LocalFocusManager.current
    var name by remember { mutableStateOf("") }
    var baseUrl by remember { mutableStateOf("") }
    var protocol by remember { mutableStateOf("anthropic") }
    var apiKey by remember { mutableStateOf("") }
    var shown by remember { mutableStateOf(false) }
    var hint by remember { mutableStateOf("") }
    val models=remember { mutableStateListOf(ProviderModel("","")) }
    var presets by remember { mutableStateOf<List<ProviderPreset>>(emptyList()) }
    var presetId by remember { mutableStateOf("") }
    var presetMenu by remember { mutableStateOf(false) }
    var details by remember { mutableStateOf(editing) }
    var expandedModels by remember { mutableStateOf(editing) }
    var loading by remember { mutableStateOf(true) }
    var ready by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var confirmDelete by remember { mutableStateOf(false) }
    var revision by remember { mutableIntStateOf(0) }
    fun choosePreset(preset: ProviderPreset?) {
        if(ready && presetId==preset?.id.orEmpty()) return
        presetId=preset?.id.orEmpty(); name=preset?.name.orEmpty(); baseUrl=preset?.baseUrl.orEmpty(); protocol=preset?.protocol ?: "openai"
        models.clear(); models.addAll(preset?.models ?: listOf(ProviderModel("","")))
        apiKey=""; shown=false; error=""; details=preset==null; expandedModels=preset==null
    }
    LaunchedEffect(id,revision) {
        loading=true
        try {
            val settings=Api.settings(); presets=settings.providerPresets
            if(id!=null) {
                val provider=settings.providers.firstOrNull { it.id==id && !it.builtin } ?: kotlin.error("找不到这个模型服务")
                name=provider.name; protocol=provider.protocol; baseUrl=provider.baseUrl.orEmpty(); hint=provider.maskedKey
                models.clear(); models.addAll(provider.models)
            } else choosePreset(presets.firstOrNull())
            ready=true; error=""
        } catch(e: CancellationException) { throw e }
        catch(e: Exception) { error=e.message ?: "加载失败" }
        finally { loading=false }
    }
    DisposableEffect(Unit) { onDispose { apiKey="" } }
    val progress=if(deleting) "正在删除…" else "正在测试并保存…"
    Screen {
        Column(Modifier.fillMaxSize().navigationBarsPadding().imePadding()) {
            SubHeader(if(editing) "编辑模型服务" else "添加模型服务",Nav::back)
            LazyColumn(Modifier.weight(1f),contentPadding=PaddingValues(horizontal=20.dp,vertical=12.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
                if(loading) item { Loading() }
                if(ready) {
                    if(!editing && presets.isNotEmpty()) item {
                        Box {
                            TextButton(onClick={presetMenu=true},enabled=!saving,modifier=Modifier.fillMaxWidth().card().testTag("provider-preset")) {
                                Text("供应商",style=Type.body(13),color=Pal.Muted)
                                Spacer(Modifier.weight(1f)); Text(presets.firstOrNull { it.id==presetId }?.name ?: "自定义",style=Type.title(15),color=Pal.Ink)
                                Icon(Icons.Outlined.ExpandMore,null,tint=Pal.Muted)
                            }
                            DropdownMenu(expanded=presetMenu,onDismissRequest={presetMenu=false},modifier=Modifier.heightIn(max=360.dp)) {
                                presets.forEach { preset -> DropdownMenuItem(text={Text(preset.name)},onClick={choosePreset(preset);presetMenu=false},
                                    trailingIcon={if(preset.id==presetId) Icon(Icons.Outlined.Check,null,tint=Pal.Accent)}) }
                                DropdownMenuItem(text={Text("自定义")},onClick={choosePreset(null);presetMenu=false})
                            }
                        }
                        presets.firstOrNull { it.id==presetId }?.let { Text(it.hint,style=Type.body(12),color=Pal.Muted,modifier=Modifier.padding(top=8.dp,start=4.dp)) }
                    }
                    item {
                        ProviderField("API Key",apiKey,{apiKey=it},if(editing) "留空保持不变" else "请输入 API Key",!saving,
                            keyboard=KeyboardType.Password,password=!shown,trailing={
                                IconButton(enabled=!saving,onClick={shown=!shown}) { Icon(if(shown) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,if(shown) "隐藏 API Key" else "显示 API Key",tint=Pal.Muted) }
                            })
                        if(editing && hint.isNotBlank()) Text("当前 Key：$hint · 留空保持不变",style=Type.body(12),color=Pal.Muted,modifier=Modifier.padding(top=6.dp,start=4.dp))
                    }
                    item { TextButton(onClick={details=!details},enabled=!saving,modifier=Modifier.testTag("provider-details")) {
                        Text("服务设置",color=Pal.Ink); Icon(if(details) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore,null,tint=Pal.Muted)
                    } }
                    if(details) {
                    item { ProviderField("名称",name,{name=it},"例如：我的模型服务",!saving) }
                    item { ProviderField("Base URL",baseUrl,{baseUrl=it},"https://example.test",!saving,keyboard=KeyboardType.Uri) }
                    item { Row(Modifier.fillMaxWidth().card().padding(16.dp),verticalAlignment=Alignment.CenterVertically) {
                        Text("协议",style=Type.body(13),color=Pal.Muted,modifier=Modifier.weight(1f)); TextButton(onClick={protocol=if(protocol=="anthropic") "openai" else "anthropic"}) { Text(if(protocol=="anthropic") "Anthropic" else "OpenAI",color=Pal.Ink) }
                    } }
                    }
                    item {
                        val names=models.map { it.name }.filter { it.isNotBlank() }
                        Text(names.take(3).joinToString(" · ") + if(names.size>3) " 等 ${names.size} 个模型" else "",style=Type.body(12),color=Pal.Muted)
                        TextButton(onClick={expandedModels=!expandedModels},enabled=!saving,modifier=Modifier.testTag("provider-models")) {
                            Text("模型（${models.size}）",color=Pal.Ink); Icon(if(expandedModels) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore,null,tint=Pal.Muted)
                        }
                    }
                    if(expandedModels) {
                    models.forEachIndexed { index,model -> item(key="model:$index") {
                        Column(Modifier.fillMaxWidth().card().padding(14.dp),verticalArrangement=Arrangement.spacedBy(10.dp)) {
                            Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically) {
                                Text("模型 ${index+1}",style=Type.title(14),color=Pal.Ink,modifier=Modifier.weight(1f))
                                if(models.size>1) IconButton(enabled=!saving,onClick={models.removeAt(index)},modifier=Modifier.size(28.dp)) {
                                    Icon(Icons.Outlined.Close,"删除模型 ${index+1}",tint=Pal.Muted,modifier=Modifier.size(18.dp))
                                }
                            }
                            ProviderField("模型 ID ${index+1}",model.id,{models[index]=models[index].copy(id=it)},"模型 ID，例如 claude-sonnet",!saving,showLabel=false)
                            ProviderField("显示名 ${index+1}",model.name,{models[index]=models[index].copy(name=it)},"模型显示名",!saving,showLabel=false)
                        }
                    } }
                    item { TextButton(enabled=!saving && models.size<20,onClick={models.add(ProviderModel("",""))}) { Icon(Icons.Outlined.Add,null,tint=Pal.Ink,modifier=Modifier.size(18.dp)); Text("添加模型",color=Pal.Ink) } }
                    item { Text("保存前会用第一个模型测试连接。",style=Type.body(12),color=Pal.Muted) }
                    }
                }
            }
            Column(Modifier.fillMaxWidth().padding(horizontal=20.dp,vertical=10.dp)) {
                if(error.isNotBlank()) ErrorNote(error)
                if(!ready && !loading) QuietButton("重新加载") { revision++ }
                if(saving) Row(Modifier.padding(bottom=12.dp),verticalAlignment=Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(16.dp),color=Pal.Ink,strokeWidth=2.dp)
                    Text(progress,style=Type.body(13),color=Pal.Muted,modifier=Modifier.padding(start=10.dp))
                }
                GoldButton(if(saving) progress else "测试并保存",Modifier.fillMaxWidth(),enabled=ready && !saving) {
                    if(saving || !ready) return@GoldButton
                    val draft=ProviderDraft(name,baseUrl,models.toList(),ProviderKey(apiKey),protocol)
                    val invalid=draft.validate(editing)
                    if(invalid!=null) error=invalid else {
                        focus.clearFocus(); saving=true; error=""
                        scope.launch {
                            try { Api.saveProvider(id,draft); apiKey=""; runtimeSettingsChanged(); Nav.back() }
                            catch(e: CancellationException) { throw e }
                            catch(e: Exception) { error=providerError(e.message,draft.apiKey) }
                            finally { saving=false }
                        }
                    }
                }
                if(editing && ready) TextButton(enabled=!saving,onClick={confirmDelete=true},modifier=Modifier.align(Alignment.CenterHorizontally)) { Text("删除服务",color=Pal.Ink) }
            }
        }
    }
    if(confirmDelete) AlertDialog(onDismissRequest={confirmDelete=false},title={Text("删除模型服务？")},text={Text("将移除这个服务及其模型。")},
        confirmButton={TextButton(onClick={
            if(saving) return@TextButton
            confirmDelete=false; saving=true; deleting=true; error=""
            scope.launch {
                try { Api.deleteProvider(id!!); runtimeSettingsChanged(); Nav.back() }
                catch(e: CancellationException) { throw e }
                catch(e: Exception) { error=e.message ?: "删除失败" }
                finally { saving=false; deleting=false }
            }
        }) { Text("删除") }},dismissButton={TextButton(onClick={confirmDelete=false}) { Text("取消") }})
}

@Composable
private fun ProviderField(label: String,value: String,onChange: (String) -> Unit,hint: String,enabled: Boolean,
    keyboard: KeyboardType = KeyboardType.Text,password: Boolean = false,showLabel: Boolean = true,trailing: (@Composable () -> Unit)? = null) {
    var focused by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().background(Pal.Field,RoundedCornerShape(16.dp))
        .border(if(focused) 1.dp else .5.dp,if(focused) Pal.Accent.copy(alpha=.5f) else Pal.Line,RoundedCornerShape(16.dp))
        .padding(start=14.dp,end=if(trailing==null) 14.dp else 4.dp,top=11.dp,bottom=11.dp)) {
        if(showLabel) Text(label,style=Type.body(12),color=Pal.Muted,modifier=Modifier.padding(bottom=5.dp))
        Row(verticalAlignment=Alignment.CenterVertically) {
            BasicTextField(value,onChange,enabled=enabled,singleLine=true,textStyle=Type.body(15).copy(color=Pal.Ink),cursorBrush=SolidColor(Pal.Ink),
                keyboardOptions=KeyboardOptions(autoCorrectEnabled=false,keyboardType=keyboard),visualTransformation=if(password) PasswordVisualTransformation() else VisualTransformation.None,
                modifier=Modifier.weight(1f).heightIn(min=24.dp).onFocusChanged { focused=it.isFocused }.testTag("provider-field:$label").semantics { contentDescription=label },
                decorationBox={inner -> Box(contentAlignment=Alignment.CenterStart) { if(value.isEmpty()) Text(hint,style=Type.body(15),color=Pal.Faint); inner() } })
            trailing?.invoke()
        }
    }
}
