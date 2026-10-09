package com.xiamu.agent.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.Cloud
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material.icons.outlined.Extension
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.KeyboardVoice
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.LaptopMac
import androidx.compose.material.icons.outlined.PhoneAndroid
import androidx.compose.material.icons.outlined.RssFeed
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xiamu.agent.Api
import com.xiamu.agent.Prefs
import com.xiamu.agent.device.Capabilities
import com.xiamu.agent.device.DeviceService
import com.xiamu.agent.objects
import org.json.JSONObject

private data class Connector(val name: String, val title: String, val description: String, val enabled: Boolean)
private data class Device(val id: String, val name: String, val kind: String, val online: Boolean, val lastSeen: Long, val caps: List<Connector>)
private data class Connections(val cloud: Device, val connected: List<Connector>, val catalog: List<Connector>, val others: List<Device>)

private fun connector(j: JSONObject, device: Boolean = false) = Connector(
    j.optString("name"), j.optString("title").ifBlank { j.optString("name") }, j.optString("description"),
    if (device) j.optBoolean("enabled") else j.optString("status") == "on",
)

private suspend fun connections(): Connections {
    val j = Api.getJson("/api/connectors")
    val cloud = j.getJSONObject("cloud")
    return Connections(
        Device(cloud.optString("id", "cloud"), cloud.optString("name", "云电脑"), "cloud", cloud.optBoolean("online"), 0, emptyList()),
        (cloud.optJSONArray("builtin").objects() + cloud.optJSONArray("installed").objects()).map { connector(it) },
        cloud.optJSONArray("catalog").objects().map { connector(it) },
        j.optJSONArray("devices").objects().filter { it.optString("id") != Prefs.deviceId }.map {
            Device(it.optString("id"), it.optString("name"), it.optString("kind"), it.optBoolean("online"), it.optLong("lastSeen"),
                it.optJSONArray("capabilities").objects().map { c -> connector(c, true) })
        },
    )
}

private fun connectorIcon(name: String): ImageVector = when (name) {
    "web_search", "tavily" -> Icons.Outlined.Search
    "web_fetch" -> Icons.Outlined.Language
    "shell" -> Icons.Outlined.Terminal
    "files" -> Icons.Outlined.Folder
    "schedule" -> Icons.Outlined.Schedule
    "transcribe" -> Icons.Outlined.KeyboardVoice
    "email" -> Icons.Outlined.Email
    "calendar" -> Icons.Outlined.CalendarMonth
    "github" -> Icons.Outlined.Code
    "notion" -> Icons.Outlined.Description
    "rss" -> Icons.Outlined.RssFeed
    "feishu" -> Icons.Outlined.Hub
    else -> Icons.Outlined.Extension
}

