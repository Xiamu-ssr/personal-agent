// Local verification: fixtures never reach the user's server; --live only reads real data and logs in WebViews.
import AppKit
import AVFoundation
import EventKit
import SwiftUI
import WebKit

struct VerificationError: Error, CustomStringConvertible {
    let description: String
}

func check(_ ok: @autoclosure () -> Bool, _ name: String) throws {
    guard ok() else { throw VerificationError(description: name) }
}

final class FixtureProtocol: URLProtocol {
    static var respond: ((URLRequest) throws -> (Int, [String: String], Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            guard let respond = Self.respond, let url = request.url else { throw VerificationError(description: "fixture routing") }
            let (status, headers, body) = try respond(request)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
    override func stopLoading() {}
}

@main
struct Verify {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        Task { @MainActor in
            do {
                if CommandLine.arguments.contains("--memory-review") {
                    try await memoryFixtures()
                    try await memoryReview()
                } else {
                    try await fixtures()
                    if CommandLine.arguments.contains("--live") { try await live() }
                }
                print("PASS: Mac verification finished")
                exit(0)
            } catch {
                // All assertion names and error messages are credential-free.
                print("FAIL: \(error)")
                exit(1)
            }
        }
        app.run()
    }


    /// Focused review checks: metadata only, inline tag line wrapping, and the original pointer callback.
    @MainActor
    static func memoryFixtures() async throws {
        let transport = Api.session
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FixtureProtocol.self]
        Api.session = URLSession(configuration: config)
        defer { Api.session.invalidateAndCancel(); Api.session = transport; FixtureProtocol.respond = nil }
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let first = (now.timeIntervalSince1970 - 7 * 86400) * 1000
        var requests = 0
        for (state, expected) in [
            (["busy": false] as [String: Any], nil as Double?),
            (["busy": false, "firstChat": NSNull()], nil),
            (["busy": false, "firstChat": first], first)
        ] {
            FixtureProtocol.respond = { request in
                try check(request.httpMethod == "GET" && request.url?.path.hasSuffix("/api/state") == true,
                          "first chat must use state only, never chat history")
                requests += 1
                return (200, [:], try JSONSerialization.data(withJSONObject: state))
            }
            let value = await HomePage.fetchFirstChat()
            try check(value == expected, "missing/null firstChat must not use a cached timestamp")
            let intro = HomePage.intro(firstChat: value, now: now)
            try check(intro == (expected == nil ? "从第一次对话开始，慢慢了解你" : "从 7 天前第一次对话开始，慢慢了解你"),
                      "firstChat milliseconds and missing/null introduction")
        }
        try check(requests == 3, "firstChat requires one small state request per load")
        print("PASS: firstChat present/missing/null; GET state only, no history fallback")

        func layout(_ text: NSAttributedString, width: CGFloat) -> (NSTextStorage, NSLayoutManager) {
            let storage = NSTextStorage(attributedString: text)
            let layout = NSLayoutManager()
            storage.addLayoutManager(layout)
            let container = NSTextContainer(size: CGSize(width: width, height: 10000))
            container.lineFragmentPadding = 0
            layout.addTextContainer(container)
            layout.ensureLayout(for: container)
            return (storage, layout)
        }
        func line(_ pair: (NSTextStorage, NSLayoutManager), _ character: Int) -> CGFloat {
            withExtendedLifetime(pair.0) {
                pair.1.lineFragmentRect(forGlyphAt: pair.1.glyphIndexForCharacter(at: character), effectiveRange: nil).minY
            }
        }
        let ref = "people/本人 100%.md"
        let shortBody = "这是一条记忆"
        let short = MemoryPointerText.rendered(text: shortBody, refs: [ref], size: 13.5)
        let wide = layout(short, width: 400)
        try check(line(wide, 0) == line(wide, short.length - 1), "pointer must share a short fact's line")
        let narrow = layout(short, width: 150)
        try check(line(narrow, shortBody.utf16.count - 1) < line(narrow, short.length - 1),
                  "a pointer wraps only when the current line cannot fit it")
        let longBody = String(repeating: "这是记忆正文", count: 8)
        let long = MemoryPointerText.rendered(text: longBody, refs: [ref], size: 13.5)
        let wrapped = layout(long, width: 300)
        try check(line(wrapped, 0) < line(wrapped, longBody.utf16.count - 1) &&
                  line(wrapped, longBody.utf16.count - 1) == line(wrapped, long.length - 1),
                  "pointer must use remaining width on a multiline fact's last line")
        let attachment = short.attribute(.attachment, at: short.length - 1, effectiveRange: nil) as? NSTextAttachment
        try check(attachment?.bounds.height == 22 && (attachment?.bounds.width ?? 0) > 0,
                  "pointer capsule must remain an indivisible inline glyph")
        var clicked = ""
        let coordinator = MemoryPointerText.Coordinator { clicked = $0 }
        let link = short.attribute(.link, at: short.length - 1, effectiveRange: nil)!
        try check(coordinator.textView(NSTextView(), clickedOnLink: link, at: short.length - 1) && clicked == ref,
                  "inline capsule must preserve the Unicode file pointer callback")
        print("PASS: inline capsules stay at text end, wrap correctly, and retain pointer actions")
    }

