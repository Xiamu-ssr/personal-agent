package com.xiamu.agent.ui

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.*
import com.xiamu.agent.*
import kotlinx.coroutines.*

@Composable
fun IdeasScreen(bottom: Dp) {
    val scope=rememberCoroutineScope()
    val (ideas,error)=load("ideas") { Api.ideas() }
    var notice by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    LazyColumn(Modifier.fillMaxSize(),contentPadding=pagePadding(bottom)) {
        item { Row(Modifier.fillMaxWidth().padding(top=8.dp,bottom=8.dp),verticalAlignment=Alignment.CenterVertically) {
            Text("新想法",style=Type.body(13),color=Pal.Muted,modifier=Modifier.weight(1f))
            QuietButton("换一批") { if(!sending) { sending=true; scope.launch {
                try { val r=Api.postJson("/api/ideas/refresh"); notice=if(r.optString("mode")=="skipped") "正在想新点子" else "豆豆正在想新点子，准备好会放在这里" }
                catch(e: CancellationException) { throw e } catch(e: Exception) { notice=e.message ?: "换批失败" } finally { sending=false }
            } } }
        } }
        if(ideas==null) item { if(error.isBlank()) Loading() else ErrorNote(error) }
        if(ideas?.groups?.isEmpty()==true) item { EmptyNote("聊得越多，点子就越贴近你。") }
        ideas?.groups?.forEach { group ->
            item { SectionTitle(group.name) }
            group.items.forEach { idea -> item(key=idea.id) {
                Row(Modifier.fillMaxWidth().tap {
                    Draft.reference(ChatQuote.from(idea, ideas.revision, group.name))
                }.padding(horizontal=4.dp,vertical=18.dp),horizontalArrangement=Arrangement.spacedBy(14.dp)) {
                    Text(idea.icon.ifBlank { "💡" },fontSize=23.sp)
                    Column(Modifier.weight(1f)) { Text(idea.title,style=Type.title(16),color=Pal.Ink); Text(idea.description,style=Type.body(13),color=Pal.Muted,modifier=Modifier.padding(top=5.dp)) }
                    Icon(Icons.Outlined.NorthWest,null,tint=Pal.Muted,modifier=Modifier.padding(top=4.dp).size(15.dp))
                }
                Hairline()
            } }
        }
        if(notice.isNotBlank()) item { FooterNote(notice) }
    }
}