@Composable
fun ConnectorsScreen(route: Route.Connectors) {
    val ctx = ctx()
    val (data, error) = load("connectors") { connections() }
    var selected by remember(route) { mutableIntStateOf(route.tab) }
    var query by remember { mutableStateOf("") }
    val list = rememberLazyListState()
    LaunchedEffect(selected, data, route.device) {
        if (selected == 2 && route.device != null && data != null) {
            val i = data.others.indexOfFirst { it.id == route.device }
            if (i >= 0) list.animateScrollToItem(1 + i)
        }
    }
    Screen {
        Column(Modifier.fillMaxSize()) {
            SubHeader("连接应用", Nav::back)
            Column(Modifier.padding(horizontal = 20.dp)) {
                BigTitle("连接应用", "连接设备和服务，豆豆就能替你做更多事")
                SegTabs(
                    listOf("本机 · ${Capabilities.all.size}", "云端 · ${data?.let { it.connected.size + it.catalog.size } ?: "—"}",
                        "其他设备 · ${data?.others?.sumOf { it.caps.size } ?: "—"}"),
                    selected, Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 10.dp),
                ) { selected = it }
            }
            LazyColumn(
                state = list, modifier = Modifier.fillMaxSize().navigationBarsPadding(),
                contentPadding = PaddingValues(start = 20.dp, end = 20.dp, bottom = 32.dp),
            ) {
                when (selected) {
                    0 -> {
                        item { SectionTitle("本机能力") }
                        item { LocalCapabilities() }
                        item { FooterNote("只把你打开的能力交给豆豆。系统权限也可以随时收回。") }
                    }
                    1 -> {
                        item { SearchField(query, { query = it }, "搜索应用", Modifier.padding(top = 8.dp)) }
                        if (data == null) item { if (error.isNotBlank()) ErrorNote(error) else Loading() }
                        else {
                            fun matches(c: Connector) = "${c.title} ${c.description} ${c.name}".contains(query.trim(), true)
                            val connected = data.connected.filter(::matches)
                            val catalog = data.catalog.filter(::matches)
                            if (connected.isNotEmpty()) {
                                item { SectionTitle("已接入") }
                                item {
                                    CardList {
                                        connected.forEachIndexed { i, c ->
                                            if (i > 0) Hairline()
                                            ListRow(c.title, c.description, connectorIcon(c.name), Pal.Link, subLines = 2,
                                                trailing = { if (c.enabled) GoldChip("已连接") else Tag("未开启") })
                                        }
                                    }
                                }
                            }
                            if (catalog.isNotEmpty()) {
                                item { SectionTitle("可以接入") }
                                item {
                                    CardList {
                                        catalog.forEachIndexed { i, c ->
                                            if (i > 0) Hairline()
                                            ListRow(c.title, c.description, connectorIcon(c.name), Pal.Link, subLines = 2, trailing = {
                                                QuietButton("连接") { Draft.send(ctx, "帮我接入「${c.title}」连接器", includeDraft = false) }
                                            })
                                        }
                                    }
                                }
                            }
                            if (connected.isEmpty() && catalog.isEmpty()) item { EmptyNote(if (query.isBlank()) "还没有云端连接器" else "没有找到匹配的应用") }
                        }
                    }
                    else -> {
                        item { FooterNote("能力开关请去那台设备上的豆豆设置。") }
                        if (data == null) item { if (error.isNotBlank()) ErrorNote(error) else Loading() }
                        else if (data.others.isEmpty()) item {
                            EmptyNote("还没有其他设备接入")
                            SilverButton("连接更多设备", Modifier.fillMaxWidth()) { Nav.open(Route.Devices) }
                        }
                        else data.others.forEach { d ->
                            item(key = d.id) {
                                Column(Modifier.alpha(if (d.online) 1f else 0.58f)) {
                                    SectionTitle(d.name)
                                    Text(deviceStatus(d), fontSize = 12.sp, color = Pal.Muted, modifier = Modifier.padding(start = 4.dp, bottom = 10.dp))
                                    if (d.caps.isEmpty()) EmptyNote("这台设备还没有提供能力")
                                    else CardList {
                                        d.caps.forEachIndexed { i, cap ->
                                            if (i > 0) Hairline()
                                            ListRow(cap.title, cap.description, capIcon(cap.name), Pal.Link, subLines = 2,
                                                trailing = { Tag(if (cap.enabled) "已开启" else "未开启", if (cap.enabled) Pal.GoldInk else Pal.Muted) })
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

private fun deviceStatus(d: Device): String =
    if (d.online) "在线" else "离线" + if (d.lastSeen > 0) " · 上次在线 ${ago(d.lastSeen)}" else ""

@Composable
fun DevicesScreen() {
    val (data, error) = load("connectors") { connections() }
    var pairing by remember { mutableStateOf<String?>(null) }
    SubPage("设备") {
        item { BigTitle("设备", "在不同设备间，继续同一件事") }
        item {
            DeviceCard(Prefs.deviceName, if (DeviceService.online.value) "本机 · 在线" else "本机 · 连接中", "android", true) {
                Nav.open(Route.Connectors(0))
            }
        }
        if (data == null) item { if (error.isNotBlank()) ErrorNote(error) else Loading() }
        else {
            item {
                DeviceCard(data.cloud.name, deviceStatus(data.cloud), "cloud", data.cloud.online) { Nav.open(Route.Connectors(1)) }
            }
            data.others.forEach { d ->
                item {
                    DeviceCard(d.name, deviceStatus(d), d.kind, d.online) { Nav.open(Route.Connectors(2, d.id)) }
                }
            }
        }
        item { SectionTitle("连接更多设备") }
        item {
            CardList {
                ListRow("连接 Mac", icon = Icons.Outlined.LaptopMac) { pairing = "Mac" }
                Hairline()
                ListRow("连接安卓手机", icon = Icons.Outlined.PhoneAndroid) { pairing = "安卓手机" }
            }
        }
    }
    val kind = pairing
    if (kind != null) {
        val ctx = ctx()
        AlertDialog(
            onDismissRequest = { pairing = null },
            title = { Text("连接 $kind", color = Pal.Ink) },
            text = {
                Column {
                    Text("在那台设备上装豆豆，用设置里的配对码登录。", fontSize = 14.sp, lineHeight = 22.sp, color = Pal.Muted)
                    PairCode()
                    PillLink("打开安装包下载页") { openBrowser(ctx, "https://github.com/Xiamu-ssr/personal-agent/releases") }
                }
            },
            confirmButton = { TextButton(onClick = { pairing = null }) { Text("完成", color = Pal.GoldInk) } },
            containerColor = Pal.CardSolid,
            shape = RoundedCornerShape(24.dp),
        )
    }
}

@Composable
private fun DeviceCard(name: String, sub: String, kind: String, online: Boolean, onClick: () -> Unit) {
    CardList(Modifier.padding(top = 14.dp).alpha(if (online) 1f else 0.6f)) {
        ListRow(name, sub, deviceIcon(kind), Color(0xFF637DA0), subLines = 2, onClick = onClick)
    }
}

@Composable
fun SkillsScreen() {
    val (skills, error) = load("skills") { Api.getJson("/api/skills").optJSONArray("skills").objects() }
    SubPage("技能") {
        item { BigTitle("技能") }
        item {
            when {
                skills == null && error.isNotBlank() -> ErrorNote(error)
                skills == null -> Loading()
                skills.isEmpty() -> EmptyNote("豆豆把常做的事整理成技能后会出现在这里")
                else -> CardList(Modifier.padding(top = 12.dp)) {
                    skills.forEachIndexed { i, s ->
                        if (i > 0) Hairline()
                        ListRow(s.optString("name"), s.optString("description"), Icons.Outlined.Extension, Color(0xFF776AA3), subLines = 3)
                    }
                }
            }
        }
    }
}

@Composable
fun SearchField(value: String, onChange: (String) -> Unit, hint: String, modifier: Modifier = Modifier) {
    Row(
        modifier.fillMaxWidth().height(46.dp).clip(RoundedCornerShape(23.dp)).background(Color(0xA6FFFFFF)).padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        Icon(Icons.Outlined.Search, null, tint = Pal.Faint, modifier = Modifier.size(18.dp))
        BasicTextField(
            value, onChange, singleLine = true, textStyle = TextStyle(fontSize = 14.sp, color = Pal.Ink), cursorBrush = SolidColor(Pal.Gold),
            modifier = Modifier.weight(1f),
            decorationBox = { inner -> Box { if (value.isBlank()) Text(hint, fontSize = 14.sp, color = Pal.Faint); inner() } },
        )
    }
}
