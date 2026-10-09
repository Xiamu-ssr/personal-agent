import AppKit
import Observation
import UserNotifications

/// Keeps this Mac registered with the cloud body as a device (WS role=device), answers capability calls,
/// and turns the server's reply/job events into notifications while the app is in the background.
@Observable
final class DeviceClient {
    static let shared = DeviceClient()

    var online = false

    @ObservationIgnored private let socket = Socket(role: "device")

    private init() {
        socket.onOpen = { [weak self] in self?.register() }
        socket.onMessage = { [weak self] m in
            switch m["t"] as? String {
            case "call": self?.handle(m)
            case "event": Self.notify(kind: m["kind"] as? String ?? "", text: m["text"] as? String ?? "")
            default: break
            }
        }
        socket.onClose = { [weak self] _ in self?.online = false }
    }

    func start() { socket.start() }

    func stop() {
        socket.stop()
        online = false
    }

    /// Reconnect so the cloud sees the new name / capability switches.
    func reregister() {
        online = false
        socket.stop()
        if Prefs.configured { socket.start() }
    }

    private func register() {
        let device: [String: Any] = [
            "id": Prefs.deviceId, "name": Prefs.deviceName, "kind": "mac",
            "capabilities": Capabilities.all.map(\.json),
        ]
        online = socket.send(["t": "register", "device": device])
        ChatClient.shared.devicesVersion += 1
    }

    private static func notify(kind: String, text: String) {
        guard Prefs.notifyMessages, !NSApp.isActive, !text.isEmpty else { return }
        Task {
            guard await Capabilities.notifyAllowed() else { return }
            let c = UNMutableNotificationContent()
            c.title = kind == "job" ? "豆豆 · 任务完成" : "豆豆"
            c.body = text
            c.sound = .default
            try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
        }
    }

    private func handle(_ m: [String: Any]) {
        let id = m["id"] as? String ?? ""
        let name = m["capability"] as? String ?? ""
        let args = m["args"] as? [String: Any] ?? [:]
        let cap = Capabilities.enabled.first { $0.name == name }
        let socket = self.socket
        Task.detached {
            var reply: [String: Any] = ["t": "result", "id": id]
            do {
                guard let cap else {
                    throw CapError(name == "__read_since" ? "这台 Mac 没有可补读的数据" : "用户没有开启这个能力：\(name)")
                }
                reply["data"] = try await cap.run(args)
                reply["ok"] = true
            } catch {
                reply["ok"] = false
                reply["error"] = error.localizedDescription
            }
            let out = reply
            await MainActor.run { _ = socket.send(out) }
        }
    }
}
