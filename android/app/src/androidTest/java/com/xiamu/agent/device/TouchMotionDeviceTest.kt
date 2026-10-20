package com.xiamu.agent.device

import android.app.UiAutomation
import android.content.ComponentName
import android.os.ParcelFileDescriptor
import android.provider.Settings
import android.view.MotionEvent
import android.view.WindowManager
import android.util.DisplayMetrics
import android.graphics.Bitmap
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.xiamu.agent.Prefs
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlin.math.abs
import kotlin.math.hypot

@RunWith(AndroidJUnit4::class)
class TouchMotionDeviceTest {
    @Test fun nativeTouchSequencesAndCancellation() = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val automation = instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
        val context = instrumentation.targetContext
        Prefs.init(context)
        Prefs.setGranted("phone_use",true)
        // Instrumentation restarts the target process; rebind its native accessibility service.
        val component = ComponentName(context,PhoneUseService::class.java).flattenToString()
        val enabled = Settings.Secure.getString(context.contentResolver,"enabled_accessibility_services").orEmpty().split(':').filter { it.isNotBlank() && it != component }
        fun shell(command: String) { ParcelFileDescriptor.AutoCloseInputStream(automation.executeShellCommand(command)).use { it.readBytes() } }
        if(enabled.isEmpty()) shell("settings delete secure enabled_accessibility_services")
        else shell("settings put secure enabled_accessibility_services ${enabled.joinToString(":")}")
        delay(500) // Settings observers must see the disabled state before the rebind.
        shell("settings put secure enabled_accessibility_services ${(enabled+component).joinToString(":")}")
        shell("settings put secure accessibility_enabled 1")
        withTimeout(12000) { while(!PhoneUseService.ready()) delay(100) }
        val scenario = ActivityScenario.launch(TouchProbeActivity::class.java)
        lateinit var probe: TouchProbeActivity
        scenario.onActivity { probe = it }
        val results = JSONArray()
        fun samples() = synchronized(probe.events) { probe.events.toList() }
        suspend fun observe(): JSONObject {
            delay(160)
            return PhoneUseService.execute(JSONObject().put("op","snapshot")) as JSONObject
        }
        suspend fun movement(fromX: Double,fromY: Double,toX: Double,toY: Double,duration: Long) {
            val frame = observe()
            val width = frame.getInt("width"); val height = frame.getInt("height")
            synchronized(probe.events) { probe.events.clear() }
            PhoneUseService.execute(JSONObject().put("op","swipe").put("frame",frame.getString("frame"))
                .put("from",JSONObject().put("x",width*fromX).put("y",height*fromY))
                .put("to",JSONObject().put("x",width*toX).put("y",height*toY)).put("duration",duration))
            delay(100)
            val events = samples()
            assertEquals(1,events.count { it.action == MotionEvent.ACTION_DOWN })
            assertEquals(1,events.count { it.action == MotionEvent.ACTION_UP })
            assertEquals(0,events.count { it.action == MotionEvent.ACTION_CANCEL })
            assertTrue(events.size > 5)
            val first = events.first(); val last = events.last()
            val dx = last.x-first.x; val dy = last.y-first.y
            val length = hypot(dx.toDouble(),dy.toDouble())
            val bend = events.maxOf { abs((it.x-first.x)*dy-(it.y-first.y)*dx) / length }
            // Raw touch coordinates and image coordinates use the same long-edge scaling.
            val metrics = DisplayMetrics()
            @Suppress("DEPRECATION")
            context.getSystemService(WindowManager::class.java).defaultDisplay.getRealMetrics(metrics)
            val scale = minOf(1.0,1440.0/maxOf(metrics.widthPixels,metrics.heightPixels))
            assertEquals(width*toX/scale,last.x.toDouble(),3.0)
            assertEquals(height*toY/scale,last.y.toDouble(),3.0)
            assertTrue("Touch path must curve between exact endpoints",bend > .1)
            results.put(JSONObject().put("moves",events.size).put("down",1).put("up",1).put("maxBendPixels",bend)
                .put("elapsedMs",last.time-first.time).put("requestedMs",duration).put("targetErrorPixels",hypot(last.x-width*toX/scale,last.y-height*toY/scale)))
        }
        try {
            movement(.5,.75,.5,.30,450)
            movement(.5,.30,.5,.75,450)
            movement(.2,.5,.8,.5,450)
            movement(.8,.5,.2,.5,450)
            movement(.2,.7,.8,.3,600)
            val screen = automation.takeScreenshot()
            File(context.filesDir,"touch-path.png").outputStream().use { screen.compress(Bitmap.CompressFormat.PNG,100,it) }
            screen.recycle()
            val snapshot = observe()
            val node = snapshot.getJSONArray("nodes").let { nodes -> (0 until nodes.length()).map { nodes.getJSONObject(it) }.first { it.optString("label").contains("触摸验收") } }
            synchronized(probe.events) { probe.events.clear() }
            PhoneUseService.execute(JSONObject().put("op","scroll").put("ref",node.getString("ref")).put("direction","down"))
            delay(100)
            assertEquals(1,samples().count { it.action == MotionEvent.ACTION_DOWN })
            assertEquals(1,samples().count { it.action == MotionEvent.ACTION_UP })
            val frame = observe()
            synchronized(probe.events) { probe.events.clear() }
            val job = launch {
                PhoneUseService.execute(JSONObject().put("op","swipe").put("frame",frame.getString("frame"))
                    .put("from",JSONObject().put("x",frame.getInt("width")*.5).put("y",frame.getInt("height")*.7))
                    .put("to",JSONObject().put("x",frame.getInt("width")*.5).put("y",frame.getInt("height")*.3)).put("duration",1800))
            }
            delay(220); job.cancelAndJoin()
            assertEquals(MotionEvent.ACTION_UP,samples().lastOrNull()?.action)
            // Start immediately: cancellation must not leave a late callback that cancels this stroke.
            PhoneUseService.execute(JSONObject().put("op","swipe").put("frame",frame.getString("frame"))
                .put("from",JSONObject().put("x",frame.getInt("width")*.3).put("y",frame.getInt("height")*.5))
                .put("to",JSONObject().put("x",frame.getInt("width")*.7).put("y",frame.getInt("height")*.5)).put("duration",400))
            assertEquals(2,samples().count { it.action == MotionEvent.ACTION_DOWN })
            assertEquals(2,samples().count { it.action == MotionEvent.ACTION_UP })
            assertEquals(0,samples().count { it.action == MotionEvent.ACTION_CANCEL })
            val file = File(context.filesDir,"touch-acceptance.json")
            file.writeText(JSONObject().put("ok",true).put("continuousCurvedGestures",results).put("nodeScroll",true).put("cancelReleasesTouch",true).put("immediateNextGesture",true).toString(2))
        } finally { scenario.close() }
    }
}
