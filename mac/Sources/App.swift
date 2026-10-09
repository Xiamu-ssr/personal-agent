import AppKit
import SwiftUI
import UserNotifications

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    /// Set by any SwiftUI view that has `openWindow`, so the Dock icon and notifications can bring the window back.
    static var openMain: (() -> Void)?

    private var pasteMonitor: Any?

    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = self
        if Prefs.configured {
            ChatClient.shared.start()
            DeviceClient.shared.start()
        }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { _ in
            guard Prefs.configured else { return }
            ChatClient.shared.reconnect()
            DeviceClient.shared.reregister()
        }
        // ⌘V with a picture or copied files goes into the composer as an attachment.
        pasteMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { e in
            guard e.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command, e.charactersIgnoringModifiers == "v",
                  !(e.window is NSPanel), Session.shared.configured, Nav.shared.tab.prompt != nil,
                  Nav.shared.stacks[Nav.shared.tab]?.isEmpty ?? true else { return e }
            return Composer.shared.paste() ? nil : e
        }
    }

    /// Closing the window keeps 豆豆 in the menu bar.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        if !hasVisibleWindows { showMain() }
        return true
    }

    private func showMain() {
        if let w = NSApp.windows.first(where: { $0.identifier?.rawValue == "main" || $0.identifier?.rawValue.hasPrefix("main") == true }) {
            w.makeKeyAndOrderFront(nil)
        } else {
            Self.openMain?()
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .sound])
    }

    /// Clicking a notification opens the chat.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        DispatchQueue.main.async {
            Nav.shared.tab = .chat
            Nav.shared.stacks[.chat] = []
            self.showMain()
        }
        done()
    }
}

#if !MAC_VERIFY
@main
struct DoudouApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    init() {
        Prefs.migrate()
    }

    var body: some Scene {
        Window("豆豆", id: "main") {
            MainView()
        }
        .defaultSize(width: 1100, height: 760)
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(replacing: .newItem) {}
        }

        MenuBarExtra {
            MenuView()
        } label: {
            MenuIcon()
        }
        .menuBarExtraStyle(.window)
    }
}

#endif

struct MenuIcon: View {
    private var chat: ChatClient { .shared }

    var body: some View {
        Image(systemName: chat.busy ? "ellipsis.bubble.fill" : (chat.connected ? "bubble.left.fill" : "bubble.left"))
    }
}
