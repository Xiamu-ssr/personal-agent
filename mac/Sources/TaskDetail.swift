import SwiftUI
import Observation

struct TaskHistoryItem: Identifiable {
    enum Kind: String { case prompt, text, tool, result }
    let id: Int
    let kind: Kind
    let text: String
    let tool: String?
    let time: Date?
}

struct TaskHistory {
    enum Status: String {
        case running, done, error, stopped
        var label: String {
            switch self { case .running: "进行中"; case .done: "完成"; case .error: "出错"; case .stopped: "已停止" }
        }
    }
    let id: String
    let title: String
    let status: Status
    let items: [TaskHistoryItem]

    static func parse(_ row: [String: Any], id: String) throws -> TaskHistory {
        guard row["id"] as? String == id, let title = row["title"] as? String,
              let statusText = row["status"] as? String, let status = Status(rawValue: statusText),
              let raw = row["items"] as? [[String: Any]] else { throw ApiError(code: 0, message: "任务记录暂时读不到") }
        let items = raw.enumerated().compactMap { index, row -> TaskHistoryItem? in
            guard let kind = (row["kind"] as? String).flatMap(TaskHistoryItem.Kind.init), let text = row["text"] as? String else { return nil }
            return TaskHistoryItem(id: index, kind: kind, text: text, tool: row["tool"] as? String, time: ProductTime.date(row["time"]))
        }
        guard items.count == raw.count else { throw ApiError(code: 0, message: "任务记录不完整，请重试") }
        return TaskHistory(id: id, title: title, status: status, items: items)
    }

    var turns: [TaskHistoryTurn] {
        var turns: [TaskHistoryTurn] = []
        for item in items {
            if item.kind == .prompt || turns.isEmpty { turns.append(TaskHistoryTurn(id: item.id)) }
            let i = turns.count - 1
            switch item.kind {
            case .prompt: turns[i].prompt = item
            case .text, .tool: turns[i].steps.append(item)
            case .result: turns[i].results.append(item)
            }
        }
        return turns
    }
}

struct TaskHistoryTurn: Identifiable {
    let id: Int
    var prompt: TaskHistoryItem?
    var steps: [TaskHistoryItem] = []
    var results: [TaskHistoryItem] = []
}

/// /api/jobs records are task summaries, with a stable task id, rather than chat messages.
struct TaskSummary: Identifiable {
    let id: String
    let title: String
    let time: Date?
    let status: TaskHistory.Status
    let outputs: [String]
    static func parse(_ row: [String: Any]) -> TaskSummary? {
        guard let id = row["id"] as? String, !id.isEmpty, let title = row["title"] as? String,
              let status = (row["status"] as? String).flatMap(TaskHistory.Status.init), status != .running else { return nil }
        var outputs = row["outputs"] as? [String] ?? []
        if let path = row["path"] as? String, !outputs.contains(path) { outputs.insert(path, at: 0) }
        return TaskSummary(id: id, title: title, time: ProductTime.date(row["ts"]), status: status, outputs: outputs)
    }
}

@MainActor @Observable
final class TaskHistoryStore {
    let id: String
    private(set) var history: TaskHistory?
    private(set) var loading = false
    private(set) var sending = false
    var draft = ""
    var error = ""
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var refreshQueued = false
    init(id: String) { self.id = id }

    static func endpoint(_ id: String, action: String) throws -> String {
        guard !id.isEmpty, let encoded = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) else {
            throw ApiError(code: 0, message: "任务编号不对")
        }
        return "/api/tasks/\(encoded)/\(action)"
    }

    func load() async {
        guard !loading else { refreshQueued = true; return }
        loading = true
        let current = generation
        defer {
            loading = false
            if refreshQueued {
                refreshQueued = false
                Task { await load() }
            }
        }
        do {
            let response = try await Api.json(Self.endpoint(id, action: "history"))
            try Task.checkCancellation()
            guard current == generation else { return }
            history = try TaskHistory.parse(response, id: id); error = ""
        } catch is CancellationError {
        } catch { self.error = error.localizedDescription }
    }

    /// Poll only this opened running task. Cancellation on navigation stops the loop and request.
    func watch() async {
        await load()
        while !Task.isCancelled && history?.status == .running {
            do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { return }
            if history?.status == .running { await load() }
        }
    }

    @discardableResult
    func send() async -> Bool {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sending, !text.isEmpty else { return false }
        generation += 1
        sending = true; error = ""
        defer { sending = false }
        do {
            let response = try await Api.json(Self.endpoint(id, action: "send"), method: "POST", body: ["text": text])
            guard response["ok"] as? Bool == true, response["id"] as? String == id else {
                throw ApiError(code: 0, message: "续聊没有发出去，请重试")
            }
            if draft.trimmingCharacters(in: .whitespacesAndNewlines) == text { draft = "" }
            await load()
            return true
        } catch { self.error = error.localizedDescription; return false }
    }

    static func briefPath(in text: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: #"data/briefs/\d{4}-\d{2}-\d{2}/[^\n<>\"\[\]()*]+?\.html"#),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let range = Range(match.range, in: text) else { return nil }
        let path = String(text[range])
        return BriefItem.validPath(path) ? path : nil
    }
}

