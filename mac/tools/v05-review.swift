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
enum V05Review {
    static let output = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("verification/v0.5.0/screenshots")
    static func window() -> NSWindow {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 820), styleMask: [.titled, .closable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        w.title = "豆豆 · 0.5.0 本地验收"; w.identifier = NSUserInterfaceItemIdentifier("main")
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
        guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { throw VerificationError(description: "v0.5 native snapshot") }
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
            NSBezierPath(roundedRect: drawRect, xRadius: 24, yRadius: 24).addClip()
            snapshot.draw(in: drawRect)
            NSGraphicsContext.restoreGraphicsState()
        }
        guard let png = bitmap.representation(using: .png, properties: [:]) else { throw VerificationError(description: "v0.5 PNG snapshot") }
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
        let inlineWorks = try await web.evaluateJavaScript("window.inlineWorks === true && document.querySelector('svg') !== null") as? Bool
        try check(inlineWorks == true, "inline scripts and SVG survive offline isolation")
        let csp = try await web.evaluateJavaScript("document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]')?.content || ''") as? String
        try check(csp?.contains("connect-src 'none'") == true, "document-start CSP prevents network connections")
        try await pause(800)
        let after = try await stats()
        try check(before["blocked"] == after["blocked"], "image/style/script/font/frame/media/fetch/XHR/beacon/WebSocket made zero local probe requests")
        for destination in [url + "?navigation", "about:blank", "file:///tmp/doudou-v05-probe", "data:text/html,other", "doudou://other?text=no"] {
            let encoded = String(data: try JSONSerialization.data(withJSONObject: [destination]), encoding: .utf8)!
            _ = try? await web.evaluateJavaScript("location.href = \(encoded)[0]")
            try await pause(100)
            let stillHere = try await web.evaluateJavaScript("window.inlineWorks === true") as? Bool
            try check(stillHere == true, "non-prompt card navigation stays blocked")
        }
        let final = try await stats()
        try check(final["blocked"] == before["blocked"] && final["send"] == before["send"], "blocked navigation neither loads nor sends")
        print("PASS: live WK sandbox blocks resource requests and navigation; inline HTML/CSS/JS/SVG work")
    }

    static func run() async throws {
        try check(LocalVerification.explicitLoopback, "v0.5 UI review requires explicit loopback server")
        _ = try await Api.json("/verify/reset")
        Session.shared.configured = true; Session.shared.onboarded = true
        let chat = ChatClient.shared; chat.start()
        let w = window(); w.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        defer { chat.stop(); w.close() }
        for _ in 0..<100 where !chat.connected { try await pause(30) }
        try check(chat.connected, "v0.5 fake service websocket")
        func shot(_ name: String, wait: UInt64 = 700) async throws { try await pause(wait); try await capture(w.contentView!, name) }
        func press(_ label: String) async throws {
            guard let marker = VerificationActionAnchor.views.object(forKey: label as NSString), marker.window === w else {
                throw VerificationError(description: "owned UI action marker: " + label)
            }
            marker.scrollToVisible(marker.bounds); try await pause(100)
            let center = marker.convert(NSPoint(x: marker.bounds.midX, y: marker.bounds.midY), to: nil)
            try check(w.contentView!.bounds.contains(w.contentView!.convert(center, from: nil)), "native click is inside owned window")
            Verify.click(w, x: center.x, y: center.y); try await pause(100)
        }

        try await scenario("idle"); try await shot("01-chat-brief-name-time")
        Nav.shared.go(.today); try await pause(2000)
        let briefs = try await BriefItem.fetch()
        try check(briefs.first?.cards.count == 3 && briefs.count == 2, "brief endpoint returns multiple full HTML documents in descending time order")
        try check(webs(w.contentView!).count >= 2, "multiple HTML cards mount in today viewport")
        weak var firstCard = webs(w.contentView!).first
        try await shot("02-today-multiple-html-cards", wait: 200)

        var long: WKWebView?
        for position: CGFloat in [350, 550, 750] {
            scroll(w.contentView!, y: position); try await pause(650)
            for web in webs(w.contentView!) {
                if (try? await web.evaluateJavaScript("document.getElementById('end') !== null") as? Bool) == true { long = web; break }
            }
            if long != nil { break }
        }
        guard let long else { throw VerificationError(description: "long HTML card mounted after outer scroll") }
        if let outer = outerScroll(w.contentView!), let doc = outer.documentView {
            let rect = long.convert(long.bounds, to: doc)
            scroll(w.contentView!, y: doc.isFlipped ? rect.minY : doc.bounds.height - rect.maxY)
            try await pause(500)
        }
        let natural = try await long.evaluateJavaScript("document.documentElement.scrollHeight") as? Double ?? 0
        try check(firstCard == nil, "offscreen WK instance and its script handlers are released")
        try check(natural > long.bounds.height && long.bounds.height <= w.contentView!.bounds.height * 0.75 + 1, "long HTML card is capped at 75 percent of window height")
        let outerY = outerScroll(w.contentView!)?.contentView.bounds.origin.y
        try await shot("03-long-card-top", wait: 200)
        _ = try await long.evaluateJavaScript("window.scrollTo(0, 720)")
        try await pause(200)
        let innerY = try await long.evaluateJavaScript("window.scrollY") as? Double ?? 0
        print("HTML measurements: document=\(natural), viewport=\(long.bounds.height), internalScroll=\(innerY)")
        try check(innerY > 0 && outerScroll(w.contentView!)?.contentView.bounds.origin.y == outerY, "long card scrolls internally without moving the page")
        try await shot("04-long-card-internal-scroll", wait: 100)
        w.setContentSize(NSSize(width: 1100, height: 700)); try await pause(300)
        try check(long.bounds.height <= 525 + 1, "HTML card cap follows window resize")
        w.setContentSize(NSSize(width: 1100, height: 820)); scroll(w.contentView!, y: 0); try await pause(900)
        let mounted = webs(w.contentView!)
        try check(mounted.count <= 3, "offscreen HTML views are reclaimed while placeholders preserve height")
        guard let action = mounted.first(where: { $0.bounds.height > 2 }) else { throw VerificationError(description: "prompt card remounted") }
        let users = chat.items.filter { $0.kind == .user }.count
        _ = try await action.evaluateJavaScript("document.querySelector('[data-prompt]')?.click()")
        try await pause(300)
        try check(Nav.shared.tab == .chat && chat.items.filter { $0.kind == .user }.count == users + 1 && chat.items.contains { $0.text == "帮我把今天的事排个顺序" }, "HTML button sends decoded prompt once and navigates to chat")
        try await shot("05-html-button-chat", wait: 1200)
        try await sandbox(); w.makeKeyAndOrderFront(nil)

        Nav.shared.go(.settings); try await shot("06-settings-model-permissions")
        try await press("模型"); try await shot("07-model-list")
        try await press("MiMo V2.6 Pro"); try await pause(500)
        try check(AgentSettingsStore.shared.snapshot?.model == "xiaomi/mimo-v2.6-pro", "real model radio button PUT confirmed")
        try await shot("08-model-selected", wait: 200)
        Nav.shared.pop(); try await pause(400); try await press("权限"); try await shot("09-permission-list")
        try await press("完全放行"); try await pause(400)
        try check(AgentSettingsStore.shared.snapshot?.permissionMode == "bypassPermissions", "real permission radio button PUT confirmed")
        try await shot("10-permission-selected", wait: 200)
        let synchronized = AgentSettingsStore(); await synchronized.load()
        try check(synchronized.snapshot?.model == "xiaomi/mimo-v2.6-pro" && synchronized.snapshot?.permissionMode == "bypassPermissions", "fresh settings client observes both saved selections")

        try await scenario("tasks"); Nav.shared.go(.tasks); try await shot("11-task-list")
        try await press("整理公开资料，写研究摘要"); try await shot("12-task-running-folded")
        let a = try await stats(); try await pause(3300); let b = try await stats()
        try check((b["task_history"] ?? 0) > (a["task_history"] ?? 0), "opened running task refreshes history at three seconds")
        Nav.shared.pop(); try await pause(500); try await press("晨报"); try await shot("13-task-completed-markdown")
        try await press("看简报"); try await shot("14-task-view-brief", wait: 1000)
        try check(Nav.shared.tab == .today && Nav.shared.briefFocus == nil && Nav.shared.stacks[.today]?.isEmpty == true, "task brief link focuses today without a detail page")

        Nav.shared.stacks[.tasks] = []; Nav.shared.go(.tasks); try await pause(500); try await press("晨报"); try await pause(500)
        guard let editor = input(w.contentView!) else { throw VerificationError(description: "task continuation input mounted") }
        w.makeFirstResponder(editor); editor.insertText("补一份检查清单", replacementRange: NSRange(location: NSNotFound, length: 0)); try await pause(100)
        let beforeSend = try await stats()
        try await press("发送续聊"); try await pause(400)
        let running = try await Api.json("/api/tasks/morning-1/history")
        try check(running["status"] as? String == "running" && running["id"] as? String == "morning-1" && (running["items"] as? [[String: Any]])?.filter { $0["kind"] as? String == "prompt" }.count == 2, "continuation preserves original task context and id")
        let afterSend = try await stats()
        try check((afterSend["task_send"] ?? 0) == (beforeSend["task_send"] ?? 0) + 1 && afterSend["send"] == beforeSend["send"], "task continuation uses POST task send, independent of main chat")
        try await shot("15-task-continuation-running", wait: 100)
        try await pause(4700); scroll(w.contentView!, y: .greatestFiniteMagnitude); try await shot("16-task-continuation-done", wait: 400)
        let done = try await Api.json("/api/tasks/morning-1/history")
        try check(done["status"] as? String == "done" && (done["items"] as? [[String: Any]])?.last?["text"] as? String != nil, "continued task completes and Markdown result refreshes")

        try await scenario("task-send-error"); Nav.shared.stacks[.tasks] = []; Nav.shared.go(.tasks); try await pause(500); try await press("晨报"); try await pause(400)
        guard let retryEditor = input(w.contentView!) else { throw VerificationError(description: "retry input mounted") }
        w.makeFirstResponder(retryEditor); retryEditor.insertText("失败时保留这段续聊", replacementRange: NSRange(location: NSNotFound, length: 0)); try await pause(100)
        try await press("发送续聊"); try await pause(500); scroll(w.contentView!, y: .greatestFiniteMagnitude); try await shot("17-task-send-error-draft", wait: 200)
        try check(retryEditor.string == "失败时保留这段续聊", "UI preserves continuation draft on server rejection")
        try await scenario("empty"); Nav.shared.go(.today); try await shot("18-today-empty-html")
        let final = try await stats()
        try check(final["blocked"] == 0, "all sandbox network and navigation probes remain blocked")
        print("PASS: v0.5 loopback production pages, HTML multi-card/height/scroll/recycling/prompt, model+permissions, running/completed tasks, continuation and failure draft")
    }
}
