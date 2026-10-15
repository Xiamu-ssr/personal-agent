package com.xiamu.agent.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material3.Icon
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import com.xiamu.agent.Api
import com.xiamu.agent.media.Images
import kotlinx.coroutines.*
import okhttp3.Request

@Composable
fun ContentImage(path: String,modifier: Modifier = Modifier,scale: ContentScale = ContentScale.Crop) {
    var bitmap by remember(path) { mutableStateOf<Bitmap?>(null) }
    LaunchedEffect(path) {
        bitmap=try {
            if(path.startsWith("data/")) Images.load(path,900)
            else withContext(Dispatchers.IO) {
                val bytes=if(path.startsWith("/api/")) Api.pathBytes(path) else Api.http.newCall(Request.Builder().url(path).build()).execute().use { if(it.isSuccessful) it.body?.bytes() else null }
                bytes?.takeIf { it.size<=20*1024*1024 }?.let { BitmapFactory.decodeByteArray(it,0,it.size) }
            }
        } catch(e: CancellationException) { throw e } catch(_: Exception) { null }
    }
    Box(modifier.background(Pal.Card),contentAlignment=Alignment.Center) {
        val b=bitmap
        if(b!=null) Image(b.asImageBitmap(),null,Modifier.fillMaxSize(),contentScale=scale)
        else Icon(Icons.Outlined.Image,null,tint=Pal.Muted,modifier=Modifier.size(28.dp))
    }
}
