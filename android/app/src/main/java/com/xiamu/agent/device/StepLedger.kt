package com.xiamu.agent.device

/** TYPE_STEP_COUNTER is a since-boot counter, never a daily total. Observe only deltas.
 * First observation / a new date / reboot establishes a baseline and adds no steps. */
data class StepBaseline(val count: Long, val date: String, val uptime: Long)
internal fun stepDelta(previous: StepBaseline?, next: StepBaseline): Long =
    if(previous == null || previous.date != next.date || next.uptime < previous.uptime || next.count < previous.count) 0
    else (next.count - previous.count).coerceAtLeast(0)
