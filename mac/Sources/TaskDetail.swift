import SwiftUI
import Observation
import CryptoKit

struct TaskHistoryItem: Identifiable, Equatable {
    enum Kind: String { case prompt, text, tool, result }
    enum Sender: String { case agent, user }
    let id: UUID
    let kind: Kind
    let from: Sender?
    let text: String
    let tool: String?
    let time: Date?
    let attachments: [Attachment]
    var message: ChatItem {
        ChatItem(id: id, kind: kind == .prompt && from == .user ? .user : .assistant,
                 text: text, attachments: attachments, ts: time)
    }
}

struct TaskHistory: Equatable {
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
            let from = (row["from"] as? String).flatMap(TaskHistoryItem.Sender.init)
            if kind == .prompt && from == nil { return nil }
            let hash = Array(SHA256.hash(data: Data("\(id):\(index)".utf8)).prefix(16))
            let identity = hash.withUnsafeBytes { UUID(uuid: $0.loadUnaligned(as: uuid_t.self)) }
            return TaskHistoryItem(id: identity, kind: kind, from: from, text: text, tool: row["tool"] as? String,
                                   time: ProductTime.date(row["time"]), attachments: (row["attachments"] as? [[String: Any]] ?? []).map(Attachment.init))
        }
        guard items.count == raw.count else { throw ApiError(code: 0, message: "任务记录不完整，请重试") }
        return TaskHistory(id: id, title: title, status: status, items: items)
    }
}

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

@MainActor @Observable final class TaskHistoryStore {
    let id: String
    let composer: Composer
    private(set) var history: TaskHistory?
    private(set) var loading = false
    var error = ""
    @ObservationIgnored private var refreshQueued = false
    init(id: String) { self.id = id; composer = Composer(taskID: id) }
    static func endpoint(_ id: String, action: String) throws -> String {
        guard !id.isEmpty, let encoded = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) else {
            throw ApiError(code: 0, message: "任务编号不对")
        }
        return "/api/tasks/\(encoded)/\(action)"
    }
    func load() async {
        guard !loading else { refreshQueued = true; return }
        loading = true
        defer {
            loading = false
            if refreshQueued { refreshQueued = false; if !Task.isCancelled { Task { await load() } } }
        }
        do {
            let response = try await Api.json(Self.endpoint(id, action: "history"))
            try Task.checkCancellation()
            let updated = try TaskHistory.parse(response, id: id)
            if updated != history { history = updated }
            error = ""
        } catch is CancellationError {} catch { self.error = error.localizedDescription }
    }
    func watch() async {
        await load()
        while !Task.isCancelled && history?.status == .running {
            do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { return }
            if history?.status == .running { await load() }
        }
    }
    static func briefPath(in text: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: #"data/briefs/\d{4}-\d{2}-\d{2}/[^\n<>\"\[\]()*]+?\.html"#),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let range = Range(match.range, in: text) else { return nil }
        let path = String(text[range]); return BriefItem.validPath(path) ? path : nil
    }
}

/// Used by task history and the live main chat. Tool details start collapsed.
struct ChatToolRow: View {
    let name: String
    let text: String
    @State private var expanded = false
    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            Text(text).font(Theme.font(size: 13)).foregroundStyle(Theme.sub).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 6)
        } label: {
            Label(name, systemImage: "wrench.and.screwdriver").font(Theme.font(size: 13)).foregroundStyle(Theme.sub)
        }.tint(Theme.sub).padding(.horizontal, 8).padding(.vertical, 6)
    }
}

