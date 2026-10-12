import AppKit
import SwiftUI
import WebKit
import Observation

@Observable final class BriefProbeModel {
    var height: CGFloat = 1
    var loading = true
    var failed = ""
}

@MainActor
enum V06Review {
    static let output = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("verification/v0.6.0/screenshots")
    static func window() -> NSWindow {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 820), styleMask: [.titled, .closable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        w.title = "豆豆 · 0.6.0 本地验收"; w.identifier = NSUserInterfaceItemIdentifier("main")
        w.titleVisibility = .hidden; w.titlebarAppearsTransparent = true; w.isReleasedWhenClosed = false
        w.contentView = NSHostingView(rootView: MainView()); w.center(); return w
    }
    static func pause(_ ms: UInt64 = 600) async throws { try await Task.sleep(nanoseconds: ms * 1_000_000) }
    static func webs(_ view: NSView) -> [WKWebView] {
        if let web = view as? WKWebView { return [web] }
        return view.subviews.flatMap(webs)
    }
    /// Capture this owned view, compositing WK's own snapshot because its remote layer is not in cacheDisplay.
    static func capture(_ view: NSView, _ name: String) async throws {
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        view.layoutSubtreeIfNeeded()
        guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { throw VerificationError(description: "v0.6 native snapshot") }
        view.cacheDisplay(in: view.bounds, to: bitmap)
        for web in webs(view) where web.bounds.height > 2 && !web.visibleRect.isEmpty {
            let snapshot = try await web.takeSnapshot(configuration: nil)
            let rect = web.convert(web.bounds, to: view)
            let visible = web.convert(web.visibleRect, to: view).intersection(view.bounds)
            guard !visible.isEmpty, let context = NSGraphicsContext(bitmapImageRep: bitmap) else { continue }
            NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = context
            let drawRect = view.isFlipped ? NSRect(x: rect.minX, y: view.bounds.height - rect.maxY, width: rect.width, height: rect.height) : rect
            let clip = view.isFlipped ? NSRect(x: visible.minX, y: view.bounds.height - visible.maxY, width: visible.width, height: visible.height) : visible
            NSBezierPath(rect: clip).addClip()
            NSBezierPath(roundedRect: drawRect, xRadius: 16, yRadius: 16).addClip()
            snapshot.draw(in: drawRect)
            NSGraphicsContext.restoreGraphicsState()
        }
        guard let png = bitmap.representation(using: .png, properties: [:]) else { throw VerificationError(description: "v0.6 PNG snapshot") }
        try png.write(to: output.appendingPathComponent(name + ".png")); print("Snapshot: \(name).png"); fflush(stdout)
    }
    static func outerScroll(_ view: NSView) -> NSScrollView? {
        func collect(_ node: NSView) -> [NSScrollView] {
            if node is WKWebView { return [] }
            return (node as? NSScrollView).map { [$0] } ?? node.subviews.flatMap(collect)
        }
        return collect(view).max { $0.bounds.height < $1.bounds.height }
    }
    static func scroll(_ view: NSView, y: CGFloat) {
        guard let scroll = outerScroll(view), let doc = scroll.documentView else { return }
        scroll.contentView.scroll(to: NSPoint(x: 0, y: min(max(0, y), max(0, doc.bounds.height - scroll.contentView.bounds.height))))
        scroll.reflectScrolledClipView(scroll.contentView)
    }
    static func input(_ view: NSView) -> ComposerTextView? {
        if let editor = view as? ComposerTextView, editor.isEditable { return editor }
        return view.subviews.compactMap(input).first
    }
    static func stats() async throws -> [String: Int] { try await Api.json("/verify/stats")["operations"] as? [String: Int] ?? [:] }
    static func scenario(_ name: String) async throws { _ = try await Api.json("/verify/scenario?name=" + name); try await pause() }

