import Foundation
import Observation

struct ChatItem: Identifiable {
    enum Kind { case user, assistant, card, note }
    let id = UUID()
    let kind: Kind
    let text: String
    var path: String? = nil
}

/// The menu-bar chat's live connection to the main thread (WS role=app).
@Observable
final class ChatClient {
    static let shared = ChatClient()

    var items: [ChatItem] = []
    var streaming = ""
    var busy = false
    var connected = false
    var toolHint = ""
    var devices: [String] = []
    var error = ""
    var configured = Prefs.configured

    @ObservationIgnored private let socket = Socket(role: "app")

    private init() {
        socket.onOpen = { [weak self] in
            self?.connected = true
            self?.error = ""
        }
        socket.onMessage = { [weak self] in self?.handle($0) }
        socket.onClose = { [weak self] why in
            self?.connected = false
            if let why { self?.error = why }
        }
    }

    func start() {
        configured = Prefs.configured
        socket.start()
    }

    func reconnect() {
        configured = Prefs.configured
        socket.restart()
    }

    func send(_ text: String) {
        if !socket.send(["t": "send", "text": text]) { error = "还没连上，稍等再发" }
    }

    func interrupt() {
        socket.send(["t": "interrupt"])
    }

    private static func str(_ v: Any?) -> String { v as? String ?? "" }

    private static func names(_ v: Any?) -> [String] {
        (v as? [[String: Any]] ?? []).map { str($0["name"]) }
    }

    private static func item(_ h: [String: Any]) -> ChatItem? {
        switch str(h["role"]) {
        case "user": return ChatItem(kind: .user, text: str(h["text"]))
        case "assistant": return ChatItem(kind: .assistant, text: str(h["text"]))
        case "card": return ChatItem(kind: .card, text: str(h["title"]), path: (h["outputs"] as? [String])?.first)
        default: return nil
        }
    }

    private func add(_ item: ChatItem) {
        items.append(item)
        if items.count > 300 { items.removeFirst(items.count - 300) }
    }

    private func handle(_ m: [String: Any]) {
        switch Self.str(m["t"]) {
        case "hello":
            items = (m["history"] as? [[String: Any]] ?? []).compactMap(Self.item)
            busy = m["busy"] as? Bool ?? false
            devices = Self.names(m["devices"])
        case "user":
            // Our own message echoes back; messages from other clients are added here too.
            let text = Self.str(m["text"])
            if !(items.last?.kind == .user && items.last?.text == text) { add(ChatItem(kind: .user, text: text)) }
        case "status":
            busy = m["busy"] as? Bool ?? false
        case "delta":
            streaming += Self.str(m["text"])
            toolHint = ""
        case "tool":
            toolHint = Self.toolLabel(Self.str(m["name"]), Self.str(m["hint"]))
            // Text before a tool call is a finished paragraph; keep it visible.
            if !streaming.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { streaming += "\n\n" }
        case "turn_end":
            let text = Self.str(m["text"])
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { add(ChatItem(kind: .assistant, text: text)) }
            if let err = m["error"] { add(ChatItem(kind: .note, text: "这一轮出错了：\(err)")) }
            streaming = ""
            toolHint = ""
            busy = false
        case "memory_updated":
            if !(items.last?.kind == .note && items.last?.text == "记忆已更新") { add(ChatItem(kind: .note, text: "记忆已更新")) }
        case "devices":
            devices = Self.names(m["devices"])
        case "job":
            if Self.str(m["phase"]) == "done", let out = (m["outputs"] as? [String])?.first {
                add(ChatItem(kind: .card, text: Self.str(m["title"]), path: out))
            }
        default:
            break
        }
    }

    private static func toolLabel(_ name: String, _ hint: String) -> String {
        switch name {
        case "Read" where hint.contains("总档"): return "在翻总档"
        case "Read", "Grep", "Glob": return "在翻资料"
        case "Write", "Edit": return hint.contains("memory") ? "在记下来" : "在写文件"
        case "Bash": return "在跑命令"
        case "WebSearch", "WebFetch": return "在查网上的"
        case "Agent", "Task": return "派了个子任务"
        case _ where name.hasPrefix("mcp__devices__"): return "在用你的设备"
        case _ where name.hasPrefix("mcp__"): return "在用连接器"
        default: return "在忙"
        }
    }
}
