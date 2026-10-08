package com.xiamu.agent

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Prefs.init(this)
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_SERVICE, "在线状态", NotificationManager.IMPORTANCE_MIN))
        nm.createNotificationChannel(NotificationChannel(CH_AGENT, "豆豆的消息", NotificationManager.IMPORTANCE_HIGH))
    }

    companion object {
        const val CH_SERVICE = "service"
        const val CH_AGENT = "agent"
    }
}