    /// Two production pages only; every request is read-only and the app socket never sends a user message.
    @MainActor
    static func memoryReview() async throws {
        try check(Prefs.configured, "saved account is required for read-only memory review")
        let state = try await Api.json("/api/state")
        let value = state["firstChat"] as? Double
        print("Live state: firstChat present=\(state.keys.contains("firstChat")), numeric=\(value != nil) (value hidden)")
        let fetched = await HomePage.fetchFirstChat()
        try check(fetched == value, "live firstChat metadata matches the state response")
        Session.shared.onboarded = true // In-memory only. No settings write or permission request.
        Nav.shared.stacks = [:]
        Nav.shared.go(.memory)
        ChatClient.shared.start()
        let output = URL(fileURLWithPath: CommandLine.arguments.last!, isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = "豆豆 · 记忆审查"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: MainView())
        window.center(); window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        defer { ChatClient.shared.stop(); window.close() }
        for _ in 0..<100 where !ChatClient.shared.connected { try await Task.sleep(nanoseconds: 100_000_000) }
        for (tab, name) in [(Tab.memory, "04-memory"), (.home, "05-doudou")] {
            Nav.shared.go(tab)
            try await Task.sleep(nanoseconds: 4_000_000_000)
            guard let view = window.contentView else { throw VerificationError(description: "memory review window") }
            view.layoutSubtreeIfNeeded()
            guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
                throw VerificationError(description: "memory review native snapshot")
            }
            view.cacheDisplay(in: view.bounds, to: bitmap)
            try bitmap.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent(name + ".png"))
            print("Snapshot: \(name).png")
        }
        print("PASS: live memory and Doudou production pages captured read-only")
    }

    @MainActor
    static func fixtures() async throws {
        let savedServer = Prefs.server, savedToken = Prefs.token
        let transport = Api.session
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FixtureProtocol.self]
        Api.session = URLSession(configuration: config)
        defer { Api.session.invalidateAndCancel(); Api.session = transport; FixtureProtocol.respond = nil }
        var routes: [String] = []
        FixtureProtocol.respond = { req in
            let path = req.url!.path
            routes.append(path)
            if path.hasSuffix("/api/pair") {
                try check(req.value(forHTTPHeaderField: "Authorization") == nil, "pairing must not carry old credentials")
                return (200, [:], Data(#"{"token":"fixture-token"}"#.utf8))
            }
            try check(req.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-token", "paired token state validation")
            return (200, [:], Data(#"{"busy":false}"#.utf8))
        }
        let paired = try await Api.authenticate(server: "https://fixture.invalid/agent", password: "123456")
        try check(paired == "fixture-token" && routes.count == 2, "six digits must use pair then state")
        routes = []
        _ = try await Api.authenticate(server: "https://fixture.invalid/agent", password: "fixture-token")
        try check(routes == ["/agent/api/state"], "a passphrase must use state directly")
        FixtureProtocol.respond = { _ in (401, [:], Data(#"{"error":"服务端错误测试"}"#.utf8)) }
        do {
            _ = try await Api.authenticate(server: "https://fixture.invalid/agent", password: "bad")
            throw VerificationError(description: "invalid login should fail")
        } catch let e as ApiError {
            try check(e.message == "服务端错误测试", "login preserves the server error message")
        }
        try check(Prefs.server == savedServer && Prefs.token == savedToken, "credential checks must not mutate the saved account")
        FixtureProtocol.respond = { _ in (200, [:], Data("<html>wrong service</html>".utf8)) }
        do {
            _ = try await Api.authenticate(server: "https://fixture.invalid/agent", password: "bad")
            throw VerificationError(description: "non-JSON services must not log in")
        } catch is ApiError {}
        print("PASS: pairing, passphrase, errors, account preservation")

        let raw = Data([1, 2, 3, 4])
        var upload = false, transcribe = false
        FixtureProtocol.respond = { req in
            try check(req.httpMethod == "POST" && req.value(forHTTPHeaderField: "Content-Type") == "application/octet-stream", "raw-byte request content type")
            var body = req.httpBody
            if body == nil, let stream = req.httpBodyStream {
                stream.open(); defer { stream.close() }
                var bytes = [UInt8](repeating: 0, count: 1024), data = Data()
                while stream.hasBytesAvailable {
                    let n = stream.read(&bytes, maxLength: bytes.count)
                    if n <= 0 { break }; data.append(contentsOf: bytes.prefix(n))
                }
                body = data
            }
            try check(body == raw, "audio requests must send original bytes rather than JSON")
            if req.url!.path.hasSuffix("/api/upload") {
                upload = true
                let name = URLComponents(url: req.url!, resolvingAgainstBaseURL: false)!.queryItems!.first!.value
                try check(name == "语音 & 100%.m4a", "upload filename encoding")
                return (200, [:], Data(#"{"path":"data/uploads/test/note.m4a","name":"语音 & 100%.m4a","size":4}"#.utf8))
            }
            transcribe = true
            try check(req.url!.query == "format=m4a", "transcribe format")
            return (200, [:], Data(#"{"text":"  转写结果  "}"#.utf8))
        }
        let att = try await Api.upload(raw, name: "语音 & 100%.m4a", kind: "voice")
        try check(att.kind == "voice" && (att.json["path"] as? String) == "data/uploads/test/note.m4a", "voice attachment WS payload")
        let transcript = try await Api.transcribe(raw, format: "m4a")
        try check(upload && transcribe && transcript == "转写结果", "raw audio upload and transcription fixtures")
        do {
            _ = try await Api.transcribe(Data(count: (10 << 20) + 1), format: "m4a")
            throw VerificationError(description: "oversized transcription must fail before network")
        } catch let e as ApiError { try check(e.code == 413, "transcription byte limit") }

        FixtureProtocol.respond = { _ in (200, ["Set-Cookie": "pa_token=fixture-cookie; Path=/agent; HttpOnly; Secure; SameSite=Lax"], Data(#"{"ok":true}"#.utf8)) }
        let cookies = try await Api.webCookies()
        try check(cookies.contains { $0.name == "pa_token" && $0.path == "/agent" && $0.isSecure && $0.isHTTPOnly }, "WebView must use the server cookie")
        try check(WebPage.resourcePath("data/sites/demo") == "data/sites/demo/", "site directory relative resource base")
        let path = "data/memory/life/测试 100%?x#y.md"
        try check(Api.filePath(path).removingPercentEncoding == "/files/" + path, "per-segment file path encoding")
        print("PASS: fixture attachments, transcription limits, cookie and file paths")

        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 4000, pixelsHigh: 2000, bitsPerSample: 8, samplesPerPixel: 4,
                                  hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        let picture = NSImage(size: NSSize(width: 4000, height: 2000)); picture.addRepresentation(rep)
        let jpeg = Composer.jpeg(picture).flatMap(NSBitmapImageRep.init(data:))
        try check(jpeg?.pixelsWide == 1600 && jpeg?.pixelsHigh == 800, "image long edge must shrink to 1600 pixels")
        let pasteboard = NSPasteboard.withUniqueName()
        pasteboard.declareTypes([.tiff, .string], owner: nil)
        pasteboard.setData(picture.tiffRepresentation!, forType: .tiff)
        pasteboard.setString("图片附带的来源说明", forType: .string)
        let pasteComposer = Composer.shared
        try check(pasteComposer.paste(pasteboard) && pasteComposer.drafts.first?.kind == "image", "pasted images must work even when the pasteboard also carries text")
        pasteboard.clearContents(); pasteComposer.reset()
        try check(cronText("30 7 * * *") == "每天 7:30" && cronText("0 20 * * 0") == "每周日 20:00", "cron translation")
        try check(ScheduleJob(id: "compact", name: "压缩", cron: "0 3 * * *", kind: "compact").isSystem, "system task must not run manually")
        let sample = "# 标题\n\n**粗体** 和 `代码`\n\n- 内容 → work/文件.md\n\n| 名称 | 数量 |\n| --- | --- |\n| 示例 | 2 |"
        try check(Markdown.parse(sample).contains { if case .table = $0 { return true }; return false }, "Markdown table")
        try check(Markdown.pointers("内容 → work/文件.md").1 == ["work/文件.md"], "memory pointer tag")
        try check(Markdown.pointers("变化 → 下一个状态").0 == "变化 → 下一个状态", "ordinary arrows must preserve their text")
        let expected = Set(["battery", "notify", "calendar_events", "clipboard_read", "clipboard_write", "open_url", "frontmost_app", "shortcuts", "folder"])
        try check(Set(Capabilities.all.map(\.name)) == expected, "full Mac capability registry without unverified location")
        try check(Capabilities.all.allSatisfy { $0.json["enabled"] is Bool && !($0.json["title"] as? String ?? "").isEmpty }, "all capabilities register enabled and title")
        print("PASS: image compression, cron, Markdown, complete capability registry")

        let chat = ChatClient()
        chat.handle(["t": "job", "phase": "started", "label": "测试任务"])
        let snapshot = chat.jobsVersion
        chat.handle(["t": "job", "phase": "done", "label": "测试任务"])
        chat.applyJobs([["label": "测试任务", "started": 1000]], version: snapshot)
        try check(chat.live.isEmpty, "late job snapshot must not resurrect a finished task")
        chat.handle(["t": "task", "phase": "started", "id": "one", "description": "子任务"])
        chat.handle(["t": "task", "phase": "done", "id": "one"])
        try check(chat.live.isEmpty, "terminal task phase without status")
        chat.handle(["t": "job", "phase": "started", "label": "旧任务"])
        chat.applyJobs([], version: chat.jobsVersion)
        try check(chat.live.isEmpty, "server truth clears jobs absent from its running list")
        chat.items = [ChatItem(kind: .user, text: "", attachments: [Attachment(path: "data/a.m4a", name: "a", kind: "voice")], pending: true),
                      ChatItem(kind: .user, text: "", attachments: [Attachment(path: "data/b.m4a", name: "b", kind: "voice")], pending: true)]
        chat.handle(["t": "user", "text": "", "attachments": [["path": "data/a.m4a", "name": "a", "kind": "voice", "transcript": "第一段"]]])
        try check(chat.items.count == 2 && !chat.items[0].pending && chat.items[1].pending && chat.items[0].attachments[0].transcript == "第一段", "empty voice echoes must match their attachment paths")
        Nav.shared.tab = .chat
        Nav.shared.stacks[.settings] = [.devices]
        Nav.shared.go(.settings)
        try check(Nav.shared.stacks[.settings]?.isEmpty == true, "settings must open its home page rather than a previous detail")
        Nav.shared.tab = .chat; Nav.shared.stacks = [:]
        print("PASS: job snapshot race, ended tasks, voice echo correlation, settings navigation")
        FixtureProtocol.respond = { _ in (502, [:], Data(#"{"error":"转写额度测试"}"#.utf8)) }
        let shared = ChatClient.shared, composer = Composer.shared
        shared.connected = true
        composer.retryAudio = raw
        composer.retryTranscribe()
        for _ in 0..<100 where composer.transcribing { try await Task.sleep(nanoseconds: 20_000_000) }
        try check(!composer.transcribing && composer.retryAudio == raw, "failed hold-to-talk transcription must retain local audio")
        composer.reset(); shared.connected = false
        print("PASS: failed transcription retains audio without uploading or sending")
    }

    @MainActor
    static func live() async throws {
        try check(Prefs.configured, "saved account is required for read-only live checks")
        let state = try await Api.json("/api/state")
        try check(state["schedule"] is [[String: Any]], "live state schedule shape")
        let cookies = try await Api.webCookies()
        try check(cookies.contains { $0.name == "pa_token" }, "live server WebView cookie")
        print("PASS: live state and /api/login cookie (values hidden)")
        print("Permission status only: microphone=\(AVCaptureDevice.authorizationStatus(for: .audio).rawValue), calendar=\(EKEventStore.authorizationStatus(for: .event).rawValue), screenCapture=\(CGPreflightScreenCaptureAccess())")
        Session.shared.onboarded = true // In-memory only. No walkthrough or system permission prompt.
        ChatClient.shared.start() // app socket only; never sends a user message or device call.
        let output = URL(fileURLWithPath: CommandLine.arguments.last!, isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.identifier = NSUserInterfaceItemIdentifier("main")
        window.title = "豆豆 · 本地只读验证"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: MainView())
        window.center(); window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        for _ in 0..<100 where !ChatClient.shared.connected { try await Task.sleep(nanoseconds: 200_000_000) }
        if !ChatClient.shared.connected {
            let reason = ChatClient.shared.error.replacingOccurrences(of: Prefs.token, with: "[redacted]")
            print("WebSocket reason: " + reason)
        }
        try check(ChatClient.shared.connected, "live app WebSocket hello")
        for _ in 0..<50 where ChatClient.shared.items.isEmpty { try await Task.sleep(nanoseconds: 100_000_000) }
        try check(!ChatClient.shared.items.isEmpty, "live chat history loaded")
        print("PASS: live app WebSocket and read-only history")

        func capture(_ name: String, wait: UInt64 = 3) async throws {
            try await Task.sleep(nanoseconds: wait * 1_000_000_000)
            guard let view = window.contentView else { throw VerificationError(description: "missing window content") }
            view.layoutSubtreeIfNeeded()
            guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { throw VerificationError(description: "native view snapshot") }
            view.cacheDisplay(in: view.bounds, to: bitmap)
            try bitmap.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent(name + ".png"))
            print("Snapshot: \(name).png")
        }
        for (tab, name) in [(Tab.chat, "01-chat"), (.today, "02-today"), (.tasks, "03-tasks"), (.memory, "04-memory"), (.home, "05-doudou"), (.settings, "06-settings")] {
            Nav.shared.go(tab)
            try await capture(name)
        }
        Nav.shared.go(.tasks)
        try await Task.sleep(nanoseconds: 1_000_000_000)
        // The segment positions follow the real 1100×760 layout. Events stay inside this process/window.
        if !press(window.contentView!, label: "已完成") { click(window, x: 351, y: window.contentView!.bounds.height - 121) }
        try await capture("03-tasks-completed", wait: 1)
        if !press(window.contentView!, label: "定时") { click(window, x: 417, y: window.contentView!.bounds.height - 121) }
        try await capture("03-tasks-scheduled", wait: 1)
        print("Task segments captured through the verification window's own event queue")
        for (route, name) in [(Route.connectors(tab: 0), "07-connectors-local"), (.connectors(tab: 1), "08-connectors-cloud"), (.connectors(tab: 2), "09-connectors-other"), (.devices, "10-devices"), (.skills, "11-skills")] {
            Nav.shared.stacks[.settings] = []
            Nav.shared.push(route, in: .settings)
            try await capture(name)
        }
        if let dir = try await Api.tree("data/memory").first(where: { $0.dir && $0.name == "work" }) {
            Nav.shared.push(.memoryCategory(dir.name), in: .memory)
            try await capture("19-memory-category", wait: 2)
        }
        if let diary = try await Api.tree("data/diary").first(where: { !$0.dir && $0.name.hasSuffix(".md") }) {
            Nav.shared.push(.doc(title: "豆豆的日记", path: "data/diary/" + diary.name), in: .home)
            try await capture("20-diary-detail", wait: 2)
        }
        if let day = try await Api.tree("data/briefs").first(where: { $0.dir }),
           let brief = try await Api.tree("data/briefs/" + day.name).first(where: { !$0.dir && $0.name.hasSuffix(".html") }) {
            Nav.shared.push(.web(title: "简报", path: "data/briefs/" + day.name + "/" + brief.name), in: .today)
            try await capture("21-brief", wait: 4)
            if let web = findWeb(window.contentView!) {
                let valid = try await web.evaluateJavaScript("document.readyState === 'complete' && document.body.innerText.length > 20") as? Bool
                try check(valid == true, "live brief WebView")
            }
        }
        Nav.shared.push(.doc(title: "总档", path: "data/memory/profile/总档.md"), in: .memory)
        try await capture("12-memory-detail")
        Nav.shared.push(.diaries, in: .home)
        try await capture("13-diaries")
        Nav.shared.push(.doc(title: "豆豆的设定", path: "data/memory/role/角色.md"), in: .home)
        try await capture("14-role")
        if let entry = try await Api.tree("data/sites").first {
            Nav.shared.push(.web(title: entry.name, path: "data/sites/" + entry.name), in: .today)
            try await capture("15-site", wait: 6)
            if let web = findWeb(window.contentView!) {
                let valid = try await web.evaluateJavaScript("document.readyState === 'complete' && document.body.innerText.length > 20 && !document.body.innerText.includes('unauthorized')") as? Bool
                try check(valid == true, "live WKWebView authenticated document")
                let image = try await web.takeSnapshot(configuration: nil)
                try image.tiffRepresentation.flatMap(NSBitmapImageRep.init(data:))!.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent("15-site-content.png"))
                print("PASS: live WKWebView document and native web snapshot")
            } else { throw VerificationError(description: "live WKWebView was not mounted") }
        }
        window.contentView = NSHostingView(rootView: LoginView().preferredColorScheme(.light))
        try await capture("16-login", wait: 1)
        window.contentView = NSHostingView(rootView: OnboardingView().preferredColorScheme(.light))
        try await capture("17-onboarding", wait: 1)
        window.contentView = NSHostingView(rootView: MenuView().preferredColorScheme(.light))
        window.setContentSize(NSSize(width: 380, height: 540))
        try await capture("18-menu-chat", wait: 1)
        let delegate = AppDelegate()
        try check(!delegate.applicationShouldTerminateAfterLastWindowClosed(NSApp), "closing the last window must keep the app alive")
        AppDelegate.openMain = { window.makeKeyAndOrderFront(nil) }
        window.close()
        _ = delegate.applicationShouldHandleReopen(NSApp, hasVisibleWindows: false)
        try check(window.isVisible, "Dock reopen delegate must bring back the window")
        print("PASS: last-window persistence and reopen delegate")
        ChatClient.shared.stop()
        window.close()
    }

    /// Only our own view tree; no AXUIElement, System Events, system permission request or external control.
    static func press(_ node: Any, label: String, depth: Int = 0) -> Bool {
        guard depth < 40, let element = node as? NSAccessibilityProtocol else { return false }
        if element.accessibilityRole() == .button, element.accessibilityLabel() == label {
            return element.accessibilityPerformPress()
        }
        for child in element.accessibilityChildren() ?? [] {
            if press(child, label: label, depth: depth + 1) { return true }
        }
        return false
    }

    static func click(_ window: NSWindow, x: CGFloat, y: CGFloat) {
        let point = NSPoint(x: x, y: y), stamp = ProcessInfo.processInfo.systemUptime
        for (type, time, pressure) in [(NSEvent.EventType.leftMouseDown, stamp, Float(1)), (.leftMouseUp, stamp + 0.08, Float(0))] {
            if let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: time,
                                            windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: pressure) {
                NSApp.postEvent(event, atStart: false)
            }
        }
    }

    static func findWeb(_ view: NSView) -> WKWebView? {
        if let web = view as? WKWebView { return web }
        for child in view.subviews { if let web = findWeb(child) { return web } }
        return nil
    }
}
