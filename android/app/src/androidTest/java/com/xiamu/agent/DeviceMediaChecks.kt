package com.xiamu.agent

import android.Manifest
import android.app.NotificationManager
import android.content.ContentValues
import android.content.ContentProvider
import android.content.ContentResolver
import android.content.ContextWrapper
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.Telephony
import androidx.core.content.FileProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.core.app.ActivityScenario
import androidx.lifecycle.Lifecycle
import androidx.test.platform.app.InstrumentationRegistry
import com.xiamu.agent.device.Capabilities
import com.xiamu.agent.device.DeviceService
import com.xiamu.agent.media.Recorder
import com.xiamu.agent.media.compressImage
import com.xiamu.agent.ui.cronLabel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.time.LocalDate
import java.time.ZoneId

/** Local emulator fixtures only: no cloud login, upload, message or job execution. */
@RunWith(AndroidJUnit4::class)
class DeviceMediaChecks {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val ctx = instrumentation.targetContext

    @Test
    fun imageCompressionAndCameraSharing() = runBlocking {
        val f = File(ctx.cacheDir, "camera/check.png").apply { parentFile!!.mkdirs() }
        val bmp = Bitmap.createBitmap(3200, 2000, Bitmap.Config.ARGB_8888)
        f.outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bmp.recycle()
        try {
            val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.files", f)
            assertEquals("content", uri.scheme)
            val bytes = compressImage(ctx, uri)
            assertEquals(0xff, bytes[0].toInt() and 0xff)
            assertEquals(0xd8, bytes[1].toInt() and 0xff)
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            assertEquals(1600, bounds.outWidth)
            assertEquals(1000, bounds.outHeight)
        } finally { f.delete() }
    }

    @Test
    fun recordingIsAdts16kMonoAndCancelCleansUp() = runBlocking {
        instrumentation.uiAutomation.adoptShellPermissionIdentity(Manifest.permission.RECORD_AUDIO)
        val recorder = Recorder(ctx)
        try {
            assertTrue("MediaRecorder should start", recorder.start())
            delay(1200)
            val file = recorder.stop() ?: error("Recording did not produce a file")
            try {
                val header = file.inputStream().use { input -> ByteArray(7).also { assertEquals(7, input.read(it)) } }
                assertEquals(0xff, header[0].toInt() and 0xff)
                assertEquals(0xf0, header[1].toInt() and 0xf0)
                assertEquals("16 kHz AAC sample-rate index", 8, (header[2].toInt() and 0x3c) shr 2)
                assertEquals("Mono AAC channel config", 1, ((header[2].toInt() and 1) shl 2) or ((header[3].toInt() and 0xc0) shr 6))
            } finally { file.delete() }
            assertTrue(recorder.start())
            delay(300)
            recorder.cancel()
            assertTrue(File(ctx.cacheDir, "voice").listFiles().orEmpty().isEmpty())
        } finally {
            recorder.cancel()
            instrumentation.uiAutomation.dropShellPermissionIdentity()
        }
    }

    @Test
    fun sqliteSmsPagesPast500WithInclusiveDatesAndIncrementalCatchup() = runBlocking {
        val provider = SmsFixtureProvider()
        provider.attachInfo(ctx, android.content.pm.ProviderInfo().apply { authority = "sms"; exported = false })
        val cr = ContentResolver.wrap(provider)
        val local = object : ContextWrapper(ctx) { override fun getContentResolver() = cr }
        val prefix = "pa-v2-local-check:"
        val today = LocalDate.now()
        val start = today.atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli()
        fun clean() { cr.delete(Telephony.Sms.CONTENT_URI, "body LIKE ?", arrayOf("$prefix%")) }
        try {
            clean()
            val ids = mutableListOf<Long>()
            for (i in 0 until 514) {
                val date = when (i) { 512 -> start - 1; 513 -> start + 86_400_000; else -> start + i * 1000 }
                val values = ContentValues().apply {
                    put("address", "+15550000000"); put("body", "$prefix$i"); put("date", date); put("type", 1); put("sub_id", -1)
                }
                val uri = cr.insert(Telephony.Sms.CONTENT_URI, values) ?: error("SMS fixture insert failed")
                ids += uri.lastPathSegment!!.toLong()
            }
            assertTrue("SMS fixture ids must exist", ids.all { it > 0 })
            cr.query(Telephony.Sms.CONTENT_URI, arrayOf("_id", "date", "body"), "body LIKE ?", arrayOf("$prefix%"), "_id ASC")!!.use {
                assertEquals("SMS fixtures must be readable before paging", 514, it.count)
                assertTrue(it.moveToFirst())
                assertEquals(start, it.getLong(1))
                assertEquals("${prefix}0", it.getString(2))
            }
            val sms = Capabilities.byName("sms")!!
            val args = JSONObject().put("limit", 999).put("query", prefix).put("from_date", today.toString()).put("to_date", today.toString())
            val first = sms.run(local, args) as JSONObject
            assertEquals(512, first.getInt("total_in_range"))
            assertEquals(500, first.getJSONArray("items").length())
            val before = first.getLong("next_before")
            val next = sms.run(local, args.put("before", before)) as JSONObject
            assertEquals(512, next.getInt("total_in_range"))
            assertEquals(12, next.getJSONArray("items").length())
            assertTrue(next.isNull("next_before"))
            val pageIds = (first.getJSONArray("items").objects() + next.getJSONArray("items").objects()).map { it.getLong("id") }
            assertEquals(ids.take(512).reversed(), pageIds)
            val catchup = Capabilities.readSince(local, "sms", (ids.first() - 1).toString(), 500)
            assertEquals(500, catchup.getJSONArray("items").length())
            assertTrue(catchup.getBoolean("more"))
            val tail = Capabilities.readSince(local, "sms", catchup.getString("next_cursor"), 500)
            assertEquals(14, tail.getJSONArray("items").length())
            assertFalse(tail.getBoolean("more"))
        } finally {
            clean()
            provider.shutdown()
        }
    }

