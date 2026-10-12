package com.xiamu.agent.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.xiamu.agent.Skin

@Composable
fun SkinsScreen() {
    SubPage("皮肤") {
        item { BigTitle("皮肤", "点一下，马上换个心情") }
        item {
            CardList {
                Skin.entries.forEachIndexed { index, skin ->
                    if (index > 0) Hairline()
                    val selected = SkinState.current.value == skin
                    Row(Modifier.fillMaxWidth().selectable(selected, role = Role.RadioButton, onClick = { SkinState.select(skin) })
                        .testTag("skin:${skin.id}").padding(vertical = 20.dp), verticalAlignment = Alignment.CenterVertically) {
                        Row(Modifier.size(70.dp, 42.dp).background(Color(skin.colors.background), RoundedCornerShape(10.dp))
                            .padding(7.dp), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                            Box(Modifier.weight(1f).fillMaxHeight().background(Color(skin.colors.card), RoundedCornerShape(5.dp)))
                            Box(Modifier.width(9.dp).fillMaxHeight().background(Color(skin.colors.accent), RoundedCornerShape(5.dp)))
                        }
                        Column(Modifier.weight(1f).padding(start = 16.dp)) {
                            Text(skin.label, style = Type.title(17), color = Pal.Ink)
                            Text(when (skin) { Skin.Silver -> "清爽银蓝，轻轻一点金"; Skin.Paper -> "米白纸色，朱砂与宋体"; Skin.Night -> "柔和夜色，薄荷与琥珀" }, style = Type.body(13), color = Pal.Muted)
                        }
                        if (selected) Icon(Icons.Outlined.Check, "已选择", tint = Pal.Link)
                    }
                }
            }
        }
        item { FooterNote("仅保存在这台手机上") }
    }
}
