package com.xiamu.agent.ui

import android.graphics.Bitmap
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.xiamu.agent.media.Images
import kotlinx.coroutines.*

@Composable
fun ContentImage(path: String,modifier: Modifier = Modifier,scale: ContentScale = ContentScale.Fit,alignment: Alignment = Alignment.Center) {
    var bitmap by remember(path) { mutableStateOf<Bitmap?>(Images.cached(path,900)) }
    LaunchedEffect(path,com.xiamu.agent.Chat.libraryVersion.intValue,com.xiamu.agent.Chat.feedVersion.intValue) {
        bitmap=Images.load(path,900)
    }
    val ratio=bitmap?.let { it.width.toFloat()/it.height.coerceAtLeast(1) } ?: (4f/3f)
    // The container owns the measured aspect ratio, so pixels cannot overflow
    // the row's bounds while a lazy list is loading or remeasuring the image.
    val frame=if(scale==ContentScale.Fit) modifier.aspectRatio(ratio) else modifier
    Box(frame.testTag("content-image:$path").background(Pal.Card),contentAlignment=Alignment.Center) {
        val b=bitmap
        if(b!=null) Image(b.asImageBitmap(),null,Modifier.fillMaxSize(),contentScale=scale,alignment=alignment)
        else Icon(Icons.Outlined.Image,null,tint=Pal.Muted,modifier=Modifier.size(28.dp))
    }
}
