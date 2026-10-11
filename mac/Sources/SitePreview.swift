import AppKit
import SwiftUI
import WebKit

struct SitePreview {
    var image: NSImage?
    var title: String
    var description = ""
}

/// Only invisible mobile-width WebViews generate thumbnails. Cache includes server, path and mtime; sign-out clears it.
@MainActor
final class SitePreviewCache {
    static let shared = SitePreviewCache()
    private var cache: [String: (SitePreview, Date)] = [:]
    private var inFlight: [String: Task<SitePreview, Never>] = [:]
    private var generation = 0

    static func key(path: String, mtime: Date) -> String { Prefs.server + "|" + path + "|" + String(mtime.timeIntervalSince1970) }

    func preview(path: String, mtime: Date, fallback: String) async -> SitePreview {
        let key = Self.key(path: path, mtime: mtime)
        if let (value, date) = cache[key], value.image != nil || Date().timeIntervalSince(date) < 30 { return value }
        if let task = inFlight[key] { return await task.value }
        let version = generation
        let task = Task { await SiteSnapshot.capture(path: path, fallback: fallback) }
        inFlight[key] = task
        let result = await task.value
        guard version == generation else { return result }
        inFlight[key] = nil
        if cache.count >= 24, let oldest = cache.min(by: { $0.value.1 < $1.value.1 })?.key { cache[oldest] = nil }
        cache[key] = (result, Date())
        return result
    }

    func clear() {
        generation += 1
        for task in inFlight.values { task.cancel() }
        inFlight = [:]; cache = [:]
    }
}

@MainActor
private final class SiteSnapshot: NSObject, WKNavigationDelegate {
    private let web: WKWebView
    private let host: NSWindow
    private var continuation: CheckedContinuation<SitePreview, Never>?
    private var timeout: Task<Void, Never>?
    private var snapshotTask: Task<Void, Never>?
    private var fallback: String

    init(fallback: String) {
        self.fallback = fallback
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 390, height: 620), configuration: config)
        host = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 390, height: 620),
                        styleMask: [.borderless], backing: .buffered, defer: false)
        super.init()
        host.isReleasedWhenClosed = false
        host.contentView = web
        host.alphaValue = 0
        web.navigationDelegate = self
    }

    static func capture(path: String, fallback: String) async -> SitePreview {
        let shot = SiteSnapshot(fallback: fallback)
        do {
            let cookies = try await Api.webCookies()
            try Task.checkCancellation()
            for cookie in cookies { await shot.web.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) }
            guard let url = Api.fileURL(path) else { return SitePreview(title: fallback) }
            return await withCheckedContinuation { continuation in
                shot.continuation = continuation
                shot.timeout = Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 8_000_000_000)
                    if !Task.isCancelled { shot.finish(SitePreview(title: fallback)) }
                }
                var request = URLRequest(url: url, timeoutInterval: 7)
                if !Api.authToken.isEmpty { request.setValue("Bearer \(Api.authToken)", forHTTPHeaderField: "Authorization") }
                shot.host.orderFront(nil)
                shot.web.load(request)
            }
        } catch { return SitePreview(title: fallback) }
    }

    private func finish(_ result: SitePreview) {
        guard let continuation else { return }
        self.continuation = nil
        timeout?.cancel(); snapshotTask?.cancel()
        web.stopLoading(); web.navigationDelegate = nil; host.close()
        continuation.resume(returning: result)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        snapshotTask = Task { @MainActor in
            let metadata = (try? await webView.evaluateJavaScript("({title:document.title,description:document.querySelector('meta[name=description]')?.content || ''})")) as? [String: String] ?? [:]
            let title = metadata["title"].flatMap { $0.isEmpty ? nil : $0 } ?? fallback
            try? await Task.sleep(nanoseconds: 350_000_000)
            guard !Task.isCancelled, continuation != nil else { return }
            let config = WKSnapshotConfiguration()
            config.rect = CGRect(x: 0, y: 0, width: 390, height: 620)
            config.snapshotWidth = 390
            let image = try? await webView.takeSnapshot(configuration: config)
            finish(SitePreview(image: image, title: title, description: metadata["description"] ?? ""))
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if let http = response.response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            decisionHandler(.cancel); finish(SitePreview(title: fallback))
        } else { decisionHandler(.allow) }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url, let base = URL(string: Prefs.server),
              url.scheme == base.scheme, url.host == base.host, url.port == base.port,
              url.path.hasPrefix(base.path + "/files/") else { decisionHandler(.cancel); finish(SitePreview(title: fallback)); return }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(SitePreview(title: fallback)) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(SitePreview(title: fallback)) }
}

struct SiteCard: View {
    let entry: TreeEntry
    @State private var preview: SitePreview?
    private var chat: ChatClient { .shared }
    private var path: String { "data/sites/" + entry.name + (entry.dir ? "/index.html" : "") }

    var body: some View {
        Button { Nav.shared.push(.web(title: preview?.title ?? entry.name, path: path)) } label: {
            VStack(alignment: .leading, spacing: 0) {
                GeometryReader { geometry in
                    if let image = preview?.image {
                        Image(nsImage: image).resizable().scaledToFill()
                            .frame(width: geometry.size.width, height: geometry.size.height, alignment: .top).clipped()
                    } else {
                        ZStack {
                            LinearGradient(colors: [Color(hex: 0xBDCEDE), Color(hex: 0xEAF0F5), Color(hex: 0xE8DABD)], startPoint: .topLeading, endPoint: .bottomTrailing)
                            Text(String((preview?.title ?? entry.name).prefix(1))).font(.system(size: 48, weight: .light)).foregroundStyle(.white.opacity(0.9))
                        }
                    }
                }.frame(height: 190).clipped()
                VStack(alignment: .leading, spacing: 7) {
                    Text(preview?.title ?? entry.name).font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                    Text(preview?.description.isEmpty == false ? preview!.description : " ").font(.system(size: 12)).foregroundStyle(Theme.sub).lineLimit(1)
                    Text("更新于 " + Fmt.when(entry.mtime)).font(.system(size: 11.5)).foregroundStyle(Theme.faint)
                }.padding(18)
            }
            .background(Theme.card).clipShape(RoundedRectangle(cornerRadius: 22))
            .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(.white.opacity(0.9), lineWidth: 1))
            .contentShape(Rectangle())
        }.buttonStyle(.plain)
        .task(id: SitePreviewCache.key(path: path, mtime: entry.mtime) + "|\(chat.filesVersion)") {
            var mtime = entry.mtime
            if entry.dir, let index = try? await Api.tree("data/sites/" + entry.name).first(where: { $0.name == "index.html" }) { mtime = index.mtime }
            preview = await SitePreviewCache.shared.preview(path: path, mtime: mtime, fallback: entry.name)
        }
    }
}
