package com.xiamu.agent.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

val CapabilityEnabled = Color(0xFF28A754)

/** Local brand-color tiles, shared by settings, catalog, details, and chat cards. */
@Composable
fun ConnectorLogo(name: String, size: Dp = 36.dp) {
    val (color,letter)=when(name) {
        "gmail" -> Color(0xFFDB4437) to "G"
        "qq-mail", "exmail" -> Color(0xFF287BE0) to "Q"
        "netease-163" -> Color(0xFFD93536) to "163"
        "netease-126" -> Color(0xFFD93536) to "126"
        "weread" -> Color(0xFF3277E5) to "读"
        "wind" -> Color(0xFFD42B39) to "W"
        "tencent-quotes" -> Color(0xFF287BE0) to null
        "github" -> Color(0xFF171717) to "G"
        "tavily" -> Color(0xFF6556D9) to "T"
        "aliyun-mail" -> Color(0xFFFF6A00) to "阿"
        "imap" -> Color(0xFF298A9A) to "M"
        "apps" -> Color(0xFF6659CF) to null
        else -> Color(0xFF5578A8) to null
    }
    ColorIconTile(color,connectorIcon(name),size,letter)
}

@Composable
fun SystemCapabilityIcon(name: String, size: Dp = 36.dp) {
    val color=when(name) {
        "battery", "sms" -> Color(0xFF28AF61)
        "notify" -> Color(0xFFEB4757)
        "location", "device" -> Color(0xFF347BE7)
        "calendar_events" -> Color(0xFFF18B2D)
        "clipboard_write", "clipboard_read" -> Color(0xFF28A9B5)
        "health" -> Color(0xFFE44F87)
        "camera" -> Color(0xFF657C98)
        "microphone", "shortcuts" -> Color(0xFF8C5BCC)
        "files", "folder" -> Color(0xFFD8A52A)
        else -> Color(0xFF6278C7)
    }
    val icon=when(name) {
        "device" -> Icons.Outlined.PhoneAndroid
        "camera" -> Icons.Outlined.PhotoCamera
        "microphone" -> Icons.Outlined.Mic
        "files" -> Icons.Outlined.Folder
        else -> capIcon(name)
    }
    ColorIconTile(color,icon,size)
}

@Composable
private fun ColorIconTile(color: Color, icon: ImageVector, size: Dp, letter: String? = null) {
    val shape=RoundedCornerShape(size*.27f)
    Box(Modifier.size(size).clip(shape).background(color).border(.5.dp,Color.White.copy(alpha=.18f),shape),contentAlignment=Alignment.Center) {
        if(letter!=null) Text(letter,color=Color.White,fontSize=(size.value*(if(letter.length>1) .35f else .49f)).sp,fontWeight=FontWeight.SemiBold)
        else Icon(icon,null,tint=Color.White,modifier=Modifier.size(size*.58f))
    }
}
