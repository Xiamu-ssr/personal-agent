import AppKit
import SwiftUI

@main struct ChatLifecycleReview {
 @MainActor static func main(){
  NSApplication.shared.setActivationPolicy(.regular)
  Task{@MainActor in do{try await run();print("PASS: atomic history, reconnect ordering, initial position and older-page anchor");exit(0)}catch{print("FAIL: \(error)");exit(1)}}
  NSApplication.shared.run()
 }
 @MainActor static func run() async throws {
  func check(_ condition:Bool,_ message:String)throws{if !condition{throw ApiError(code:0,message:message)}}
  let transcript=ChatTranscript(),rows=(0..<1000).map{i in ["id":"synthetic-\(i)","role":i%2==0 ? "user":"assistant","text":"合成消息 \(i)：核对历史加载和阅读位置。","ts":1_790_000_000_000+i] as [String:Any]}
  transcript.mergeSnapshot(rows)
  try check(transcript.revision==1,"History must publish one revision")
  let ids=transcript.items.map(\.serverID)
  transcript.mergeSnapshot(Array(rows.suffix(100)))
  try check(transcript.items.map(\.serverID)==ids && transcript.revision==1,"Reconnect suffix reordered known history")
  transcript.mergeSnapshot(rows)
  try check(transcript.revision==1,"Identical refill published unnecessary updates")
  let window=NSWindow(contentRect:NSRect(x:0,y:0,width:900,height:700),styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false)
  window.isReleasedWhenClosed=false;window.title="豆豆 · 聊天加载验收"
  window.contentView=NSHostingView(rootView:NativeChatList(transcript:transcript,state:transcript.scrollState,active:true).frame(maxWidth:.infinity,maxHeight:.infinity))
  window.makeKeyAndOrderFront(nil)
  func find(_ v:NSView)->NSTableView?{if let t=v as? NSTableView{return t};return v.subviews.compactMap(find).first}
  for _ in 0..<40{try await Task.sleep(nanoseconds:50_000_000);window.contentView?.layoutSubtreeIfNeeded()}
  let table=find(window.contentView!)!,scroll=table.enclosingScrollView!,coordinator=table.delegate as! NativeChatList.Coordinator
  try check(table.rows(in:scroll.documentVisibleRect).location>980,"Initial history did not open at the newest rows")
  transcript.scrollState.report(distance:100000,viewport:700,positionChanged:true)
  table.scrollRowToVisible(500);try await Task.sleep(nanoseconds:300_000_000)
  let before=table.row(at:NSPoint(x:1,y:scroll.contentView.bounds.minY+1)),anchor=coordinator.items[before].serverID
  let older=(0..<100).map{i in ["id":"older-\(i)","role":"user","text":"更早的合成消息 \(i)","ts":1_789_999_000_000+i] as [String:Any]}
  transcript.mergeSnapshot(older)
  try await Task.sleep(nanoseconds:500_000_000)
  let after=table.row(at:NSPoint(x:1,y:scroll.contentView.bounds.minY+1))
  try check(coordinator.items[after].serverID==anchor,"Prepending older history moved the reading anchor")
  let bytes=window.contentView!.bitmapImageRepForCachingDisplay(in:window.contentView!.bounds)!
  window.contentView!.cacheDisplay(in:window.contentView!.bounds,to:bytes)
  try bytes.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:"/tmp/doudou-v181-check/mac-history.png"))
  Prefs.server="http://127.0.0.1:18771";Prefs.token="local-fixture"
  let client=ChatClient.shared;client.start()
  for _ in 0..<100 {if client.connected && !client.items.isEmpty{break};try await Task.sleep(nanoseconds:50_000_000)}
  try check(client.items.count==100,"Cold connect fetched the entire transcript")
  await client.loadEarlier();try check(client.items.count==200,"Older page was not loaded")
  let composer=Composer();composer.text="Synthetic Mac receipt";let start=Date()
  let sent=await composer.sendContents()
  try check(sent && composer.text.isEmpty && Date().timeIntervalSince(start)<2,"Composer waited for native model admission")
  try check(client.items.filter{$0.text=="Synthetic Mac receipt"}.count==1,"Receipt and WS echo created duplicate bubbles")
  print("Receipt confirmed in \(Int(Date().timeIntervalSince(start)*1000)) ms while model admission remains delayed")
  client.stop()
  window.close()
 }
}
