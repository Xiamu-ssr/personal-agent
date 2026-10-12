import SwiftUI
import WebKit

enum BriefNavigation {
    static func prompt(_ url: URL) -> String? {
        guard url.scheme?.lowercased() == "doudou", url.host == "prompt", url.path.isEmpty,
              url.user == nil, url.password == nil, url.port == nil,
              let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              query.count == 1, query[0].name == "text", let text = query[0].value,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return text
    }
}

@MainActor
enum BriefSandbox {
    static let rules = #"[{"trigger":{"url-filter":".*"},"action":{"type":"block"}},{"trigger":{"url-filter":"^data:"},"action":{"type":"ignore-previous-rules"}},{"trigger":{"url-filter":"^about:blank$"},"action":{"type":"ignore-previous-rules"}}]"#
    // Install before parsing. Inline CSS/JS, SVG and data images still work.
    static let isolationScript = #"""
    (() => {
      const meta = document.createElement('meta');
      meta.httpEquiv = 'Content-Security-Policy';
      meta.content = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
      (document.head || document.documentElement).prepend(meta);
    })();
    """#
    static func skinScript(_ skin: Skin) -> String {
        """
        (() => {
          const apply = () => {
            if (!document.documentElement) return false;
            document.documentElement.dataset.skin = '\(skin.rawValue)';
            const style = document.createElement('style');
            style.textContent = 'html,body{overflow:clip!important;overscroll-behavior:none!important}::-webkit-scrollbar{display:none!important}';
            document.documentElement.prepend(style);
            return true;
          };
          if (!apply()) { const watch = new MutationObserver(() => { if (apply()) watch.disconnect(); }); watch.observe(document, {childList:true}); }
        })();
        """
    }
    static let measureScript = #"""
    (() => {
      let pending = false;
      let lastHeight = 0;
      const measure = () => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
          pending = false;
          const height = Math.ceil(document.documentElement.scrollHeight);
          if (height !== lastHeight) {
            lastHeight = height;
            window.webkit.messageHandlers.briefHeight.postMessage(height);
          }
        });
      };
      new ResizeObserver(measure).observe(document.body);
      document.fonts.ready.then(measure);
      window.addEventListener('resize', measure);
      measure();
    })();
    """#
    static let store = WKWebsiteDataStore.nonPersistent()
    static let pool = WKProcessPool()
    private static var compiled: Task<WKContentRuleList, Error>?

    static func ruleList() async throws -> WKContentRuleList {
        if let compiled { return try await compiled.value }
        let task = Task<WKContentRuleList, Error> {
            try await withCheckedThrowingContinuation { continuation in
                WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "doudou-brief-offline-v05", encodedContentRuleList: rules) { rule, error in
                    if let rule { continuation.resume(returning: rule) }
                    else { continuation.resume(throwing: error ?? ApiError(code: 0, message: "简报隔离规则加载失败")) }
                }
            }
        }
        compiled = task
        do { return try await task.value } catch { compiled = nil; throw error }
    }
}

/// Load exactly cards[].html, without a server base URL or credentials.
struct BriefWebView: NSViewRepresentable {
    let html: String
    var skin: Skin = Theme.skin
    @Binding var documentHeight: CGFloat
    @Binding var loading: Bool
    @Binding var failed: String

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = BriefSandbox.store
        config.processPool = BriefSandbox.pool
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.mediaTypesRequiringUserActionForPlayback = .all
        config.userContentController.addUserScript(WKUserScript(source: BriefSandbox.skinScript(skin), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.addUserScript(WKUserScript(source: BriefSandbox.isolationScript, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        config.userContentController.addUserScript(WKUserScript(source: BriefSandbox.measureScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: .defaultClient))
        config.userContentController.add(context.coordinator, contentWorld: .defaultClient, name: "briefHeight")
        let web = BriefNativeWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.setValue(false, forKey: "drawsBackground")
        web.allowsBackForwardNavigationGestures = false
        BriefResources.created += 1
        #if MAC_PERF
        PerfProbe.shared.record("brief_created")
        #endif
        context.coordinator.installWheelMonitor(web)
        context.coordinator.load(web, html: html)
        return web
    }

    func updateNSView(_ web: WKWebView, context: Context) {
        context.coordinator.parent = self
        if context.coordinator.html != html { context.coordinator.load(web, html: html) }
        context.coordinator.applySkin(web, skin: skin)
    }

    static func dismantleNSView(_ web: WKWebView, coordinator: Coordinator) {
        BriefResources.dismantled += 1
        #if MAC_PERF
        PerfProbe.shared.record("brief_dismantled")
        #endif
        coordinator.invalidate()
        web.stopLoading()
        web.navigationDelegate = nil
        web.uiDelegate = nil
        web.configuration.userContentController.removeScriptMessageHandler(forName: "briefHeight", contentWorld: .defaultClient)
        web.configuration.userContentController.removeAllUserScripts()
        web.removeFromSuperview()
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var parent: BriefWebView
        var html = ""
        private var skin: Skin
        private var wheelMonitor: Any?
        private var rulesInstalled = false
        var work: Task<Void, Never>?
        private var initialDocument = false
        private var generation = 0
        private var invalidated = false
        private var publication: DispatchWorkItem?
        private var pendingHeight: CGFloat?
        private var pendingLoading: Bool?
        private var pendingFailure: String?
        init(_ parent: BriefWebView) { self.parent = parent; skin = parent.skin }

        func invalidate() {
            invalidated = true; generation += 1
            if let wheelMonitor { NSEvent.removeMonitor(wheelMonitor); self.wheelMonitor = nil }
            work?.cancel(); work = nil
            publication?.cancel(); publication = nil
            pendingHeight = nil; pendingLoading = nil; pendingFailure = nil
        }

        /// Coalesce WebKit callbacks, then publish in a later run-loop turn, never during native layout/update.
        private func publish(height: CGFloat? = nil, loading: Bool? = nil, failure: String? = nil) {
            guard !invalidated else { return }
            if let height { pendingHeight = height }
            if let loading { pendingLoading = loading }
            if let failure { pendingFailure = failure }
            guard publication == nil else { return }
            let current = generation
            let work = DispatchWorkItem { [weak self] in
                guard let self, !invalidated, current == generation else { return }
                publication = nil
                let height = pendingHeight, loading = pendingLoading, failure = pendingFailure
                pendingHeight = nil; pendingLoading = nil; pendingFailure = nil
                if let height, abs(parent.documentHeight - height) > 0.5 {
                    parent.documentHeight = height
                    #if MAC_PERF
                    PerfProbe.shared.record("brief_height_publish")
                    #endif
                }
                if let loading, parent.loading != loading { parent.loading = loading }
                if let failure, parent.failed != failure { parent.failed = failure }
            }
            publication = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.02, execute: work)
        }

        func load(_ web: WKWebView, html: String) {
            work?.cancel()
            publication?.cancel(); publication = nil
            pendingHeight = nil; pendingLoading = nil; pendingFailure = nil
            generation += 1
            self.html = html
            work = Task { @MainActor [weak self, weak web] in
                guard let self, let web else { return }
                publish(loading: true, failure: "")
                do {
                    let rules = try await BriefSandbox.ruleList()
                    try Task.checkCancellation()
                    if !rulesInstalled { web.configuration.userContentController.add(rules); rulesInstalled = true }
                    initialDocument = true
                    #if MAC_PERF
                    PerfProbe.shared.record("brief_load")
                    #endif
                    BriefResources.loads += 1
                    web.loadHTMLString(Self.document(html, skin: parent.skin), baseURL: nil)
                } catch is CancellationError {
                } catch {
                    publish(loading: false, failure: "简报加载失败：\(error.localizedDescription)")
                }
            }
        }

        /// Also put the attribute on the initial root tag, so styles see it on the first parse.
        static func document(_ html: String, skin: Skin) -> String {
            guard let root = html.range(of: "<html", options: .caseInsensitive), let end = html[root.upperBound...].firstIndex(of: ">") else { return html }
            var document = html
            let tag = String(html[root.lowerBound...end]).replacingOccurrences(of: #"\sdata-skin\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)"#, with: "", options: .regularExpression)
            document.replaceSubrange(root.lowerBound...end, with: String(tag.dropLast()) + " data-skin=\"\(skin.rawValue)\">")
            return document
        }
        func applySkin(_ web: WKWebView, skin: Skin) {
            guard self.skin != skin else { return }
            self.skin = skin
            web.appearance = Theme.appearance
            let controller = web.configuration.userContentController
            controller.removeAllUserScripts()
            controller.addUserScript(WKUserScript(source: BriefSandbox.skinScript(skin), injectionTime: .atDocumentStart, forMainFrameOnly: true))
            controller.addUserScript(WKUserScript(source: BriefSandbox.isolationScript, injectionTime: .atDocumentStart, forMainFrameOnly: false))
            controller.addUserScript(WKUserScript(source: BriefSandbox.measureScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: .defaultClient))
            BriefResources.skinUpdates += 1
            web.evaluateJavaScript("document.documentElement.dataset.skin = '\(skin.rawValue)'", in: nil, in: .defaultClient) { _ in }
        }
        func installWheelMonitor(_ web: WKWebView) {
            wheelMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak web] event in
                guard let web, event.window === web.window,
                      web.visibleRect.contains(web.convert(event.locationInWindow, from: nil)),
                      abs(event.scrollingDeltaY) >= abs(event.scrollingDeltaX) else { return event }
                web.enclosingScrollView?.scrollWheel(with: event)
                return nil
            }
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.frameInfo.isMainFrame, let height = message.body as? NSNumber else { return }
            setHeight(height.doubleValue)
        }

        private func setHeight(_ value: Double) {
            guard value.isFinite, value > 0 else { return }
            let height = CGFloat(ceil(value))
            publish(height: height)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            initialDocument = false
            publish(loading: false)
            let current = generation
            webView.evaluateJavaScript("document.documentElement.scrollHeight", in: nil, in: .defaultClient) { [weak self] result in
                guard let self, !invalidated, current == generation else { return }
                if case .success(let height as NSNumber) = result { setHeight(height.doubleValue) }
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { return decisionHandler(.cancel) }
            if initialDocument && action.targetFrame?.isMainFrame == true && url.absoluteString == "about:blank" {
                initialDocument = false
                return decisionHandler(.allow)
            }
            decisionHandler(.cancel)
            if action.sourceFrame.isMainFrame, let prompt = BriefNavigation.prompt(url) { Nav.shared.ask(prompt) }
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) { completionHandler() }
        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) { completionHandler(false) }
        func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) { completionHandler(nil) }
        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) { decisionHandler(.deny) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail(error) }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail(error) }
        private func fail(_ error: Error) {
            guard (error as NSError).code != NSURLErrorCancelled else { return }
            publish(loading: false, failure: "简报暂时加载不了")
        }
    }
}

/// Native fall-through also covers events forwarded by a WebKit child responder.
final class BriefNativeWebView: WKWebView {
    override func scrollWheel(with event: NSEvent) { enclosingScrollView?.scrollWheel(with: event) }
}
@MainActor enum BriefResources {
    static var created = 0
    static var dismantled = 0
    static var loads = 0
    static var skinUpdates = 0
    static var live: Int { created - dismantled }
}
