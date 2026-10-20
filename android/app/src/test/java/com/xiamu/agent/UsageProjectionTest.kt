package com.xiamu.agent

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class UsageProjectionTest {
    @Test fun unavailableAndMalformedBalancesNeverBecomeZeroOrFullProgress() {
        val unavailable=Usage.from(JSONObject("""{"status":"unsupported","message":"未提供余量","items":[]}"""))!!
        assertEquals("未提供余量",unavailable.headline);assertTrue(unavailable.items.isEmpty())
        val malformed=Usage.from(JSONObject("""{"status":"error","items":[{"remaining":null},{"remaining":-1}]}"""))!!
        assertTrue(malformed.items.isEmpty())
    }
    @Test fun cashWithoutAnUpperLimitHasNoProgressAndPartialCoverageStaysExplicit() {
        val cash=Usage.from(JSONObject("""{"status":"partial","message":"已查询 1/2 个账号","items":[{"label":"余额","unit":"CNY","remaining":12.34,"limit":null,"fraction":null}]}"""))!!
        assertEquals("¥12.34",cash.headline);assertNull(cash.items.single().fraction);assertNull(cash.items.single().limit)
        assertEquals("partial",cash.status);assertEquals("已查询 1/2 个账号",cash.message)
    }
}
