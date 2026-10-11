import AppKit
import SwiftUI

/// The real MenuView in an owned native test window, with the same live loopback socket as the packaged app.
@MainActor
enum LocalMenuReview {
    static func run() async throws {
        guard let url = URL(string: Prefs.server), ["127.0.0.1", "localhost", "::1"].contains(url.host ?? "") else {
            throw VerificationError(description: "local menu review requires a loopback server argument")
        }
        let output = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent("verification/v0.3.0/screenshots")
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 380, height: 540),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "豆豆 · 菜单栏布局 · 本地验收"
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: MenuView())
        window.center(); window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        let chat = ChatClient.shared
        chat.start()
        defer { chat.stop(); window.close() }
        for _ in 0..<100 where !chat.connected { try await Task.sleep(nanoseconds: 20_000_000) }
        try check(chat.connected, "menu review connected to fake socket")

        func capture(_ name: String) throws {
            guard let view = window.contentView else { throw VerificationError(description: "local menu content") }
            view.layoutSubtreeIfNeeded()
            guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { throw VerificationError(description: "local menu snapshot") }
            view.cacheDisplay(in: view.bounds, to: bitmap)
            guard let rendered = bitmap.representation(using: .png, properties: [:]) else { throw VerificationError(description: "local menu rendered snapshot") }
            try rendered.write(to: output.appendingPathComponent(name + ".png"))
        }
        func input(_ root: NSView) -> ComposerTextView? {
            if let editor = root as? ComposerTextView, editor.isEditable { return editor }
            return root.subviews.compactMap(input).first
        }
        _ = try await Api.json("/verify/scenario?name=queue")
        try await Task.sleep(nanoseconds: 650_000_000)
        guard let root = window.contentView, let editor = input(root) else { throw VerificationError(description: "menu native input") }
        try check(editor.isEditable && chat.busyReason == "task_result", "menu input remains editable during native task-result turn")
        window.makeFirstResponder(editor)
        editor.insertText("菜单栏里也可以继续排队。", replacementRange: NSRange(location: 0, length: editor.string.utf16.count))
        try await Task.sleep(nanoseconds: 100_000_000)
        let enter = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
                                    windowNumber: window.windowNumber, context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36)!
        editor.keyDown(with: enter)
        try await Task.sleep(nanoseconds: 350_000_000)
        try check(chat.items.contains { $0.text == "菜单栏里也可以继续排队。" && $0.queued && !$0.pending }, "menu Return sends to fake service and retains queue state after echo")
        try capture("05-menu-queue-task-result")
        _ = try await Api.json("/verify/scenario?name=schedule")
        try await Task.sleep(nanoseconds: 350_000_000)
        try check(chat.busyReason == "schedule" && chat.items.contains { $0.kind == .schedule }, "menu renders alarm and schedule status")
        try capture("06-menu-schedule-alarm")
        print("PASS: native production MenuView, editable busy input, Return sending and echo, queue/task-result/schedule screenshots (loopback only)")
    }
}
