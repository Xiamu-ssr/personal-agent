import SwiftUI
import WebKit

/// Sites share the server's /api/login cookie, including all relative resources.
struct WebPage: NSViewRepresentable {
    let path: String
    @Binding var loading: Bool
    @Binding var failed: String

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.setValue(false, forKey: "drawsBackground")
        context.coordinator.load(web, path)
        return web
    }

    func updateNSView(_ web: WKWebView, context: Context) {
        context.coordinator.parent = self
        if context.coordinator.path != path { context.coordinator.load(web, path) }
    }

    static func dismantleNSView(_ web: WKWebView, coordinator: Coordinator) {
        coordinator.work?.cancel()
        web.stopLoading()
    }

    /// Directories must have a trailing slash so scripts, styles and images resolve inside them.
    static func resourcePath(_ path: String) -> String {
        (path as NSString).pathExtension.isEmpty && !path.hasSuffix("/") ? path + "/" : path
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var parent: WebPage
        var path = ""
        var work: Task<Void, Never>?

        init(_ parent: WebPage) { self.parent = parent }

        func load(_ web: WKWebView, _ path: String) {
            work?.cancel()
            self.path = path
            work = Task { @MainActor [weak self, weak web] in
                guard let self, let web else { return }
                parent.loading = true
                parent.failed = ""
                do {
                    let cookies = try await Api.webCookies()
                    try Task.checkCancellation()
                    for cookie in cookies {
                        await web.configuration.websiteDataStore.httpCookieStore.setCookie(cookie)
                    }
                    try Task.checkCancellation()
                    guard let url = Api.fileURL(WebPage.resourcePath(path)) else { throw ApiError(code: 0, message: "文件地址不对") }
                    var req = URLRequest(url: url)
                    req.setValue("Bearer \(Api.authToken)", forHTTPHeaderField: "Authorization")
                    _ = web.load(req)
                } catch is CancellationError {
                } catch {
                    parent.loading = false
                    parent.failed = error.localizedDescription
                }
            }
        }

        private func inside(_ url: URL) -> Bool {
            guard let base = URL(string: Prefs.server), url.scheme == base.scheme,
                  url.host == base.host, url.port == base.port else { return false }
            return url.path == base.path || url.path.hasPrefix(base.path + "/")
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { return decisionHandler(.cancel) }
            if url.absoluteString == "about:blank" || inside(url) { return decisionHandler(.allow) }
            if ["http", "https"].contains(url.scheme?.lowercased() ?? "") { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url, inside(url) { webView.load(action.request) }
            return nil
        }

        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                     decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            if let http = response.response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                parent.loading = false
                parent.failed = "HTTP \(http.statusCode)"
                return decisionHandler(.cancel)
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            parent.loading = true
            parent.failed = ""
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { parent.loading = false }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail(error) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail(error) }

        private func fail(_ error: Error) {
            guard (error as NSError).code != NSURLErrorCancelled else { return }
            parent.loading = false
            parent.failed = error.localizedDescription
        }
    }
}
