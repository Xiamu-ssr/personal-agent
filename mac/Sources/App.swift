import AppKit
import SwiftUI
import UserNotifications

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    /// Set by any SwiftUI view that has `openWindow`, so the Dock icon and notifications can bring the window back.
    static var openMain: (() -> Void)?

    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = self
        MenuController.shared.install()
        if LocalVerification.explicitLoopback || Prefs.configured {
            ChatClient.shared.start()
            if !LocalVerification.explicitLoopback { DeviceClient.shared.start() }
        }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { _ in
            guard LocalVerification.explicitLoopback || Prefs.configured else { return }
            ChatClient.shared.reconnect()
            if !LocalVerification.explicitLoopback { DeviceClient.shared.reregister() }
        }
        if LocalVerification.openMenuOnLaunch {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                // Keep the local acceptance popover as the only visible app surface.
                for window in NSApp.windows where window.identifier?.rawValue.hasPrefix("main") == true { window.orderOut(nil) }
                MenuController.shared.button?.performClick(nil)
            }
        }
    }

    /// Closing the window keeps 豆豆 in the menu bar.
    func applicationDidBecomeActive(_ notification: Notification) {
        guard LocalVerification.explicitLoopback || Prefs.configured else {return}
        Task { @MainActor in await ChatClient.shared.catchUp() }
    }

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


    var body: some Scene {
        Window("豆豆", id: "main") {
            MainView()
        }
        .defaultSize(width: 1100, height: 760)
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(replacing: .newItem) {}
        }

    }
}

#endif
