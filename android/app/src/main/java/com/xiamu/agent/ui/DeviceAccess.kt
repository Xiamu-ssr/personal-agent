package com.xiamu.agent.ui

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.compose.foundation.layout.*
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.xiamu.agent.Prefs
import com.xiamu.agent.device.Capabilities
import com.xiamu.agent.device.DeviceService
import com.xiamu.agent.device.PhoneUseService
import kotlinx.coroutines.delay

@Composable
internal fun DeviceOwnership() {
    val c = ctx()
    var role by remember { mutableStateOf(Prefs.deviceRole) }
    Column(Modifier.padding(top=14.dp)) {
        SectionTitle("这台设备属于谁")
        CardList {
            listOf("owner", "agent").forEachIndexed { i, value ->
                if(i>0) Hairline()
                ListRow(if(value=="agent") "豆豆专用" else "我日常使用",
                    if(value=="agent") "让豆豆用它操作应用、处理事务" else "平时读取信息；操作应用按我交代的任务来",
                    subLines=2,trailing={ RadioButton(role==value,null) },onClick={
                        role=value; Prefs.deviceRole=value; DeviceService.capabilitiesChanged(c)
                    })
            }
        }
    }
}

@Composable
internal fun PhoneUseAuthorization() {
    val c = ctx()
    var tick by remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) { while(true) { delay(1000); tick++ } }
    val wanted = remember(tick,permissionRevision.intValue) { Prefs.granted("phone_use") }
    val ready = remember(tick,permissionRevision.intValue) { Capabilities.byName("phone_use")!!.enabled(c) }
    fun enable() {
        Prefs.setGranted("phone_use",true); permissionRevision.intValue++
        DeviceService.capabilitiesChanged(c); PhoneUseService.openSettings(c)
    }
    Column {
        ListRow("手机操作",when {
            ready -> "已就绪 · 可观察屏幕、点击、输入和滑动"
            wanted && PhoneUseService.systemEnabled(c) -> "系统已授权，等待手机操作服务连接"
            wanted -> "还差系统授权 · 点这里开启豆豆手机操作"
            else -> "看屏幕、点击、输入和滑动；首次开启需系统授权"
        },leading={SystemCapabilityIcon("phone_use")},subLines=2,onClick={enable()},trailing={
            GoldSwitch(ready,CapabilityEnabled) { want ->
                if(want) enable() else {
                    Prefs.setGranted("phone_use",false); permissionRevision.intValue++
                    PhoneUseService.disable(); DeviceService.capabilitiesChanged(c)
                }
            }
        })
        if(wanted && !ready) {
            Column(Modifier.padding(start=14.dp,end=14.dp,bottom=14.dp)) {
                FooterNote("在系统无障碍的“已下载的应用”中打开“豆豆手机操作”。")
                QuietButton("打开无障碍设置") { PhoneUseService.openSettings(c) }
                if(Build.VERSION.SDK_INT>=33) {
                    FooterNote("若系统提示“受限设置”，进入应用信息，点右上角菜单允许受限设置，再开启“豆豆手机操作”。")
                    QuietButton("打开应用信息") { c.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.fromParts("package",c.packageName,null))) }
                }
            }
        }
    }
}

@Composable
internal fun BackgroundConnection() {
    val c=ctx()
    var unrestricted by remember { mutableStateOf(c.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(c.packageName)) }
    LaunchedEffect(Unit) { while(true) { unrestricted=c.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(c.packageName); delay(1500) } }
    Column {
        SectionTitle("后台连接")
        CardList {
            ListRow(if(DeviceService.online.value) "设备已接入云端" else "设备正在重新连接",
                if(DeviceService.online.value) "离开豆豆后，已授权的能力继续可用" else DeviceService.connectionStatus.value,
                leading={SystemCapabilityIcon("device")},subLines=2,
                trailing={QuietButton("重连") { DeviceService.start(c,reregister=true) }})
            Hairline()
            ListRow("后台运行",if(unrestricted) "已允许不受电池优化限制" else "允许后台运行，减少锁屏后断开连接",
                subLines=2,onClick={
                    val request=Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,Uri.fromParts("package",c.packageName,null))
                    try { c.startActivity(request) } catch(_:Exception) { c.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
                },trailing={Text(if(unrestricted) "已允许" else "去设置",style=Type.body(13),color=if(unrestricted) CapabilityEnabled else Pal.Muted)})
        }
    }
}
