package com.xiamu.agent
import org.json.JSONObject
/** User uploads, separate from assistant media cards. */
data class Attachment(val path: String,val name: String,val kind: String,val transcript: String? = null) {
    fun toJson()=JSONObject().put("path",path).put("name",name).put("kind",kind)
    companion object { fun from(j: JSONObject)=Attachment(j.optString("path"),j.optString("name"),j.optString("kind","file"),j.optString("transcript").takeIf(String::isNotBlank)) }
}
