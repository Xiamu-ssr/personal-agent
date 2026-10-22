package com.xiamu.agent.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import com.xiamu.agent.ChatItem
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import com.xiamu.agent.Chat
import com.xiamu.agent.Prefs
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking

class ChatLifecycleDeviceTest {
 @get:Rule val ui=createAndroidComposeRule<LayoutProbeActivity>()
 @Test fun coldHistoryStartsAtNewestWithoutAnimatingAcrossTheTranscript(){
  var items by mutableStateOf<List<ChatItem>>(emptyList())
  ui.setContent{AgentTheme{Box(Modifier.fillMaxSize()){ChatScreen(rememberLazyListState(),0.dp,items=items,error="",emptyText="正在加载")}}}
  ui.runOnIdle{items=(0..<1000).map{ChatItem.User("Synthetic message $it",ts=it.toLong(),id="m-$it")}}
  ui.onNodeWithText("Synthetic message 999").assertIsDisplayed()
  ui.onNodeWithText("Synthetic message 0").assertDoesNotExist()
  repeat(3){ui.onNodeWithTag("chat-list").performTouchInput{swipeDown()}}
  ui.runOnIdle{items=(0..<100).map{ChatItem.User("Older message $it",ts=(it-100).toLong(),id="old-$it")}+items}
  ui.onNodeWithText("Synthetic message 999").assertDoesNotExist()
  ui.onNodeWithTag("return-bottom").performClick()
  ui.onNodeWithText("Synthetic message 999").assertIsDisplayed()
 }
 @Test fun cloudReceiptClearsDraftWhileNativeAdmissionIsStillPending(){
  val context=InstrumentationRegistry.getInstrumentation().targetContext
  Prefs.init(context);val previous=Prefs.server to Prefs.token;val draft=MessageDraft()
  ui.setContent{Box(Modifier.fillMaxSize())}
  try {
   ui.runOnIdle{Chat.reset();Prefs.server="http://127.0.0.1:18771";Prefs.token="local-fixture";Chat.connect()}
   ui.waitUntil(8000){Chat.connected.value && Chat.items.isNotEmpty()}
   ui.runOnIdle{assertTrue(Chat.items.size<=100);draft.text.value="Synthetic Android receipt";assertTrue(draft.send(context))}
   ui.waitUntil(2000){draft.text.value.isEmpty() && !draft.sending.value}
   ui.runOnIdle{assertEquals(1,Chat.items.filterIsInstance<ChatItem.User>().count{it.text=="Synthetic Android receipt"})}
  } finally {ui.runOnUiThread{draft.reset();Chat.reset();Prefs.server=previous.first;Prefs.token=previous.second}}
 }
}
