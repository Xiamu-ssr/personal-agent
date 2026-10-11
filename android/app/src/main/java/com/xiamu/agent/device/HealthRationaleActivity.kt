package com.xiamu.agent.device

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xiamu.agent.ui.*

/** Required privacy link for both the provider APK and Android 14+ Health Connect. */
class HealthRationaleActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { AgentTheme { Screen { Column(Modifier.fillMaxSize().statusBarsPadding().padding(24.dp)) {
            Text("运动健康数据",fontSize=24.sp,color=Pal.Ink)
            Text("开启后，豆豆可读取 Health Connect 的步数、睡眠、心率与心率变异性，用于你请求的健康回顾和健康简报。数据会返回你登录的个人云端服务。",fontSize=15.sp,lineHeight=25.sp,color=Pal.Muted,modifier=Modifier.padding(top=20.dp))
            Text("没有健康数据时，使用手机计步传感器记录开启后的步数。你可以在「连接应用 → 本机」关闭运动健康，也可以在 Health Connect 随时撤销读取权限。",fontSize=15.sp,lineHeight=25.sp,color=Pal.Muted,modifier=Modifier.padding(top=16.dp))
            GoldButton("返回",Modifier.fillMaxWidth().padding(top=24.dp)) { finish() }
        } } } }
    }
}
