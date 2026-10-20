package com.xiamu.agent.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.*
import androidx.test.platform.app.InstrumentationRegistry
import com.xiamu.agent.*
import com.xiamu.agent.media.Images
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class ImageLayoutDeviceTest {
    @get:Rule val ui=createAndroidComposeRule<LayoutProbeActivity>()

    @Test fun portraitAndMultipleImagesReserveTheirFullHeightBeforeCaptionAndNextRow() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        Prefs.init(context);Prefs.server="http://127.0.0.1:18770";Prefs.token="synthetic-layout-token"
        var width by mutableStateOf(320)
        var font by mutableStateOf(1f)
        var paths by mutableStateOf(listOf("data/library/portrait.png"))
        ui.setContent {
            val density=LocalDensity.current.density
            CompositionLocalProvider(LocalDensity provides Density(density,font)) {
                Column(Modifier.width(width.dp).verticalScroll(rememberScrollState())) {
                    ChatRow(ChatItem.User("SYNTHETIC CAPTION",paths.map {Attachment(it,"Synthetic image","image")},id="layout-user"))
                    Text("NEXT ROW",Modifier.testTag("next-row"))
                }
            }
        }
        for((w,f) in listOf(320 to 1f,280 to 1.4f)) for(sample in listOf(listOf("portrait"),listOf("landscape"),listOf("portrait","landscape"),listOf("portrait","landscape","square"))) {
            ui.runOnIdle {width=w;font=f;paths=sample.map {"data/library/$it.png"}}
            ui.waitUntil(15000) {paths.all {Images.cached(it,900)!=null}}
            ui.waitForIdle()
            val pictures=paths.map {ui.onNodeWithTag("content-image:$it",useUnmergedTree=true).getUnclippedBoundsInRoot()}
            val caption=ui.onNodeWithText("SYNTHETIC CAPTION",useUnmergedTree=true).getUnclippedBoundsInRoot()
            val next=ui.onNodeWithTag("next-row",useUnmergedTree=true).getUnclippedBoundsInRoot()
            for((i,p) in pictures.withIndex()) {
                val expected=when(sample[i]) {"portrait"->1.5f;"landscape"->.5f;else->1f}
                assertEquals("Original aspect ratio at $w / $f",expected,p.height.value/p.width.value,.015f)
                assertTrue("Caption must follow the entire image",caption.top.value>=p.bottom.value-1)
                assertTrue("Image must stay inside the viewport",p.left.value>=-1 && p.right.value<=w+1)
            }
            assertTrue("Following row must not overlap the caption",next.top.value>=caption.bottom.value-1)
        }
    }

    @Test fun feedImageKeepsOriginalAspectRatioAndAllThreeBands() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        Prefs.init(context);Prefs.server="http://127.0.0.1:18770";Prefs.token="synthetic-layout-token"
        val path="data/library/portrait.png"
        val post=FeedPost("data/feed/2026-10-20/1200-layout.md","2026-10-20","Synthetic feed","Fixture","","2026-10-20 12:00","🌿",path,"Synthetic body")
        ui.setContent {Column(Modifier.width(320.dp).verticalScroll(rememberScrollState())) {FeedPostView(post)}}
        ui.waitUntil(15000) {Images.cached(path,900)!=null};ui.waitForIdle()
        val image=ui.onNodeWithTag("content-image:$path",useUnmergedTree=true).getUnclippedBoundsInRoot()
        assertEquals(1.5f,image.height.value/image.width.value,.015f)
        assertTrue("A portrait feed image must not be limited to the old 180dp",image.height.value>300)
        val pixels=ui.onNodeWithTag("content-image:$path",useUnmergedTree=true).captureToImage().toPixelMap()
        val top=pixels[pixels.width/2,pixels.height/6]
        val middle=pixels[pixels.width/2,pixels.height/2]
        val bottom=pixels[pixels.width/2,pixels.height*5/6]
        assertTrue("Top blue band is visible",top.blue>top.red+.2f)
        assertTrue("Middle green band is visible",middle.green>middle.red+.1f)
        assertTrue("Bottom orange band is visible",bottom.red>bottom.blue+.3f)
    }
}
