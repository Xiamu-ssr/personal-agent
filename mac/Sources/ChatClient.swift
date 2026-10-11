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

struct ChatItem: Identifiable, Equatable {
    enum Kind: Equatable { case user, assistant, card, note, schedule }
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
    var queued = false
    var source = ""
    /// Server turnQueue identity, distinct from the stable local view identity.
    var serverID = ""

    var scheduleTitle: String {
        guard let start = text.range(of: "该出「"), let end = text.range(of: "」了", range: start.upperBound..<text.endIndex) else {
            return text.replacingOccurrences(of: "[定时]", with: "").components(separatedBy: "\n").first?.trimmingCharacters(in: .whitespaces) ?? "定时提醒"
        }
        return String(text[start.upperBound..<end.lowerBound]) + "时间到了"
    }
}

/// An isolated job (maintenance / legacy briefs); main-thread background tasks have their own ID list.
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
    var streamID = UUID()
    var busy = false
    var busyReason = ""
    var connected = false
    var toolHint = ""
    var error = ""
    var configured = LocalVerification.explicitLoopback || Prefs.configured
    var live: [LiveTask] = []
    private(set) var backgroundTasks: [BackgroundTask] = []
    private(set) var stoppingTasks: Set<String> = []
    var taskError = ""
    var queueNotice = ""
    private(set) var queueOperations: Set<String> = []

    var replyStatus: String {
        switch busyReason {
        case "task_result": return "豆豆正在处理子任务结果…"
        case "schedule": return "豆豆正在安排定时任务…"
        default: return toolHint.isEmpty ? "豆豆正在回复…" : "豆豆正在回复 · " + toolHint
        }
    }
    /// Bumped when data/ changes (memory, briefs, sites) or a job finishes, so pages reload.
    var filesVersion = 0
    var jobsVersion = 0
    var devicesVersion = 0

    @ObservationIgnored private let socket = Socket(role: "app")
    // Local verification supplies a recorder instead of opening a network socket.
    @ObservationIgnored private var sender: (([String: Any]) -> Bool)?
    @ObservationIgnored private var snapshotEchoes: [UUID: Date] = [:]
    @ObservationIgnored private var waitingInputs: [(id: UUID, schedule: Bool)] = []
    @ObservationIgnored private var endedTasks: Set<String> = []
    @ObservationIgnored private var endedOrder: [String] = []
    @ObservationIgnored private var historyTask: Task<Void, Never>?
    private var connectionVersion = 0
    @ObservationIgnored private var pendingDelta = ""
    @ObservationIgnored private var streamFlush: Task<Void, Never>?
    @ObservationIgnored private var streamGeneration = 0

    private func cancelDeltas() {
        streamFlush?.cancel()
        streamFlush = nil
        pendingDelta = ""
        streamGeneration += 1
    }

    private func flushDeltas() {
        streamFlush?.cancel()
        streamFlush = nil
        streamGeneration += 1
        guard !pendingDelta.isEmpty else { return }
        streaming += pendingDelta
        pendingDelta = ""
        #if MAC_PERF
        PerfProbe.shared.record("stream_flush")
        #endif
    }

    private func queueDelta(_ text: String) {
        guard !text.isEmpty else { return }
        if streaming.isEmpty && pendingDelta.isEmpty { streamID = UUID() }
        pendingDelta += text
        guard streamFlush == nil else { return }
        let generation = streamGeneration
        // Keep short replies fluid; long command output needs fewer full text layouts.
        let bytes = streaming.utf8.count + pendingDelta.utf8.count
        let delay: UInt64 = bytes > 16_000 ? 1_000_000_000 : bytes > 4_000 ? 500_000_000 : 250_000_000
        streamFlush = Task { @MainActor [weak self] in
            do { try await Task.sleep(nanoseconds: delay) } catch { return }
            guard let self, !Task.isCancelled, generation == self.streamGeneration else { return }
            self.flushDeltas()
        }
    }

    init(sender: (([String: Any]) -> Bool)? = nil) {
        self.sender = sender
        socket.onOpen = { [weak self] in
            self?.connected = true
            self?.error = ""
        }
        socket.onMessage = { [weak self] in self?.handle($0) }
        socket.onClose = { [weak self] why in
            self?.connected = false
            self?.busy = false
            self?.busyReason = ""
            self?.toolHint = ""
            self?.backgroundTasks = []
            self?.stoppingTasks = []
            self?.queueOperations = []
            if let why { self?.error = why }
        }
    }

    func start() {
        configured = LocalVerification.explicitLoopback || Prefs.configured
        socket.start()
    }

    func reconnect() {
        configured = LocalVerification.explicitLoopback || Prefs.configured
        connected = false
        busy = false; busyReason = ""; toolHint = ""
        backgroundTasks = []; stoppingTasks = []
        cancelDeltas()
        socket.stop()
        if configured { socket.start() }
    }

    func stop() {
        cancelDeltas()
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
        busyReason = ""
        backgroundTasks = []
        stoppingTasks = []
        endedTasks = []; endedOrder = []; waitingInputs = []; snapshotEchoes = [:]
        taskError = ""
        queueNotice = ""; queueOperations = []
    }

    private func transmit(_ message: [String: Any]) -> Bool {
        if let sender { return sender(message) }
        return socket.send(message)
    }

    @discardableResult
    func send(_ text: String, attachments: [Attachment] = []) -> Bool {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty else { return false }
        var msg: [String: Any] = ["t": "send", "text": text]
        if !attachments.isEmpty { msg["attachments"] = attachments.map(\.json) }
        guard transmit(msg) else {
            error = "还没连上，稍等再发"
            return false
        }
        let item = ChatItem(kind: .user, text: text, attachments: attachments, ts: Date(), pending: true,
                            queued: busy || !waitingInputs.isEmpty)
        add(item)
        waitingInputs.append((item.id, false))
        error = ""
        return true
    }

    func interrupt() {
        if !transmit(["t": "interrupt"]) { error = "还没连上，无法停止当前回复" }
    }

    @discardableResult
    func updateQueue(_ item: ChatItem, text: String? = nil) -> Bool {
        guard item.queued, !item.serverID.isEmpty, !queueOperations.contains(item.serverID) else { return false }
        if let text, text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return false }
        var message: [String: Any] = ["t": text == nil ? "unqueue" : "edit_queued", "id": item.serverID]
        if let text { message["text"] = text }
        guard transmit(message) else { queueNotice = "还没连上，稍后再试"; return false }
        queueOperations.insert(item.serverID)
        queueNotice = ""
        return true
    }

    func stopTask(_ id: String) {
        guard backgroundTasks.contains(where: { $0.id == id }), !stoppingTasks.contains(id) else { return }
        taskError = ""
        stoppingTasks.insert(id)
        if !transmit(["t": "stop_task", "id": id]) {
            stoppingTasks.remove(id)
            taskError = "还没连上，无法停止任务"
        }
    }

    private func endTask(_ id: String) {
        backgroundTasks.removeAll { $0.id == id }
        stoppingTasks.remove(id)
        if endedTasks.insert(id).inserted { endedOrder.append(id) }
        if endedOrder.count > 256 {
            endedTasks.remove(endedOrder.removeFirst())
        }
    }

    /// A level snapshot replaces the complete list, including an empty list.
    func applyTasks(_ rows: [[String: Any]]) {
        var byID: [String: BackgroundTask] = [:]
        for row in rows {
            let id = Self.str(row["id"])
            guard !id.isEmpty else { continue }
            byID[id] = BackgroundTask(id: id, description: Self.str(row["description"]),
                                      startedAt: Self.date(row["startedAt"]) ?? Date())
        }
        for old in backgroundTasks where byID[old.id] == nil { endTask(old.id) }
        for id in byID.keys { endedTasks.remove(id) }
        endedOrder.removeAll { !endedTasks.contains($0) }
        backgroundTasks = byID.values.sorted { $0.startedAt == $1.startedAt ? $0.id < $1.id : $0.startedAt < $1.startedAt }
        stoppingTasks.formIntersection(Set(byID.keys))
    }

    private func handleTask(_ message: [String: Any]) {
        let phase = Self.str(message["phase"])
        if phase == "snapshot" { applyTasks(message["tasks"] as? [[String: Any]] ?? []); return }
        let id = Self.str(message["id"])
        guard !id.isEmpty else { return }
        let patch = message["patch"] as? [String: Any] ?? [:]
        let status = Self.str(patch["status"] ?? message["status"])
        if phase == "notification" || ["done", "completed", "failed", "stopped", "killed", "error"].contains(phase) ||
            ["completed", "failed", "stopped", "killed", "error"].contains(status) { endTask(id); return }
        guard message["background"] as? Bool != false, !endedTasks.contains(id) else { return }
        if let index = backgroundTasks.firstIndex(where: { $0.id == id }) {
            let description = Self.str(patch["description"] ?? message["description"])
            if !description.isEmpty { backgroundTasks[index].description = description }
            if let started = Self.date(message["startedAt"]) { backgroundTasks[index].startedAt = started }
            if let summary = message["summary"] as? String { backgroundTasks[index].summary = summary }
        } else if phase == "started" {
            backgroundTasks.append(BackgroundTask(id: id, description: Self.str(message["description"]),
                                                  startedAt: Self.date(message["startedAt"]) ?? Date()))
        }
    }

    private static func str(_ v: Any?) -> String { v as? String ?? "" }

    private static func date(_ v: Any?) -> Date? {
        (v as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue / 1000) }
    }

    static func item(_ h: [String: Any]) -> ChatItem? {
        let atts = (h["attachments"] as? [[String: Any]] ?? []).map(Attachment.init)
        switch str(h["role"]) {
        case "user": return ChatItem(kind: str(h["source"]) == "schedule" ? .schedule : .user,
                                     text: str(h["text"]), attachments: atts, ts: date(h["ts"]), source: str(h["source"]), serverID: str(h["id"]))
        case "assistant": return ChatItem(kind: .assistant, text: str(h["text"]), ts: date(h["ts"]))
        case "card":
            let outputs = (h["path"] as? String).map { [$0] } ?? h["outputs"] as? [String] ?? []
            return ChatItem(kind: .card, text: str(h["title"]), outputs: outputs, label: str(h["label"]), ts: date(h["ts"]))
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
                    item.queued = same.queued
                    item.pending = same.pending
                    used.insert(same.id)
                }
                return item
            }
            history += old.filter { !used.contains($0.id) }
            items = history
            // HTTP may already contain an event still in flight on the socket. Match that echo once.
            rememberSnapshotEchoes(history.filter { !used.contains($0.id) })
        }
    }

    func rememberSnapshotEchoes(_ snapshot: [ChatItem]) {
        let ids = Set(items.map(\.id)), now = Date()
        snapshotEchoes = snapshotEchoes.filter { ids.contains($0.key) && $0.value > now }
        let cutoff = now.addingTimeInterval(-10)
        for item in snapshot where (item.kind == .user || item.kind == .schedule) && (item.ts ?? .distantPast) >= cutoff {
            snapshotEchoes[item.id] = now.addingTimeInterval(10)
        }
    }

    private static func same(_ a: ChatItem, _ b: ChatItem) -> Bool {
        if !a.serverID.isEmpty && !b.serverID.isEmpty { return a.serverID == b.serverID }
        guard a.kind == b.kind, a.text == b.text, a.outputs == b.outputs,
              a.attachments.map(\.path) == b.attachments.map(\.path) else { return false }
        if a.pending { return true }
        if let x = a.ts, let y = b.ts { return abs(x.timeIntervalSince(y)) < 2 }
        return a.ts == b.ts
    }

    func handle(_ m: [String: Any]) {
        switch Self.str(m["t"]) {
        case "hello":
            cancelDeltas()
            connectionVersion += 1
            jobsVersion += 1
            items = (m["history"] as? [[String: Any]] ?? []).compactMap(Self.item)
            busy = m["busy"] as? Bool ?? false
            busyReason = busy ? Self.str(m["reason"]) : ""
            waitingInputs = []; snapshotEchoes = [:]
            for row in m["queued"] as? [[String: Any]] ?? [] {
                var entry = row
                entry["role"] = "user"
                if var item = Self.item(entry), !item.serverID.isEmpty {
                    item.queued = item.kind == .user
                    items.removeAll { $0.serverID == item.serverID }
                    add(item)
                    waitingInputs.append((item.id, item.kind == .schedule))
                }
            }
            stoppingTasks = []; endedTasks = []; endedOrder = []
            taskError = ""; error = ""
            queueOperations = []; queueNotice = ""
            applyTasks(m["tasks"] as? [[String: Any]] ?? [])
            streaming = ""
            toolHint = ""
            // Tasks from before the reconnect may have ended while we were away.
            live = []
            refreshJobs()
            refreshHistory()
            devicesVersion += 1
        case "user":
            let text = Self.str(m["text"])
            let serverID = Self.str(m["id"])
            let atts = (m["attachments"] as? [[String: Any]] ?? []).map(Attachment.init)
            // Our own message echoes back (now with voice transcripts); others' messages are new.
            let scheduled = Self.str(m["source"]) == "schedule"
            let receivedAt = Date()
            if !serverID.isEmpty, let i = items.firstIndex(where: { $0.serverID == serverID }) {
                items[i].text = text
                items[i].pending = false
                if !atts.isEmpty { items[i].attachments = atts }
            } else if !scheduled, let i = items.firstIndex(where: { $0.pending && $0.text == text && $0.attachments.map(\.path) == atts.map(\.path) }) {
                items[i].pending = false
                items[i].serverID = serverID
                if !atts.isEmpty { items[i].attachments = atts }
            } else if let i = items.firstIndex(where: { (snapshotEchoes[$0.id] ?? .distantPast) > receivedAt && $0.kind == (scheduled ? .schedule : .user) &&
                $0.text == text && $0.attachments.map(\.path) == atts.map(\.path) }) {
                snapshotEchoes.removeValue(forKey: items[i].id)
                items[i].serverID = serverID
                items[i].queued = !scheduled && (busy || !waitingInputs.isEmpty)
                waitingInputs.append((items[i].id, scheduled))
                if !atts.isEmpty { items[i].attachments = atts }
            } else {
                let item = ChatItem(kind: scheduled ? .schedule : .user, text: text, attachments: atts, ts: Date(),
                                    queued: !scheduled && (busy || !waitingInputs.isEmpty), source: Self.str(m["source"]), serverID: serverID)
                add(item)
                waitingInputs.append((item.id, scheduled))
            }
        case "queue_update":
            let id = Self.str(m["id"])
            queueOperations.remove(id)
            guard let index = items.firstIndex(where: { $0.serverID == id }) else { return }
            switch Self.str(m["state"]) {
            case "removed":
                let localID = items[index].id
                items.remove(at: index)
                waitingInputs.removeAll { $0.id == localID }
                snapshotEchoes.removeValue(forKey: localID)
            case "edited":
                if let text = m["text"] as? String { items[index].text = text }
            case "too_late":
                items[index].queued = false
                waitingInputs.removeAll { $0.id == items[index].id }
                queueNotice = "豆豆已经在看这条了"
                Nav.shared.show(queueNotice)
            default: break
            }
        case "status":
            busy = m["busy"] as? Bool ?? false
            if !busy { busyReason = ""; toolHint = "" }
            else if let reason = m["reason"] as? String {
                // Each reason-bearing status starts a new turn, including native task-result turns without a user event.
                cancelDeltas()
                streaming = ""; streamID = UUID(); toolHint = ""
                busyReason = reason
                if reason == "user" || reason == "schedule",
                   let index = waitingInputs.firstIndex(where: { $0.schedule == (reason == "schedule") }) {
                    let id = waitingInputs.remove(at: index).id
                    if let item = items.firstIndex(where: { $0.id == id }) { items[item].queued = false }
                }
            }
        case "delta":
            queueDelta(Self.str(m["text"]))
            toolHint = ""
        case "tool":
            flushDeltas()
            toolHint = Self.toolLabel(Self.str(m["name"]), Self.str(m["hint"]))
            // Text before a tool call is a finished paragraph; keep it visible.
            if !streaming.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !streaming.hasSuffix("\n\n") { streaming += "\n\n" }
        case "turn_end":
            cancelDeltas()
            let text = Self.str(m["text"])
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { add(ChatItem(kind: .assistant, text: text, ts: Date())) }
            if let err = m["error"] as? String { add(ChatItem(kind: .note, text: "这一轮出错了：\(err)")) }
            streaming = ""
            toolHint = ""
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
                let outputs = (m["path"] as? String).map { [$0] } ?? m["outputs"] as? [String] ?? []
                if !outputs.isEmpty { add(ChatItem(kind: .card, text: Self.str(m["title"]), outputs: outputs, label: label, ts: Date())) }
                jobsVersion += 1
                filesVersion += 1
            }
        case "task":
            handleTask(m)
        case "task_stop":
            let id = Self.str(m["id"])
            guard backgroundTasks.contains(where: { $0.id == id }) else { return }
            if m["ok"] as? Bool == false {
                stoppingTasks.remove(id)
                taskError = Self.stopError(Self.str(m["code"]))
            }
        default:
            break
        }
    }

    private static func stopError(_ code: String) -> String {
        switch code {
        case "invalid_task_id": return "任务编号不对，请刷新后重试"
        case "task_ended": return "任务已经结束，等待列表更新"
        case "task_not_found": return "没有这个运行中的后台任务，等待列表更新"
        case "task_stopping": return "任务正在停止，请稍等"
        case "session_unavailable": return "主会话暂时不可用，请稍后再试"
        default: return "停止任务失败，请稍后再试"
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