private val domainIcons=listOf(Icons.Outlined.FavoriteBorder,Icons.Outlined.PeopleOutline,Icons.Outlined.AttachMoney,Icons.Outlined.Business,Icons.Outlined.Palette,Icons.Outlined.LaptopMac,Icons.Outlined.Adjust)
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GoalsScreen(bottom: Dp) {
    val (json,error)=load("goals") { Api.goals() }
    val goals=remember(json) { json?.optJSONArray("items").objects().mapNotNull { runCatching { Goal.from(it) }.getOrNull() } }
    var domain by remember { mutableStateOf<String?>(null) }
    val context=ctx()
    LazyColumn(Modifier.fillMaxSize(),contentPadding=pagePadding(bottom)) {
        item { SectionTitle("正在跟进") }
        if(json==null) item { if(error.isBlank()) Loading() else ErrorNote(error) }
        if(json!=null && goals.orEmpty().none { it.status !in listOf("已完成","取消") }) item { EmptyNote("从一个小目标开始，豆豆陪你跟进。") }
        goals.orEmpty().filter { it.status !in listOf("已完成","取消") }.forEach { goal -> item(key=goal.name) {
            Column(Modifier.fillMaxWidth().tap { Nav.open(Route.GoalDetail(goal.name)) }.padding(horizontal=4.dp,vertical=18.dp)) {
                Row { Text(goal.title,style=Type.title(16),color=Pal.Ink,modifier=Modifier.weight(1f)); Text("${goal.progress}%",style=Type.body(13),color=Pal.Muted) }
                LinearProgressIndicator(progress={goal.progress/100f},color=Pal.Accent,trackColor=Pal.Line,modifier=Modifier.fillMaxWidth().padding(top=12.dp,bottom=9.dp).height(3.dp))
                Text("${goal.status} · 下次跟进 ${checkinLabel(goal.nextCheckin)}",style=Type.body(12),color=Pal.Muted)
            }
            Hairline()
        } }
        val errors=json?.optJSONArray("errors").objects()
        if(errors.isNotEmpty()) item { ErrorNote(errors.joinToString("\n") { "${it.optString("name")}：${it.optString("error")}" }) }
        item { SectionTitle("创建目标"); Text("一起聊清楚你想做的事，定好计划，再按你的节奏跟进。",style=Type.body(13),color=Pal.Muted,modifier=Modifier.padding(bottom=12.dp)) }
        Goal.domains.forEachIndexed { i,name -> item { ListRow(name,icon=domainIcons[i],trailing={Icon(Icons.Outlined.Add,null,tint=Pal.Muted,modifier=Modifier.size(20.dp))},onClick={domain=name}) } }
    }
    domain?.let { name -> ModalBottomSheet(onDismissRequest={domain=null},containerColor=Pal.Card) {
        Column(Modifier.padding(horizontal=20.dp).padding(bottom=24.dp).navigationBarsPadding()) {
            Text("创建${name}目标",style=Type.title(20),color=Pal.Ink)
            Text("先在聊天中一起完善目标。豆豆会问几个问题，了解你的想法，定好计划、步骤和跟进频率。",style=Type.body(15),color=Pal.Ink,modifier=Modifier.padding(vertical=16.dp))
            Text("定好后，你可以在这里查看进度。",style=Type.body(13),color=Pal.Muted)
            GoldButton("开始吧",Modifier.fillMaxWidth().padding(top=20.dp)) { domain=null; Draft.send(context,"我想立一个${name}方面的目标",includeDraft=false) }
        }
    } }
}
private fun checkinLabel(value: String?): String = value?.let { runCatching { java.time.OffsetDateTime.parse(it).atZoneSameInstant(java.time.ZoneId.systemDefault()).format(java.time.format.DateTimeFormatter.ofPattern("M月d日 HH:mm")) }.getOrDefault(it) } ?: "暂无安排"
@Composable
fun GoalDetailScreen(name: String) {
    val (goal,error)=load("goal:$name") { Api.goal(name) }
    val context=ctx()
    SubPage("目标详情") {
        if(goal==null) item { if(error.isBlank()) Loading() else ErrorNote(error) }
        goal?.let { g ->
            item { BigTitle(g.title,g.domain); Spacer(Modifier.height(12.dp)); Tag(g.status); Text("${g.progress}%",style=Type.title(28),color=Pal.Ink,modifier=Modifier.padding(top=18.dp)); LinearProgressIndicator(progress={g.progress/100f},modifier=Modifier.fillMaxWidth().padding(vertical=12.dp),color=Pal.Ink,trackColor=Pal.Line); Text("下次跟进 · ${checkinLabel(g.nextCheckin)}",style=Type.body(13),color=Pal.Muted); g.due?.let { Text("截止 · $it",style=Type.body(13),color=Pal.Muted) } }
            item { Column(Modifier.padding(top=24.dp).card().padding(18.dp)) { Markdown(g.body) } }
            item { GoldButton("聊聊这个目标",Modifier.fillMaxWidth().padding(top=20.dp)) { Draft.send(context,"我想聊聊「${g.title}」这个目标",includeDraft=false) } }
        }
    }
}

