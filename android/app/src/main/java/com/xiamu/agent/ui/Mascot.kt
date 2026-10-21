package com.xiamu.agent.ui

import android.media.MediaPlayer
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.PowerManager
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
import androidx.compose.ui.platform.testTag
import androidx.core.content.ContextCompat
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
    var resumed by remember(lifecycle) { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
    var foregroundEpoch by remember(lifecycle) { mutableIntStateOf(0) }
    var lowPower by remember { mutableStateOf(context.getSystemService(PowerManager::class.java).isPowerSaveMode) }
    val allowMotion=!lowPower && android.provider.Settings.Global.getFloat(context.contentResolver,android.provider.Settings.Global.ANIMATOR_DURATION_SCALE,1f)>0f
    var motion by remember { mutableStateOf<String?>(null) }
    val mayAnimate=expressive && allowMotion && resumed && raw!=0
    var peeking by remember { mutableStateOf(false) }
    val reveal by animateFloatAsState(if(peeking && allowMotion) 1f else 0f,animationSpec=tween(260),label="companion-peek")
    val sizePx=with(LocalDensity.current) { size.toPx() }
    LaunchedEffect(state,expressive,allowMotion) {
        peeking=false
        if(expressive && allowMotion && state in listOf("happy","waiting")) { peeking=true;delay(2400);peeking=false }
    }
    DisposableEffect(lifecycle,context) {
        val observer=LifecycleEventObserver { _,event ->
            when(event) {
                Lifecycle.Event.ON_RESUME -> { resumed=true;foregroundEpoch++ }
                Lifecycle.Event.ON_PAUSE,Lifecycle.Event.ON_STOP,Lifecycle.Event.ON_DESTROY -> resumed=false
                else -> Unit
            }
        }
        val power=object:BroadcastReceiver() {
            override fun onReceive(c:Context?,intent:Intent?) { lowPower=context.getSystemService(PowerManager::class.java).isPowerSaveMode }
        }
        lifecycle.addObserver(observer)
        ContextCompat.registerReceiver(context,power,IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED),ContextCompat.RECEIVER_NOT_EXPORTED)
        onDispose { lifecycle.removeObserver(observer); context.unregisterReceiver(power) }
    }
    LaunchedEffect(state,mayAnimate,foregroundEpoch) {
        val token=java.util.UUID.randomUUID().toString()
        motion=if(mayAnimate) token else null
        if(mayAnimate) { delay(if(state in listOf("happy","waiting")) 4900 else 2500); if(motion==token) motion=null }
    }
    val videoBackground=if(dark) Color.Black else Color(0xFFFFFEFF)
    Box(Modifier.size(size)) {
    val baseColor=Pal.Quiet
    Canvas(Modifier.align(Alignment.BottomCenter).width(size*.85f).height(size*.24f).graphicsLayer { alpha=reveal }) { drawOval(baseColor) }
    Box(Modifier.fillMaxSize().graphicsLayer { alpha=1f-reveal }.shadow(3.dp,CircleShape,clip=false)
        .border(.5.dp,if(dark) Color(0xFF323232) else Color(0xFFE5E5E5),CircleShape)
        .clip(CircleShape).background(videoBackground)) {
        if(still!=null) Image(still.asImageBitmap(),"头像状态：$state",Modifier.fillMaxSize())
        if(mayAnimate && motion!=null && !peeking) key(raw,motion) {
            val token=motion
            AvatarVideo(raw) { if(motion==token) motion=null }
        }
    }
    if(still!=null) Image(still.asImageBitmap(),null,Modifier.fillMaxSize().graphicsLayer {
        alpha=reveal;scaleX=1.24f+.1f*reveal;scaleY=scaleX;translationY=-sizePx*.06f*reveal;rotationZ=3f*reveal
    })
    }
}

/** Decoder lifetime is the short reaction, rather than the lifetime of the chat page. */
@Composable private fun AvatarVideo(raw:Int,onFinished:()->Unit) {
    val context=LocalContext.current
    val finished by rememberUpdatedState(onFinished)
    val player=remember(raw) { MediaPlayer() }
    val lifecycle=LocalLifecycleOwner.current.lifecycle
    val released=remember(player) { java.util.concurrent.atomic.AtomicBoolean(false) }
    DisposableEffect(player,lifecycle) {
        fun release() { if(released.compareAndSet(false,true)) runCatching { player.release() } }
        val observer=LifecycleEventObserver { _,event ->
            if(event==Lifecycle.Event.ON_PAUSE) runCatching { player.pause() }
            if(event==Lifecycle.Event.ON_STOP) {release();finished()}
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); release() }
    }
    AndroidView(modifier=Modifier.fillMaxSize().testTag("avatar-video"),factory={ c -> TextureView(c).apply {
        isOpaque=false
        outlineProvider=object:ViewOutlineProvider() { override fun getOutline(view:View,outline:Outline) { outline.setOval(0,0,view.width,view.height) } }
        clipToOutline=true
        surfaceTextureListener=object:TextureView.SurfaceTextureListener {
            override fun onSurfaceTextureAvailable(texture:SurfaceTexture,w:Int,h:Int) {
                runCatching {
                    val surface=Surface(texture); player.setSurface(surface); surface.release()
                    context.resources.openRawResourceFd(raw).use { player.setDataSource(it.fileDescriptor,it.startOffset,it.length) }
                    player.isLooping=false; player.setVolume(0f,0f)
                    player.setOnPreparedListener { if(!released.get() && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) it.start() }
                    player.setOnCompletionListener { finished() }
                    player.setOnErrorListener { _,_,_ -> finished();true }
                    player.prepareAsync()
                }.onFailure { finished() }
            }
            override fun onSurfaceTextureDestroyed(texture:SurfaceTexture):Boolean {
                runCatching { player.pause();player.setSurface(null) }; return true
            }
            override fun onSurfaceTextureSizeChanged(texture:SurfaceTexture,w:Int,h:Int) { invalidateOutline() }
            override fun onSurfaceTextureUpdated(texture:SurfaceTexture) {}
        }
    } })
}

@Composable
fun AvatarLabel(subtitle: String? = null,onClick: () -> Unit) {
    Box(Modifier.widthIn(min=96.dp,max=190.dp).height(80.dp),contentAlignment=Alignment.TopCenter) {
        Avatar(44.dp,expressive=true)
        Text(Chat.agentName.value,style=Type.title(13),color=Pal.Ink,maxLines=1,
            modifier=Modifier.padding(top=48.dp))
        val avatar=Chat.avatar.value
        val status=avatar.takeIf { it.state!="idle" }?.text?.ifBlank {
            when(avatar.state) { "working" -> "正在处理";"waiting" -> "等你回应";"happy" -> "这件事办好了";"error" -> "需要看一眼";else -> "" }
        }?.takeIf { it.isNotBlank() }
        val label=listOfNotNull(subtitle,status).joinToString(" · ")
        if(label.isNotBlank()) Text(label,style=Type.body(10),color=Pal.Muted,maxLines=1,
            modifier=Modifier.padding(top=68.dp).background(Pal.Background).padding(horizontal=5.dp))
        // Keep the hit target above TextureView, which can otherwise consume video touches.
        Box(Modifier.matchParentSize().tap(onClick=onClick).semantics {
            contentDescription=listOf("打开头像控制台",subtitle,status).filterNotNull().filter { it.isNotBlank() }.joinToString("，")
        })
    }
}
