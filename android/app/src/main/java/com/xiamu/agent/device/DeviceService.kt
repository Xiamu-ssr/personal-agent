package com.xiamu.agent.device

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.compose.runtime.mutableStateOf
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.xiamu.agent.Api
import com.xiamu.agent.App
import com.xiamu.agent.MainActivity
import com.xiamu.agent.Prefs
import com.xiamu.agent.R
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject

/** Keeps this phone registered with the cloud body as a device, so the agent can use granted capabilities. */
class DeviceService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val main = Handler(Looper.getMainLooper())
    private var ws: WebSocket? = null
    private var retry = 0
    private var running = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startInForeground()
        running = true
        if (intent?.action == ACTION_REREGISTER) ws?.close(1000, "re-register")
        if (ws == null) connect()
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        ws?.close(1000, null)
        scope.cancel()
        online.value = false
        super.onDestroy()
    }

    private fun startInForeground() {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n: Notification = NotificationCompat.Builder(this, App.CH_SERVICE)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle("豆豆在线")
            .setContentText("这台手机已连接，豆豆可以用你授权的能力")
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        if (Prefs.granted("location") && has(android.Manifest.permission.ACCESS_COARSE_LOCATION)) {
            type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
        }
        if (Build.VERSION.SDK_INT < 34) return startForeground(1, n)
        try {
            startForeground(1, n, type)
        } catch (e: SecurityException) {
            // Started from the background (e.g. after boot): location type isn't allowed there.
            startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        }
    }

    private fun has(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    private fun enabledCaps(): List<Capability> =
        Capabilities.all.filter { c -> Prefs.granted(c.name) && c.permissions.all { has(it) } }

    private fun connect() {
        if (!Prefs.configured || !running) return
        ws = Api.http.newWebSocket(Api.wsRequest("device"), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                retry = 0
                val caps = JSONArray().apply { enabledCaps().forEach { put(it.toJson()) } }
                val device = JSONObject().put("id", Prefs.deviceId).put("name", Prefs.deviceName).put("kind", "android")
                    .put("capabilities", caps)
                webSocket.send(JSONObject().put("t", "register").put("device", device).toString())
                main.post { online.value = true }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val m = runCatching { JSONObject(text) }.getOrNull() ?: return
                if (m.optString("t") == "call") scope.launch { handleCall(webSocket, m) }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = dropped(webSocket)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = dropped(webSocket)
        })
    }

    private fun dropped(webSocket: WebSocket) {
        main.post { reconnectLater(webSocket) }
    }

    private fun reconnectLater(webSocket: WebSocket) {
        if (ws === webSocket) ws = null
        online.value = false
        if (!running) return
        val delay = (2000L shl retry.coerceAtMost(4)).coerceAtMost(60_000L)
        retry++
        main.postDelayed({ if (ws == null) connect() }, delay)
    }

    private suspend fun handleCall(webSocket: WebSocket, m: JSONObject) {
        val id = m.optString("id")
        val name = m.optString("capability")
        val args = m.optJSONObject("args") ?: JSONObject()
        val reply = JSONObject().put("t", "result").put("id", id)
        try {
            val data: Any = if (name == "__read_since") {
                val source = args.optString("source")
                if (enabledCaps().none { it.sync && it.name == source }) throw IllegalStateException("用户没有授权 $source")
                Capabilities.readSince(this, source, args.optString("cursor").takeIf { it.isNotBlank() && it != "null" },
                    args.optInt("limit", 50))
            } else {
                val cap = enabledCaps().firstOrNull { it.name == name } ?: throw IllegalStateException("用户没有授权这个能力：$name")
                cap.run(this, args)
            }
            reply.put("ok", true).put("data", data)
        } catch (e: Exception) {
            reply.put("ok", false).put("error", e.message ?: e.javaClass.simpleName)
        }
        webSocket.send(reply.toString())
    }

    companion object {
        const val ACTION_REREGISTER = "reregister"
        val online = mutableStateOf(false)

        fun start(ctx: Context, reregister: Boolean = false) {
            if (!Prefs.configured) return
            val i = Intent(ctx, DeviceService::class.java)
            if (reregister) i.action = ACTION_REREGISTER
            ContextCompat.startForegroundService(ctx, i)
        }

        fun stop(ctx: Context) = ctx.stopService(Intent(ctx, DeviceService::class.java))
    }
}

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED && Prefs.configured && Prefs.onboarded) {
            DeviceService.start(context)
        }
    }
}