@Composable
fun LibraryScreen(bottom: Dp) {
    val (library,error)=load("library",revision=Chat.libraryVersion.intValue,watchFiles=false) { Api.library() }
    val context=ctx()
    val scope=rememberCoroutineScope()
    var selected by remember { mutableStateOf<Artifact?>(null) }
    var section by remember {mutableStateOf(0)}
    val artifacts=library?.artifacts.orEmpty().filter{section==0 || (section==1&&it.kind=="site") || (section==2&&it.kind=="document")}
    val media=library?.media.orEmpty().filter{section==0 || it.kind==when(section){3->"image";4->"video";5->"audio";else->""}}
    LazyColumn(Modifier.fillMaxSize(),contentPadding=pagePadding(bottom)) {
        item {SegTabs(listOf("全部","站点","文档","图片","视频","音频"),section,modifier=Modifier.padding(bottom=16.dp),onSelect={section=it})}
        if(library==null) item { if(error.isBlank()) Loading() else ErrorNote(error) }
        if(library!=null && artifacts.isEmpty() && section in 1..2) item {EmptyNote(if(section==1)"豆豆制作的站点会放在这里。" else "报告与文档会放在这里。")}
        artifacts.chunked(2).forEach { row -> item(key=row.first().path) { Row(Modifier.padding(bottom=14.dp),horizontalArrangement=Arrangement.spacedBy(12.dp)) {
            row.forEach { a -> Column(Modifier.weight(1f).testTag("library-artifact:${a.path}").clip(RoundedCornerShape(20.dp)).background(Pal.Card).tap {
                if(a.kind=="document" && a.files.size>1) selected=a
                else if(a.path.isNotBlank()) scope.launch { runCatching { openFile(context,a.path,a.name) }.onFailure { Chat.error.value="文件暂不可用" } }
            }) {
                if(a.thumbnail!=null) ContentImage(a.thumbnail,Modifier.fillMaxWidth().height(132.dp).clip(RoundedCornerShape(topStart=20.dp,topEnd=20.dp)),scale=ContentScale.Crop,alignment=Alignment.TopCenter) else Box(Modifier.fillMaxWidth().height(132.dp),contentAlignment=Alignment.Center) { Icon(Icons.Outlined.Description,null,tint=Pal.Muted,modifier=Modifier.size(36.dp)) }
                Text(a.name,style=Type.title(14),color=Pal.Ink,maxLines=2,overflow=TextOverflow.Ellipsis,modifier=Modifier.padding(start=12.dp,end=12.dp,top=10.dp).testTag("artifact-title:${a.path}"))
                Text(if(a.kind=="site") "站点" else "文档",style=Type.body(12),color=Pal.Muted,modifier=Modifier.padding(start=12.dp,end=12.dp,top=3.dp,bottom=12.dp))
            } }
            if(row.size==1) Spacer(Modifier.weight(1f))
        } } }
        if(section==0&&media.isNotEmpty())item {SectionTitle("影音")}
        if(library!=null&&media.isEmpty()&&section>=3)item{EmptyNote("交付的内容会放在这里。")}
        media.chunked(3).forEach { row -> item(key=row.first().path) { Row(Modifier.padding(bottom=5.dp),horizontalArrangement=Arrangement.spacedBy(5.dp)) {
            row.forEach { m -> Box(Modifier.weight(1f).aspectRatio(1f).clip(RoundedCornerShape(12.dp)).background(Pal.Card).tap {
                if(m.kind=="image") Nav.open(Route.Image(m.path)) else selected=Artifact(m.name,m.path,"media",0,null,listOf(m))
            },contentAlignment=Alignment.Center) {
                if(m.kind=="image") ContentImage(m.path,Modifier.fillMaxSize())
                else Column(horizontalAlignment=Alignment.CenterHorizontally) { Icon(if(m.kind=="video") Icons.Outlined.PlayCircle else Icons.Outlined.Audiotrack,null,tint=Pal.Ink); Text(m.name,style=Type.body(11),color=Pal.Muted,maxLines=2,modifier=Modifier.padding(8.dp)) }
            } }
            repeat(3-row.size) { Spacer(Modifier.weight(1f)) }
        } } }
    }
    selected?.let { a -> androidx.compose.ui.window.Dialog(onDismissRequest={selected=null}) { Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(24.dp)).background(Pal.Background).padding(18.dp)) {
        Text(a.name,style=Type.title(17),color=Pal.Ink); MediaViews(a.files); RowActions("关闭") { selected=null }
    } } }
}
