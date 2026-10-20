package com.xiamu.agent.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.pager.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalDensity
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
fun ModelSettingsScreen() {
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
        item { Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically) { Box(Modifier.weight(1f)) { BigTitle("模型") }; TextButton(onClick={invalidateCache("settings");revision++},enabled=!saving) { Text("刷新",color=Pal.Muted) } } }
        if(settings==null && loadError.isBlank()) item { Loading() }
        settings?.let { current ->
            item {
                val pager=rememberPagerState(initialPage=current.providers.indexOfFirst { it.id==current.model.provider }.coerceAtLeast(0),pageCount={current.providers.size+1})
                LaunchedEffect(current.model.provider) { val index=current.providers.indexOfFirst { it.id==current.model.provider }; if(index>=0 && pager.settledPage!=index) pager.animateScrollToPage(index) }
                LaunchedEffect(pager.settledPage,current.providers.getOrNull(pager.settledPage)?.id) {
                    current.providers.getOrNull(pager.settledPage)?.let { provider ->
                        if(provider.id!=current.model.provider && !saving) select(ModelSelection(provider.id,provider.models.first().id))
                    }
                }
                BoxWithConstraints(Modifier.fillMaxWidth().padding(top=12.dp)) {
                    val cardHeight=(224*LocalDensity.current.fontScale.coerceAtLeast(1f)).dp
                    HorizontalPager(state=pager,pageSpacing=12.dp,pageSize=PageSize.Fixed(maxWidth-20.dp),modifier=Modifier.height(cardHeight).testTag("provider-wallet")) { index ->
                        current.providers.getOrNull(index)?.let { provider ->
                            ProviderCard(provider,current.model.provider==provider.id) { if(!provider.builtin) Nav.open(Route.ProviderForm(provider.id)) }
                        } ?: AddProviderCard { Nav.open(Route.ProviderForm()) }
                    }
                }
                Row(Modifier.fillMaxWidth().padding(vertical=15.dp),horizontalArrangement=Arrangement.Center) {
                    repeat(current.providers.size+1) { index ->
                        Box(Modifier.padding(horizontal=3.dp).size(if(pager.currentPage==index) 7.dp else 5.dp).background(if(pager.currentPage==index) Pal.GoldInk else Pal.Line,CircleShape))
                    }
                }
                val provider=current.providers.getOrNull(pager.currentPage)
                if(provider!=null) {
                    Row(Modifier.fillMaxWidth().padding(top=8.dp,bottom=12.dp),verticalAlignment=Alignment.CenterVertically) {
                        Text("选择模型",style=Type.title(17),color=Pal.Ink,modifier=Modifier.weight(1f))
                        Text(provider.name,style=Type.body(12),color=Pal.Muted)
                    }
                    Column(Modifier.fillMaxWidth().card().selectableGroup().padding(horizontal=18.dp)) {
                        provider.models.forEachIndexed { index,model ->
                            if(index>0) Hairline()
                            val selection=ModelSelection(provider.id,model.id)
                            ModelOptionRow(model.name,model.note.ifBlank { model.id },current.model==selection,!saving,"model:${provider.id}:${model.id}") {
                                if(current.model!=selection) select(selection)
                            }
                        }
                    }
                } else FooterNote("接入新的模型服务，额度与模型一起管理。")
            }
        }
        if(loadError.isNotBlank()) item { ErrorNote(loadError); QuietButton("重新加载") { revision++ } }
        if(saveError.isNotBlank()) item { ErrorNote(saveError) }
        item { FooterNote(if(saving) "正在保存…" else "从下一轮开始生效") }
    }
}

private val CardInk=Color(0xFF49371D)

@Composable
private fun ProviderCard(provider: ModelProvider, selected: Boolean, edit: () -> Unit) {
    Box(Modifier.fillMaxSize().clip(RoundedCornerShape(24.dp))
        .background(Brush.linearGradient(listOf(Color(0xFFECD8A9),Color(0xFFF9EDCF),Color(0xFFCBB078))))
        .border(1.dp,Color.White.copy(alpha=.55f),RoundedCornerShape(24.dp))) {
        Text(provider.name.uppercase(),fontSize=Type.Page*2.6f,fontWeight=FontWeight.Black,color=CardInk.copy(alpha=.055f),maxLines=1,softWrap=false,
            modifier=Modifier.align(Alignment.CenterEnd).padding(top=48.dp))
        Column(Modifier.fillMaxSize().padding(23.dp),verticalArrangement=Arrangement.SpaceBetween) {
            Row(verticalAlignment=Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("DOUDOU  /  MODEL ACCESS",style=Type.body(9),color=CardInk.copy(alpha=.55f))
                    Text(provider.name,style=Type.title(23),color=CardInk,modifier=Modifier.padding(top=8.dp),maxLines=1,overflow=TextOverflow.Ellipsis)
                }
                if(!provider.builtin) IconButton(onClick=edit,modifier=Modifier.size(32.dp).testTag("provider-edit:${provider.id}")) { Icon(Icons.Outlined.MoreHoriz,"编辑供应商",tint=CardInk) }
            }
            Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.Bottom) {
                Column(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(5.dp)) {
                    if(provider.usage?.visible==true) {
                        provider.usage.items.firstOrNull()?.let { Text(it.label,style=Type.body(10),color=CardInk.copy(alpha=.55f)) }
                        Text(provider.usage.headline,style=if(provider.usage.items.isNotEmpty()) Type.title(25) else Type.body(13),color=CardInk)
                    } else Text("已连接",style=Type.body(13),color=CardInk.copy(alpha=.75f))
                    provider.usage?.items?.drop(1)?.take(1)?.forEach { Text("${it.label} · ${it.amount}",style=Type.body(10),color=CardInk.copy(alpha=.6f)) }
                    provider.usage?.items?.firstOrNull()?.fraction?.let { fraction ->
                        Box(Modifier.width(146.dp).height(3.dp).clip(CircleShape).background(CardInk.copy(alpha=.12f))) {
                            Box(Modifier.fillMaxWidth(fraction).fillMaxHeight().background(CardInk.copy(alpha=.65f)))
                        }
                    }
                }
                Column(horizontalAlignment=Alignment.End,verticalArrangement=Arrangement.spacedBy(8.dp)) {
                    if(selected) Text("● 使用中",style=Type.body(10),color=CardInk)
                    Text(provider.maskedKey.ifBlank { "SERVER ACCOUNT" },style=Type.body(10),color=CardInk.copy(alpha=.6f))
                }
            }
        }
    }
}

@Composable
private fun AddProviderCard(add: () -> Unit) {
    Surface(onClick=add,modifier=Modifier.fillMaxSize().testTag("provider-add"),shape=RoundedCornerShape(24.dp),color=Pal.Quiet,
        border=androidx.compose.foundation.BorderStroke(1.dp,Pal.Line)) {
        Column(horizontalAlignment=Alignment.CenterHorizontally,verticalArrangement=Arrangement.Center) {
            Icon(Icons.Outlined.Add,"添加模型服务",tint=Pal.GoldInk,modifier=Modifier.size(32.dp))
            Text("添加模型服务",style=Type.title(16),color=Pal.Ink,modifier=Modifier.padding(top=12.dp))
            Text("你的下一张卡片",style=Type.body(12),color=Pal.Muted,modifier=Modifier.padding(top=6.dp))
        }
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
