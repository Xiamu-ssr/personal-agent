import AppKit
import SwiftUI
import Foundation

final class CacheWire:URLProtocol {
    static var requests:[URLRequest]=[]
    static var version="one"
    override class func canInit(with request:URLRequest)->Bool{true}
    override class func canonicalRequest(for request:URLRequest)->URLRequest{request}
    override func startLoading(){
        Self.requests.append(request)
        let tag="\""+Self.version+"\"",unchanged=request.value(forHTTPHeaderField:"If-None-Match")==tag
        let response=HTTPURLResponse(url:request.url!,statusCode:unchanged ? 304:200,httpVersion:nil,headerFields:["ETag":tag])!
        client?.urlProtocol(self,didReceive:response,cacheStoragePolicy:.notAllowed)
        if !unchanged {client?.urlProtocol(self,didLoad:Data((Self.version+":"+(request.value(forHTTPHeaderField:"Authorization") ?? "public")).utf8))}
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading(){}
}

@main struct V17Review {
    @MainActor static func main(){
        NSApplication.shared.setActivationPolicy(.regular)
        Task{@MainActor in do{try await run();print("PASS: account-scoped cache, actual library and native virtualized chat");exit(0)}catch{print("FAIL",error);exit(1)}}
        NSApplication.shared.run()
    }
    @MainActor static func run() async throws {
        precondition(Prefs.isolatedRoot != nil && LocalVerification.explicitLoopback)
        let output=URL(fileURLWithPath:ProcessInfo.processInfo.environment["DOUDOU_REVIEW_OUTPUT"]!)
        try FileManager.default.createDirectory(at:output,withIntermediateDirectories:true)
        let server=Prefs.server,token=Prefs.token,transport=Api.session
        let config=URLSessionConfiguration.ephemeral;config.protocolClasses=[CacheWire.self];Api.session=URLSession(configuration:config)
        let cache=ResourceCache()
        let fixture="https://cloud.example.invalid",one="synthetic-account-one",two="synthetic-account-two"
        async let first=cache.value("data/uploads/shared.txt",server:fixture,token:one)
        async let concurrent=cache.value("data/uploads/shared.txt",server:fixture,token:one)
        let (a,b)=try await(first,concurrent)
        guard a==b,CacheWire.requests.count==1 else{throw ApiError(code:0,message:"Concurrent requests were not coalesced")}
        let unchanged=try await cache.value("data/uploads/shared.txt",force:true,server:fixture,token:one)
        guard unchanged==a,CacheWire.requests.count==2,CacheWire.requests.last?.value(forHTTPHeaderField:"If-None-Match") == "\"one\"" else{throw ApiError(code:0,message:"ETag revalidation failed")}
        CacheWire.version="two";let changed=try await cache.value("data/uploads/shared.txt",force:true,server:fixture,token:one)
        guard changed != a else{throw ApiError(code:0,message:"Updated file remained stale")}
        let second=try await cache.value("data/uploads/shared.txt",server:fixture,token:two)
        guard second != changed else{throw ApiError(code:0,message:"Another account saw cached private bytes")}
        _=try await cache.value("https://images.example.invalid/public.png")
        guard CacheWire.requests.last?.value(forHTTPHeaderField:"Authorization")==nil else{throw ApiError(code:0,message:"External request received the private credential")}
        let restored=ResourceCache();_ = try await restored.value("data/uploads/shared.txt",server:fixture,token:two)
        guard CacheWire.requests.count==5 else{throw ApiError(code:0,message:"Disk cache did not survive a new cache instance")}
        let changedWhileAway=ResourceCache();await changedWhileAway.invalidate();CacheWire.version="three"
        let refreshed=try await changedWhileAway.value("data/uploads/shared.txt",server:fixture,token:two)
        guard refreshed != second,CacheWire.requests.count==6 else{throw ApiError(code:0,message:"A content event failed to invalidate bytes stored only on disk")}
        Prefs.server=server;Prefs.token=token;Api.session=transport
        for path in ["data/library/media/演示视频.mp4","data/library/media/演示音频.mp3"] {
            let item=MediaItem(["path":path,"kind":"file"])!,playback=MediaPlayback()
            await playback.prepare(item)
            guard playback.player != nil,playback.duration>=2 else{throw ApiError(code:0,message:"Mainstream media could not load")}
            playback.player?.isMuted=true;playback.toggle();try await Task.sleep(nanoseconds:700_000_000)
            guard playback.time>0 else{throw ApiError(code:0,message:"Native playback did not advance")};playback.release()
        }
        AppearanceStore.shared.select(.dark)
        let window=NSWindow(contentRect:NSRect(x:0,y:0,width:960,height:860),styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false)
        window.isReleasedWhenClosed=false;window.title="豆豆 · 1.7 内容与长会话验收"
        func show<V:View>(_ view:V){window.contentView=NSHostingView(rootView:view.background(Theme.background).foregroundStyle(Theme.ink).preferredColorScheme(.dark));window.center();window.makeKeyAndOrderFront(nil)}
        func until(_ condition:()->Bool) async throws{for _ in 0..<200{if condition(){return};try await Task.sleep(nanoseconds:100_000_000)};throw ApiError(code:0,message:"Native UI did not settle")}
        func shot(_ name:String)throws{let view=window.contentView!;let bitmap=view.bitmapImageRepForCachingDisplay(in:view.bounds)!;view.cacheDisplay(in:view.bounds,to:bitmap);try bitmap.representation(using:.png,properties:[:])!.write(to:output.appendingPathComponent(name+".png"))}
        LibraryStore.shared.reset();show(LibraryPage())
        try await until{LibraryStore.shared.artifacts.count==7}
        try await until{LibraryStore.shared.artifacts.filter{$0.thumbnail != nil}.filter{VerificationActionAnchor.views.object(forKey:("library-image-"+($0.thumbnail ?? "")) as NSString) != nil}.count>=5}
        try shot("mac-library")
        let libraryCount=LibraryStore.shared.artifacts.count;show(Text("返回资源库"));show(LibraryPage());try await Task.sleep(nanoseconds:500_000_000)
        guard LibraryStore.shared.artifacts.count==libraryCount else{throw ApiError(code:0,message:"Navigation discarded the library")}
        let transcript=ChatTranscript(),state=ChatScrollState()
        let text=String(repeating:"这是一段合成长回复，用于验证内容布局和窗口缩放，不包含真实用户资料。",count:18)
        for i in 0..<1000{transcript.receive(["id":"review-\(i)","role":i%2==0 ? "user":"assistant","text":i%2==0 ? "第 \(i) 个合成问题":"## 长回复 \(i)\n\n\(text)\n\n1. **背景**：\(text)\n2. **行动**：\(text)\n\n| 项目 | 结果 |\n| --- | --- |\n| 验收 | 正常 |","ts":1792500000000+i*1000])}
        show(NativeChatList(transcript:transcript,state:state,active:true))
        func table(_ view:NSView)->NSTableView?{if let v=view as? NSTableView{return v};return view.subviews.compactMap{table($0)}.first}
        try await until{table(window.contentView!)?.numberOfRows==1000}
        try await Task.sleep(nanoseconds:500_000_000)
        guard let list=table(window.contentView!),let scroll=list.enclosingScrollView else{throw ApiError(code:0,message:"No native chat list")}
        guard list.rows(in:list.visibleRect).contains(999),list.bounds.height>10000 else{throw ApiError(code:0,message:"Chat did not scroll to its actual final row")}
        func hostCount(_ view:NSView)->Int{(view is ChatBubbleHost ? 1:0)+view.subviews.reduce(0){$0+hostCount($1)}}
        let initialHosts=hostCount(list)
        list.scrollRowToVisible(100);state.report(distance:list.bounds.height-scroll.contentView.bounds.maxY,viewport:scroll.contentSize.height,positionChanged:true)
        let position=scroll.contentView.bounds.minY
        transcript.receive(["id":"while-reading","role":"assistant","text":"这条新消息不应把正在看的历史拉到底部。"])
        try await Task.sleep(nanoseconds:300_000_000)
        guard abs(scroll.contentView.bounds.minY-position)<2,state.unread>0 else{throw ApiError(code:0,message:"New message stole the history reader's position")}
        let readingRow=list.row(at:NSPoint(x:1,y:scroll.contentView.bounds.minY+1))
        window.setContentSize(NSSize(width:720,height:860));try await Task.sleep(nanoseconds:500_000_000)
        guard list.row(at:NSPoint(x:1,y:scroll.contentView.bounds.minY+1))==readingRow else{throw ApiError(code:0,message:"Window resize jumped to a different historical message")}
        state.returnToBottom();show(NativeChatList(transcript:transcript,state:state,active:true,returnRevision:1));try await Task.sleep(nanoseconds:500_000_000)
        let start=Date();var ticks=0
        while Date().timeIntervalSince(start)<20{
            try await Task.sleep(nanoseconds:100_000_000);ticks+=1
            if ticks%10==0{window.setContentSize(NSSize(width:ticks%20==0 ? 960:720,height:860))}
            if ticks%15==0{transcript.receive(["id":"incoming-\(ticks)","role":"assistant","text":"持续接收合成消息 \(ticks)：\(text)"])}
        }
        guard ticks>=120 else{throw ApiError(code:0,message:"Main-thread responsiveness regressed")}
        try shot("mac-long-chat")
        let record:[String:Any]=["cacheCoalesced":true,"etagRevalidated":true,"overwriteUpdated":true,"diskInvalidatedByEvent":true,"accountsIsolated":true,"diskCacheReused":true,"externalHasNoCredential":true,"nativeMediaPlayed":2,"libraryEntries":libraryCount,"chatMessages":transcript.items.count,"initialRetainedHosts":initialHosts,"responsiveTicks":ticks,"seconds":Date().timeIntervalSince(start),"historyPositionPreserved":true,"historyMessagePreservedAcrossResize":true,"syntheticData":true]
        try JSONSerialization.data(withJSONObject:record,options:.prettyPrinted).write(to:output.appendingPathComponent("mac-review.json"));window.close()
    }
}
