package com.xiamu.agent

import android.content.Context
import android.hardware.SensorManager
import android.hardware.Sensor
import android.graphics.Bitmap
import android.content.Intent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.records.*
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.records.metadata.Device
import androidx.health.connect.client.permission.HealthPermission
import com.xiamu.agent.device.*
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.time.LocalDate
import java.io.File
import java.time.Instant

@RunWith(AndroidJUnit4::class)
class HealthChecks {
    private val instrumentation=InstrumentationRegistry.getInstrumentation()
    private val context=instrumentation.targetContext
    @Test fun realHealthConnectReadsLocallySeededStepsSleepHeartAndHrv()=runBlocking {
        if(!HealthAccess.available(context)) return@runBlocking
        val client=HealthConnectClient.getOrCreate(context)
        val granted=client.permissionController.getGrantedPermissions()
        assertTrue("本地验收 APK 必须用 install -g 授予健康读取权限",HealthAccess.readPermissions.all { it in granted })
        val now=Instant.now()
        val metadata=Metadata.autoRecorded(device=Device(type=Device.TYPE_PHONE))
        val steps=StepsRecord(now.minusSeconds(1800),null,now.minusSeconds(1200),null,1250,metadata)
        val sleep=SleepSessionRecord(now.minusSeconds(10800),null,now.minusSeconds(7200),null,metadata)
        val heart=HeartRateRecord(now.minusSeconds(600),null,now.minusSeconds(300),null,listOf(HeartRateRecord.Sample(now.minusSeconds(500),72)),metadata)
        val hrv=HeartRateVariabilityRmssdRecord(now.minusSeconds(500),null,42.0,metadata)
        val ids=client.insertRecords(listOf(steps,sleep,heart,hrv)).recordIdsList
        val priorities=HealthTestPriority(context)
        try {
            priorities.prepare()
            val result=HealthAccess.read(context,JSONObject())
            val dir=File(context.getExternalFilesDir(null),"v0.4.0").apply { mkdirs() }
            File(dir,"health-connect-seeded-result.json").writeText(result.toString(2))
            assertEquals("health_connect",result.getString("source"))
            val item=result.getJSONArray("items").objects().first { it.getString("date")==LocalDate.now().toString() }
            assertTrue(item.getLong("steps")>=1250)
            assertEquals(60,item.getInt("sleep_minutes"))
            assertEquals(72.0,item.getDouble("heart_rate_bpm"),.01)
            assertEquals(42.0,item.getDouble("hrv_ms"),.01)
            File(dir,"health-connect-seeded-evidence.json").writeText(JSONObject().put("fixtureRecords",4).put("source",result.getString("source")).put("assertedSteps",1250).put("assertedSleepMinutes",60).put("assertedHeartRate",72).put("assertedHrv",42).put("cleanup","deleteRecords in finally").toString(2))
        } finally {
            client.deleteRecords(StepsRecord::class,listOf(ids[0]),emptyList())
            client.deleteRecords(SleepSessionRecord::class,listOf(ids[1]),emptyList())
            client.deleteRecords(HeartRateRecord::class,listOf(ids[2]),emptyList())
            client.deleteRecords(HeartRateVariabilityRmssdRecord::class,listOf(ids[3]),emptyList())
            priorities.close()
        }
    }
    @Test fun actualProviderAndSensorAvailabilityAndFallbackAreReported()=runBlocking {
        context.getSharedPreferences("observed-steps",Context.MODE_PRIVATE).edit().clear().commit()
        val sdk=HealthConnectClient.getSdkStatus(context)
        val permissions=if(HealthAccess.available(context)) HealthConnectClient.getOrCreate(context).permissionController.getGrantedPermissions() else emptySet()
        val sensor=context.getSystemService(SensorManager::class.java).getDefaultSensor(Sensor.TYPE_STEP_COUNTER)
        val result=HealthAccess.read(context,JSONObject())
        val evidence=JSONObject().put("sdkStatus",sdk).put("available",HealthAccess.available(context)).put("grantedReadPermissions",permissions.filter { it in HealthAccess.readPermissions })
            .put("stepCounterPresent",sensor!=null).put("result",result)
        val dir=File(context.getExternalFilesDir(null),"v0.4.0").apply { mkdirs() }
        File(dir,"health-device-evidence.json").writeText(evidence.toString(2))
        assertTrue(result.optString("source") in setOf("health_connect","step_counter"))
        if(result.getString("source")=="step_counter") {
            assertTrue(result.getString("note").contains("Health Connect"))
            assertEquals(0,result.getJSONArray("items").length())
        }
    }
    @Test fun simulatedStepObservationsPersistOnlyDeltaAndMarkPartial() {
        val prefs=context.getSharedPreferences("observed-steps",Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        val day=LocalDate.now().toString()
        StepCounter.observe(context,StepBaseline(40000,day,1000))
        StepCounter.observe(context,StepBaseline(40125,day,2000))
        StepCounter.observe(context,StepBaseline(4,day,500))
        StepCounter.observe(context,StepBaseline(14,day,800))
        val result=StepCounter.read(context,LocalDate.now(),1)
        if(HealthAccess.sensorPermission(context)) {
            val item=result.getJSONArray("items").getJSONObject(0)
            assertEquals(135,item.getInt("steps")); assertTrue(item.getBoolean("partial"))
        }
        assertEquals(135,prefs.getLong("day:$day",-1))
        prefs.edit().clear().commit()
    }
    @Test fun invalidHealthRangesAreRejectedAndOldCapabilityIsGone()=runBlocking {
        assertNull(Capabilities.byName("open_url"))
        assertNotNull(Capabilities.byName("health"))
        for(args in listOf(JSONObject().put("from","bad"),JSONObject().put("days",0),JSONObject().put("days",32))) {
            try { HealthAccess.read(context,args); fail("日期或天数必须被校验") } catch(expected: IllegalArgumentException) {}
        }
        assertTrue(Capabilities.byName("notify")!!.args.contains("url"))
    }
    @Test fun healthFallbackDiagnosticScreenshot() {
        ActivityScenario.launch<V4ReviewActivity>(Intent(context,V4ReviewActivity::class.java).putExtra("scenario","health-fallback")).use {
            Thread.sleep(1500)
            val dir=File(context.getExternalFilesDir(null),"v0.4.0").apply { mkdirs() }
            val image=instrumentation.uiAutomation.takeScreenshot()
            File(dir,"health-fallback.png").outputStream().use { out -> image.compress(Bitmap.CompressFormat.PNG,100,out) }
            image.recycle()
        }
    }
}
