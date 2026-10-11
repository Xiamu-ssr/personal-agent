import AppKit
import SwiftUI

/// The production NSStatusItem/NSPopover, never a substitute menu-shaped window.
@MainActor
enum LocalMenuReview {
    static func run() async throws {
        try check(LocalVerification.openMenuOnLaunch, "menu review requires explicit loopback and --open-menu-on-launch")
        Session.shared.configured = true; Session.shared.onboarded = true
        let chat = ChatClient.shared; chat.start()
        defer { chat.stop(); MenuController.shared.close() }
        for _ in 0..<100 where !chat.connected { try await V04Review.pause(30) }
        try check(chat.connected, "menu connected to loopback websocket")
        try await V04Review.scenario("idle")
        let menu = MenuController.shared; menu.install(); menu.button?.performClick(nil)
        try await V04Review.pause(300); try check(menu.popover.isShown, "performClick opens real popover")
        guard let root = menu.popover.contentViewController?.view, let editor = V04Review.input(root) else { throw VerificationError(description: "real menu native composer") }
        try V04Review.capture(root, "30-menu-open")
        editor.window?.makeFirstResponder(editor)
        editor.insertText("菜单栏本地验收消息。", replacementRange: NSRange(location: 0, length: editor.string.utf16.count))
        try await V04Review.pause(100)
        let enter = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: editor.window!.windowNumber, context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36)!
        editor.keyDown(with: enter); try await V04Review.pause(1500)
        try check(chat.items.contains { $0.kind == .user && $0.text == "菜单栏本地验收消息。" && !$0.pending } && chat.items.last?.kind == .assistant && !chat.busy, "Return sends and renders reply")
        try V04Review.capture(root, "31-menu-reply")
        let main = V04Review.window(); AppDelegate.openMain = { main.makeKeyAndOrderFront(nil) }
        func pressHeader(_ label: String) throws {
            func find(_ view: NSView) -> NSButton? {
                if let button = view as? NSButton, button.accessibilityLabel() == label { return button }
                return view.subviews.compactMap(find).first
            }
            guard let button = find(root) else { throw VerificationError(description: "popover action: " + label) }
            button.performClick(nil)
        }
        try pressHeader("打开主窗口"); try await V04Review.pause(500)
        try check(main.isVisible && !menu.popover.isShown, "open main closes popover")
        try V04Review.capture(main.contentView!, "32-menu-opened-main")
        menu.button?.performClick(nil); try await V04Review.pause(200)
        try check(menu.popover.isShown, "same popover reopens"); try V04Review.capture(root, "33-menu-before-quit")
        print("PASS: real status-item click path, native Return/reply and shared main window; invoking menu Quit"); fflush(stdout)
        try pressHeader("退出豆豆")
        try await V04Review.pause(1000)
        throw VerificationError(description: "menu Quit did not terminate the owned test process")
    }
}