struct TaskDetailPage: View {
    let title: String
    let briefPath: String?
    @State private var store: TaskHistoryStore
    @State private var follower = BottomFollower()
    @State private var scrollState = ChatScrollState()
    @State private var dropping = false
    private var chat: ChatClient { .shared }
    init(id: String, title: String, briefPath: String?) {
        self.title = title; self.briefPath = briefPath; _store = State(initialValue: TaskHistoryStore(id: id))
    }
    private var output: String? {
        if let briefPath, BriefItem.validPath(briefPath) { return briefPath }
        return store.history?.items.reversed().compactMap { TaskHistoryStore.briefPath(in: $0.text) }.first
    }
    var body: some View {
        SubPage(title: store.history?.title ?? title, scrolls: false) {
            VStack(spacing: 0) {
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 14) {
                            if let history = store.history {
                                HStack(spacing: 8) {
                                    Text(history.status.label).font(Theme.font(size: 13)).foregroundStyle(history.status == .error ? Theme.danger : Theme.sub)
                                    Spacer()
                                    if history.status == .running && chat.backgroundTasks.contains(where: { $0.id == store.id }) {
                                        Button(chat.stoppingTasks.contains(store.id) ? "停止中…" : "停止") { chat.stopTask(store.id) }
                                            .buttonStyle(SoftButtonStyle()).disabled(chat.stoppingTasks.contains(store.id))
                                    }
                                }.padding(.vertical, 8)
                                LazyVStack(alignment: .leading, spacing: 14) {
                                    ForEach(Array(history.items.enumerated()), id: \.element.id) { index, item in
                                        if item.kind == .tool { ChatToolRow(name: item.tool ?? "工具", text: item.text) }
                                        else {
                                            VStack(alignment: .leading, spacing: 5) {
                                                if index == 0 && item.kind == .prompt && item.from == .agent {
                                                    Text("豆豆交代的").font(Theme.font(size: 12)).foregroundStyle(Theme.accent).padding(.leading, 8)
                                                }
                                                MessageRow(item: item.message)
                                            }.id(item.id)
                                        }
                                    }
                                }
                                if let output { Button { Nav.shared.open(output) } label: { Label("看简报", systemImage: "doc.richtext") }.buttonStyle(SoftButtonStyle()).verificationAction("看简报") }
                            } else { Note(text: store.loading ? "加载中…" : "任务正在准备，记录会出现在这里") }
                            if !store.error.isEmpty { Note(text: store.error); Button("重试") { Task { await store.load() } }.buttonStyle(SoftButtonStyle()) }
                            if !chat.taskError.isEmpty { Note(text: chat.taskError) }
                            Color.clear.frame(height: 1).id("end")
                        }
                        .background(ChatScrollReader(state: scrollState).frame(width: 0, height: 0))
                        .frame(maxWidth: 820).padding(.horizontal, 28).padding(.vertical, 12).frame(maxWidth: .infinity)
                    }.scrollContentBackground(.hidden)
                        .overlay(alignment: .bottomTrailing) { ReturnToBottom(state: scrollState) { scrollState.returnToBottom(); follower.request() } }
                        .onAppear { follower.request() }
                        .onChange(of: store.history) {
                            scrollState.messages(store.history?.items.filter { $0.kind != .tool }.map(\.id) ?? [])
                            if scrollState.atBottom { follower.request() }
                        }
                        .onChange(of: store.composer.sentRevision) { scrollState.returnToBottom(); follower.request() }
                        .onChange(of: follower.revision) {
                            guard scrollState.atBottom else { return }
                            var transaction = Transaction(); transaction.disablesAnimations = true
                            withTransaction(transaction) { proxy.scrollTo("end", anchor: .bottom) }
                        }.onDisappear { follower.cancel() }
                }
                ComposerBar(placeholder: "接着聊这个任务…", c: store.composer)
                    .frame(maxWidth: 820).padding(.horizontal, 28).padding(.bottom, 18).padding(.top, 4)
            }
            .onDrop(of: [.fileURL, .image], isTargeted: $dropping) { store.composer.drop($0) }
        }
        .task(id: "\(store.composer.sentRevision)-\(store.history?.status.rawValue ?? "loading")") { await store.watch() }
        .onChange(of: chat.jobsVersion) { Task { await store.load() } }
        .onDisappear { store.composer.cancelRecording() }
    }
}
