import AppKit
import SwiftUI
import WebKit
import CoreGraphics

struct ReviewFailure:Error,CustomStringConvertible {let description:String}
@main struct V081Review {
    static let output=URL(fileURLWithPath:"/tmp/v081-mac-shots")
    static var window:NSWindow!
    static var shotCount=0
    @MainActor static func main() {
        let app=NSApplication.shared;app.setActivationPolicy(.regular)
        Task { @MainActor in
            do {try await run();print("PASS: v0.8.1 native Mac + local cloud review");fflush(stdout);exit(0)}
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
    @MainActor static func editor() throws -> ComposerTextView {
        guard let e=collect(window.contentView!,type:ComposerTextView.self).first(where:{$0.isEditable && $0.bounds.width>100}) else {throw ReviewFailure(description:"composer editor")};return e
    }
    @MainActor static func type(_ text:String) async throws {
        let e=try editor();window.makeFirstResponder(e);e.string=text;e.didChangeText();e.delegate?.textDidChange?(Notification(name:NSText.didChangeNotification,object:e));try await pause(200)
    }
    @MainActor static func run() async throws {
        try FileManager.default.createDirectory(at:output,withIntermediateDirectories:true)
        try check(LocalVerification.explicitLoopback && Prefs.isolatedRoot != nil,"explicit loopback and isolated user data")
        Prefs.notifyMessages=false;Prefs.deviceName="演示 Mac";AppearanceStore.shared.select(.light)
        Prefs.setGranted("folder_downloads",true);Prefs.setGranted("shell",true)
        window=NSWindow(contentRect:NSRect(x:0,y:0,width:1120,height:920),styleMask:[.titled,.closable,.resizable,.fullSizeContentView],backing:.buffered,defer:false)
        window.title="豆豆 · 0.8.1 验收";window.titleVisibility = .hidden;window.titlebarAppearsTransparent=true;window.isReleasedWhenClosed=false
        window.contentView=NSHostingView(rootView:MainView());window.center();window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)
        let chat=ChatClient.shared
        let delegate=AppDelegate();delegate.applicationDidFinishLaunching(Notification(name:NSApplication.didFinishLaunchingNotification))
        try await until("main bootstrap"){chat.connected && chat.items.count>=2 && !chat.busy}
        AppDelegate.openMain={window.makeKeyAndOrderFront(nil)}
        if CommandLine.arguments.contains("--record-quote") {try await recordQuote();chat.stop();return}
        if CommandLine.arguments.contains("--activity-detail") {
            let activities=try await Api.json("/api/activities")
            guard let work=(activities["recent"] as? [[String:Any]])?.first(where:{$0["title"] as? String == "阅读并整理资料"}),let id=work["id"] as? String else {throw ReviewFailure(description:"existing demo work")}
            Nav.shared.push(.activity(id:id,title:"阅读并整理资料"));_=try await inspectActivity(id);chat.stop();return
        }
        let c=Composer.shared
        let imageURL=URL(fileURLWithPath:"mac/Resources/Mascot/idle/still.png").standardizedFileURL
        let sample=NSImage(contentsOf:imageURL)!
        let pdfURL=URL(fileURLWithPath:Prefs.isolatedRoot!.path).appendingPathComponent("演示资料.pdf")
        try FileManager.default.createDirectory(at:pdfURL.deletingLastPathComponent(),withIntermediateDirectories:true)
        let pdfView=NSTextField(labelWithString:"豆豆 · 演示资料");pdfView.frame=NSRect(x:0,y:0,width:400,height:250)
        try pdfView.dataWithPDF(inside:pdfView.bounds).write(to:pdfURL)
        c.add(image:sample,name:"产品观察-01");try await shot("01-attachment-image")
        c.add(image:sample,name:"产品观察-02");c.add(image:sample,name:"产品观察-03");try await shot("02-attachment-three-images")
        try check(try frame("attachment-strip").height == 48,"attachment strip has one bounded row")
        c.drafts=[];c.add(urls:[pdfURL]);try await shot("03-attachment-pdf")
        c.add(image:sample,name:"产品观察");try await shot("04-attachment-mixed")
        try await type(String(repeating:"附件上方一行排列，长文字也能继续输入，按钮位置保持稳定。",count:12))
        try await shot("05-attachment-long-text")
        try check((try editor()).enclosingScrollView!.bounds.height < 150,"long text editor is bounded to five lines")
        c.drafts=[];try await type("拖入的文件会放在附件条里。")
        let pasteboard=NSPasteboard.withUniqueName();pasteboard.writeObjects([pdfURL as NSURL,imageURL as NSURL])
        let drag=ReviewDraggingInfo(pasteboard:pasteboard,window:window)
        let native=try editor()
        try check(native.draggingEntered(drag) == .copy && native.performDragOperation(drag),"native NSTextView accepts a Finder-shaped file drop through attachment handling")
        try await until("native drop attachments"){c.drafts.count == 2}
        try check(c.text == "拖入的文件会放在附件条里。" && !native.string.contains(pdfURL.path),"native drop inserts no local path or image into the text")
        try await shot("06-attachment-drag")
        let beforeDrop=c.drafts.count
        try check(c.drop([NSItemProvider(contentsOf:pdfURL)!]),"SwiftUI content drop accepts file URL provider")
        try await until("SwiftUI provider drop"){c.drafts.count == beforeDrop+1}
        c.drafts.removeLast();try await press("composer-send")
        try await until("sent attachments"){c.drafts.isEmpty && chat.items.contains{$0.kind == .user && $0.attachments.count == 2} && !chat.busy}
        try await scrollChatToEnd()
        try await shot("07-attachment-bubbles")

        Nav.shared.go(.settings);try await shot("08-settings-light")
        AppearanceStore.shared.select(.dark);try await shot("09-settings-dark")
        AppearanceStore.shared.select(.light);Nav.shared.push(.connectors(tab:0));try await shot("10-capabilities-light")
        AppearanceStore.shared.select(.dark);try await shot("11-capabilities-dark")
        AppearanceStore.shared.select(.light);Nav.shared.push(.connectors(tab:1));try await shot("12-connectors-light")
        AppearanceStore.shared.select(.dark);try await shot("13-connectors-dark")
        AppearanceStore.shared.select(.light);Nav.shared.go(.feed)
        try await until("feed loaded"){!FeedStore.shared.items.isEmpty}
        let post=FeedStore.shared.items[0],historyBefore=try await Api.json("/api/history")
        try await press("feed-discuss-"+post.path)
        try await until("quote composer"){c.quote?.path == post.path}
        let historyAfter=try await Api.json("/api/history")
        try check((historyBefore["items"] as! [[String:Any]]).count == (historyAfter["items"] as! [[String:Any]]).count,"discuss selection sends no message")
        try check(window.firstResponder === (try editor()),"discussion opens focused main composer")
        try await shot("14-discussion-quote-strip")
        try await type("这对我们的产品设计有什么启发？");try await press("composer-send")
        try await until("quoted user bubble"){chat.items.contains{$0.quote?.path == post.path} && !chat.busy}
        guard let quoted=chat.items.first(where:{$0.quote?.path == post.path}) else {throw ReviewFailure(description:"quoted user bubble")}
        try check(quoted.text == "这对我们的产品设计有什么启发？","user bubble contains own words, not the expanded model prompt")
        try await scrollChatToEnd()
        try await shot("15-discussion-quote-bubble")
        try await press("quote-"+quoted.serverID);try await pause(400)
        try check(Nav.shared.tab == .feed,"quote card returns to its feed post")
        try await shot("16-quote-return-to-feed")

        Nav.shared.openSide(SideChatThread());try await pause(250)
        try await typeAndSend("旁聊演示：阅读清单")
        try await until("background side activity"){Nav.shared.sideChat?.status == "done"}
        Nav.shared.go(.chat);try await pause(250)
        try await typeAndSend("0.8.1 验收：读演示资料后整理行动清单")
        for _ in 0..<400 {if (try await control())["readStarted"] as? Bool == true {break};try await pause(50)}
        try check(chat.busy,"real SDK tool is blocked while the App disconnects")
        let previousIDs=Set(chat.items.map(\.serverID))
        chat.disconnectForReview()
        _=try await control("release",method:"POST")
        for _ in 0..<400 {if (try await Api.json("/api/state"))["busy"] as? Bool == false {break};try await pause(50)}
        let gap=try await Api.json("/api/history"),gapRows=gap["items"] as! [[String:Any]]
        let missed=gapRows.filter{($0["role"] as? String == "assistant") && !previousIDs.contains($0["id"] as? String ?? "")}
        try check(missed.count >= 2 && !gapRows.contains{$0["fallback"] as? Bool == true},"multiple say replies were generated offline, with no final-body fallback")
        try check(!chat.items.contains{$0.text.contains("行动清单已经整理好")},"App did miss the disconnected reply before reconnect")
        chat.reconnect();try await until("reconnect catch-up"){chat.connected && chat.items.contains{$0.text.contains("行动清单已经整理好")}}
        try check(Set(chat.items.map(\.serverID)).count == chat.items.count,"reconnect hello and HTTP fill merge without duplicate IDs")
        try check(!chat.items.contains{$0.text.contains("这段普通正文只留")},"ordinary assistant prose remains out of chat")
        try await scrollChatToEnd()
        try await shot("17-reconnect-catch-up")
        guard let workMessage=chat.items.last(where:{$0.kind == .assistant && !$0.activityID.isEmpty}) else {throw ReviewFailure(description:"work activity identity")}
        try await checkCopyOnly(workMessage)
        let activities=try await Api.json("/api/activities?limit=30")
        let all=(activities["running"] as? [[String:Any]] ?? [])+(activities["recent"] as? [[String:Any]] ?? [])
        guard let mainWork=all.first(where:{$0["id"] as? String == workMessage.activityID}) else {throw ReviewFailure(description:"main work activity missing")}
        try check((mainWork["summary"] as? String ?? "").isEmpty,"completed work can be listed before asynchronous metadata is ready")
        try check(all.contains{$0["chatType"] as? String == "side"},"console also includes the side activity")
        let pureRound=chat.items.last(where:{$0.quote != nil})?.activityID
        try check(pureRound != nil && !all.contains{$0["id"] as? String == pureRound},"say-only discussion is not listed as work")
        Nav.shared.console=true;Nav.shared.consoleTab=0
        let list=ActivityListStore.shared
        try await until("console work row"){list.item(workMessage.activityID) != nil && !list.loading}
        try await pause(350)
        let rowIDs=list.recent.map(\.id),rowTime=list.item(workMessage.activityID)?.time,jobs=chat.jobsVersion
        let rowFrame=try frameInWindow("activity-row-"+workMessage.activityID)
        try check((try await control())["summaryStarted"] as? Bool == true,"real cloud summary generator is awaiting the scripted local model")
        _=try await control("release-summary",method:"POST")
        try await until("updated row"){list.item(workMessage.activityID)?.title == "阅读并整理资料"}
        try await pause(250)
        try check(!(list.item(workMessage.activityID)?.summary ?? "").isEmpty && list.item(workMessage.activityID)!.title.count<=14,"completed main work has a generated topic title and summary")
        try check(list.recent.map(\.id) == rowIDs && list.item(workMessage.activityID)?.time == rowTime && jobs == chat.jobsVersion && (try frameInWindow("activity-row-"+workMessage.activityID)) == rowFrame,"real updated WS event patches the existing row without reload, reorder or layout shift")
        try await shot("18-console-activity-summary-light")
        AppearanceStore.shared.select(.dark);try await shot("23-console-activity-summary-dark");AppearanceStore.shared.select(.light)
        await SideChats.shared.load()
        try check(SideChats.shared.items.allSatisfy{$0.chatType == "side"} && !SideChats.shared.items.contains{$0.id == workMessage.activityID},"main work never enters the sidebar side-chat list")
        try await press("activity-row-"+workMessage.activityID)
        let steps=try await inspectActivity(workMessage.activityID)
        try check(steps.contains{($0["text"] as? String ?? "").contains("这段普通正文只留")},"ordinary assistant prose is available in activity trajectory")
        try await typeAndSend("继续把行动清单压缩成三步")
        var continuationFound=false
        for _ in 0..<400 {
            let history=try await Api.json(ActivityStore.endpoint(workMessage.activityID,action:"history"))
            if (history["items"] as? [[String:Any]] ?? []).contains(where:{$0["from"] as? String == "user" && ($0["text"] as? String ?? "").contains("继续把行动清单")}) {continuationFound=true;break}
            try await pause(50)
        }
        try check(continuationFound,"native activity composer continues the same activity trajectory")
        Nav.shared.go(.chat);try await pause(250)

        // Foreground callback must fill a gap even before the websocket reconnects.
        chat.disconnectForReview()
        let foreground=try await Api.json("/api/send",method:"POST",body:["text":"前台补漏演示","clientId":UUID().uuidString])
        for _ in 0..<400 {if (try await Api.json("/api/state"))["busy"] as? Bool == false {break};try await pause(50)}
        let newID=foreground["id"] as! String
        try check(!chat.items.contains{$0.serverID == newID},"foreground test really has an offline gap")
        AppDelegate().applicationDidBecomeActive(Notification(name:NSApplication.didBecomeActiveNotification))
        try await until("foreground catch-up"){chat.items.contains{$0.serverID == newID}}
        try check(Set(chat.items.map(\.serverID)).count == chat.items.count,"foreground HTTP catch-up also has no duplicates")
        chat.reconnect();try await until("connected for quick chat"){chat.connected}
        // Exercise the installed wake observer without actually sleeping the user's computer.
        chat.disconnectForReview()
        let wake=try await Api.json("/api/send",method:"POST",body:["text":"唤醒补漏演示","clientId":UUID().uuidString])
        for _ in 0..<400 {if (try await Api.json("/api/state"))["busy"] as? Bool == false {break};try await pause(50)}
        NSWorkspace.shared.notificationCenter.post(name:NSWorkspace.didWakeNotification,object:nil)
        try await until("wake catch-up"){chat.connected && chat.items.contains{$0.serverID == wake["id"] as? String}}
        try check(Set(chat.items.map(\.serverID)).count == chat.items.count,"production wake observer reconnects and catches up")
        chat.disconnectForReview()
        let menuGap=try await Api.json("/api/send",method:"POST",body:["text":"菜单栏补漏演示","clientId":UUID().uuidString])
        for _ in 0..<400 {if (try await Api.json("/api/state"))["busy"] as? Bool == false {break};try await pause(50)}
        c.add(urls:[pdfURL]);c.add(image:sample,name:"菜单栏图片");c.text="从菜单栏发送附件"
        MenuController.shared.install();MenuController.shared.button?.performClick(nil)
        try await until("real menu popover"){MenuController.shared.popover.isShown}
        try await until("menu catches missed replies"){chat.items.contains{$0.serverID == menuGap["id"] as? String}}
        try check(Set(chat.items.map(\.serverID)).count == chat.items.count,"menu opening fills offline gap without duplicate IDs")
        try await pause(900)
        if let w=MenuController.shared.popover.contentViewController?.view.window {try await capture(w,"20-menu-attachments")}
        try await pause(200);try await press("composer-send")
        try await until("menu attachment send"){c.drafts.isEmpty && chat.items.contains{$0.text == "从菜单栏发送附件" && $0.attachments.count == 2}}
        MenuController.shared.close()
        let retry=Composer();retry.text="同一消息去重验收";var replay:[String]=[];var acceptedIDs:[String]=[]
        retry.delivery={submission in
            replay.append(submission.clientID)
            let accepted=try await Api.json(submission.endpoint,method:"POST",body:submission.body)
            acceptedIDs.append(accepted["id"] as! String)
            if replay.count == 1 {throw URLError(.networkConnectionLost)}
        }
        let initial=await retry.sendContents(),retried=await retry.sendContents()
        let afterReplay=try await Api.json("/api/history")
        try check(!initial && retried && replay.count == 2 && replay[0] == replay[1] && acceptedIDs[0] == acceptedIDs[1],"real server replay returns the same user message ID after a lost acknowledgement")
        try check((afterReplay["items"] as! [[String:Any]]).filter{$0["text"] as? String == "同一消息去重验收"}.count == 1,"real server handles retry only once")
        let summary:[String:Any]=["screenshots":shotCount,"missedReplies":missed.count,"mainMessages":chat.items.count,"uniqueIDs":Set(chat.items.map(\.serverID)).count,"activityTitleAndSummary":true,"updatedInPlace":true,"activityContinuation":continuationFound,"copyOnly":true,"sayOnly":true,"isolatedData":Prefs.isolatedRoot!.path,"capture":CGPreflightScreenCaptureAccess() ? "screencapture -l":"NSView snapshot"]
        try JSONSerialization.data(withJSONObject:summary,options:.prettyPrinted).write(to:output.appendingPathComponent("acceptance.json"))
        try check(!FileManager.default.fileExists(atPath:Prefs.isolatedRoot!.appendingPathComponent("token").path),"isolated review never saved a token")
        chat.stop()
    }
    @MainActor static func recordQuote() async throws {
        Nav.shared.go(.feed)
        try await until("recording feed"){!FeedStore.shared.items.isEmpty}
        let post=FeedStore.shared.items[0]
        let directory=output.appendingPathComponent("recording")
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
        guard CGPreflightScreenCaptureAccess() else {throw ReviewFailure(description:"window recording permission unavailable")}
        let recording=Task { @MainActor in
            var timestamps:[Double]=[]
            for i in 0..<48 {
                let target=directory.appendingPathComponent(String(format:"%04d.png",i))
                let process=Process();process.executableURL=URL(fileURLWithPath:"/usr/sbin/screencapture")
                process.arguments=["-x","-l",String(window.windowNumber),target.path]
                try process.run();process.waitUntilExit()
                guard process.terminationStatus == 0 else {throw ReviewFailure(description:"owned window recording frame")}
                timestamps.append(Date().timeIntervalSince1970)
                try await pause(160)
            }
            try JSONSerialization.data(withJSONObject:timestamps).write(to:directory.appendingPathComponent("timestamps.json"))
        }
        try await pause(900);try await press("feed-discuss-"+post.path)
        try await pause(900);try await type("这条动态对我们的产品有什么启发？")
        try await pause(1000);try await press("composer-send")
        try await until("recorded quote bubble"){ChatClient.shared.items.contains{$0.quote?.path == post.path && $0.text == "这条动态对我们的产品有什么启发？"}}
        try await scrollChatToEnd()
        try await pause(1500)
        try await recording.value
        try check(true,"recorded only the owned App window during discussion-to-send")
    }
    @MainActor static func inspectActivity(_ id:String) async throws->[[String:Any]] {
        try await until("activity detail"){window.attachedSheet == nil && ComposerVerification.currentTask?.taskID == id}
        window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)
        let detail=try await Api.json(ActivityStore.endpoint(id,action:"history")),steps=detail["items"] as? [[String:Any]] ?? []
        guard let readIndex=steps.firstIndex(where:{$0["kind"] as? String == "tool" && ($0["text"] as? String ?? "").contains("context.txt")}) else {throw ReviewFailure(description:"real Read tool trace")}
        do {try await until("activity trace rendered"){VerificationActionAnchor.views.object(forKey:("activity-step-\(readIndex)") as NSString)?.window != nil}}
        catch {try await capture(window,"debug-activity-detail");throw error}
        let collapsed=try frameInWindow("activity-step-\(readIndex)").height
        try await press("activity-step-\(readIndex)",leading:true)
        try await shot("19-activity-detail-trajectory")
        try check(try frameInWindow("activity-step-\(readIndex)").height>collapsed+10,"Read tool summary is visibly expanded in the activity detail")
        return steps
    }
    @MainActor static func checkCopyOnly(_ item:ChatItem) async throws {
        try await scrollChatToEnd()
        guard let marker=VerificationActionAnchor.views.object(forKey:("message-"+item.serverID) as NSString) else {throw ReviewFailure(description:"assistant bubble geometry")}
        marker.scrollToVisible(marker.bounds);try await pause(200)
        let p=marker.convert(NSPoint(x:30,y:marker.bounds.midY),to:nil)
        let event=NSEvent.mouseEvent(with:.rightMouseDown,location:p,modifierFlags:[],timestamp:ProcessInfo.processInfo.systemUptime,windowNumber:window.windowNumber,context:nil,eventNumber:2,clickCount:1,pressure:1)!
        var view=window.contentView?.hitTest(window.contentView!.convert(p,from:nil))
        while let current=view {
            if let menu=current.menu(for:event),menu.items.contains(where:{$0.title == "复制"}) {
                try check(!menu.items.contains{$0.title == "查看过程"},"assistant context menu keeps Copy and removes View Process")
                return
            }
            view=current.superview
        }
        throw ReviewFailure(description:"native context menu action was not exposed")
    }
    @MainActor static func frameInWindow(_ name:String)throws->NSRect {
        guard let marker=VerificationActionAnchor.views.object(forKey:name as NSString),let view=marker.window?.contentView else {throw ReviewFailure(description:"window geometry marker "+name)}
        return marker.convert(marker.bounds,to:view)
    }
    static func control(_ route:String="",method:String="GET",body:[String:Any]?=nil) async throws->[String:Any] {
        let meta=try JSONSerialization.jsonObject(with:Data(contentsOf:output.appendingPathComponent("local-cloud.json"))) as! [String:Any]
        var r=URLRequest(url:URL(string:(meta["control"] as! String)+"/"+route)!);r.httpMethod=method
        if let body {r.httpBody=try JSONSerialization.data(withJSONObject:body);r.setValue("application/json",forHTTPHeaderField:"Content-Type")}
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
    @MainActor static func scrollChatToEnd() async throws {
        for _ in 0..<4 {
            guard let s=collect(window.contentView!,type:NSTableView.self).first?.enclosingScrollView,let doc=s.documentView else {throw ReviewFailure(description:"native chat scroller")}
            s.contentView.scroll(to:NSPoint(x:0,y:doc.isFlipped ? max(0,doc.bounds.height-s.contentView.bounds.height):0));s.reflectScrolledClipView(s.contentView)
            try await pause(150)
        }
    }
    @MainActor static func find<T:NSView>(_ view:NSView,type:T.Type)->T? { collect(view,type:type).first }
    @MainActor static func scroll(_ view:NSView,y:CGFloat) {
        guard let s=collect(view,type:NSScrollView.self).max(by:{$0.bounds.height<$1.bounds.height}),let doc=s.documentView else {return}
        s.contentView.scroll(to:NSPoint(x:0,y:min(max(0,y),max(0,doc.bounds.height-s.contentView.bounds.height))));s.reflectScrolledClipView(s.contentView)
    }
    @MainActor static func press(_ name:String,leading:Bool=false) async throws {
        guard let marker=VerificationActionAnchor.views.object(forKey:name as NSString),let w=marker.window else {throw ReviewFailure(description:"native action marker "+name)}
        marker.scrollToVisible(marker.bounds);try await pause(100)
        let p=marker.convert(NSPoint(x:leading ? 6:marker.bounds.midX,y:marker.bounds.midY),to:nil)
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
