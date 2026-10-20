import AppKit
import SwiftUI

/// Render production views with isolated preferences and a synthetic HTTP transport.
@main struct V15Review {
    static var window: NSWindow!
    static let output = URL(fileURLWithPath: ProcessInfo.processInfo.environment["DOUDOU_REVIEW_OUTPUT"] ?? "/tmp/doudou-v150/mac-shots")
    @MainActor static func main() {
        NSApplication.shared.setActivationPolicy(.regular)
        Task { @MainActor in
            do { try await run(); window.close(); print("PASS: console and local connector UI, ownership persists"); exit(0) }
            catch { print("FAIL: \(error)"); exit(1) }
        }
        NSApplication.shared.run()
    }
    static func pause() async throws { try await Task.sleep(nanoseconds: 800_000_000) }
    @MainActor static func shot(_ name: String) throws {
        let view = window.contentView!
        view.layoutSubtreeIfNeeded()
        let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds)!
        view.cacheDisplay(in: view.bounds, to: bitmap)
        try bitmap.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent(name + ".png"))
    }
    @MainActor static func run() async throws {
        precondition(LocalVerification.explicitLoopback && Prefs.isolatedRoot != nil)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        Prefs.deviceName = "验收 Mac"; Prefs.deviceRole = "owner"; Prefs.notifyMessages = false
        AppearanceStore.shared.select(.light)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockTransport.self]; Api.session = URLSession(configuration: config)
        MockTransport.respond = { request in
            switch request.url!.path {
            case "/api/activities": return (200, ["running": [], "recent": []])
            case "/api/connectors": return (200, ["cloud": ["online": true, "installed": [], "catalog": []], "devices": []])
            default: return (200, ["items": []])
            }
        }
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 860, height: 1000), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.title = "豆豆 · 界面验收"
        window.contentView = NSHostingView(rootView: ConsoleView())
        window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        try await pause(); try shot("console")
        window.contentView = NSHostingView(rootView: ConnectorsPage(initialTab: 0, focus: nil)
            .frame(width: 860, height: 1000).background(Theme.background).foregroundStyle(Theme.ink).preferredColorScheme(Theme.scheme))
        try await pause(); try shot("local-connector")
        guard let marker = VerificationActionAnchor.views.object(forKey: "device-owner-agent"), marker.window === window else { throw CocoaError(.coderValueNotFound) }
        marker.scrollToVisible(marker.bounds)
        try await pause()
        let point = marker.convert(NSPoint(x: marker.bounds.midX, y: marker.bounds.midY), to: nil)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            NSApp.postEvent(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0)!, atStart: false)
        }
        try await pause()
        guard Prefs.deviceRole == "agent" else { throw CocoaError(.validationMissingMandatoryProperty) }
        try shot("local-connector-agent")
    }
}
