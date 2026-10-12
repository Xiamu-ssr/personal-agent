package com.xiamu.agent.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.xiamu.agent.Prefs
import com.xiamu.agent.device.*

internal val permissionRevision = mutableIntStateOf(0)

/** One runtime request, then one Health Connect page. Individual switches stay independent. */
@Composable
fun EnableAllCapabilities() {
    val c=ctx()
    var notice by remember { mutableStateOf("") }
    var requesting by remember { mutableStateOf(false) }
    val health=rememberLauncherForActivityResult(HealthAccess.permissionContract) { granted ->
        HealthAccess.updateGranted(granted)
        Prefs.setGranted("health",HealthAccess.hasPermissions(c))
        permissionRevision.intValue++; DeviceService.start(c,reregister=true)
        requesting=false
        notice=if(HealthAccess.readPermissions.any { it in granted }) "健康读取权限已开启" else "Health Connect 未授权，计步权限仍可单独使用"
    }
    fun afterRuntime() {
        Capabilities.all.forEach { Prefs.setGranted(it.name,it.hasPermissions(c)) }
        Prefs.notifyMessages=Capabilities.byName("notify")!!.hasPermissions(c)
        permissionRevision.intValue++; DeviceService.start(c,reregister=true)
        if(HealthAccess.available(c)) health.launch(HealthAccess.permissions(c))
        else { requesting=false; notice="已开启获得授权的能力；Health Connect 不可用，运动健康使用计步传感器" }
    }
    val runtime=rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { afterRuntime() }
    Column(Modifier.fillMaxWidth().padding(vertical=12.dp)) {
        GoldButton(if(requesting) "正在开启…" else "一键开启",Modifier.fillMaxWidth(),enabled=!requesting) {
            requesting=true
            val permissions=(Capabilities.all.flatMap { it.permissions } + listOf(Manifest.permission.RECORD_AUDIO,Manifest.permission.CAMERA)).distinct()
                .filter { ContextCompat.checkSelfPermission(c,it) != PackageManager.PERMISSION_GRANTED }
            if(permissions.isEmpty()) afterRuntime() else runtime.launch(permissions.toTypedArray())
        }
        if(notice.isNotBlank()) Text(notice,fontSize = Type.Label,lineHeight = Type.SecondaryLine,color=Pal.Muted,modifier=Modifier.padding(top=8.dp))
    }
}
