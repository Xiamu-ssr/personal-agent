import AppKit
import WebKit
import Darwin

@main
struct CapsTest {
    @MainActor private static var checks = 0

    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        DispatchQueue.global().asyncAfter(deadline: .now() + 60) {
            fputs("FAIL: 本地能力测试超过 60 秒\n", stderr); exit(1)
        }
        Task { @MainActor in
            do {
                if let index = CommandLine.arguments.firstIndex(of: "--persist-clean"),
                   CommandLine.arguments.count > index + 1, let id = UUID(uuidString: CommandLine.arguments[index+1]) {
                    try await cleanProfile(id)
                    exit(0)
                }
                if CommandLine.arguments.contains("--persist-write") || CommandLine.arguments.contains("--persist-read") {
                    try await persistence()
                    app.terminate(nil)
                    exit(0)
                }
                try await shell()
                try geometry()
                try images()
                try registration()
                try await browser()
                print("PASS: \(checks) checks; local/offscreen only; no TCC requests or screen input")
                exit(0)
            } catch {
                fputs("FAIL: \(error.localizedDescription)\n", stderr)
                exit(1)
            }
        }
        app.run()
    }

    @MainActor private static func check(_ condition: @autoclosure () -> Bool, _ label: String) throws {
        guard condition() else { throw CapError(label) }
        checks += 1
        print("PASS: \(label)")
    }

    @MainActor private static func shell() async throws {
        let result = try await ShellTool.run(["command": "printf hello; printf oops >&2; exit 7"])
        try check(result["stdout"] as? String == "hello", "shell stdout")
        try check(result["stderr"] as? String == "oops", "shell stderr")
        try check(result["exit"] as? Int == 7, "shell nonzero exit preserved")
        let cwd = try await ShellTool.run(["command": "pwd", "cwd": "/private/tmp"])
        try check((cwd["stdout"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) == "/private/tmp", "shell cwd")
        let long = try await ShellTool.run(["command": "/usr/bin/yes 豆豆 | /usr/bin/head -n 15000"])
        let out = long["stdout"] as? String ?? "", err = long["stderr"] as? String ?? ""
        try check(out.count + err.count <= 20_000 && err.contains("已截断"), "shell combined 20k bound and truncation marker")
        try check(out.hasPrefix("豆豆\n") && !out.contains("\u{fffd}"), "shell Unicode truncation")
        let both = ShellTool.bounded(String(repeating: "o", count: 15000), String(repeating: "e", count: 15000))
        try check(both.0.count + both.1.count == 20_000 && both.1.hasPrefix("eee"), "shell keeps bounded stderr diagnostics")
        let start = ProcessInfo.processInfo.systemUptime
        let timeout = try await ShellTool.run(["command": "sleep 8 & child=$!; print -r -- $child; wait", "timeout": 0.4])
        try check(timeout["exit"] as? Int == 124 && ProcessInfo.processInfo.systemUptime - start < 3, "shell timeout exit=124")
        if let string = timeout["stdout"] as? String, let pid = Int32(string.trimmingCharacters(in: .whitespacesAndNewlines)) {
            for _ in 0..<20 {
                if kill(pid, 0) == -1 { break }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            try check(kill(pid, 0) == -1 && errno == ESRCH, "shell timeout kills child process group")
        } else { throw CapError("shell timeout did not report child PID") }
        let orphan = try await ShellTool.run(["command": "sleep 8 & print -r -- $!; exit 0", "timeout": 0.4])
        try check(orphan["exit"] as? Int == 124, "shell deadline remains after leader exits with open pipes")
        do {
            _ = try await ShellTool.run(["command": "true", "timeout": 301])
            throw CapError("accepted a timeout over 300")
        } catch let error as CapError {
            try check(error.localizedDescription.contains("300"), "shell rejects timeout over 300")
        }
        do {
            _ = try await ShellTool.run(["command": "true", "cwd": "/nonexistent-doudou-caps-test"])
            throw CapError("accepted invalid cwd")
        } catch let error as CapError {
            try check(error.localizedDescription.contains("启动失败"), "shell reports invalid cwd")
        }
    }

    @MainActor private static func geometry() throws {
        let retina = CaptureGeometry(display: 1, screen: CGRect(x: 0, y: 0, width: 1800, height: 1125),
                                     image: CGSize(width: 1440, height: 900))
        let middle = try retina.screenPoint(CGPoint(x: 720, y: 450))
        try check(middle == CGPoint(x: 900, y: 562.5), "computer Retina/resized coordinates")
        let secondary = CaptureGeometry(display: 2, screen: CGRect(x: -1920, y: -200, width: 1920, height: 1080),
                                        image: CGSize(width: 1440, height: 810))
        let offset = try secondary.screenPoint(CGPoint(x: 720, y: 405))
        try check(offset == CGPoint(x: -960, y: 340), "computer multi-display offset")
        try check(CaptureGeometry.scaledSize(CGSize(width: 3840, height: 2160)) == CGSize(width: 1440, height: 810), "image long edge <=1440")
        try check(CaptureGeometry.scaledSize(CGSize(width: 400, height: 200)) == CGSize(width: 400, height: 200), "image never upscales")
        do {
            _ = try retina.screenPoint(CGPoint(x: 1440, y: 0))
            throw CapError("accepted outside image")
        } catch let error as CapError {
            try check(error.localizedDescription.contains("坐标超出"), "computer rejects outside screenshot")
        }
        let from = CGPoint(x: 0, y: 0), to = CGPoint(x: 600, y: 400)
        let path = PointerMotion.path(from: from, to: to, seed: 42)
        try check(path == PointerMotion.path(from: from, to: to, seed: 42), "motion pure/seeded")
        try check(path != PointerMotion.path(from: from, to: to, seed: 43), "motion randomized control points")
        try check(path.first?.point == from && abs(path.last!.point.x - to.x) <= 2 && abs(path.last!.point.y - to.y) <= 2, "motion starts at cursor and lands within 2px")
        try check(path.count >= 25 && path.dropFirst().allSatisfy { $0.delay > 0 } && path.map(\.delay).reduce(0,+) < 1, "motion bounded, variable timing")
        try check(path.contains { abs($0.point.x * to.y - $0.point.y * to.x) > 10 }, "motion curved path")
    }

    @MainActor private static func images() throws {
        let context = CGContext(data: nil, width: 2400, height: 1600, bitsPerComponent: 8, bytesPerRow: 0,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        context.setFillColor(NSColor.blue.cgColor)
        context.fill(CGRect(x: 0, y: 0, width: 2400, height: 1600))
        let image = try DeviceImage.jpeg(context.makeImage()!)
        try check(image["mime"] as? String == "image/jpeg" && image["width"] as? Int == 1440, "JPEG image encoding and resize")
        let bytes = Data(base64Encoded: image["image"] as! String)!
        let decoded = NSBitmapImageRep(data: bytes)!
        try check(decoded.pixelsWide == 1440 && decoded.pixelsHigh == 960 && bytes.count < 5 * 1024 * 1024, "JPEG decodable and below cloud limit")
        let reply = DeviceResult.success(id: "local-call", data: image)
        let json = try JSONSerialization.data(withJSONObject: reply)
        let roundtrip = try JSONSerialization.jsonObject(with: json) as! [String: Any]
        let data = roundtrip["data"] as! [String: Any]
        try check(data["image"] as? String == image["image"] as? String && data["mime"] as? String == "image/jpeg", "device image/mime survive result.data serialization")
        let multiple = DeviceResult.success(id: "multi", data: [image, image])
        try check(JSONSerialization.isValidJSONObject(multiple), "device image array serialization")
    }

    @MainActor private static func registration() throws {
        try check(Capabilities.all.map(\.name) == ["shell","folder_desktop","folder_documents","folder_downloads","computer_use","browser","notify","calendar_events"], "v0.4 capability set")
        try check(Capabilities.all.filter { $0.name.hasPrefix("folder_") }.allSatisfy { $0.run == nil }, "folders have no run tools")
        DeviceClient.shared.start()
        let device = Socket.sent.last?["device"] as? [String: Any]
        let caps = device?["capabilities"] as? [[String: Any]] ?? []
        try check(caps.compactMap { $0["name"] as? String } == ["shell","computer_use","browser","notify","calendar_events"], "device registration omits folder switches")
        try check(Capabilities.all.allSatisfy { $0.appIcon.size.width > 0 }, "capability icons from NSWorkspace")
    }

    @MainActor private static func ref(_ tree: String, role: String, name: String) throws -> String {
        guard let line = tree.components(separatedBy: "\n").first(where: { $0.contains("- \(role) \"\(name)\"") }),
              let match = line.range(of: #"\[ref=e[0-9]+\]"#, options: .regularExpression) else { throw CapError("missing ref: \(name)") }
        return String(line[match].dropFirst(5).dropLast())
    }

    @MainActor private static func browser() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("doudou-caps-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let page = root.appendingPathComponent("page.html")
        let longPage = root.appendingPathComponent("long.html")
        let next = root.appendingPathComponent("next.html")
        try localHTML.write(to: page, atomically: true, encoding: .utf8)
        try "<title>Long</title><main><ul>\((0..<2500).map { "<li><button>Entry \($0)</button></li>" }.joined())</ul></main>".write(to: longPage, atomically: true, encoding: .utf8)
        try "<title>Next</title><h1>Next page</h1>".write(to: next, atomically: true, encoding: .utf8)
        let browser = DoudouBrowser(visible: false, dataStore: .nonPersistent(), localOnly: true)
        let opened = try await browser.run(["op":"open","url":page.absoluteString]) as! [String: Any]
        let tab = opened["tab"] as! String
        let tree = opened["snapshot"] as! String
        try check(opened["stable"] as? Bool == true && tree.contains("- main \"Workbench\"\n  - heading \"Local capabilities\" [level=1]"), "browser snapshot hierarchy")
        try check(tree.contains("- region \"Actions\"\n    - button \"Press\" [ref="), "browser nested interactive refs")
        try check(tree.contains("checked=true") && tree.contains("disabled"), "browser accessibility states")
        try check(!tree.contains("Invisible") && !tree.contains("<button") && !tree.contains("- img"), "browser omits hidden/decorative/HTML")
        let pressed = try await browser.run(["op":"click","tab":tab,"ref":ref(tree, role:"button", name:"Press")]) as! [String: Any]
        let afterClick = pressed["snapshot"] as! String
        if !afterClick.contains("click-isTrusted=true") { print("LOCAL CLICK SNAPSHOT:\n" + afterClick) }
        try check(afterClick.contains("click-isTrusted=true"), "browser native click isTrusted")
        let safariURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Safari")!
        let safariVersion = Bundle(url: safariURL)!.object(forInfoDictionaryKey: "CFBundleShortVersionString") as! String
        try check(afterClick.contains("Version/\(safariVersion) Safari/"), "browser UA has installed system Safari version")
        try check(afterClick.contains("settled=true") && pressed["stable"] as? Bool == true, "browser waits for DOM stability after click")
        let typed = try await browser.run(["op":"type","tab":tab,"ref":ref(afterClick, role:"textbox", name:"Name"),"text":"Hi豆豆🙂","submit":true]) as! [String: Any]
        let afterType = typed["snapshot"] as! String
        try check(afterType.contains("value=\"Hi豆豆🙂\""), "browser native per-character Unicode typing")
        try check(afterType.contains("input-isTrusted=true") && afterType.contains("key-isTrusted=true"), "browser input/keyboard isTrusted")
        try check(afterType.contains("submit-isTrusted=true"), "browser native Return submits form")
        let picture = try await browser.run(["op":"screenshot","tab":tab]) as! [String: Any]
        let jpeg = Data(base64Encoded: picture["image"] as! String)!
        try check(NSBitmapImageRep(data: jpeg) != nil && picture["mime"] as? String == "image/jpeg", "browser WKWebView screenshot")
        let large = try await browser.run(["op":"open","url":longPage.absoluteString]) as! [String: Any]
        let longTree = large["snapshot"] as! String
        try check(longTree.count <= 12_000 && longTree.contains("已截断"), "browser snapshot 12k bound and marker")
        let all = try await browser.run(["op":"tabs"]) as! [[String: Any]]
        try check(all.count == 2 && all.contains { $0["tab"] as? String == tab }, "browser multiple tabs")
        _ = try await browser.run(["op":"open","url":next.absoluteString,"tab":tab])
        let previous = try await browser.run(["op":"back","tab":tab]) as! [String: Any]
        try check((previous["snapshot"] as? String)?.contains("Local capabilities") == true, "browser open reuses tab and back")
        let fresh = try await browser.run(["op":"open","url":page.absoluteString,"tab":tab]) as! [String: Any]
        try check((fresh["snapshot"] as? String)?.contains("scrolled=false") == true, "browser scroll starts at top of fresh page")
        let scrolled = try await browser.run(["op":"scroll","tab":tab,"dy":200]) as! [String: Any]
        if (scrolled["snapshot"] as? String)?.contains("scrolled=true") != true { print("LOCAL SCROLL SNAPSHOT:\n" + (scrolled["snapshot"] as? String ?? "")) }
        try check((scrolled["snapshot"] as? String)?.contains("scrolled=true") == true, "browser native scroll moves local page")
        let top = try await browser.run(["op":"scroll","tab":tab,"dy":-100000]) as! [String: Any]
        try check((top["snapshot"] as? String)?.contains("scrolled=false") == true, "browser native scroll returns page to top")
        _ = try await browser.run(["op":"close","tab":large["tab"] as! String])
        let remaining = try await browser.run(["op":"tabs"]) as! [[String: Any]]
        try check(remaining.count == 1, "browser closes tab")
        _ = try await browser.run(["op":"close","tab":tab])
    }

    @MainActor private static func persistence() async throws {
        let args = CommandLine.arguments
        guard let index = args.firstIndex(where: { $0 == "--persist-write" || $0 == "--persist-read" }),
              args.count > index + 2, let id = UUID(uuidString: args[index+1]) else { throw CapError("invalid persistence test arguments") }
        let writing = args[index] == "--persist-write"
        let store = WKWebsiteDataStore(forIdentifier: id)
        try check(store.isPersistent && store.identifier == id, "named browser profile is persistent")
        let browser = DoudouBrowser(visible: false, dataStore: store, localOnly: true)
        let file = URL(fileURLWithPath: args[index+2])
        var url = URLComponents(url: file, resolvingAgainstBaseURL: false)!
        if writing { url.query = "write" }
        let opened = try await browser.run(["op":"open","url":url.url!.absoluteString]) as! [String: Any]
        if writing {
            let cookie = HTTPCookie(properties: [.domain:"127.0.0.1", .path:"/", .name:"doudou-caps", .value:"local-test",
                                                 .expires:Date().addingTimeInterval(3600)])!
            try check(!cookie.isSessionOnly && cookie.expiresDate != nil, "local test cookie has a persistent expiry")
            await withCheckedContinuation { continuation in
                store.httpCookieStore.setCookie(cookie) { continuation.resume() }
            }
        }
        let cookies: [HTTPCookie] = await withCheckedContinuation { continuation in
            store.httpCookieStore.getAllCookies { continuation.resume(returning: $0) }
        }
        try check(cookies.contains { $0.name == "doudou-caps" && $0.value == "local-test" },
                  writing ? "browser writes isolated local test cookie" : "browser cookie survives process restart")
        try check((opened["snapshot"] as? String)?.contains("caps-storage=saved") == true,
                  writing ? "browser writes local profile storage" : "browser profile storage survives process restart")
        if writing {
            // Fetch records from the storage process before this test executable exits.
            await withCheckedContinuation { continuation in
                store.fetchDataRecords(ofTypes: [WKWebsiteDataTypeLocalStorage, WKWebsiteDataTypeCookies]) { _ in continuation.resume() }
            }
        }
        _ = try await browser.run(["op":"close","tab":opened["tab"] as! String])
    }

    @MainActor private static func cleanProfile(_ id: UUID) async throws {
        // A separate process removes the test profile, after every owning WKWebView/dataStore exits.
        let bootstrap = WKWebsiteDataStore.nonPersistent()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            WKWebsiteDataStore.remove(forIdentifier: id) { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume() }
            }
        }
        withExtendedLifetime(bootstrap) {}
        try check(true, "temporary persistent test profile removed")
    }

    private static let localHTML = #"""
    <!doctype html><html><head><meta charset="utf-8"><title>Local capabilities</title>
    <style>body {font:16px system-ui;margin:20px} button,input {padding:12px;margin:4px} .hidden{display:none}</style></head>
    <body><main aria-label="Workbench"><h1>Local capabilities</h1><section aria-label="Actions">
    <button id="press">Press</button><button disabled>Disabled</button><button class="hidden">Invisible</button>
    <img alt="" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
    <form id="form"><label>Name<input id="name" aria-label="Name"></label><button type="submit">Send</button></form>
    <input type="checkbox" checked aria-label="Enabled"><output id="report">Ready</output>
    </section><div style="height:1800px">Scroll area</div></main><script>
    const state = {}, press = document.getElementById('press'), nameInput = document.getElementById('name'),
      form = document.getElementById('form'), report = document.getElementById('report');
    state.ua = navigator.userAgent;
    const render = () => report.textContent = Object.entries(state).map(([k,v]) => k+'='+v).join('; ');
    press.addEventListener('click', e => { state['click-isTrusted'] = e.isTrusted; render();
      setTimeout(() => { state.settled=true; render(); }, 200); });
    nameInput.addEventListener('input', e => { state['input-isTrusted']=e.isTrusted; render(); });
    nameInput.addEventListener('keydown', e => { state['key-isTrusted']=e.isTrusted; render(); });
    form.addEventListener('submit', e => { e.preventDefault(); state['submit-isTrusted']=e.isTrusted; render(); });
    window.addEventListener('scroll', () => { state.scrolled = scrollY > 0; render(); });
    state.scrolled = scrollY > 0; render();
    </script></body></html>
    """#
}
