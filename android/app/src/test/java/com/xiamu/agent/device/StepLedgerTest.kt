package com.xiamu.agent.device

import org.junit.Assert.*
import org.junit.Test

class StepLedgerTest {
    @Test fun sinceBootCounterIsNotTodaysTotal() { assertEquals(0,stepDelta(null,StepBaseline(50000,"2026-10-11",1000))) }
    @Test fun deltasSurviveOrdinaryServiceRestart() { assertEquals(125,stepDelta(StepBaseline(50000,"2026-10-11",1000),StepBaseline(50125,"2026-10-11",2000))) }
    @Test fun midnightAndRebootResetBaseline() {
        val before=StepBaseline(50000,"2026-10-11",1000)
        assertEquals(0,stepDelta(before,StepBaseline(50125,"2026-10-12",2000)))
        assertEquals(0,stepDelta(before,StepBaseline(10,"2026-10-11",500)))
        assertEquals(0,stepDelta(before,StepBaseline(90000,"2026-10-11",500)))
    }
}
