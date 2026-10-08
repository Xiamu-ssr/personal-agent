import AppKit
import SwiftUI
import UserNotifications

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = self
        ChatClient.shared.start()
        DeviceClient.shared.start()
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { _ in
            ChatClient.shared.reconnect()
            DeviceClient.shared.reregister()
        }
    }

    // Menu-bar apps count as foreground; still show banners.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .sound])
    }
}

@main
struct DoudouApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        MenuBarExtra {
            MenuView()
        } label: {
            MenuIcon()
        }
        .menuBarExtraStyle(.window)

        Window("豆豆设置", id: "settings") {
            SettingsView()
        }
        .windowResizability(.contentSize)
    }
}

struct MenuIcon: View {
    private var chat: ChatClient { .shared }

    var body: some View {
        Image(systemName: chat.busy ? "ellipsis.bubble.fill" : (chat.connected ? "bubble.left.fill" : "bubble.left"))
    }
}
