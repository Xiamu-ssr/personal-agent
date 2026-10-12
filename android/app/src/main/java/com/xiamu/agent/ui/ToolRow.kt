package com.xiamu.agent.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

/** Tool output is initially folded in both the main conversation and task conversations. */
@Composable
internal fun ToolRow(label: String, detail: String, active: Boolean = false, tag: String = "tool-row") {
    var expanded by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().testTag(tag)) {
        Row(Modifier.fillMaxWidth().tap { expanded = !expanded }.padding(vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
            if (active) CircularProgressIndicator(Modifier.size(14.dp), color = Pal.Link, strokeWidth = 1.5.dp)
            else Icon(Icons.Outlined.Terminal, null, tint = Pal.Muted, modifier = Modifier.size(16.dp))
            Text(label, style = Type.body(13), color = Pal.Muted, modifier = Modifier.weight(1f).padding(start = 9.dp), maxLines = 1)
            Icon(if (expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, if (expanded) "收起工具" else "展开工具", tint = Pal.Muted, modifier = Modifier.size(18.dp))
        }
        AnimatedVisibility(expanded) { Markdown(detail, modifier = Modifier.padding(start = 25.dp, bottom = 10.dp), fontSize = 13, color = Pal.Muted) }
    }
}
