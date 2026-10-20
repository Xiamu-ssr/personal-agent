package com.xiamu.agent

import org.json.JSONObject
import java.text.NumberFormat
import java.util.Locale

data class Allowance(val label: String, val unit: String, val remaining: Double, val limit: Double?, val fraction: Float?, val resetAt: String?) {
    val amount: String get() {
        val n=NumberFormat.getNumberInstance(Locale.CHINA).apply { maximumFractionDigits=if(unit in listOf("CNY","USD")) 2 else 0 }.format(remaining)
        return when(unit) { "CNY" -> "¥$n"; "USD" -> "$$n"; "credits" -> "$n 积分"; "flows" -> "$n Flows"; else -> "$n $unit" }
    }
}
data class Usage(val status: String, val message: String, val items: List<Allowance>, val checkedAt: Long) {
    val visible: Boolean get() = items.isNotEmpty() || status in setOf("ok","exhausted","error","partial")
    val headline: String get() = items.firstOrNull()?.amount ?: when(status) {
        "ok" -> "额度正常"; "exhausted" -> "额度不足"; "error" -> "暂不可用"; "partial" -> "部分可用"; else -> ""
    }
    companion object {
        fun from(j: JSONObject?): Usage? = j?.let { json ->
            Usage(json.optString("status"),json.optString("message"),json.optJSONArray("items").objects().mapNotNull { i ->
                val remaining=i.optDouble("remaining",Double.NaN)
                if(!remaining.isFinite() || remaining<0) null else Allowance(i.optString("label"),i.optString("unit"),remaining,
                    i.optDouble("limit",Double.NaN).takeIf { it.isFinite() && it>=0 },
                    i.optDouble("fraction",Double.NaN).takeIf { it.isFinite() && it in 0.0..1.0 }?.toFloat(),
                    i.optString("resetAt").takeIf { !i.isNull("resetAt") && it.isNotBlank() })
            },json.optLong("checkedAt"))
        }
    }
}
