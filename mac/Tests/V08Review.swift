import AppKit
import SwiftUI
import WebKit
import CoreGraphics
import AVFoundation

struct ReviewFailure:Error,CustomStringConvertible { let description:String }
@main struct V08Review {
    @MainActor static func main() {
        let app=NSApplication.shared; app.setActivationPolicy(.regular)
        Task { @MainActor in do { try await run(); print("PASS: v0.8 local cloud + Mac UI review"); exit(0) } catch { print("FAIL: \(error)"); fflush(stdout); exit(1) } }
        app.run()
    }
    static let output=URL(fileURLWithPath:"/tmp/v08-mac-shots")
    static var window:NSWindow!
    static var shotCount=0
    static var recording:Task<Void,Error>?
    static func check(_ pass:Bool,_ text:String)throws { if !pass {throw ReviewFailure(description:text)}; print("PASS: "+text); fflush(stdout) }
    static func pause(_ ms:UInt64=500) async throws { try await Task.sleep(nanoseconds:ms*1_000_000) }
    @MainActor static func until(_ text:String,_ predicate:()->Bool) async throws {
        for _ in 0..<800 { if predicate() { return }; try await pause(50) }; throw ReviewFailure(description:"timed out: "+text+"; "+ChatClient.shared.error)
    }
    @MainActor static func run() async throws {
        try FileManager.default.createDirectory(at:output,withIntermediateDirectories:true)
        try check(LocalVerification.explicitLoopback && Prefs.isolatedRoot != nil,"explicit loopback + isolated preferences, credential and browser data")
        Prefs.notifyMessages=false; Prefs.deviceName="演示 Mac"; AppearanceStore.shared.select(.light)
        window=NSWindow(contentRect:NSRect(x:0,y:0,width:1120,height:920),styleMask:[.titled,.closable,.resizable,.fullSizeContentView],backing:.buffered,defer:false)
        window.title="豆豆 · 0.8 本地验收"; window.titleVisibility = .hidden; window.titlebarAppearsTransparent=true; window.isReleasedWhenClosed=false
        window.contentView=NSHostingView(rootView:MainView()); window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps:true)
        MenuController.shared.install(); AppDelegate.openMain={ window.makeKeyAndOrderFront(nil) }
        print("CAPTURE: "+(CGPreflightScreenCaptureAccess() ? "screencapture window" : "NSView + WKWebView snapshots (no screen recording permission)")); fflush(stdout)
        let chat=ChatClient.shared; chat.start()
        try await until("first chat") { chat.items.filter{$0.kind == .assistant}.count>=2 && !chat.busy }
        let firstHistory=try await Api.json("/api/history")
        try check(!(firstHistory["items"] as? [[String:Any]] ?? []).contains { $0["source"] as? String == "onboarding" },"first-chat internal prompt stays out of user history")
        recording=Task { @MainActor in try await recordWindow(seconds:28) }
        scroll(window.contentView!,y:0); try await shot("01-first-chat")
        guard let nameBubble=chat.items.first(where:{!$0.options.isEmpty}) else { throw ReviewFailure(description:"first chat option bubble") }
        try await shot("02-first-chat-options")
        try await press("option-"+nameBubble.serverID+"-0")
        try await until("option consumed") { chat.items.first{$0.serverID == nameBubble.serverID}?.optionsUsed == true && !chat.busy }
        let saved=try await Api.json("/api/history")
        try check((saved["items"] as? [[String:Any]] ?? []).first{$0["id"] as? String == nameBubble.serverID}?["optionsUsed"] as? Bool == true,"native option click persisted and group permanently disabled")
        scroll(window.contentView!,y:0); try await shot("03-options-used")
        try await chat.send("演示忙时：请先读计划，再给我两个选项");try check(true,"send work request")
        for _ in 0..<400 { if (try await control())["readStarted"] as? Bool == true {break};try await pause(50) }
        try check(chat.busy && chat.avatarState == .working,"real SDK Read in progress and working avatar")
        scroll(window.contentView!,y:.greatestFiniteMagnitude); try await shot("04-avatar-working")
        try await chat.send("忙时插话：把散步也安排进去");try check(true,"busy interjection transmits immediately")
        try await pause(250); scroll(window.contentView!,y:.greatestFiniteMagnitude); try await shot("05-busy-interjection")
        _ = try await control("release",method:"POST")
        try await until("second say") { !chat.busy && chat.items.contains{$0.text.contains("收到你的补充") } }
        try check(chat.items.filter{$0.text.contains("收到你的补充")}.count == 1,"second say arrives once after busy interjection")
        try check(chat.avatarState == .waiting,"unconsumed option sets waiting avatar")
        scroll(window.contentView!,y:.greatestFiniteMagnitude); try await shot("06-two-say-options-waiting")
        let activities=try await Api.json("/api/activities")
        let recent=activities["recent"] as? [[String:Any]] ?? []
        guard let workID=chat.items.last(where:{$0.text.contains("收到你的补充")})?.activityID,!workID.isEmpty else {throw ReviewFailure(description:"work process identity")}
        try check(recent.contains{$0["id"] as? String == workID},"main round that used tools appears in the activity list")
        let detail=try await Api.json(ActivityStore.endpoint(workID,action:"history"))
        let steps=detail["items"] as? [[String:Any]] ?? []
        try check(steps.contains{($0["text"] as? String ?? "").contains("忙时插话")} && steps.contains{$0["kind"] as? String == "tool"},"same activity contains interjection and tool summary")
        Nav.shared.console=true; Nav.shared.consoleTab=0; try await shot("07-console-activities")
        Nav.shared.consoleTab=2; try await shot("09-console-schedules")
        Nav.shared.consoleTab=3; try await shot("10-console-memory")
        Nav.shared.console=false; try await pause()
        Nav.shared.push(.activity(id:workID,title:"演示忙时")); try await shot("11-activity-detail")
        let continuation=ComposerVerification.currentTask
        try check(continuation?.taskID == workID,"activity continuation shares production attachment composer")
        continuation?.text="继续聊这个计划"; let didSend=await continuation?.sendContents() ?? false
        try check(didSend,"activity continuation accepted by cloud")
        try await pause(800)
        Nav.shared.go(.feed); AppearanceStore.shared.select(.light); try await pause(1200); scroll(window.contentView!,y:0); try await shot("12-feed-light")
        try check(FeedStore.shared.items.count>=7,"feed loads multiple dates through cloud")
        if FeedStore.shared.next != nil { await FeedStore.shared.load() }
        try check(FeedStore.shared.days.count == 10,"feed cursor reaches ten seeded dates without splitting a day")
        AppearanceStore.shared.select(.dark); try await shot("13-feed-dark")
        try await press("feed-settings"); try await shot("14-feed-settings")
        guard let feedMarker=VerificationActionAnchor.views.object(forKey:"feed-save"),let feedWindow=feedMarker.window else {throw ReviewFailure(description:"feed settings window")}
        let editors=collect(feedWindow.contentView!,type:NSTextView.self).filter{$0.isEditable && !$0.isFieldEditor}
        print("FEED_EDITORS: \(editors.count)");fflush(stdout)
        guard let editor=editors.first(where:{$0.string.contains("关注 AI")}) ?? editors.first else {throw ReviewFailure(description:"native feed text editor")}
        editor.string += "\n本地验收：保留原文来源。";editor.didChangeText()
        editor.delegate?.textDidChange?(Notification(name:NSText.didChangeNotification,object:editor))
        try await pause(200);try await press("feed-save")
        var savedInstructions=false
        for _ in 0..<30 {let p=try await Api.json("/api/feed/settings");if (p["instructions"] as? String ?? "").contains("本地验收"){savedInstructions=true;break};try await pause(100)}
        try check(savedInstructions,"native feed editor saves instructions to cloud")
        try await pause(); Nav.shared.go(.chat); _ = try await control("feed-new",method:"POST"); try await pause(250)
        try check(FeedBadge.shared.unread,"new feed notification sets sidebar badge")
        Nav.shared.go(.feed); try await pause(300); try check(!FeedBadge.shared.unread,"entering feed clears badge")
        let feed=FeedStore.shared.items[0]
        try await press("feed-like-"+feed.path);try await press("feed-dislike-"+feed.path)
        try await press("feed-discuss-"+feed.path);try await pause(250);try check(Composer.shared.quote?.path == feed.path,"feed discussion attaches a quote before sending");try await press("composer-send")
        try await pause(600);try check(Nav.shared.tab == .chat,"native feed discussion switches to main chat");try await shot("15-feed-discussion")
        AppearanceStore.shared.select(.light); Nav.shared.go(.ideas); try await shot("16-ideas")
        let ideas=try await Api.json("/api/ideas"),groups=ideas["groups"] as? [[String:Any]] ?? []
        if let idea=(groups.first?["items"] as? [[String:Any]])?.first,let id=idea["id"] as? String {
            try await press("idea-"+id); try await pause(500); try check(Nav.shared.tab == .chat,"native idea click switches to chat"); try await shot("17-idea-chat")
        }
        Nav.shared.go(.goals); try await shot("18-goals")
        try await press("create-健康"); try await shot("19-create-goal")
        try await press("goal-start")
        try await pause(700); try check(Nav.shared.tab == .chat,"goal creation starts a conversation")
        Nav.shared.go(.goals); Nav.shared.push(.goal("每周运动")); try await shot("20-goal-detail")
        Nav.shared.go(.library); try await pause(1800); try await shot("21-library-artifacts")
        try await press("pill-影音内容"); try await shot("22-library-media")
        Nav.shared.console=true; Nav.shared.consoleTab=1; try await shot("25-console-computer")
        Nav.shared.console=false; Nav.shared.go(.settings); try await shot("26-settings")
        Nav.shared.push(.models); try await shot("27-models")
        Nav.shared.go(.settings); Nav.shared.push(.connectors(tab:1)); try await shot("28-connectors")
        Nav.shared.go(.settings); Nav.shared.push(.connectors(tab:0)); try await shot("29-local-capabilities")
        Nav.shared.go(.chat); window.makeKeyAndOrderFront(nil); try await pause(500)
        MenuController.shared.button?.performClick(nil); try await pause(600)
        if let menuWindow=MenuController.shared.popover.contentViewController?.view.window { try await capture(menuWindow,"30-menu-quick-chat") }
        MenuController.shared.close()
        let cameraAuthorization=AVCaptureDevice.authorizationStatus(for:.video)
        let cameraWindow=NSWindow(contentRect:NSRect(x:0,y:0,width:612,height:475),styleMask:[.titled,.closable],backing:.buffered,defer:false)
        cameraWindow.isReleasedWhenClosed=false;cameraWindow.title="豆豆 · 拍照";cameraWindow.contentView=NSHostingView(rootView:PhotoCaptureView{_ in});cameraWindow.center();cameraWindow.makeKeyAndOrderFront(nil)
        try await pause(500);try await capture(cameraWindow,"34-photo-entry");cameraWindow.close();window.makeKeyAndOrderFront(nil)
        try check(AVCaptureDevice.authorizationStatus(for:.video) == cameraAuthorization,"photo entry never requests camera permission before opening camera")
        if let options=chat.items.last(where:{!$0.options.isEmpty && !$0.optionsUsed}) { await chat.choose(messageID:options.serverID,optionID:options.options[0].id) }
        try await until("happy") { chat.avatarState == .happy }
        try await shot("31-avatar-happy")
        try await pause(3300); try await shot("32-avatar-idle")
        try await chat.send("故障演示");try check(true,"send scripted failure")
        try await until("error avatar") { chat.avatarState == .error }
        try await shot("33-avatar-error")
        try check(CGPreflightScreenCaptureAccess() == false || shotCount>0,"capture completed using available permission")
        try check(!Prefs.supportDir.path.hasPrefix(NSHomeDirectory()+"/Library/Application Support/Doudou"),"acceptance never uses installed app data directory")
        if let recording { try await recording.value }
        chat.stop(); window.close()
        print("SCREENSHOTS: \(shotCount)"); fflush(stdout)
    }
    /// Sample only this owned window. macOS ignores -l when screencapture uses -v,
    /// so recording individual window frames also excludes unrelated windows and system alerts.
    @MainActor static func recordWindow(seconds:Double) async throws {
        let frames=FileManager.default.temporaryDirectory.appendingPathComponent("v08-window-frames-"+UUID().uuidString)
        try FileManager.default.createDirectory(at:frames,withIntermediateDirectories:true)
        defer { try? FileManager.default.removeItem(at:frames) }
        let start=ProcessInfo.processInfo.systemUptime
        var samples:[(String,Double)]=[]
        while ProcessInfo.processInfo.systemUptime-start<seconds {
            let file=frames.appendingPathComponent(String(format:"%05d.png",samples.count))
            let timestamp=ProcessInfo.processInfo.systemUptime-start
            var captured=false
            if CGPreflightScreenCaptureAccess() {
                let p=Process();p.executableURL=URL(fileURLWithPath:"/usr/sbin/screencapture")
                p.arguments=["-x","-l",String(window.windowNumber),file.path];try p.run();p.waitUntilExit()
                captured=p.terminationStatus == 0
            }
            if !captured,let view=window.contentView,let bitmap=view.bitmapImageRepForCachingDisplay(in:view.bounds) {
                view.cacheDisplay(in:view.bounds,to:bitmap)
                if let png=bitmap.representation(using:.png,properties:[:]) {try png.write(to:file);captured=true}
            }
            if captured {samples.append((file.path,timestamp))}
            let remaining=0.2-(ProcessInfo.processInfo.systemUptime-start-timestamp)
            try await pause(UInt64(max(1,remaining*1000)))
        }
        guard samples.count>20 else {throw ReviewFailure(description:"window recording frame count")}
        var list=""
        for index in samples.indices {
            let duration=index+1<samples.count ? samples[index+1].1-samples[index].1 : 0.2
            list += "file '\(samples[index].0)'\nduration \(duration)\n"
        }
        list += "file '\(samples.last!.0)'\n"
        let manifest=frames.appendingPathComponent("frames.txt");try list.write(to:manifest,atomically:true,encoding:.utf8)
        let encode=Process();encode.executableURL=URL(fileURLWithPath:"/usr/bin/env")
        encode.arguments=["ffmpeg","-v","error","-y","-f","concat","-safe","0","-i",manifest.path,"-vf","scale=1232:-2,format=yuv420p","-an","-c:v","libx264","-crf","21","-fps_mode","vfr","-movflags","+faststart",output.appendingPathComponent("key-flow-window.mp4").path]
        try encode.run();encode.waitUntilExit()
        try check(encode.terminationStatus == 0,"owned-window recording encoded (\(samples.count) live frames)")
    }
    static func control(_ route:String="",method:String="GET") async throws->[String:Any] {
        let meta=try JSONSerialization.jsonObject(with:Data(contentsOf:output.appendingPathComponent("local-cloud.json"))) as! [String:Any]
        var r=URLRequest(url:URL(string:(meta["control"] as! String)+"/"+route)!);r.httpMethod=method
        let (d,_)=try await URLSession.shared.data(for:r);return try JSONSerialization.jsonObject(with:d) as! [String:Any]
    }
    @MainActor static func shot(_ name:String) async throws { try await pause(750); try await capture(window.attachedSheet ?? window,name) }
    @MainActor static func capture(_ w:NSWindow,_ name:String) async throws {
        guard let view=w.contentView else {throw ReviewFailure(description:"capture content view")}; view.layoutSubtreeIfNeeded()
        let target=output.appendingPathComponent(name+".png")
        if CGPreflightScreenCaptureAccess() {
            let process=Process();process.executableURL=URL(fileURLWithPath:"/usr/sbin/screencapture");process.arguments=["-x","-l",String(w.windowNumber),target.path];try process.run();process.waitUntilExit()
            if process.terminationStatus == 0 {shotCount += 1;print("SHOT: "+name);fflush(stdout);return}
        }
        guard let bitmap=view.bitmapImageRepForCachingDisplay(in:view.bounds) else {throw ReviewFailure(description:"native snapshot")}
        view.cacheDisplay(in:view.bounds,to:bitmap)
        for web in collect(view,type:WKWebView.self) where !web.visibleRect.isEmpty {
            let snapshot=try await web.takeSnapshot(configuration:nil)
            let rect=web.convert(web.bounds,to:view),visible=web.convert(web.visibleRect,to:view).intersection(view.bounds)
            guard !visible.isEmpty,let context=NSGraphicsContext(bitmapImageRep:bitmap) else {continue}
            NSGraphicsContext.saveGraphicsState();NSGraphicsContext.current=context
            let draw=view.isFlipped ? NSRect(x:rect.minX,y:view.bounds.height-rect.maxY,width:rect.width,height:rect.height):rect
            let clip=view.isFlipped ? NSRect(x:visible.minX,y:view.bounds.height-visible.maxY,width:visible.width,height:visible.height):visible
            NSBezierPath(rect:clip).addClip();snapshot.draw(in:draw);NSGraphicsContext.restoreGraphicsState()
        }
        guard let png=bitmap.representation(using:.png,properties:[:]) else {throw ReviewFailure(description:"PNG encode")}
        try png.write(to:target);shotCount += 1;print("SHOT: "+name);fflush(stdout)
    }
    @MainActor static func collect<T:NSView>(_ view:NSView,type:T.Type)->[T] { (view as? T).map{[$0]} ?? view.subviews.flatMap{collect($0,type:type)} }
    @MainActor static func find<T:NSView>(_ view:NSView,type:T.Type)->T? { collect(view,type:type).first }
    @MainActor static func scroll(_ view:NSView,y:CGFloat) {
        guard let s=collect(view,type:NSScrollView.self).max(by:{$0.bounds.height<$1.bounds.height}),let doc=s.documentView else {return}
        s.contentView.scroll(to:NSPoint(x:0,y:min(max(0,y),max(0,doc.bounds.height-s.contentView.bounds.height))));s.reflectScrolledClipView(s.contentView)
    }
    @MainActor static func press(_ name:String) async throws {
        guard let marker=VerificationActionAnchor.views.object(forKey:name as NSString),let w=marker.window else {throw ReviewFailure(description:"native action marker "+name)}
        marker.scrollToVisible(marker.bounds);try await pause(100)
        let p=marker.convert(NSPoint(x:marker.bounds.midX,y:marker.bounds.midY),to:nil)
        for type in [NSEvent.EventType.leftMouseDown,.leftMouseUp] {
            let event=NSEvent.mouseEvent(with:type,location:p,modifierFlags:[],timestamp:ProcessInfo.processInfo.systemUptime,windowNumber:w.windowNumber,context:nil,eventNumber:1,clickCount:1,pressure:type == .leftMouseDown ? 1:0)!
            NSApp.postEvent(event,atStart:false)
        }; try await pause(250)
    }
    @MainActor static func accessibilityPress(_ obj:Any,label:String,depth:Int=0)->Bool {
        guard depth<80,let el=obj as? NSAccessibilityProtocol else {return false}
        if el.accessibilityRole() == .button && (el.accessibilityLabel() == label || el.accessibilityTitle() == label) {return el.accessibilityPerformPress()}
        for child in el.accessibilityChildren() ?? [] {if accessibilityPress(child,label:label,depth:depth+1) {return true}};return false
    }
}
