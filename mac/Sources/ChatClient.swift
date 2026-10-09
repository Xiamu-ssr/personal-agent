import Foundation
import Observation

/// A file that rides along with a user message; `path` is under data/uploads/.
struct Attachment: Hashable {
    var path: String
    var name: String
    /// image | file | voice
    var kind: String
    var transcript: String? = nil

    var json: [String: Any] { ["path": path, "name": name, "kind": kind] }

    init(path: String, name: String, kind: String, transcript: String? = nil) {
        self.path = path
        self.name = name
        self.kind = kind
        self.transcript = transcript
    }

    init(_ j: [String: Any]) {
        path = j["path"] as? String ?? ""
        name = j["name"] as? String ?? (path as NSString).lastPathComponent
        kind = j["kind"] as? String ?? "file"
        transcript = j["transcript"] as? String
    }
}

struct ChatItem: Identifiable {
    enum Kind { case user, assistant, card, note }
    var id = UUID()
    let kind: Kind
    var text: String
    var attachments: [Attachment] = []
    /// Cards: what the job produced, and its label (e.g. 晨报).
    var outputs: [String] = []
    var label = ""
    var ts: Date? = nil
    /// Sent from here, waiting for the server's echo.
    var pending = false
}

/// Something running in the background: an isolated job (晨报…) or a sub-agent task of the main thread.
struct LiveTask: Identifiable {
    let id: String
    var label: String
    var started: Date
    var detail = ""
}

/// The live connection to the main thread (WS role=app), shared by the window and the menu-bar chat.
@Observable
final class ChatClient {
    static let shared = ChatClient()

    var items: [ChatItem] = []
    var streaming = ""
    var busy = false
    var connected = false
    var toolHint = ""
    var error = ""
    var configured = Prefs.configured
    var live: [LiveTask] = []
    /// Bumped when data/ changes (memory, briefs, sites) or a job finishes, so pages reload.
    var filesVersion = 0
    var jobsVersion = 0
    var devicesVersion = 0

    @ObservationIgnored private let socket = Socket(role: "app")
    @ObservationIgnored private var historyTask: Task<Void, Never>?
    private var connectionVersion = 0

    init() {
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
        connected = false
        socket.stop()
        if configured { socket.start() }
    }

    func stop() {
        socket.stop()
        historyTask?.cancel()
        connectionVersion += 1
        jobsVersion += 1
        connected = false
        error = ""
        toolHint = ""
        configured = false
        items = []
        live = []
        streaming = ""
        busy = false
    }

    @discardableResult
    func send(_ text: String, attachments: [Attachment] = []) -> Bool {
        guard !busy else { error = "豆豆正在忙，等它完成再发"; return false }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty else { return false }
        var msg: [String: Any] = ["t": "send", "text": text]
        if !attachments.isEmpty { msg["attachments"] = attachments.map(\.json) }
        guard socket.send(msg) else {
            error = "还没连上，稍等再发"
            return false
        }
        add(ChatItem(kind: .user, text: text, attachments: attachments, ts: Date(), pending: true))
        return true
    }

    func interrupt() {
        socket.send(["t": "interrupt"])
    }

    private static func str(_ v: Any?) -> String { v as? String ?? "" }

    private static func date(_ v: Any?) -> Date? {
        (v as? Double).map { Date(timeIntervalSince1970: $0 / 1000) }
    }

    static func item(_ h: [String: Any]) -> ChatItem? {
        let atts = (h["attachments"] as? [[String: Any]] ?? []).map(Attachment.init)
        switch str(h["role"]) {
        case "user": return ChatItem(kind: .user, text: str(h["text"]), attachments: atts, ts: date(h["ts"]))
        case "assistant": return ChatItem(kind: .assistant, text: str(h["text"]), ts: date(h["ts"]))
        case "card":
            return ChatItem(kind: .card, text: str(h["title"]), outputs: h["outputs"] as? [String] ?? [], label: str(h["label"]), ts: date(h["ts"]))
        default: return nil
        }
    }

    private func add(_ item: ChatItem) {
        items.append(item)
        if items.count > 400 { items.removeFirst(items.count - 400) }
    }

    /// Reconcile a server snapshot only if no newer socket event has arrived.
    func applyJobs(_ rows: [[String: Any]], version: Int) {
        guard jobsVersion == version else { return }
        let running = rows.map {
            LiveTask(id: "job:" + Self.str($0["label"]), label: Self.str($0["label"]),
                     started: Self.date($0["started"]) ?? Date(), detail: "定时任务")
        }
        live = running + live.filter { !$0.id.hasPrefix("job:") }
    }

    private func refreshJobs() {
        let version = jobsVersion
        let connection = connectionVersion
        Task { @MainActor in
            guard let r = try? await Api.json("/api/jobs"), connection == connectionVersion else { return }
            applyJobs(r["running"] as? [[String: Any]] ?? [], version: version)
        }
    }

