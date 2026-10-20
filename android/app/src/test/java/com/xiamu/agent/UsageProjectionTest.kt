package com.xiamu.agent

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class UsageProjectionTest {
    @Test fun unavailableAndMalformedBalancesNeverBecomeZeroOrFullProgress() {
        val unavailable=Usage.from(JSONObject("""{"status":"unsupported","message":"未提供余量","items":[]}"""))!!
        assertEquals("",unavailable.headline);assertFalse(unavailable.visible);assertTrue(unavailable.items.isEmpty())
        val malformed=Usage.from(JSONObject("""{"status":"error","items":[{"remaining":null},{"remaining":-1}]}"""))!!
        assertTrue(malformed.items.isEmpty())
    }
    @Test fun availabilityUsesShortProductLabelsAndHidesUnsupportedExplanations() {
        fun usage(status: String)=Usage.from(JSONObject().put("status",status).put("message","后台接口说明，不显示"))!!
        assertEquals("额度正常",usage("ok").headline);assertTrue(usage("ok").visible)
        assertEquals("额度不足",usage("exhausted").headline);assertTrue(usage("exhausted").visible)
        assertFalse(usage("credentials").visible);assertFalse(usage("unsupported").visible)
    }
    @Test fun cashWithoutAnUpperLimitHasNoProgressAndPartialCoverageStaysExplicit() {
        val cash=Usage.from(JSONObject("""{"status":"partial","message":"已查询 1/2 个账号","items":[{"label":"余额","unit":"CNY","remaining":12.34,"limit":null,"fraction":null}]}"""))!!
        assertEquals("¥12.34",cash.headline);assertNull(cash.items.single().fraction);assertNull(cash.items.single().limit)
        assertEquals("partial",cash.status);assertEquals("已查询 1/2 个账号",cash.message)
    }
}
