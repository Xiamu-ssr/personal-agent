// Only linked by caps-test.sh. There is no network, cloud session or real message notification.
import Foundation

final class Socket {
    static var sent: [[String: Any]] = []
    var onOpen: (() -> Void)?
    var onMessage: (([String: Any]) -> Void)?
    var onClose: ((String?) -> Void)?
    init(role: String) {}
    func start() { onOpen?() }
    func stop() {}
    func send(_ value: [String: Any]) -> Bool { Self.sent.append(value); return true }
}

final class ChatClient {
    static let shared = ChatClient()
    var devicesVersion = 0
}