    static func sandbox() async throws {
        let before = try await stats()
        let url = Prefs.server + "/verify/blocked"
        let html = """
        <!doctype html><html><head><style>body{font:16px -apple-system;margin:0;padding:20px}.probe{background-image:url('\(url)?css')}@font-face{font-family:probe;src:url('\(url)?font')}</style>
        <link rel="stylesheet" href="\(url)?style"><script src="\(url)?script"></script></head><body><h2>HTML 隔离验证</h2>
        <div class="probe">内联样式、脚本与 SVG 可以显示</div><svg width="50" height="40"><circle cx="20" cy="20" r="16" fill="#b0c5d8"/></svg>
        <img src="\(url)?image"><iframe src="\(url)?frame"></iframe><audio src="\(url)?media" preload="auto"></audio>
        <script>window.inlineWorks=true;fetch('\(url)?fetch').catch(()=>{});try{const x=new XMLHttpRequest();x.open('GET','\(url)?xhr');x.send()}catch{};try{new WebSocket('\(url.replacingOccurrences(of: "http:", with: "ws:"))?socket')}catch{};try{navigator.sendBeacon('\(url)?beacon','probe')}catch{};</script></body></html>
        """
        let model = BriefProbeModel()
        struct Probe: View {
            @Bindable var model: BriefProbeModel
            let html: String
            var body: some View { BriefWebView(html: html, documentHeight: $model.height, loading: $model.loading, failed: $model.failed) }
        }
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 320), styleMask: [.titled], backing: .buffered, defer: false)
        w.isReleasedWhenClosed = false; w.contentView = NSHostingView(rootView: Probe(model: model, html: html)); w.center(); w.makeKeyAndOrderFront(nil)
        defer { w.close() }
        for _ in 0..<100 where model.loading { try await pause(30) }
        guard let web = webs(w.contentView!).first else { throw VerificationError(description: "sandbox WK mounted") }
        try check(!model.loading && model.failed.isEmpty, "sandbox card loads only after offline rules compile")
        let inlineWorks = try await evaluate(web, "window.inlineWorks === true && document.querySelector('svg') !== null") as? Bool
        try check(inlineWorks == true, "inline scripts and SVG survive offline isolation")
        let csp = try await evaluate(web, "document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]')?.content || ''") as? String
        try check(csp?.contains("connect-src 'none'") == true, "document-start CSP prevents network connections")
        try await pause(800)
        let after = try await stats()
        try check(before["blocked"] == after["blocked"], "image/style/script/font/frame/media/fetch/XHR/beacon/WebSocket made zero local probe requests")
        for destination in [url + "?navigation", "about:blank", "file:///tmp/doudou-v06-probe", "data:text/html,other", "doudou://other?text=no"] {
            let encoded = String(data: try JSONSerialization.data(withJSONObject: [destination]), encoding: .utf8)!
            _ = try? await evaluate(web, "location.href = \(encoded)[0]")
            try await pause(100)
            let stillHere = try await evaluate(web, "window.inlineWorks === true") as? Bool
            try check(stillHere == true, "non-prompt card navigation stays blocked")
        }
        let final = try await stats()
        try check(final["blocked"] == before["blocked"] && final["send"] == before["send"], "blocked navigation neither loads nor sends")
        print("PASS: live WK sandbox blocks resource requests and navigation; inline HTML/CSS/JS/SVG work")
    }

    static func wheel(_ window: NSWindow, at view: NSView, x: Int32, y: Int32) throws {
        let local = view.convert(NSPoint(x:view.visibleRect.midX,y:view.visibleRect.midY),to:nil)
        if x == 0 {
            let cg = CGEvent(scrollWheelEvent2Source:nil,units:.pixel,wheelCount:2,wheel1:y,wheel2:0,wheel3:0)!
            cg.setIntegerValueField(.scrollWheelEventIsContinuous,value:1)
            guard let web = view as? BriefNativeWebView else { throw VerificationError(description:"owned brief native wheel target") }
            web.scrollWheel(with:NSEvent(cgEvent:cg)!)
        } else {
            func find(_ view:NSView) -> TodaySwipeView? { if let swipe=view as? TodaySwipeView { return swipe }; return view.subviews.compactMap(find).first }
            guard let swipe=find(window.contentView!) else { throw VerificationError(description:"owned today swipe receiver") }
            _ = swipe.handle(OwnedWheelEvent(window:window,location:local,x:CGFloat(x),y:CGFloat(y)))
        }
        print("Wheel routed: x=\(x), y=\(y)"); fflush(stdout)
    }

    static func evaluate(_ web: WKWebView, _ script: String) async throws -> Any? {
        try await withCheckedThrowingContinuation { continuation in
            var resolved = false
            let timeout = DispatchWorkItem {
                guard !resolved else { return }; resolved = true
                continuation.resume(throwing: VerificationError(description: "owned WK JavaScript timed out"))
            }
            DispatchQueue.main.asyncAfter(deadline:.now()+8,execute:timeout)
            web.evaluateJavaScript(script) { value,error in
                guard !resolved else { return }; resolved = true; timeout.cancel()
                if let error { continuation.resume(throwing:error) } else { continuation.resume(returning:value) }
            }
        }
    }

    static func run() async throws {
        try check(LocalVerification.explicitLoopback, "v0.6 UI review requires explicit loopback server")
        _ = try await Api.json("/verify/reset")
        Session.shared.configured = true; Session.shared.onboarded = true
        let originalSkin=Theme.skin
        let chat = ChatClient.shared; chat.start()
        let w = window(); w.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        defer { SkinStore.shared.select(originalSkin); chat.stop(); w.close() }
        for _ in 0..<100 where !chat.connected { try await pause(30) }
        try check(chat.connected, "v0.6 fake service websocket")
        func shot(_ name: String, wait: UInt64 = 700) async throws { try await pause(wait); try await capture(w.contentView!, name) }
        func press(_ label: String) async throws {
            guard let marker = VerificationActionAnchor.views.object(forKey: label as NSString), marker.window === w else {
                throw VerificationError(description: "owned UI action marker: " + label)
            }
            marker.scrollToVisible(marker.bounds); try await pause(100)
            let center = marker.convert(NSPoint(x: marker.bounds.midX, y: marker.bounds.midY), to: nil)
            Verify.click(w, x: center.x, y: center.y); try await pause(150)
        }
        for skin in ProcessInfo.processInfo.environment["V06_REVIEW_SKIP_SKINS"] == "1" ? [] : Skin.allCases {
            Nav.shared.go(.settings); try await pause(700); try await press(skin.title)
            try check(Theme.skin==skin && SkinStore(defaults:Prefs.uiDefaults).skin==skin, "native skin selection saves locally")
            try check(w.appearance?.name==(skin == .night ? NSAppearance.Name.darkAqua : .aqua), "window system controls follow selected skin")
            if skin == .paper { try await shot("10-settings-skin") }
            Nav.shared.go(.today); try await pause(1400)
            let mounted=webs(w.contentView!)
            try check(!mounted.isEmpty, "today mounts complete brief HTML")
            for web in mounted {
                let actual=try await evaluate(web, "document.documentElement.dataset.skin") as? String
                try check(actual==skin.rawValue,"document-start skin reaches each brief card")
                try check(web.bounds.width <= 441, "today stays one centered phone-width column")
                let overflow=try await evaluate(web, "getComputedStyle(document.documentElement).overflowY") as? String
                try check(overflow=="clip", "brief documents disable internal scrolling")
            }
            try await shot("0\(skin == .silver ? 1 : skin == .paper ? 3 : 5)-today-\(skin.rawValue)",wait:100)
            Nav.shared.go(.chat); try await shot("0\(skin == .silver ? 2 : skin == .paper ? 4 : 6)-chat-\(skin.rawValue)")
        }
        print("PHASE: brief interaction"); fflush(stdout)
        SkinStore.shared.select(.silver); Nav.shared.go(.today); try await pause(1200)
        guard let card=webs(w.contentView!).first else { throw VerificationError(description:"skin reuse card") }
        let loads=BriefResources.loads, created=BriefResources.created
        print("PHASE: reuse skin changes"); fflush(stdout)
        for skin in [.night,.paper,.silver,.night,.silver] as [Skin] { SkinStore.shared.select(skin); try await pause(160) }
        try check(webs(w.contentView!).contains { $0 === card } && BriefResources.loads==loads && BriefResources.created==created, "skin changes reuse the same WK instance and document")
        print("PHASE: long height and wheel"); fflush(stdout)
        scroll(w.contentView!,y:550); print("PHASE: long scroll set"); fflush(stdout); try await pause(700)
        guard let long=webs(w.contentView!).first(where: { $0.bounds.height > 600 }) else { throw VerificationError(description:"full long brief mounted") }
        print("PHASE: evaluate long"); fflush(stdout)
        let natural=try await evaluate(long, "document.documentElement.scrollHeight") as? Double ?? 0
        print("HTML measurements: natural=\(natural), frame=\(long.bounds.height), window=\(w.contentView!.bounds.height)"); fflush(stdout)
        try check(abs(natural-long.bounds.height)<2 && long.bounds.height > w.contentView!.bounds.height*0.75, "long card uses full scrollHeight beyond old 75 percent limit")
        let outerBefore=outerScroll(w.contentView!)!.contentView.bounds.origin.y
        try wheel(w,at:long,x:0,y:-120); try await pause(300)
        let outerAfter=outerScroll(w.contentView!)!.contentView.bounds.origin.y
        let inner=try await evaluate(long, "window.scrollY") as? Double ?? -1
        print("Wheel result: outer=\(outerBefore) -> \(outerAfter), inner=\(inner)")
        try check(outerAfter != outerBefore && inner==0, "native wheel over brief moves only the outer list")
        try await shot("12-brief-full-height",wait:100)
        scroll(w.contentView!,y:0); try await pause(600)
        guard let swipeCard=webs(w.contentView!).first else { throw VerificationError(description:"swipe brief") }
        try wheel(w,at:swipeCard,x:-110,y:0); try await pause(500)
        try check(Nav.shared.todaySection==1,"two-finger horizontal swipe over a card switches to sites")
        guard let outer=outerScroll(w.contentView!) else { throw VerificationError(description:"sites scroll") }
        try wheel(w,at:outer,x:110,y:0); try await pause(500)
        try check(Nav.shared.todaySection==0,"reverse horizontal swipe returns to briefs")
        try await pause(500)
        let todayInput=input(w.contentView!)!
        try wheel(w,at:todayInput,x:-110,y:0); try await pause(150)
        try check(Nav.shared.todaySection==0,"horizontal gesture in composer keeps the selected today section")
        let users=chat.items.filter { $0.kind == .user }.count
        guard let action=webs(w.contentView!).first else { throw VerificationError(description:"prompt card") }
        _ = try await evaluate(action, "document.querySelector('[data-prompt]')?.click()")
        try await pause(800)
        try check(Nav.shared.tab == .chat && chat.items.filter { $0.kind == .user }.count==users+1,"brief prompt sends once and opens chat")
        try await sandbox(); w.makeKeyAndOrderFront(nil)

        try await scenario("scroll-review"); Nav.shared.go(.chat); try await pause(1300)
        let root=w.contentView!, initialScroll=outerScroll(root)!
        let endY=initialScroll.contentView.bounds.origin.y
        scroll(root,y:max(0,endY-1300)); try await pause(500)
        try check(VerificationActionAnchor.views.object(forKey:"回到底部")?.window===w,"history scroll shows return-to-bottom UI")
        let readingY=initialScroll.contentView.bounds.origin.y
        let editor=input(root)!; w.makeFirstResponder(editor); try await pause(300)
        try check(abs(initialScroll.contentView.bounds.origin.y-readingY)<2,"focusing composer preserves history position")
        _ = try await Api.json("/verify/incoming"); try await pause(600)
        try check(abs(initialScroll.contentView.bounds.origin.y-readingY)<2,"incoming stream preserves history position")
        try await shot("11-return-to-bottom-new-message",wait:100)
        try await pause(1200)
        func reader(_ view:NSView) -> ChatScrollObserver? { if let observer=view as? ChatScrollObserver { return observer }; return view.subviews.compactMap(reader).first }
        guard let readingState=reader(root)?.state else { throw VerificationError(description:"owned chat scroll observer") }
        let unreadBeforeReconnect=readingState.unread
        chat.reconnect(); try await pause(1000)
        try check(chat.connected && readingState.unread==unreadBeforeReconnect,"reconnect history snapshot retains unread count without counting old rows")
        try check(abs(initialScroll.contentView.bounds.origin.y-readingY)<2,"reconnect history snapshot preserves reading position")
        try await shot("21-reconnect-reading-count",wait:100)
        try await press("回到底部"); try await pause(500)
        try check(initialScroll.contentView.bounds.origin.y>readingY+500,"return button scrolls to bottom")
        scroll(root,y:0); try await pause(500)
        w.makeFirstResponder(editor); editor.insertText("发送后回到底部",replacementRange:NSRange(location:NSNotFound,length:0)); try await pause(100)
        editor.keyDown(with: NSEvent.keyEvent(with:.keyDown,location:.zero,modifierFlags:[],timestamp:ProcessInfo.processInfo.systemUptime,windowNumber:w.windowNumber,context:nil,characters:"\r",charactersIgnoringModifiers:"\r",isARepeat:false,keyCode:36)!)
        try await pause(700)
        try check(initialScroll.contentView.bounds.origin.y>readingY+500,"sending scrolls to bottom")

        try await scenario("tasks"); Nav.shared.go(.tasks); try await shot("08-task-list")
        let beforePage=try await stats()
        scroll(root,y:.greatestFiniteMagnitude); try await pause(1000)
        let afterPage=try await stats()
        try check((afterPage["jobs_next"] ?? 0)>(beforePage["jobs_next"] ?? 0),"scrolling task list bottom loads the next server cursor")
        scroll(root,y:0); try await pause(500); try await press("整理公开资料，写研究摘要")
        try await shot("09-task-detail")
        let pollA=try await stats(); try await pause(3300); let pollB=try await stats()
        try check((pollB["task_history"] ?? 0)>(pollA["task_history"] ?? 0),"running task polls at three seconds")
        guard let taskInput=input(root) else { throw VerificationError(description:"shared task composer") }
        let image=NSImage(size:NSSize(width:40,height:30)); image.lockFocus(); NSColor(Theme.accent).setFill(); NSRect(x:0,y:0,width:40,height:30).fill(); image.unlockFocus()
        let taskStoreComposer = taskComposer(root)
        guard let taskStoreComposer else { throw VerificationError(description:"task composer probe") }
        taskStoreComposer.add(image:image,name:"本地图片")
        taskStoreComposer.drafts.append(Draft(data:Data("本地文件附件".utf8),name:"检查.txt",kind:"file"))
        w.makeFirstResponder(taskInput); taskInput.insertText("补一份检查清单",replacementRange:NSRange(location:NSNotFound,length:0)); try await pause(300)
        let beforeSend=try await stats(); try await press("发送续聊"); try await pause(700)
        let afterSend=try await stats(), taskHistory=try await Api.json("/api/tasks/report/history")
        let prompts=(taskHistory["items"] as? [[String:Any]] ?? []).filter { $0["kind"] as? String=="prompt" }
        try check((afterSend["task_send"] ?? 0)==(beforeSend["task_send"] ?? 0)+1 && (afterSend["upload"] ?? 0)==(beforeSend["upload"] ?? 0)+2 && afterSend["send"]==beforeSend["send"],"shared task composer uploads image/file and uses only task send")
        try check(prompts.last?["from"] as? String=="user" && (prompts.last?["attachments"] as? [[String:Any]])?.count==2,"task history preserves continuation sender and attachments")
        try await shot("13-task-continuation-attachments",wait:200)
        try await pause(4000)
        try await scenario("task-long"); Nav.shared.stacks[.tasks]=[]; Nav.shared.go(.tasks); try await pause(600); try await press("整理公开资料，写研究摘要"); try await pause(600)
        let taskScroll=outerScroll(root)!, taskBottom=taskScroll.contentView.bounds.origin.y
        scroll(root,y:max(0,taskBottom-1100)); try await pause(300)
        let taskReading=taskScroll.contentView.bounds.origin.y
        _ = try await Api.json("/verify/task-progress?id=report"); try await pause(3400)
        try check(abs(taskScroll.contentView.bounds.origin.y-taskReading)<2,"running task history refresh with appended text preserves reading position")
        try await shot("20-task-reading-position",wait:100)
        try await scenario("task-send-error"); Nav.shared.stacks[.tasks]=[]; Nav.shared.go(.tasks); try await pause(600); try await press("晨报"); try await pause(400)
        let retryInput=input(root)!; w.makeFirstResponder(retryInput); retryInput.insertText("失败时保留草稿",replacementRange:NSRange(location:NSNotFound,length:0)); try await pause(200); try await press("发送续聊"); try await pause(500)
        try check(retryInput.string=="失败时保留草稿","task send failure preserves visible draft")
        try await shot("14-task-send-error")

        try await scenario("idle"); Nav.shared.go(.memory); try await pause(700); try await press("健康"); try await shot("07-health",wait:1000)
        let beforeSync=try await stats(); try await press("同步健康"); try await pause(400); let afterSync=try await stats()
        try check((afterSync["health_sync"] ?? 0)==(beforeSync["health_sync"] ?? 0)+1,"cloud sync control calls immediate health sync")
        scroll(root,y:300); try await shot("15-health-records",wait:300)
        let health=try await Api.json("/api/health"), week=(health["weekly"] as! [[String:Any]])[0]
        try await press("健康周报 " + (week["date"] as! String)); try await pause(1000)
        let weekStats = try await stats()
        try check(!webs(root).isEmpty && (weekStats["brief_item"] ?? 0) > 0,"old health weekly report opens brief item cards")
        try await shot("16-health-weekly-brief",wait:100)
        Nav.shared.pop(); try await pause(800); scroll(root,y:.greatestFiniteMagnitude); try await pause(400); try await press("健康记录 基线"); try await shot("17-health-memory-record")
        try await scenario("health-empty"); Nav.shared.stacks[.memory]=[]; Nav.shared.go(.memory); try await pause(500); try await press("健康"); try await shot("18-health-empty")
        try await scenario("health-offline"); Nav.shared.pop(); try await pause(500); try await press("健康"); try await pause(600); try await press("同步健康"); try await shot("19-health-offline-existing-data")
        let final=try await stats()
        try check(final["blocked"]==0,"sandbox network/navigation probes remain blocked")
        print("PASS: v0.6 local UI skins/cards, full height, wheel/swipe, scroll/focus/send, task pagination/chat/attachments, health/sync/old briefs/records/null/offline")
    }
    static func taskComposer(_ view: NSView) -> Composer? { ComposerVerification.currentTask }
}

