package com.xiamu.agent.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xiamu.agent.Api
import org.json.JSONObject

@Composable
fun MembershipCard(state: JSONObject?) {
    Box(Modifier.fillMaxWidth().height(180.dp).clip(RoundedCornerShape(24.dp)).background(GoldBrush)) {
        Canvas(Modifier.fillMaxSize()) {
            val gap = 12.dp.toPx()
            var x = 0f
            while(x < size.width) { var y=0f; while(y<size.height) { drawCircle(Color(0x226C4A25),.8.dp.toPx(),Offset(x,y)); y+=gap }; x+=gap }
        }
        Column(Modifier.padding(24.dp)) {
            Text("DOUDOU · PERSONAL AGENT",fontSize=10.sp,letterSpacing=2.sp,color=Pal.GoldInk.copy(alpha=.6f))
            Text("${state?.optString("userCall")?.ifBlank { null } ?: "你"} Pro",fontSize=28.sp,fontWeight=FontWeight.Bold,color=Pal.GoldInk,modifier=Modifier.padding(top=22.dp))
            val days = state?.let(Api::firstChatTime)?.let { dayDiff(it).coerceAtLeast(0)+1 } ?: 1
            Text("陪伴第 $days 天",fontSize=13.sp,color=Pal.GoldInk.copy(alpha=.8f),modifier=Modifier.padding(top=8.dp))
        }
        Box(Modifier.align(Alignment.BottomEnd).padding(20.dp).size(54.dp).border(1.dp,Pal.GoldInk.copy(alpha=.35f),CircleShape),contentAlignment=Alignment.Center) {
            Text("豆豆",fontSize=13.sp,fontWeight=FontWeight.Medium,color=Pal.GoldInk.copy(alpha=.55f))
        }
    }
}
