package com.xiamu.agent.device

import org.junit.Assert.*
import org.junit.Test
import kotlin.math.hypot

class TouchMotionTest {
    private val start = TouchMotion.Point(500.0, 1500.0)
    private val end = TouchMotion.Point(500.0, 300.0)

    @Test fun keepsExactEndpointsAndOneContinuousStroke() {
        val path = TouchMotion.plan(start, end, 1080, 2400, 450, 12)
        assertEquals(start, path.first().from)
        assertEquals(end, path.last().to)
        assertEquals(450L, path.sumOf { it.duration })
        path.zipWithNext().forEach { (a,b) -> assertEquals(a.to, b.from) }
        assertTrue(path.all { it.duration > 0 })
    }

    @Test fun acceleratesAndDeceleratesWithoutReversing() {
        val path = TouchMotion.plan(start, end, 1080, 2400, 540, 12)
        fun speed(s: TouchMotion.Segment) = hypot(s.to.x-s.from.x, s.to.y-s.from.y) / s.duration
        assertTrue(speed(path[path.size/2]) > speed(path.first()) * 4)
        assertTrue(speed(path[path.size/2]) > speed(path.last()) * 4)
        path.forEach { assertTrue(it.to.y < it.from.y) }
    }

    @Test fun bendsBetweenEndpointsWithoutChangingTheTarget() {
        val a = TouchMotion.plan(start, end, 1080, 2400, 450, 12)
        val b = TouchMotion.plan(start, end, 1080, 2400, 450, 24)
        assertNotEquals(a, b)
        assertTrue(a.any { kotlin.math.abs(it.to.x-start.x) > 1 })
        assertEquals(end, a.last().to)
        assertEquals(end, b.last().to)
    }

    @Test fun staysInsideTheScreenIncludingEdgesAndShortMoves() {
        val pairs = listOf(
            TouchMotion.Point(0.0, 0.0) to TouchMotion.Point(1079.0, 2399.0),
            TouchMotion.Point(0.0, 1200.0) to TouchMotion.Point(0.0, 300.0),
            TouchMotion.Point(1079.0, 1.0) to TouchMotion.Point(1079.0, 2399.0),
            TouchMotion.Point(500.0, 300.0) to TouchMotion.Point(500.5, 300.1),
            TouchMotion.Point(1000.0, 500.0) to TouchMotion.Point(10.0, 500.0)
        )
        for (seed in 0L..100L) for ((from,to) in pairs) {
            val path = TouchMotion.plan(from,to,1080,2400,seed=seed)
            assertEquals(from,path.first().from)
            assertEquals(to,path.last().to)
            for (s in path) for (p in listOf(s.from,s.c1,s.c2,s.to)) {
                assertTrue(p.x.isFinite() && p.y.isFinite())
                assertTrue(p.x in 0.0..1079.0 && p.y in 0.0..2399.0)
            }
        }
    }

    @Test fun defaultDurationRespondsToDistanceAndExecutionIsBounded() {
        val short = TouchMotion.plan(start,TouchMotion.Point(500.0,1450.0),1080,2400,seed=3)
        val long = TouchMotion.plan(start,end,1080,2400,seed=3)
        assertTrue(short.sumOf { it.duration } < long.sumOf { it.duration })
        for (duration in listOf(80L, 2000L)) {
            val path = TouchMotion.plan(start,end,1080,2400,duration,3)
            assertTrue(path.size in 4..20)
            assertEquals(duration,path.sumOf { it.duration })
        }
    }

    @Test fun rejectsInvalidGeometryAndDurations() {
        for (point in listOf(TouchMotion.Point(Double.NaN,0.0),TouchMotion.Point(-1.0,0.0),TouchMotion.Point(1080.0,0.0))) {
            assertThrows(IllegalArgumentException::class.java) { TouchMotion.plan(point,end,1080,2400) }
        }
        assertThrows(IllegalArgumentException::class.java) { TouchMotion.plan(start,start,1080,2400) }
        for (duration in listOf(0L,79L,2001L)) {
            assertThrows(IllegalArgumentException::class.java) { TouchMotion.plan(start,end,1080,2400,duration) }
        }
    }
}