// Public NSEvent subclass keeps this fixture entirely inside its owned AppKit window.
final class OwnedWheelEvent: NSEvent {
    private let ownedWindow: NSWindow
    private let point: NSPoint
    private let dx: CGFloat
    private let dy: CGFloat
    init(window:NSWindow,location:NSPoint,x:CGFloat,y:CGFloat) {
        ownedWindow=window; point=location; dx=x; dy=y; super.init()
    }
    required init?(coder:NSCoder) { fatalError() }
    override var type: NSEvent.EventType { .scrollWheel }
    override var window: NSWindow? { ownedWindow }
    override var windowNumber: Int { ownedWindow.windowNumber }
    override var locationInWindow: NSPoint { point }
    override var timestamp: TimeInterval { ProcessInfo.processInfo.systemUptime }
    override var scrollingDeltaX: CGFloat { dx }
    override var scrollingDeltaY: CGFloat { dy }
    override var deltaX: CGFloat { dx }
    override var deltaY: CGFloat { dy }
    override var deltaZ: CGFloat { 0 }
    override var hasPreciseScrollingDeltas: Bool { true }
    override var phase: NSEvent.Phase { .began }
    override var momentumPhase: NSEvent.Phase { [] }
    override var modifierFlags: NSEvent.ModifierFlags { [] }
    override var isDirectionInvertedFromDevice: Bool { true }
}
