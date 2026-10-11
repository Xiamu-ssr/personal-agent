import AppKit
import WebKit

@MainActor
final class BrowserTab {
    let id = "tab-" + UUID().uuidString.lowercased()
    let webView: WKWebView
    var observations: [NSKeyValueObservation] = []
    var lastPointer: CGPoint?
    var navigationError: String?

    init(webView: WKWebView) { self.webView = webView }
    var json: [String: Any] {
        ["tab": id, "title": webView.title ?? "新标签", "url": webView.url?.absoluteString ?? "about:blank"]
    }
}

/// All synthetic events stay inside this app's NSWindow. No global CGEvent posts or accessibility permission.
@MainActor
final class DoudouBrowser: NSObject, WKNavigationDelegate, WKUIDelegate, NSTextFieldDelegate, NSWindowDelegate {
    static let storeIdentifier = UUID(uuidString: "8E15CE9B-4507-4DA3-A3E7-BFA93B5874DD")!
    static let shared = DoudouBrowser()

    private let dataStore: WKWebsiteDataStore
    private let visible: Bool
    private let localOnly: Bool
    private var browserWindow: NSWindow?
    private let tabsBar = NSStackView()
    private let host = NSView()
    private let address = NSTextField()
    private let backButton = NSButton()
    private let forwardButton = NSButton()
    private var tabs: [BrowserTab] = []
    private var selected: String?
    private var performing = false
    private var eventNumber = 1

    /// Tests pass a non-persistent store and an offscreen window restricted to local navigation.
    init(visible: Bool = true, dataStore: WKWebsiteDataStore? = nil, localOnly: Bool = false) {
        self.visible = visible
        self.localOnly = localOnly
        self.dataStore = dataStore ?? WKWebsiteDataStore(forIdentifier: Self.storeIdentifier)
        super.init()
    }

