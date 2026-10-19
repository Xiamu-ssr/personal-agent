package com.xiamu.agent.device

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.compose.runtime.mutableStateOf
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.xiamu.agent.Api
import com.xiamu.agent.App
import com.xiamu.agent.Chat
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
    private var locationForeground = false
    private var account: Pair<String,String>? = null

    override fun onCreate() { super.onCreate(); active = this }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!Prefs.configured) { stopSelf(); return START_NOT_STICKY }
        startInForeground()
        StepCounter.start(this)
        scope.launch { runCatching { HealthAccess.refresh(this@DeviceService) } }
        running = true
        if (ws != null && account != (Prefs.server to Prefs.token)) {
            val old = ws
            ws = null
            old?.close(1000, "re-register")
            online.value = false
        }
        if (ws == null) connect() else if(intent?.action == ACTION_REREGISTER) ws?.let(::register)
        return START_STICKY
    }

    override fun onDestroy() {
        StepCounter.stop()
        running = false
        ws?.close(1000, null)
        ws = null
        main.removeCallbacksAndMessages(null)
        scope.cancel()
        online.value = false
        if(active === this) active = null
        super.onDestroy()
    }

    private fun startInForeground() {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n: Notification = NotificationCompat.Builder(this, App.CH_SERVICE)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(if (online.value) "豆豆在线" else "豆豆连接中")
            .setContentText(if (online.value) "已接入云端 · 豆豆可使用已授权的能力" else connectionStatus.value)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT < 34) return startForeground(1, n)
        var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        locationForeground = Capabilities.byName("location")!!.enabled(this) && (App.foreground || locationForeground)
        if (locationForeground) {
            type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
        }
        try {
            startForeground(1, n, type)
        } catch (e: SecurityException) {
            // Started from the background (e.g. after boot): location type isn't allowed there.
            startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            locationForeground = false
        }
    }

    private fun enabled(c: Capability) = c.enabled(this)
    private fun enabledCaps(): List<Capability> = Capabilities.all.filter(::enabled)

    private fun register(webSocket: WebSocket) {
        val caps = JSONArray().apply { Capabilities.all.forEach { cap ->
            put(cap.toJson(enabled(cap)).put("unavailableReason",cap.unavailableReason(this@DeviceService))
                .put("status",if(enabled(cap)) "ready" else if(Prefs.granted(cap.name)) "permission_required" else "off"))
        } }
        val device = JSONObject().put("id", Prefs.deviceId).put("name", Prefs.deviceName).put("kind", "android").put("role", Prefs.deviceRole)
            .put("capabilities", caps)
        webSocket.send(JSONObject().put("t", "register").put("device", device).toString())
    }

    private fun connect() {
        if (!Prefs.configured || !running) return
        val request = Api.wsRequest("device") ?: return
        account = Prefs.server to Prefs.token
        ws = Api.http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                main.post {
                    if (ws !== webSocket || !running || !Prefs.configured) return@post
                    retry = 0
                    online.value = false
                    connectionStatus.value = "连接已建立，等待云端确认设备"
                    register(webSocket)
                    startInForeground()
                    main.postDelayed({ if(ws === webSocket && !online.value) { webSocket.cancel(); reconnectLater(webSocket) } },15000)
                    main.postDelayed({ if (ws === webSocket) Chat.filesVersion.intValue++ }, 400)
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (ws !== webSocket || !running || !Prefs.configured) return
                val m = runCatching { JSONObject(text) }.getOrNull() ?: return
                when (m.optString("t")) {
                    "registered" -> main.post {
                        if(ws === webSocket && m.optString("id") == Prefs.deviceId) {
                            online.value = true; connectionStatus.value = "设备已接入云端"; startInForeground()
                        }
                    }
                    "call" -> scope.launch { handleCall(webSocket, m) }
                    "event" -> onEvent(m.optString("kind"), m.optString("text"))
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = dropped(webSocket)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                main.post { if(ws === webSocket) connectionStatus.value = if(response?.code == 401) "设备连接未通过认证，请重新配对" else "连接中断，正在重新接入云端" }
                dropped(webSocket)
            }
        })
    }

    private fun dropped(webSocket: WebSocket) {
        main.post { reconnectLater(webSocket) }
    }

    private fun reconnectLater(webSocket: WebSocket) {
        if (ws !== webSocket) return
        ws = null
        online.value = false
        if (!running || !Prefs.configured) return
        startInForeground()
        val delay = (2000L shl retry.coerceAtMost(4)).coerceAtMost(60_000L)
        retry++
        main.postDelayed({ if (ws == null) connect() }, delay)
    }

    /** Each say can notify while the App is in the background. */
    private fun onEvent(kind: String, text: String) {
        if (kind == "reply") onAgentEvent(this, kind, text)
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
                val cap = Capabilities.byName(name) ?: throw IllegalStateException("当前版本没有提供这个能力：$name")
                if(!cap.enabled(this)) throw IllegalStateException(cap.unavailableReason(this))
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
        val connectionStatus = mutableStateOf("正在连接云端")
        @Volatile private var active: DeviceService? = null

        fun capabilitiesChanged(ctx: Context) {
            val service = active
            if(service != null) service.main.post { service.ws?.let { service.register(it) } }
            else if(Prefs.configured) start(ctx)
        }

        internal fun onAgentEvent(ctx: Context, kind: String, text: String) {
            if (kind != "reply" || App.foreground || !Prefs.notifyMessages || text.isBlank()) return
            if (!NotificationManagerCompat.from(ctx).areNotificationsEnabled()) return
            Capabilities.notify(ctx, "豆豆", text)
        }

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
        if (intent.action == Intent.ACTION_BOOT_COMPLETED && Prefs.configured) {
            DeviceService.start(context)
        }
    }
}
