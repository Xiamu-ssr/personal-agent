package com.xiamu.agent.device

import kotlin.math.hypot
import kotlin.math.min
import kotlin.math.roundToLong
import kotlin.random.Random

/** Geometry and timing only. Endpoints stay exact; all variation is inside the screen. */
internal object TouchMotion {
    data class Point(val x: Double, val y: Double) {
        operator fun plus(p: Point) = Point(x + p.x, y + p.y)
        operator fun minus(p: Point) = Point(x - p.x, y - p.y)
        operator fun times(scale: Double) = Point(x * scale, y * scale)
    }
    data class Segment(val from: Point, val c1: Point, val c2: Point, val to: Point, val duration: Long)

    fun plan(from: Point, to: Point, width: Int, height: Int, duration: Long? = null, seed: Long = Random.nextLong()): List<Segment> {
        require(width > 0 && height > 0)
        fun valid(p: Point) = p.x.isFinite() && p.y.isFinite() && p.x >= 0 && p.y >= 0 && p.x < width && p.y < height
        require(valid(from) && valid(to)) { "手势坐标超出屏幕范围" }
        val delta = to - from
        val distance = hypot(delta.x, delta.y)
        require(distance > 0) { "移动手势需要不同的起点和终点" }
        val random = Random(seed)
        val normal = Point(-delta.y / distance, delta.x / distance)
        val bend = min(28.0, distance * .04)
        fun bounded(p: Point) = Point(p.x.coerceIn(0.0, width - 1.0), p.y.coerceIn(0.0, height - 1.0))
        val c1 = bounded(from + delta * .30 + normal * (bend * random.nextDouble(-1.0, 1.0)))
        val c2 = bounded(from + delta * .72 + normal * (bend * random.nextDouble(-1.0, 1.0)))
        val total = duration?.also { require(it in 80..2000) { "手势时长须在 80–2000 毫秒之间" } }
            ?: ((190 + distance * .32) * random.nextDouble(.94, 1.06)).roundToLong().coerceIn(180, 950)
        val count = (total / 45).toInt().coerceIn(4, 20)
        fun position(u: Double): Point {
            if (u == 0.0) return from
            if (u == 1.0) return to
            val v = 1 - u
            return bounded(from * (v*v*v) + c1 * (3*v*v*u) + c2 * (3*v*u*u) + to * (u*u*u))
        }
        fun tangent(u: Double): Point {
            val v = 1 - u
            return (c1-from) * (3*v*v) + (c2-c1) * (6*v*u) + (to-c2) * (3*u*u)
        }
        // Minimum-jerk progress; native continued strokes preserve one DOWN/MOVE/UP sequence.
        fun progress(i: Int): Double {
            val t = i.toDouble() / count
            return t*t*t * (10 + t * (-15 + 6*t))
        }
        return (0 until count).map { i ->
            val start = progress(i)
            val end = progress(i + 1)
            val a = position(start)
            val b = position(end)
            val span = (end-start) / 3
            Segment(a, bounded(a+tangent(start)*span), bounded(b-tangent(end)*span), b,
                total * (i+1) / count - total * i / count)
        }
    }
}
