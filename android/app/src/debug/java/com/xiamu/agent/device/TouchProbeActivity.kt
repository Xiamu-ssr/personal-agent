package com.xiamu.agent.device

import android.app.Activity
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.os.Bundle
import android.view.MotionEvent
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import java.util.Collections

/** A synthetic touch surface, compiled into Debug only. Never opens another app or account. */
class TouchProbeActivity : Activity() {
    data class Event(val action: Int, val x: Float, val y: Float, val time: Long)
    val events: MutableList<Event> = Collections.synchronizedList(mutableListOf())
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        setContentView(object : View(this) {
            val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            init { contentDescription = "豆豆触摸验收区域"; importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES }
            override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
                super.onInitializeAccessibilityNodeInfo(info)
                info.isScrollable = true
            }
            override fun onTouchEvent(event: MotionEvent): Boolean {
                events.add(Event(event.actionMasked,event.rawX,event.rawY,event.eventTime))
                invalidate()
                return true
            }
            override fun onDraw(canvas: Canvas) {
                canvas.drawColor(Color.rgb(248,248,245))
                paint.color = Color.rgb(36,46,42); paint.textSize = 40f; paint.style = Paint.Style.FILL
                canvas.drawText("豆豆 · 连续触摸验收",40f,80f,paint)
                paint.textSize = 27f; paint.color = Color.GRAY
                canvas.drawText("曲线路径 / 准确落点 / 单次按下与松开",40f,125f,paint)
                val samples = synchronized(events) { events.toList() }
                paint.color = Color.rgb(83,124,105); paint.strokeWidth = 6f; paint.style = Paint.Style.STROKE
                val path = Path()
                val offset = IntArray(2); getLocationOnScreen(offset)
                samples.forEachIndexed { i,p ->
                    if(i == 0 || p.action == MotionEvent.ACTION_DOWN) path.moveTo(p.x-offset[0],p.y-offset[1])
                    else path.lineTo(p.x-offset[0],p.y-offset[1])
                }
                canvas.drawPath(path,paint)
            }
        })
    }
}