struct TaskDetailPage: View {
    let title: String
    let briefPath: String?
    @State private var store: TaskHistoryStore
    @State private var focused = false
    private var chat: ChatClient { .shared }
    init(id: String, title: String, briefPath: String?) {
        self.title = title; self.briefPath = briefPath
        _store = State(initialValue: TaskHistoryStore(id: id))
    }

    private var output: String? {
        if let briefPath, BriefItem.validPath(briefPath) { return briefPath }
        if let path = chat.items.last(where: { $0.taskID == store.id })?.outputs.first(where: { BriefItem.validPath($0) }) { return path }
        return store.history?.items.reversed().compactMap { TaskHistoryStore.briefPath(in: $0.text) }.first
    }

    var body: some View {
        VStack(spacing: 0) {
            SubPage(title: store.history?.title ?? title) {
                if let history = store.history {
                    HStack(spacing: 8) {
                        if history.status == .running { ActiveProgress().controlSize(.small) }
                        Text(history.status.label).font(.system(size: 13, weight: .medium))
                            .foregroundStyle(history.status == .error ? Theme.danger : Theme.sub)
                        Spacer()
                        if history.status == .running && chat.backgroundTasks.contains(where: { $0.id == store.id }) {
                            Button(chat.stoppingTasks.contains(store.id) ? "停止中…" : "停止") { chat.stopTask(store.id) }
                                .buttonStyle(SoftButtonStyle()).disabled(chat.stoppingTasks.contains(store.id))
                        }
                    }
                    ForEach(Array(history.turns.enumerated()), id: \.element.id) { index, turn in
                        TaskTurnView(turn: turn, first: index == 0)
                    }
                    if history.items.isEmpty { Note(text: "任务正在准备，记录会出现在这里") }
                    if let output {
                        Button { Nav.shared.open(output) } label: { Label("看简报", systemImage: "doc.richtext") }
                            .buttonStyle(SoftButtonStyle())
                            .verificationAction("看简报")
                    }
                } else if store.loading { Note(text: "加载中…") }
                if !store.error.isEmpty {
                    Note(text: store.error, icon: "wifi.exclamationmark")
                    Button("重试") { Task { await store.load() } }.buttonStyle(SoftButtonStyle())
                }
                if !chat.taskError.isEmpty { Note(text: chat.taskError, icon: "exclamationmark.circle") }
            }
            HStack(alignment: .bottom, spacing: 12) {
                GrowingInput(text: $store.draft, focused: $focused, placeholder: "接着聊这个任务…", enabled: true,
                             onSubmit: send, onAttachmentPaste: { _ in false })
                    .frame(maxWidth: .infinity)
                Button(action: send) {
                    if store.sending { ActiveProgress().controlSize(.small).frame(width: 32, height: 32) }
                    else { Image(systemName: "arrow.up").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.goldText).frame(width: 32, height: 32).background(Theme.goldWash, in: Circle()) }
                }
                .buttonStyle(.plain).disabled(store.sending || store.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("发送续聊")
                .verificationAction("发送续聊")
            }
            .padding(14).background(Theme.card, in: RoundedRectangle(cornerRadius: 24))
            .overlay(RoundedRectangle(cornerRadius: 24).strokeBorder(.white, lineWidth: 1))
            .frame(maxWidth: 820).padding(.horizontal, 28).padding(.bottom, 18).padding(.top, 8)
        }
        .task(id: store.history?.status == .running) { await store.watch() }
        .onChange(of: chat.jobsVersion) { Task { await store.load() } }
    }

    private func send() { Task { if await store.send() { focused = true } } }
}

private struct TaskTurnView: View {
    let turn: TaskHistoryTurn
    let first: Bool
    @State private var expanded = false
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let prompt = turn.prompt {
                VStack(alignment: .leading, spacing: 10) {
                    SectionTitle(text: first ? "任务说明" : "继续聊")
                    MarkdownView(text: prompt.text, size: 14.5).textSelection(.enabled)
                    if let time = prompt.time { Text(Fmt.when(time)).font(.system(size: 11)).foregroundStyle(Theme.faint) }
                }.frame(maxWidth: .infinity, alignment: .leading).card(radius: 22, padding: 22)
            }
            if !turn.steps.isEmpty {
                DisclosureGroup(isExpanded: $expanded) {
                    VStack(alignment: .leading, spacing: 14) {
                        ForEach(turn.steps) { item in
                            HStack(alignment: .top, spacing: 10) {
                                Image(systemName: item.kind == .tool ? "wrench.and.screwdriver" : "text.bubble").foregroundStyle(Theme.accent)
                                VStack(alignment: .leading, spacing: 4) {
                                    if item.kind == .tool { Text(item.text).font(.system(size: 13)).foregroundStyle(Theme.ink) }
                                    else { MarkdownView(text: item.text, size: 13) }
                                    if let time = item.time { Text(Fmt.hm.string(from: time)).font(.system(size: 11)).foregroundStyle(Theme.faint) }
                                }
                            }
                        }
                    }.padding(.top, 14)
                } label: { Text("豆豆的步骤 · \(turn.steps.count)").font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.sub) }
                .tint(Theme.sub).card(radius: 22, padding: 20)
            }
            ForEach(turn.results) { result in
                VStack(alignment: .leading, spacing: 12) {
                    SectionTitle(text: "结果")
                    MarkdownView(text: result.text, size: 14.5).textSelection(.enabled)
                }.frame(maxWidth: .infinity, alignment: .leading).card(radius: 22, padding: 22)
            }
        }
    }
}