    func run(_ args: [String: Any]) async throws -> Any {
        guard !performing else { throw CapError("浏览器操作正在进行，请等上一次调用完成") }
        performing = true
        defer { performing = false }
        ensureWindow()
        let op = args["op"] as? String ?? "tabs"
        if op == "tabs" {
            if tabs.isEmpty { _ = try await newTab() }
            return tabs.map { tab -> [String: Any] in
                var value = tab.json; value["active"] = tab.id == selected; return value
            }
        }
        if op == "open" {
            guard let string = args["url"] as? String, let url = URL(string: string), allowed(url) else {
                throw CapError("open 需要 http/https 或本地 file 网址")
            }
            let tab: BrowserTab
            if args["tab"] != nil { tab = try find(args) }
            else { tab = try await newTab() }
            select(tab)
            load(url, into: tab.webView)
            let stable = try await waitForStable(tab)
            return try await snapshot(tab, stable: stable)
        }
        let tab = try find(args)
        select(tab)
        switch op {
        case "snapshot": return try await snapshot(tab)
        case "click":
            let point = try await targetPoint(args, in: tab)
            try await click(point, in: tab)
            return try await snapshot(tab, stable: waitForStable(tab))
        case "type":
            guard let text = args["text"] as? String else { throw CapError("type 需要 text") }
            let point = try await targetPoint(args, in: tab)
            try await click(point, in: tab)
            for character in text {
                try sendKey(String(character), to: tab)
                try await Task.sleep(nanoseconds: UInt64.random(in: 35_000_000...110_000_000))
            }
            if args["submit"] as? Bool == true { try sendKey("\r", to: tab, keyCode: 36) }
            return try await snapshot(tab, stable: waitForStable(tab))
        case "scroll":
            guard let amount = args["dy"] as? NSNumber, amount.doubleValue.isFinite, abs(amount.doubleValue) <= 100_000 else {
                throw CapError("scroll 需要有限的 dy 像素数，正数向下")
            }
            let view = tab.webView
            guard let window = view.window else { throw CapError("浏览器窗口已关闭") }
            let center = CGPoint(x: view.bounds.midX, y: view.bounds.midY)
            let position = view.convert(center, to: nil)
            guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1,
                                      wheel1: -amount.int32Value, wheel2: 0, wheel3: 0) else { throw CapError("无法创建浏览器滚动事件") }
            let screen = window.convertPoint(toScreen: position)
            event.location = CGPoint(x: screen.x, y: (NSScreen.screens.first?.frame.maxY ?? 0) - screen.y)
            event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window.windowNumber))
            event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window.windowNumber))
            guard let native = NSEvent(cgEvent: event) else { throw CapError("无法创建浏览器滚动事件") }
            // Send directly to WebKit's content view, never to the global event tap.
            (view.hitTest(center) ?? view).scrollWheel(with: native)
            return try await snapshot(tab, stable: waitForStable(tab))
        case "screenshot":
            let config = WKSnapshotConfiguration()
            config.rect = tab.webView.bounds
            config.afterScreenUpdates = true
            let image = try await tab.webView.takeSnapshot(configuration: config)
            guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { throw CapError("无法取得浏览器截图") }
            var result = try DeviceImage.jpeg(cgImage)
            result["tab"] = tab.id
            return result
        case "back":
            guard tab.webView.canGoBack else { throw CapError("这个标签没有上一页") }
            tab.webView.goBack()
            return try await snapshot(tab, stable: waitForStable(tab))
        case "close":
            close(tab)
            return ["closed": tab.id]
        default: throw CapError("browser 的 op 不正确")
        }
    }

    private func find(_ args: [String: Any]) throws -> BrowserTab {
        guard let id = args["tab"] as? String, let tab = tabs.first(where: { $0.id == id }) else {
            throw CapError("需要有效的 tab，请先调用 tabs 或 open")
        }
        return tab
    }

    private func allowed(_ url: URL) -> Bool {
        if url.isFileURL || url.absoluteString == "about:blank" { return true }
        guard ["http", "https"].contains(url.scheme?.lowercased() ?? ""), let name = url.host else { return false }
        return !localOnly || ["127.0.0.1", "::1", "localhost"].contains(name.lowercased())
    }

    private func load(_ url: URL, into webView: WKWebView) {
        if url.isFileURL { webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent()) }
        else { webView.load(URLRequest(url: url)) }
    }

    private func configuration() -> WKWebViewConfiguration {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = dataStore
        config.userContentController.addUserScript(WKUserScript(source: BrowserScripts.install, injectionTime: .atDocumentEnd,
                                                                forMainFrameOnly: false, in: .defaultClient))
        return config
    }

    private func newTab() async throws -> BrowserTab {
        let tab = addTab(configuration())
        // WKWebView supplies the current system WebKit/macOS UA. Safari adds its installed Version token.
        let base = try await tab.webView.evaluateJavaScript("navigator.userAgent") as? String ?? ""
        guard let safari = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Safari"),
              let version = Bundle(url: safari)?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
              let range = base.range(of: #"AppleWebKit/([0-9.]+)"#, options: .regularExpression) else {
            close(tab)
            throw CapError("无法读取当前系统 Safari 的 User-Agent")
        }
        let webKit = String(base[range]).replacingOccurrences(of: "AppleWebKit/", with: "")
        tab.webView.customUserAgent = base + " Version/\(version) Safari/\(webKit)"
        return tab
    }

    private func addTab(_ config: WKWebViewConfiguration) -> BrowserTab {
        // Popups use the same fixed profile too.
        config.websiteDataStore = dataStore
        let view = WKWebView(frame: host.bounds, configuration: config)
        view.navigationDelegate = self
        view.uiDelegate = self
        view.allowsBackForwardNavigationGestures = true
        let tab = BrowserTab(webView: view)
        tab.observations = [
            view.observe(\.title, options: [.new]) { [weak self] _, _ in Task { @MainActor in self?.refreshChrome() } },
            view.observe(\.url, options: [.new]) { [weak self] _, _ in Task { @MainActor in self?.refreshChrome() } },
            view.observe(\.isLoading, options: [.new]) { [weak self] _, _ in Task { @MainActor in self?.refreshChrome() } },
        ]
        tabs.append(tab)
        select(tab)
        return tab
    }

    private func ensureWindow() {
        if let window = browserWindow {
            if visible { window.makeKeyAndOrderFront(nil) }
            return
        }
        let origin = visible ? CGPoint(x: 160, y: 160) : CGPoint(x: -12000, y: -12000)
        let window = NSWindow(contentRect: CGRect(origin: origin, size: CGSize(width: 1100, height: 780)),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "豆豆浏览器"
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.acceptsMouseMovedEvents = true
        window.minSize = CGSize(width: 640, height: 420)
        let root = NSStackView()
        root.orientation = .vertical
        root.spacing = 0
        root.alignment = .leading
        root.translatesAutoresizingMaskIntoConstraints = false
        window.contentView = NSView()
        window.contentView!.addSubview(root)
        NSLayoutConstraint.activate([
            root.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor),
            root.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor),
            root.topAnchor.constraint(equalTo: window.contentView!.topAnchor),
            root.bottomAnchor.constraint(equalTo: window.contentView!.bottomAnchor)
        ])
        let toolbar = NSStackView()
        toolbar.spacing = 8
        toolbar.edgeInsets = NSEdgeInsets(top: 8, left: 10, bottom: 8, right: 10)
        for (button, title, action) in [(backButton, "←", #selector(back)), (forwardButton, "→", #selector(forward))] {
            button.title = title; button.target = self; button.action = action; button.bezelStyle = .rounded
            toolbar.addArrangedSubview(button)
        }
        toolbar.addArrangedSubview(NSButton(title: "刷新", target: self, action: #selector(reload)))
        address.placeholderString = "输入网址"
        address.target = self
        address.action = #selector(navigate)
        address.delegate = self
        address.setContentHuggingPriority(.defaultLow, for: .horizontal)
        toolbar.addArrangedSubview(address)
        toolbar.addArrangedSubview(NSButton(title: "+", target: self, action: #selector(addBlank)))
        tabsBar.orientation = .horizontal
        tabsBar.spacing = 6
        let scroller = NSScrollView()
        scroller.hasHorizontalScroller = true
        scroller.drawsBackground = false
        tabsBar.translatesAutoresizingMaskIntoConstraints = false
        scroller.documentView = tabsBar
        NSLayoutConstraint.activate([
            tabsBar.heightAnchor.constraint(equalToConstant: 34),
            tabsBar.leadingAnchor.constraint(equalTo: scroller.contentView.leadingAnchor)
        ])
        root.addArrangedSubview(toolbar)
        root.addArrangedSubview(scroller)
        root.addArrangedSubview(host)
        for view in [toolbar, scroller, host] {
            view.translatesAutoresizingMaskIntoConstraints = false
            view.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true
        }
        scroller.heightAnchor.constraint(equalToConstant: 44).isActive = true
        host.heightAnchor.constraint(greaterThanOrEqualToConstant: 100).isActive = true
        host.setContentHuggingPriority(.defaultLow, for: .vertical)
        browserWindow = window
        window.contentView?.layoutSubtreeIfNeeded()
        if visible { window.center(); window.makeKeyAndOrderFront(nil) }
        else {
            // WebKit renders and receives NSWindow events while the window stays outside all displays.
            window.setFrameOrigin(origin)
            window.orderFront(nil)
        }
    }

    private func select(_ tab: BrowserTab) {
        selected = tab.id
        for child in host.subviews { child.removeFromSuperview() }
        let view = tab.webView
        view.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: host.leadingAnchor), view.trailingAnchor.constraint(equalTo: host.trailingAnchor),
            view.topAnchor.constraint(equalTo: host.topAnchor), view.bottomAnchor.constraint(equalTo: host.bottomAnchor)
        ])
        host.layoutSubtreeIfNeeded()
        refreshChrome()
    }

    private func close(_ tab: BrowserTab) {
        tab.webView.stopLoading()
        tab.webView.removeFromSuperview()
        tab.webView.navigationDelegate = nil
        tab.webView.uiDelegate = nil
        tabs.removeAll { $0.id == tab.id }
        if selected == tab.id {
            selected = nil
            if let next = tabs.last { select(next) }
        }
        refreshChrome()
    }

    private func refreshChrome() {
        for view in tabsBar.arrangedSubviews { tabsBar.removeArrangedSubview(view); view.removeFromSuperview() }
        for tab in tabs {
            let row = NSStackView()
            let button = NSButton(title: String((tab.webView.title ?? "新标签").prefix(22)), target: self, action: #selector(chooseTab(_:)))
            button.identifier = NSUserInterfaceItemIdentifier(tab.id)
            button.bezelStyle = .rounded
            button.state = tab.id == selected ? .on : .off
            let close = NSButton(title: "×", target: self, action: #selector(closeTab(_:)))
            close.identifier = NSUserInterfaceItemIdentifier(tab.id)
            row.addArrangedSubview(button); row.addArrangedSubview(close)
            tabsBar.addArrangedSubview(row)
        }
        let active = tabs.first { $0.id == selected }?.webView
        // Never replace an address the user is currently editing.
        if address.currentEditor() == nil { address.stringValue = active?.url?.absoluteString ?? "" }
        backButton.isEnabled = active?.canGoBack ?? false
        forwardButton.isEnabled = active?.canGoForward ?? false
    }

    private func script(_ script: String, in tab: BrowserTab) async throws -> Any {
        try await evaluate { reply in
            tab.webView.evaluateJavaScript(script, in: nil, in: .defaultClient) { result in
                reply(result)
            }
        }
    }

    /// A page with a stuck script must not leave the device call waiting indefinitely.
    private func evaluate(timeout: Double = 10, _ operation: (@escaping (Result<Any, Error>) -> Void) -> Void) async throws -> Any {
        try await withCheckedThrowingContinuation { continuation in
            let reply = BrowserScriptReply(continuation)
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) {
                reply.finish(.failure(CapError("页面 JavaScript 响应超时，请在豆豆浏览器窗口接手或重新打开页面")))
            }
            operation { reply.finish($0) }
        }
    }

    private func snapshot(_ tab: BrowserTab, stable: Bool? = nil) async throws -> [String: Any] {
        _ = try await script(BrowserScripts.install, in: tab)
        let tree = try await script(BrowserScripts.snapshot, in: tab) as? String ?? ""
        var value = tab.json
        value["snapshot"] = tree
        if let stable { value["stable"] = stable }
        if let error = tab.navigationError { value["navigation_error"] = error }
        return value
    }

    private func waitForStable(_ tab: BrowserTab) async throws -> Bool {
        let began = ProcessInfo.processInfo.systemUptime
        while ProcessInfo.processInfo.systemUptime - began < 10 {
            try await Task.sleep(nanoseconds: 100_000_000)
            if !tab.webView.isLoading {
                do {
                    let remaining = 10 - (ProcessInfo.processInfo.systemUptime - began)
                    if remaining <= 0 { return false }
                    let idle = try await evaluate(timeout: remaining) { reply in
                        let js = BrowserScripts.install + "\nwindow.__doudou.idle()"
                        tab.webView.evaluateJavaScript(js, in: nil, in: .defaultClient) { reply($0) }
                    } as? NSNumber
                    if (idle?.doubleValue ?? 0) >= 500 && ProcessInfo.processInfo.systemUptime - began >= 0.5 { return true }
                } catch { /* A navigation can destroy the JS context between these calls. */ }
            }
        }
        return false
    }

    private func targetPoint(_ args: [String: Any], in tab: BrowserTab) async throws -> CGPoint {
        guard let ref = args["ref"] as? String else { throw CapError("需要 snapshot 里的 ref") }
        _ = try await script(BrowserScripts.install, in: tab)
        let value = try await evaluate { reply in
            tab.webView.callAsyncJavaScript(BrowserScripts.target, arguments: ["ref": ref], in: nil, in: .defaultClient) { result in
                reply(result)
            }
        }
        guard let rect = value as? [String: NSNumber],
              let x = rect["x"]?.doubleValue, let y = rect["y"]?.doubleValue,
              let width = rect["width"]?.doubleValue, let height = rect["height"]?.doubleValue,
              let viewportWidth = rect["viewportWidth"]?.doubleValue, let viewportHeight = rect["viewportHeight"]?.doubleValue,
              viewportWidth > 0, viewportHeight > 0 else { throw CapError("无法取得元素位置，请重新 snapshot") }
        let view = tab.webView
        let marginX = min(3, width / 4), marginY = min(3, height / 4)
        let px = Double.random(in: (x + marginX)...(x + width - marginX))
        let py = Double.random(in: (y + marginY)...(y + height - marginY))
        let localX = view.bounds.minX + px / viewportWidth * view.bounds.width
        let topY = py / viewportHeight * view.bounds.height
        let localY = view.isFlipped ? view.bounds.minY + topY : view.bounds.maxY - topY
        return view.convert(CGPoint(x: localX, y: localY), to: nil)
    }

    private func click(_ target: CGPoint, in tab: BrowserTab) async throws {
        guard let window = browserWindow else { throw CapError("浏览器窗口已关闭") }
        let view = tab.webView
        let start = tab.lastPointer ?? view.convert(CGPoint(x: view.bounds.midX, y: view.bounds.midY), to: nil)
        // The point is already random within the element; zero landing error keeps tiny controls clickable.
        let path = PointerMotion.path(from: start, to: target, seed: .random(in: .min ... .max), jitterRadius: 0)
        for sample in path.dropFirst() {
            try await Task.sleep(nanoseconds: UInt64(sample.delay * 1_000_000_000))
            try mouse(.mouseMoved, point: sample.point, window: window)
        }
        tab.lastPointer = target
        try mouse(.leftMouseDown, point: target, window: window)
        do { try await Task.sleep(nanoseconds: UInt64.random(in: 45_000_000...90_000_000)) }
        catch { try? mouse(.leftMouseUp, point: target, window: window); throw error }
        try mouse(.leftMouseUp, point: target, window: window)
    }

    private func mouse(_ type: NSEvent.EventType, point: CGPoint, window: NSWindow) throws {
        eventNumber += 1
        guard let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
                                            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                            context: nil, eventNumber: eventNumber, clickCount: type == .mouseMoved ? 0 : 1,
                                            pressure: type == .leftMouseDown ? 1 : 0) else { throw CapError("无法创建浏览器鼠标事件") }
        // Dispatch to the hit WebKit responder: NSWindow may consume the first click of a non-key window.
        guard let responder = window.contentView?.hitTest(point) else { throw CapError("浏览器点击落在窗口之外") }
        switch type {
        case .mouseMoved: responder.mouseMoved(with: event)
        case .leftMouseDown:
            window.makeFirstResponder(responder)
            responder.mouseDown(with: event)
        case .leftMouseUp: responder.mouseUp(with: event)
        default: window.sendEvent(event)
        }
    }

    private func sendKey(_ text: String, to tab: BrowserTab, keyCode: UInt16? = nil) throws {
        guard let window = browserWindow else { throw CapError("浏览器窗口已关闭") }
        let code = keyCode ?? NativeKey.code(text) ?? 0
        for type in [NSEvent.EventType.keyDown, .keyUp] {
            guard let event = NSEvent.keyEvent(with: type, location: tab.lastPointer ?? .zero, modifierFlags: [],
                                              timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                              context: nil, characters: text, charactersIgnoringModifiers: text, isARepeat: false, keyCode: code) else {
                throw CapError("无法创建浏览器键盘事件")
            }
            if type == .keyDown { window.firstResponder?.keyDown(with: event) }
            else { window.firstResponder?.keyUp(with: event) }
        }
    }

    @objc private func back() { tabs.first { $0.id == selected }?.webView.goBack() }
    @objc private func forward() { tabs.first { $0.id == selected }?.webView.goForward() }
    @objc private func reload() { tabs.first { $0.id == selected }?.webView.reload() }
    @objc private func navigate() {
        let raw = address.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let string = raw.contains("://") || raw == "about:blank" ? raw : "https://" + raw
        guard let url = URL(string: string), allowed(url), let tab = tabs.first(where: { $0.id == selected }) else { return }
        load(url, into: tab.webView)
    }
    @objc private func addBlank() { Task { _ = try? await newTab() } }
    @objc private func chooseTab(_ sender: NSButton) {
        if let tab = tabs.first(where: { $0.id == sender.identifier?.rawValue }) { select(tab) }
    }
    @objc private func closeTab(_ sender: NSButton) {
        if let tab = tabs.first(where: { $0.id == sender.identifier?.rawValue }) { close(tab) }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        tabs.first { $0.webView === webView }?.navigationError = nil
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { tabs.first { $0.webView === webView }?.navigationError = error.localizedDescription }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        tabs.first { $0.webView === webView }?.navigationError = error.localizedDescription
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(navigationAction.request.url.map(allowed) == true ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url, allowed(url) else { return nil }
        let tab = addTab(configuration)
        tab.webView.customUserAgent = webView.customUserAgent
        return tab.webView
    }
    func webViewDidClose(_ webView: WKWebView) {
        if let tab = tabs.first(where: { $0.webView === webView }) { close(tab) }
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        guard visible, let window = browserWindow else { completionHandler(); return }
        let alert = NSAlert(); alert.messageText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        guard visible, let window = browserWindow else { completionHandler(false); return }
        let alert = NSAlert(); alert.messageText = message; alert.addButton(withTitle: "确定"); alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }
}

@MainActor
private final class BrowserScriptReply {
    private var continuation: CheckedContinuation<Any, Error>?
    init(_ continuation: CheckedContinuation<Any, Error>) { self.continuation = continuation }
    func finish(_ result: Result<Any, Error>) {
        guard let continuation else { return }
        self.continuation = nil
        continuation.resume(with: result)
    }
}
