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
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.ui.platform.LocalDensity
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
import kotlinx.coroutines.delay

/** A TextureView keeps the video inside Compose clipping; its player follows visible lifecycle. */
@Composable
fun Avatar(size: Dp = 76.dp,state: String = Chat.avatar.value.state,expressive: Boolean = false) {
    val context=LocalContext.current
    val dark=ThemeState.dark.value
    val resources=context.resources
    val raw=remember(state,dark) { resources.getIdentifier("mascot_${state}_${if(dark) "dark" else "light"}","raw",context.packageName) }
    val still=remember(state) { resources.getIdentifier("mascot_${state}_still","raw",context.packageName).takeIf { it!=0 }?.let { BitmapFactory.decodeResource(resources,it) } }
    val lifecycle=LocalLifecycleOwner.current.lifecycle
    var prepared by remember(raw) { mutableStateOf(false) }
    val player=remember(raw) { MediaPlayer() }
    val allowMotion=android.provider.Settings.Global.getFloat(context.contentResolver,android.provider.Settings.Global.ANIMATOR_DURATION_SCALE,1f)>0f
    var peeking by remember { mutableStateOf(false) }
    val reveal by animateFloatAsState(if(peeking && allowMotion) 1f else 0f,animationSpec=tween(260),label="companion-peek")
    val sizePx=with(LocalDensity.current) { size.toPx() }
    LaunchedEffect(state,expressive,allowMotion) {
        peeking=false
        if(expressive && allowMotion && state in listOf("happy","waiting")) { peeking=true;delay(2400);peeking=false }
    }
    DisposableEffect(player,lifecycle) {
        val observer=LifecycleEventObserver { _,event ->
            if(event==Lifecycle.Event.ON_STOP && prepared) runCatching { player.pause() }
            if(event==Lifecycle.Event.ON_START && prepared && !peeking && android.provider.Settings.Global.getFloat(context.contentResolver,android.provider.Settings.Global.ANIMATOR_DURATION_SCALE,1f)>0f) runCatching { player.start() }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); runCatching { player.release() } }
    }
    LaunchedEffect(allowMotion,peeking,prepared) {
        if(prepared) {
            if(!allowMotion || peeking) runCatching { player.pause() }
            else if(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) runCatching { player.start() }
        }
    }
    val videoBackground=if(dark) Color.Black else Color(0xFFFFFEFF)
    Box(Modifier.size(size)) {
    val baseColor=Pal.Quiet
    Canvas(Modifier.align(Alignment.BottomCenter).width(size*.85f).height(size*.24f).graphicsLayer { alpha=reveal }) { drawOval(baseColor) }
    Box(Modifier.fillMaxSize().graphicsLayer { alpha=1f-reveal }.shadow(3.dp,CircleShape,clip=false)
        .border(.5.dp,if(dark) Color(0xFF323232) else Color(0xFFE5E5E5),CircleShape)
        .clip(CircleShape).background(videoBackground)) {
        if(still!=null) Image(still.asImageBitmap(),"头像状态：$state",Modifier.fillMaxSize())
        if(allowMotion) key(raw) {
            AndroidView(modifier=Modifier.fillMaxSize(),update={ it.alpha=1f-reveal },factory={ c -> TextureView(c).apply {
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
                            if(prepared) {
                                if(!peeking && allowMotion && lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) player.start()
                                return
                            }
                            resources.openRawResourceFd(raw).use { player.setDataSource(it.fileDescriptor,it.startOffset,it.length) }
                            player.isLooping=true; player.setVolume(0f,0f)
                            player.setOnPreparedListener { prepared=true; if(!peeking && allowMotion && lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) it.start() }
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
    if(still!=null) Image(still.asImageBitmap(),null,Modifier.fillMaxSize().graphicsLayer {
        alpha=reveal;scaleX=1.24f+.1f*reveal;scaleY=scaleX;translationY=-sizePx*.06f*reveal;rotationZ=3f*reveal
    })
    }
}

@Composable
fun AvatarLabel(subtitle: String? = null,onClick: () -> Unit) {
    Box(Modifier.widthIn(min=96.dp,max=190.dp).height(124.dp),contentAlignment=Alignment.TopCenter) {
        Avatar(84.dp,expressive=true)
        Text(Chat.agentName.value,style=Type.title(11),color=Pal.Ink,maxLines=1,
            modifier=Modifier.padding(top=74.dp).clip(CircleShape).background(Pal.Card).border(.5.dp,Pal.Line,CircleShape).padding(horizontal=11.dp,vertical=4.dp))
        val avatar=Chat.avatar.value
        val status=avatar.takeIf { it.state!="idle" }?.text?.ifBlank {
            when(avatar.state) { "working" -> "正在处理";"waiting" -> "等你回应";"happy" -> "这件事办好了";"error" -> "需要看一眼";else -> "" }
        }?.takeIf { it.isNotBlank() }
        val label=listOfNotNull(subtitle,status).joinToString(" · ")
        if(label.isNotBlank()) Text(label,style=Type.body(10),color=Pal.Muted,maxLines=1,
            modifier=Modifier.padding(top=105.dp).clip(CircleShape).background(Pal.Background).padding(horizontal=5.dp))
        // Keep the hit target above TextureView, which can otherwise consume video touches.
        Box(Modifier.matchParentSize().tap(onClick=onClick).semantics {
            contentDescription=listOf("打开头像控制台",subtitle,status).filterNotNull().filter { it.isNotBlank() }.joinToString("，")
        })
    }
}
