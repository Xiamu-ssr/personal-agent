package com.xiamu.agent

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import java.util.UUID

object Prefs {
    private lateinit var sp: SharedPreferences

    fun init(ctx: Context) {
        sp = ctx.getSharedPreferences("agent", Context.MODE_PRIVATE)
        if (sp.getString("deviceId", null) == null) {
            sp.edit().putString("deviceId", "android-" + UUID.randomUUID().toString().take(8)).apply()
        }
    }

    var server: String
        get() = sp.getString("server", DEFAULT_SERVER)!!.trimEnd('/')
        set(v) = sp.edit().putString("server", v.trim().trimEnd('/')).apply()

    var token: String
        get() = sp.getString("token", "")!!
        set(v) = sp.edit().putString("token", v.trim()).apply()

    var onboarded: Boolean
        get() = sp.getBoolean("onboarded", false)
        set(v) = sp.edit().putBoolean("onboarded", v).apply()

    val deviceId: String get() = sp.getString("deviceId", "android")!!

    var deviceName: String
        get() = sp.getString("deviceName", "${Build.MANUFACTURER} ${Build.MODEL}")!!
        set(v) = sp.edit().putString("deviceName", v.trim()).apply()

    fun granted(cap: String): Boolean = sp.getBoolean("cap.$cap", false)
    fun setGranted(cap: String, on: Boolean) = sp.edit().putBoolean("cap.$cap", on).apply()

    val configured: Boolean get() = token.isNotBlank() && server.isNotBlank()

    const val DEFAULT_SERVER = "https://127.0.0.1/agent"
}
