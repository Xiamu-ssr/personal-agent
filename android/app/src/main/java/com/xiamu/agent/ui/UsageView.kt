package com.xiamu.agent.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.xiamu.agent.Usage

@Composable
internal fun UsageView(usage: Usage?, compact: Boolean = false, ink: Color = Pal.Ink) {
    if(usage==null) return
    Column(verticalArrangement=Arrangement.spacedBy(6.dp)) {
        val items=if(compact) usage.items.take(1) else usage.items
        if(items.isEmpty()) Text(usage.headline,style=Type.body(if(compact) 10 else 12),color=ink.copy(alpha=.64f))
        items.forEach { item ->
            Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween) {
                if(!compact) Text(item.label,style=Type.body(11),color=ink.copy(alpha=.64f))
                Text(item.amount,style=Type.title(if(compact) 11 else 14),color=ink)
            }
            item.fraction?.let { fraction ->
                Box(Modifier.fillMaxWidth().height(4.dp).clip(CircleShape).background(ink.copy(alpha=.12f))) {
                    Box(Modifier.fillMaxWidth(fraction).fillMaxHeight().background(if(fraction<.1f) Pal.Danger else ink.copy(alpha=.7f)))
                }
            }
            if(!compact) item.resetAt?.let { Text("${runCatching { java.time.OffsetDateTime.parse(it).atZoneSameInstant(java.time.ZoneId.systemDefault()).format(java.time.format.DateTimeFormatter.ofPattern("M月d日 HH:mm")) }.getOrDefault(it)} 恢复",style=Type.body(10),color=ink.copy(alpha=.6f)) }
        }
        if(usage.status=="partial") Text(usage.message,style=Type.body(10),color=ink.copy(alpha=.6f))
    }
}
