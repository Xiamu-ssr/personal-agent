import Foundation
import Observation

/// Keeps this Mac registered with the cloud body as a device (WS role=device) and answers capability calls.
@Observable
final class DeviceClient {
    static let shared = DeviceClient()

    var online = false

    @ObservationIgnored private let socket = Socket(role: "device")

    private init() {
        socket.onOpen = { [weak self] in self?.register() }
        socket.onMessage = { [weak self] m in
            if m["t"] as? String == "call" { self?.handle(m) }
        }
        socket.onClose = { [weak self] _ in self?.online = false }
    }

    func start() { socket.start() }

    /// Reconnect so the cloud sees the new name / capability list.
    func reregister() { socket.restart() }

    private func register() {
        let device: [String: Any] = [
            "id": Prefs.deviceId, "name": Prefs.deviceName, "kind": "mac",
            "capabilities": Capabilities.enabled.map(\.json),
        ]
        online = socket.send(["t": "register", "device": device])
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
                    throw CapError(name == "__read_since" ? "这台 Mac 没有可补读的数据" : "用户没有授权这个能力：\(name)")
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
