package com.xiamu.agent

import android.health.connect.HealthConnectManager
import android.health.connect.datatypes.DataOrigin
import android.os.OutcomeReceiver
import android.content.Context
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit

/** Emulator tests only. Like Android CTS setupAggregation, install -g skips the UI path
 * that adds the fixture writer to Activity/Sleep priority lists. Preserve and restore both.
 * Source: AOSP HealthFitness tests/cts/utils/HealthConnectTestUtils/.../TestUtils.java.
 * Reflection accesses the test/system APIs absent from the public SDK; never in the APK. */
internal class HealthTestPriority(private val context: Context) : AutoCloseable {
    private val manager=context.getSystemService(HealthConnectManager::class.java)
    private val executor=Executor { it.run() }
    private val original=linkedMapOf<Int,List<DataOrigin>>()
    private fun <T> await(block: (OutcomeReceiver<T,Exception>)->Unit): T? {
        val latch=CountDownLatch(1); var result: T?=null; var error: Exception?=null
        block(object: OutcomeReceiver<T,Exception> {
            override fun onResult(value: T) { result=value; latch.countDown() }
            override fun onError(value: Exception) { error=value; latch.countDown() }
        })
        check(latch.await(5,TimeUnit.SECONDS)) { "Health Connect priority test setup timed out" }
        error?.let { throw it }; return result
    }
    private fun manage(block: ()->Unit) {
        val automation=InstrumentationRegistry.getInstrumentation().uiAutomation
        automation.adoptShellPermissionIdentity("android.permission.MANAGE_HEALTH_DATA")
        try { block() } finally { automation.dropShellPermissionIdentity() }
    }
    fun prepare() = manage {
        val categories=Class.forName("android.health.connect.HealthDataCategory")
        for(name in listOf("ACTIVITY","SLEEP")) {
            val category=categories.getField(name).getInt(null)
            val response=await<Any> { callback -> manager.javaClass.getMethod("fetchDataOriginsPriorityOrder",Int::class.javaPrimitiveType,Executor::class.java,OutcomeReceiver::class.java)
                .invoke(manager,category,executor,callback) }!!
            @Suppress("UNCHECKED_CAST")
            val prior=response.javaClass.getMethod("getDataOriginsPriorityOrder").invoke(response) as List<DataOrigin>
            original[category]=prior
            val origin=DataOrigin.Builder().setPackageName(context.packageName).build()
            update(category,listOf(origin)+prior.filter { it.packageName!=context.packageName })
        }
    }
    private fun update(category: Int,origins: List<DataOrigin>) {
        val type=Class.forName("android.health.connect.UpdateDataOriginPriorityOrderRequest")
        val request=type.getConstructor(List::class.java,Int::class.javaPrimitiveType).newInstance(origins,category)
        await<Any?> { callback -> manager.javaClass.getMethod("updateDataOriginPriorityOrder",type,Executor::class.java,OutcomeReceiver::class.java)
            .invoke(manager,request,executor,callback) }
    }
    override fun close() = manage { original.forEach { (category,origins) -> update(category,origins) } }
}
