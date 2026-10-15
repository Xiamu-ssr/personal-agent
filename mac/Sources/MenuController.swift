import AppKit
import Observation
import SwiftUI

enum LocalVerification {
    /// The launch shortcut is ignored unless an explicit command-line server is loopback.
    static var explicitLoopback: Bool {
        let args = CommandLine.arguments
        guard let i = args.firstIndex(of: "-server"), args.indices.contains(i + 1),
              let url = URL(string: args[i + 1]), url.scheme == "http",
              ["127.0.0.1", "localhost", "::1"].contains(url.host ?? "") else { return false }
        return Prefs.isolatedRoot != nil && Prefs.server == args[i + 1].trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }
    static var openMenuOnLaunch: Bool { explicitLoopback && CommandLine.arguments.contains("--open-menu-on-launch") }
}

/// Production status item. Real clicks and the loopback launch shortcut share this action.
@MainActor
final class MenuController: NSObject {
    static let shared = MenuController()
    private var statusItem: NSStatusItem?
    let popover = NSPopover()
    var button: NSStatusBarButton? { statusItem?.button }

    func install() {
        guard statusItem == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem = item
        item.button?.target = self
        item.button?.action = #selector(toggle(_:))
        item.button?.toolTip = "豆豆"
        item.button?.setAccessibilityLabel("豆豆菜单栏")
        popover.behavior = .transient
        popover.contentSize = NSSize(width: 380, height: 540)
        popover.contentViewController = NSHostingController(rootView: MenuView())
        updateIcon()
    }

    private func updateIcon() {
        withObservationTracking {
            let chat = ChatClient.shared
            let symbol = chat.busy ? "ellipsis.bubble.fill" : chat.connected ? "bubble.left.fill" : "bubble.left"
            let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "豆豆")
            image?.isTemplate = true
            button?.image = image
        } onChange: { [weak self] in
            DispatchQueue.main.async { self?.updateIcon() }
        }
    }

    @objc private func toggle(_ sender: Any?) {
        if popover.isShown { close(); return }
        guard let button else { return }
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        NSApp.activate(ignoringOtherApps: true)
        popover.contentViewController?.view.window?.makeKey()
    }

    func close() { popover.performClose(nil) }
}
