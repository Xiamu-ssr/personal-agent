package com.xiamu.agent.ui

import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.*
import androidx.test.platform.app.InstrumentationRegistry
import com.xiamu.agent.*
import com.xiamu.agent.media.Images
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class LibraryLayoutDeviceTest {
    @get:Rule val ui=createAndroidComposeRule<LayoutProbeActivity>()

    @Test fun realLibraryPreviewsStayInsideTheirFramesAndAboveTheirTitlesAtLargeFont() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        Prefs.init(context);Prefs.server="http://127.0.0.1:18770";Prefs.token="local-fixture"
        val library=runBlocking{Api.library()}
        val pages=library.artifacts.filter{it.kind=="site"}
        assertEquals(6,pages.size)
        assertTrue(library.artifacts.none{it.name in listOf("theme","mark")})
        var font by mutableFloatStateOf(1f)
        ui.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density,font)) {
                Box(Modifier.width(280.dp).fillMaxHeight()){LibraryScreen(0.dp)}
            }
        }
        for(f in listOf(1f,1.4f)) {
            ui.runOnIdle{font=f}
            for(page in pages) {
                ui.onNode(hasScrollAction()).performScrollToNode(hasTestTag("library-artifact:${page.path}"))
                ui.waitUntil(20_000){Images.cached(page.thumbnail!!,900)!=null};ui.waitForIdle()
                val preview=ui.onNodeWithTag("content-image:${page.thumbnail}",useUnmergedTree=true).getUnclippedBoundsInRoot()
                val title=ui.onNodeWithTag("artifact-title:${page.path}",useUnmergedTree=true).getUnclippedBoundsInRoot()
                val card=ui.onNodeWithTag("library-artifact:${page.path}",useUnmergedTree=true).getUnclippedBoundsInRoot()
                assertEquals("Preview height must remain bounded",132f,preview.height.value,.5f)
                assertTrue("Title must follow the preview at font $f",title.top>=preview.bottom)
                assertTrue("Title must stay in the card",title.bottom<=card.bottom)
            }
        }
    }
}
