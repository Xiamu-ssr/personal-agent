package com.xiamu.agent

import org.json.JSONObject

data class BrowserFrameInfo(val id: Long,val width: Int,val height: Int) {
    fun pointer(type: String,x: Float,y: Float,displayWidth: Int,displayHeight: Int): JSONObject {
        require(displayWidth>0 && displayHeight>0 && x>=0 && y>=0 && x<=displayWidth && y<=displayHeight)
        return JSONObject().put("type",type).put("frameId",id).put("x",x).put("y",y).put("width",displayWidth).put("height",displayHeight)
    }
}
