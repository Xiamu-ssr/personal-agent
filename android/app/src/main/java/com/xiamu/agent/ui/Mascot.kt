package com.xiamu.agent.ui

import android.media.MediaPlayer
import android.view.TextureView
import android.view.Surface
import android.graphics.SurfaceTexture
import android.graphics.BitmapFactory
import android.graphics.Outline
import android.view.View
import android.view.ViewOutlineProvider
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.*
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.*
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.xiamu.agent.Chat

/** A TextureView keeps the video inside Compose clipping; its player follows visible lifecycle. */
@Composable
fun Avatar(size: Dp = 76.dp,state: String = Chat.avatar.value.state) {
    val context=LocalContext.current
    val dark=ThemeState.dark.value
    val resources=context.resources
    val raw=remember(state,dark) { resources.getIdentifier("mascot_${state}_${if(dark) "dark" else "light"}","raw",context.packageName) }
    val still=remember(state) { resources.getIdentifier("mascot_${state}_still","raw",context.packageName).takeIf { it!=0 }?.let { BitmapFactory.decodeResource(resources,it) } }
    val lifecycle=LocalLifecycleOwner.current.lifecycle
    var prepared by remember(raw) { mutableStateOf(false) }
    val player=remember(raw) { MediaPlayer() }
    DisposableEffect(player,lifecycle) {
        val observer=LifecycleEventObserver { _,event ->
            if(event==Lifecycle.Event.ON_STOP) runCatching { player.pause() }
            if(event==Lifecycle.Event.ON_START && prepared) runCatching { player.start() }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); runCatching { player.release() } }
    }
    val videoBackground=if(dark) Color.Black else Color(0xFFFFFEFF)
    Box(Modifier.size(size).shadow(2.dp,CircleShape,clip=false)
        .border(.5.dp,if(dark) Color(0xFF323232) else Color(0xFFE5E5E5),CircleShape)
        .clip(CircleShape).background(videoBackground)) {
        if(still!=null) Image(still.asImageBitmap(),"头像状态：$state",Modifier.fillMaxSize())
        key(raw) {
            AndroidView(modifier=Modifier.fillMaxSize(),factory={ c -> TextureView(c).apply {
                isOpaque=false
                outlineProvider=object : ViewOutlineProvider() {
                    override fun getOutline(view: View,outline: Outline) { outline.setOval(0,0,view.width,view.height) }
                }
                clipToOutline=true
                surfaceTextureListener=object : TextureView.SurfaceTextureListener {
                    override fun onSurfaceTextureAvailable(texture: SurfaceTexture,w: Int,h: Int) {
                        if(raw==0) return
                        runCatching {
                            val surface=Surface(texture)
                            player.setSurface(surface); surface.release()
                            resources.openRawResourceFd(raw).use { player.setDataSource(it.fileDescriptor,it.startOffset,it.length) }
                            player.isLooping=true; player.setVolume(0f,0f)
                            player.setOnPreparedListener { prepared=true; if(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) it.start() }
                            player.setOnErrorListener { _,_,_ -> prepared=false; true }
                            player.prepareAsync()
                        }
                    }
                    override fun onSurfaceTextureDestroyed(t: SurfaceTexture): Boolean { runCatching { player.setSurface(null) }; return true }
                    override fun onSurfaceTextureSizeChanged(t: SurfaceTexture,w: Int,h: Int) { invalidateOutline() }
                    override fun onSurfaceTextureUpdated(t: SurfaceTexture) {}
                }
            } })
        }
    }
}

@Composable
fun AvatarLabel(subtitle: String? = null,onClick: () -> Unit) {
    Box(Modifier.widthIn(min=92.dp,max=180.dp).height(110.dp),contentAlignment=Alignment.TopCenter) {
        Avatar(80.dp)
        Text(Chat.agentName.value,style=Type.title(11),color=Pal.Ink,maxLines=1,
            modifier=Modifier.padding(top=69.dp).clip(CircleShape).background(Pal.Quiet).padding(horizontal=9.dp,vertical=3.dp))
        val status=Chat.avatar.value.takeIf { it.state=="working" }?.text?.ifBlank { "努力工作中" }
        val label=listOfNotNull(subtitle,status).joinToString(" · ")
        if(label.isNotBlank()) Text(label,style=Type.body(10),color=Pal.Muted,maxLines=1,
            modifier=Modifier.padding(top=94.dp).clip(CircleShape).background(Pal.Background).padding(horizontal=5.dp))
        // Keep the hit target above TextureView, which can otherwise consume video touches.
        Box(Modifier.matchParentSize().tap(onClick=onClick).semantics { contentDescription=if(subtitle==null) "打开头像控制台" else "打开头像控制台，$subtitle" })
    }
}
