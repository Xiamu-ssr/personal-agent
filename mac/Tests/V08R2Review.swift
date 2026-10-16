import AppKit
import SwiftUI
import WebKit
import CoreGraphics

struct ReviewFailure:Error,CustomStringConvertible {let description:String}
@main struct V08R2Review {
    static let output=URL(fileURLWithPath:"/tmp/v08-mac-shots/r2")
    static var window:NSWindow!
    static var shotCount=0
    @MainActor static func main() {
        let app=NSApplication.shared;app.setActivationPolicy(.regular)
        Task { @MainActor in
            do {try await run();print("PASS: r2 native Mac + local cloud review");fflush(stdout);exit(0)}
            catch {print("FAIL: \(error)");fflush(stdout);exit(1)}
        };app.run()
    }
    static func check(_ pass:Bool,_ message:String)throws {if !pass {throw ReviewFailure(description:message)};print("PASS: "+message);fflush(stdout)}
    static func pause(_ ms:UInt64=500) async throws {try await Task.sleep(nanoseconds:ms*1_000_000)}
    @MainActor static func until(_ message:String,_ condition:()->Bool) async throws {
        for _ in 0..<600 {if condition(){return};try await pause(50)}
        throw ReviewFailure(description:"timed out: "+message+"; "+ChatClient.shared.error)
    }
    @MainActor static func frame(_ name:String)throws->NSRect {
        guard let marker=VerificationActionAnchor.views.object(forKey:name as NSString) else {throw ReviewFailure(description:"geometry marker "+name)}
        return marker.convert(marker.bounds,to:window.contentView!)
    }
    @MainActor static func typeAndSend(_ text:String) async throws {
        guard let editor=collect(window.contentView!,type:NSTextView.self).first(where:{$0.isEditable && !$0.isFieldEditor && $0.bounds.width>100}) else {throw ReviewFailure(description:"native composer editor")}
        window.makeFirstResponder(editor);editor.string=text;editor.didChangeText()
        editor.delegate?.textDidChange?(Notification(name:NSText.didChangeNotification,object:editor))
        try await pause(180);try await press("composer-send")
    }
    @MainActor static func run() async throws {
        try FileManager.default.createDirectory(at:output,withIntermediateDirectories:true)
        try check(LocalVerification.explicitLoopback && Prefs.isolatedRoot != nil,"explicit loopback and isolated user data")
        Prefs.notifyMessages=false;Prefs.deviceName="演示 Mac";AppearanceStore.shared.select(.light)
        window=NSWindow(contentRect:NSRect(x:0,y:0,width:1120,height:920),styleMask:[.titled,.closable,.resizable,.fullSizeContentView],backing:.buffered,defer:false)
        window.title="豆豆 · 0.8 第二轮验收";window.titleVisibility = .hidden;window.titlebarAppearsTransparent=true;window.isReleasedWhenClosed=false
        window.contentView=NSHostingView(rootView:MainView());window.center();window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)
        AppDelegate.openMain={window.makeKeyAndOrderFront(nil)}
        let chat=ChatClient.shared;chat.start()
        try await until("main bootstrap"){chat.connected && chat.items.count>=2 && !chat.busy}
        try await until("side list ready"){!SideChats.shared.loading}
        if CommandLine.arguments.contains("--restore-side") {
            await SideChats.shared.load()
            try check(SideChats.shared.items.count == 2,"fresh App process restores only the two server side chats")
            let meta=try JSONSerialization.jsonObject(with:Data(contentsOf:output.appendingPathComponent("side-isolation.json"))) as! [String:Any]
            let id=meta["sideA"] as! String
            try await pause(250);try await press("side-chat-"+id)
            try await until("restored side history"){Nav.shared.sideChat?.transcript.items.contains{$0.optionsUsed} == true}
            try check(Nav.shared.sideChat?.transcript.items.contains{$0.text.contains("先列三个方向")} == true,"fresh process restores consumed side options and its messages")
            try await shot("12-side-restored")
            try await press("tab-chat");try await pause(400)
            try check(Nav.shared.sideChat == nil && !chat.items.contains{$0.text.contains("旁聊演示：")},"restored main chat remains separate")
        } else {
            scroll(window.contentView!,y:0);try await shot("01-chat-light")
            AppearanceStore.shared.select(.dark);try await shot("02-chat-dark")
            AppearanceStore.shared.select(.light);Nav.shared.go(.feed);try await pause(800);scroll(window.contentView!,y:0);try await shot("03-feed-light")
            AppearanceStore.shared.select(.dark);try await shot("14-feed-dark");AppearanceStore.shared.select(.light);try await pause(200)
            let avatar=try frame("floating-avatar"),title=try frame("page-title-动态")
            scroll(window.contentView!,y:620);try await pause(400)
            let scrolledAvatar=try frame("floating-avatar"),scrolledTitle=try frame("page-title-动态")
            try check(abs(avatar.midY-scrolledAvatar.midY)<1 && abs(title.midY-scrolledTitle.midY)>500,"floating avatar stays fixed while feed title scrolls away")
            try await shot("04-feed-scrolled-light")
            AppearanceStore.shared.select(.dark);try await shot("05-feed-scrolled-dark")
            AppearanceStore.shared.select(.light);try await press("tab-chat")
            try await chat.send("演示忙时：先读一下今天的计划");try check(true,"main chat starts real SDK Read")
            for _ in 0..<400 {if (try await control())["readStarted"] as? Bool == true {break};try await pause(50)}
            try check(chat.busy,"main chat remains busy during side chat test")
            let mainBefore=try await Api.json("/api/history")
            let mainBeforeData=try JSONSerialization.data(withJSONObject:mainBefore,options:.sortedKeys)
            await SideChats.shared.load()
            try check(SideChats.shared.items.isEmpty,"ordinary main activity never appears in sidebar side list")
            try await press("new-side-chat")
            guard let sideA=Nav.shared.sideChat else {throw ReviewFailure(description:"new side page")}
            try check(sideA.activityID == nil,"new button opens a draft without creating empty server activity")
            try await shot("06-new-side-chat")
            try await typeAndSend("旁聊演示：想给周末留一点时间")
            try await until("first side options"){sideA.activityID != nil && sideA.transcript.items.contains{!$0.options.isEmpty} && sideA.status == "done"}
            guard let idA=sideA.activityID,let option=sideA.transcript.items.first(where:{!$0.options.isEmpty}) else {throw ReviewFailure(description:"created side chat identity")}
            try check(chat.busy && !chat.items.contains{$0.activityID == idA},"side reply leaves main busy and its transcript unchanged")
            scroll(window.contentView!,y:0);try await shot("07-side-messages")
            try await press("option-"+option.serverID+"-0")
            try await until("side choice reply"){sideA.transcript.items.contains{$0.optionsUsed} && sideA.transcript.items.contains{$0.text.contains("这个话题留在这条旁聊")}}
            try await shot("08-side-options-used")
            try await press("new-side-chat")
            guard let sideB=Nav.shared.sideChat else {throw ReviewFailure(description:"second side draft")}
            try await typeAndSend("旁聊演示：做一份阅读清单")
            try await until("second side options"){sideB.activityID != nil && sideB.transcript.items.contains{!$0.options.isEmpty} && sideB.status == "done"}
            let idB=sideB.activityID!
            await SideChats.shared.load();try await pause(400)
            try check(Set(SideChats.shared.items.map(\.id)) == [idA,idB],"sidebar shows exactly chatType side A and B")
            try check(sideB.transcript.items.filter{!$0.options.isEmpty}.allSatisfy{!$0.optionsUsed},"consuming A options leaves B options enabled")
            try await shot("09-side-list")
            try await press("side-chat-"+idA);try await pause(500)
            try check(Nav.shared.sideChat === sideA && !sideA.transcript.items.contains{$0.text.contains("阅读清单")},"sidebar reopens A without B messages")
            try await shot("10-side-reopened")
            let mainAfter=try await Api.json("/api/history")
            try check(try JSONSerialization.data(withJSONObject:mainAfter,options:.sortedKeys) == mainBeforeData,"real cloud main history is byte-identical throughout both side chats")
            try check(chat.busy && !chat.items.contains{$0.activityID == idA || $0.activityID == idB},"Mac main bubbles and busy state stay independent")
            _ = try await control("release",method:"POST")
            try await until("main released"){!chat.busy}
            try await press("tab-chat");try await pause(400);scroll(window.contentView!,y:0)
            try check(Nav.shared.sideChat == nil && !chat.items.contains{$0.text.contains("旁聊演示：")},"native main tab returns to uncontaminated main chat")
            try await shot("11-main-chat-isolated")
            let result:[String:Any]=["sideA":idA,"sideB":idB,"mainHistoryUnchangedDuringSideChats":true,"mainBusyPreserved":true,"scrolledTitleDelta":abs(title.midY-scrolledTitle.midY),"fixedAvatarDelta":abs(avatar.midY-scrolledAvatar.midY),"isolatedData":true]
            try JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys]).write(to:output.appendingPathComponent("side-isolation.json"))
        }
        chat.stop();window.close();print("SCREENSHOTS: \(shotCount)");fflush(stdout)
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