    @Test
    fun approximateLocationCountsAsAuthorized() {
        val location = Capabilities.byName("location")!!
        instrumentation.uiAutomation.adoptShellPermissionIdentity(Manifest.permission.ACCESS_COARSE_LOCATION)
        try { assertTrue(location.hasPermissions(ctx)) }
        finally { instrumentation.uiAutomation.dropShellPermissionIdentity() }
    }

    @Test
    fun scheduleExamplesAreReadable() {
        assertEquals("每天 7:30", cronLabel("30 7 * * *"))
        assertEquals("每周日 20:00", cronLabel("0 20 * * 0"))
        assertEquals("工作日 9:00", cronLabel("0 9 * * 1-5"))
        assertEquals("每月 1 日 10:00", cronLabel("0 10 1 * *"))
        assertEquals("每 15 分钟", cronLabel("*/15 * * * *"))
    }

    @Test
    fun firstChatStateMetadataHandlesNullAndMissing() {
        assertEquals(1_700_000_000_123L, Api.firstChatTime(JSONObject("{\"firstChat\":1700000000123}")))
        assertNull(Api.firstChatTime(JSONObject("{\"firstChat\":null}")))
        assertNull(Api.firstChatTime(JSONObject("{}")))
    }

    @Test
    fun deviceEventsNotifyOnlyInBackgroundAndRespectSwitch() {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        val previous = Prefs.notifyMessages
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            nm.cancelAll()
            Prefs.notifyMessages = true
            assertTrue(App.foreground)
            DeviceService.onAgentEvent(ctx, "reply", "本地通知验收")
            assertTrue(nm.activeNotifications.isEmpty())
            scenario.moveToState(Lifecycle.State.CREATED)
            assertFalse(App.foreground)
            DeviceService.onAgentEvent(ctx, "reply", "本地通知验收")
            Thread.sleep(300)
            assertEquals(1, nm.activeNotifications.size)
            assertEquals(App.CH_AGENT, nm.activeNotifications.single().notification.channelId)
            nm.cancelAll()
            Prefs.notifyMessages = false
            DeviceService.onAgentEvent(ctx, "job", "本地通知验收")
            Thread.sleep(300)
            assertTrue(nm.activeNotifications.isEmpty())
        } finally {
            nm.cancelAll()
            Prefs.notifyMessages = previous
            scenario.close()
        }
    }
}

/** Real SQLite queries through ContentResolver; no permission to alter the emulator's SMS inbox. */
private class SmsFixtureProvider : ContentProvider() {
    private val db = SQLiteDatabase.create(null).apply {
        execSQL("CREATE TABLE sms (_id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT, body TEXT, date INTEGER, type INTEGER, sub_id INTEGER)")
    }
    override fun onCreate() = true
    override fun getType(uri: Uri): String? = null
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, order: String?): Cursor =
        db.query("sms", projection, selection, args, null, null, order)
    override fun insert(uri: Uri, values: ContentValues?): Uri = Uri.withAppendedPath(uri, db.insertOrThrow("sms", null, values).toString())
    override fun delete(uri: Uri, selection: String?, args: Array<out String>?) = db.delete("sms", selection, args)
    override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?) = db.update("sms", values, selection, args)
    override fun shutdown() { db.close() }
}
