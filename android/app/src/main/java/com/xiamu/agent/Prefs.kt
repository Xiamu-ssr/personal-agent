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

    var appearance: String
        get() = sp.getString("appearance", "system") ?: "system"
        set(v) = sp.edit().putString("appearance", v).apply()
    var feedKnownPaths: Set<String>
        get() = sp.getStringSet("feedKnown.${server}",emptySet())?.toSet() ?: emptySet()
        set(v) = sp.edit().putStringSet("feedKnown.${server}",v).apply()
    var feedUnread: Boolean
        get() = sp.getBoolean("feedUnread.${server}", false)
        set(v) = sp.edit().putBoolean("feedUnread.${server}",v).apply()

    var server: String
        get() = (sp.getString("server", "") ?: "").trim().trimEnd('/')
        set(v) = sp.edit().putString("server", v.trim().trimEnd('/')).apply()

    var token: String
        get() = sp.getString("token", "")!!
        set(v) = sp.edit().putString("token", v.trim()).apply()

    var notifyMessages: Boolean
        get() = sp.getBoolean("notifyMessages", true)
        set(v) = sp.edit().putBoolean("notifyMessages", v).apply()

    val deviceId: String get() = sp.getString("deviceId", "android")!!

    val deviceName: String get() = sp.getString("deviceName", "${Build.MANUFACTURER} ${Build.MODEL}")!!

    fun granted(cap: String): Boolean = sp.getBoolean("cap.$cap", false)
    fun setGranted(cap: String, on: Boolean) = sp.edit().putBoolean("cap.$cap", on).apply()

    fun healthSeen(path: String): Long = sp.getLong("health.seen.$path", 0)
    fun markHealthSeen(path: String, at: Long = System.currentTimeMillis()) { sp.edit().putLong("health.seen.$path", at).apply() }

    val configured: Boolean get() = token.isNotBlank() && server.isNotBlank()
}