    /// /hello carries only 100 entries; load the specified 200 without discarding messages received during the request.
    private func refreshHistory() {
        historyTask?.cancel()
        let connection = connectionVersion
        historyTask = Task { @MainActor in
            guard let r = try? await Api.json("/api/history?n=200"), !Task.isCancelled, connection == connectionVersion else { return }
            let old = items
            var used = Set<UUID>()
            var history = (r["items"] as? [[String: Any]] ?? []).compactMap(Self.item).map { item in
                var item = item
                if let same = old.first(where: { !used.contains($0.id) && Self.same($0, item) }) {
                    item.id = same.id
                    used.insert(same.id)
                }
                return item
            }
            history += old.filter { !used.contains($0.id) }
            items = history
        }
    }

    private static func same(_ a: ChatItem, _ b: ChatItem) -> Bool {
        guard a.kind == b.kind, a.text == b.text, a.outputs == b.outputs,
              a.attachments.map(\.path) == b.attachments.map(\.path) else { return false }
        if let x = a.ts, let y = b.ts { return abs(x.timeIntervalSince(y)) < 2 }
        return a.ts == b.ts
    }

    func handle(_ m: [String: Any]) {
        switch Self.str(m["t"]) {
        case "hello":
            connectionVersion += 1
            jobsVersion += 1
            items = (m["history"] as? [[String: Any]] ?? []).compactMap(Self.item)
            busy = m["busy"] as? Bool ?? false
            streaming = ""
            toolHint = ""
            // Tasks from before the reconnect may have ended while we were away.
            live = []
            refreshJobs()
            refreshHistory()
            devicesVersion += 1
        case "user":
            let text = Self.str(m["text"])
            let atts = (m["attachments"] as? [[String: Any]] ?? []).map(Attachment.init)
            // Our own message echoes back (now with voice transcripts); others' messages are new.
            if let i = items.lastIndex(where: { $0.pending && $0.text == text && (atts.isEmpty || $0.attachments.map(\.path) == atts.map(\.path)) }) {
                items[i].pending = false
                if !atts.isEmpty { items[i].attachments = atts }
            } else {
                add(ChatItem(kind: .user, text: text, attachments: atts, ts: Date()))
            }
        case "status":
            busy = m["busy"] as? Bool ?? false
        case "delta":
            streaming += Self.str(m["text"])
            toolHint = ""
        case "tool":
            toolHint = Self.toolLabel(Self.str(m["name"]), Self.str(m["hint"]))
            // Text before a tool call is a finished paragraph; keep it visible.
            if !streaming.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !streaming.hasSuffix("\n\n") { streaming += "\n\n" }
        case "turn_end":
            let text = Self.str(m["text"])
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { add(ChatItem(kind: .assistant, text: text, ts: Date())) }
            if let err = m["error"] as? String { add(ChatItem(kind: .note, text: "这一轮出错了：\(err)")) }
            streaming = ""
            toolHint = ""
            busy = false
        case "memory_updated":
            filesVersion += 1
            if !(items.last?.kind == .note && items.last?.text == "记忆已更新") { add(ChatItem(kind: .note, text: "记忆已更新")) }
        case "files_changed":
            filesVersion += 1
        case "devices":
            devicesVersion += 1
        case "job":
            jobsVersion += 1
            let label = Self.str(m["label"])
            if Self.str(m["phase"]) == "started" {
                live.removeAll { $0.id == "job:" + label }
                live.append(LiveTask(id: "job:" + label, label: label, started: Date(), detail: "定时任务"))
            } else {
                live.removeAll { $0.id == "job:" + label }
                let outputs = m["outputs"] as? [String] ?? []
                if !outputs.isEmpty { add(ChatItem(kind: .card, text: Self.str(m["title"]), outputs: outputs, label: label, ts: Date())) }
                jobsVersion += 1
                filesVersion += 1
            }
        case "task":
            jobsVersion += 1
            let id = "task:" + Self.str(m["id"])
            let phase = Self.str(m["phase"])
            let status = Self.str(m["status"])
            let desc = Self.str(m["description"])
            if ["notification", "done", "completed", "failed", "stopped", "killed", "error"].contains(phase) || ["completed", "failed", "stopped", "killed", "error"].contains(status) {
                live.removeAll { $0.id == id }
                jobsVersion += 1
            } else if let i = live.firstIndex(where: { $0.id == id }) {
                let s = Self.str(m["summary"])
                if !s.isEmpty { live[i].detail = s }
            } else {
                live.append(LiveTask(id: id, label: desc.isEmpty ? "子任务" : desc, started: Date(), detail: "子任务"))
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
