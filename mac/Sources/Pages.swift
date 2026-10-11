import SwiftUI

/// A data page: big title, top-right settings, scrolling content, and the shared input box at the bottom.
struct PageScaffold<Content: View>: View {
    let title: String
    var subtitle = ""
    var tab: Tab? = nil
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    HStack(alignment: .top) {
                        PageTitle(title: title, subtitle: subtitle)
                        Spacer()
                        if tab != .settings { CircleIconButton(icon: "gearshape", help: "设置") { Nav.shared.go(.settings) } }
                    }
                    .padding(.top, 8)
                    content()
                }
                .frame(maxWidth: 940, alignment: .leading)
                .padding(.horizontal, 36)
                .padding(.top, 14)
                .padding(.bottom, 28)
                .frame(maxWidth: .infinity)
            }
            .scrollContentBackground(.hidden)
            if let prompt = tab?.prompt {
                ComposerBar(placeholder: prompt)
                    .frame(maxWidth: 820)
                    .padding(.horizontal, 28)
                    .padding(.bottom, 18)
                    .padding(.top, 4)
            }
        }
    }
}

/// A pushed page: back button + title, then content.
struct SubPage<Content: View, Trailing: View>: View {
    let title: String
    var subtitle = ""
    var scrolls = true
    @ViewBuilder var trailing: () -> Trailing
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Button { Nav.shared.pop() } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.left").font(.system(size: 13, weight: .semibold))
                        Text("返回").font(.system(size: 13))
                    }
                    .foregroundStyle(Theme.ink.opacity(0.75))
                    .padding(.horizontal, 12)
                    .frame(height: 32)
                    .background(Capsule().fill(Theme.card))
                    .overlay(Capsule().strokeBorder(.white, lineWidth: 1))
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .keyboardShortcut("[", modifiers: .command)
                if !scrolls {
                    Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                }
                Spacer()
                trailing()
            }
            .padding(.horizontal, 28)
            .padding(.top, 14)
            .padding(.bottom, 10)
            if scrolls {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        PageTitle(title: title, subtitle: subtitle)
                        content()
                    }
                    .frame(maxWidth: 940, alignment: .leading)
                    .padding(.horizontal, 36)
                    .padding(.bottom, 28)
                    .frame(maxWidth: .infinity)
                }
                .scrollContentBackground(.hidden)
            } else {
                content()
            }
        }
    }
}

extension SubPage where Trailing == EmptyView {
    init(title: String, subtitle: String = "", scrolls: Bool = true, @ViewBuilder content: @escaping () -> Content) {
        self.init(title: title, subtitle: subtitle, scrolls: scrolls, trailing: { EmptyView() }, content: content)
    }
}

struct RouteView: View {
    let route: Route

    var body: some View {
        switch route {
        case .web(let title, let path): WebRoute(title: title, path: path)
        case .doc(let title, let path): DocRoute(title: title, path: path)
        case .memoryCategory(let dir): MemoryCategoryPage(dir: dir)
        case .diaries: DiaryListPage()
        case .connectors(let tab, let focus): ConnectorsPage(initialTab: tab, focus: focus)
        case .connector(let name): ConnectorDetailPage(name: name)
        case .connectorForm(let name, let accountID): ConnectorFormPage(name: name, accountID: accountID)
        case .devices: DevicesPage()
        case .skills: SkillsPage()
        }
    }
}

struct WebRoute: View {
    let title: String
    let path: String
    @State private var loading = true
    @State private var failed = ""

    var body: some View {
        SubPage(title: title, scrolls: false) {
            if loading { ActiveProgress().controlSize(.small) }
            Button {
                Task { @MainActor in
                    do { try await Api.openExternally(path.hasSuffix(".html") ? path : path + "/index.html") } catch { Nav.shared.show("打不开：\(error.localizedDescription)") }
                }
            } label: { Label("用默认应用打开", systemImage: "arrow.up.forward.app") }
                .buttonStyle(SoftButtonStyle())
        } content: {
            ZStack {
                WebPage(path: path, loading: $loading, failed: $failed)
                if !failed.isEmpty { Note(text: "打不开：\(failed)", icon: "exclamationmark.triangle") }
            }
            .background(.white)
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(.white, lineWidth: 1))
            .shadow(color: Color(hex: 0x253751, alpha: 0.06), radius: 16, y: 8)
            .padding(.horizontal, 28)
            .padding(.bottom, 22)
        }
    }
}

/// A Markdown file (memory, diary, 角色) rendered natively.
struct DocRoute: View {
    let title: String
    let path: String
    @State private var text: String? = nil
    @State private var err = ""
    private var chat: ChatClient { .shared }

    var body: some View {
        SubPage(title: title, subtitle: subtitle) {
            Group {
                if let text {
                    MarkdownView(text: text, size: 14.5, onPointer: path.hasPrefix("data/memory/") ? openPointer : nil)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Note(text: err.isEmpty ? "加载中…" : err)
                }
            }
            .card(radius: 22, padding: 24)
        }
        .task(id: "\(path)#\(chat.filesVersion)") {
            do { text = try await Api.text(path); err = "" } catch { text = nil; err = error.localizedDescription }
        }
    }

    private var subtitle: String {
        let parts = path.split(separator: "/")
        if path.hasPrefix("data/memory/"), parts.count >= 3 { return "记忆 · " + Theme.category(String(parts[2])).name }
        if path.hasPrefix("data/diary/") { return "豆豆的日记" }
        return path
    }

    private func openPointer(_ ref: String) {
        let p = "data/memory/" + ref
        Nav.shared.push(.doc(title: ((ref as NSString).lastPathComponent as NSString).deletingPathExtension, path: p))
    }
}

// MARK: - 任务

struct ScheduleJob: Identifiable {
    let id: String
    let name: String
    let cron: String
    let kind: String
    var isSystem: Bool { kind == "compact" || kind == "cleanup" }
}

/// "30 7 * * *" → 每天 7:30, "0 20 * * 0" → 每周日 20:00.
func cronText(_ cron: String) -> String {
    let p = cron.split(separator: " ").map(String.init)
    guard p.count == 5 else { return cron }
    let (m, h, dom, mon, dow) = (p[0], p[1], p[2], p[3], p[4])
    if m.hasPrefix("*/"), h == "*" { return "每 \(m.dropFirst(2)) 分钟" }
    if m.allSatisfy(\.isNumber), h == "*" { return "每小时第 \(m) 分" }
    guard let mi = Int(m), h.allSatisfy({ $0.isNumber || $0 == "," }) else { return cron }
    let time = h.split(separator: ",").map { String(format: "%@:%02d", String($0), mi) }.joined(separator: "、")
    let days = ["日", "一", "二", "三", "四", "五", "六", "日"]
    if dom == "*" && mon == "*" {
        if dow == "*" { return "每天 \(time)" }
        if dow == "1-5" { return "工作日 \(time)" }
        if dow == "0,6" || dow == "6,0" { return "周末 \(time)" }
        let ds = dow.split(separator: ",").compactMap { Int($0) }.filter { $0 >= 0 && $0 <= 7 }
        if !ds.isEmpty { return "每周" + ds.map { days[$0] }.joined(separator: "、") + " \(time)" }
    }
    if let d = Int(dom), mon == "*", dow == "*" { return "每月 \(d) 日 \(time)" }
    return cron
}

struct TasksPage: View {
    @Environment(\.interactiveWindow) private var active
    @Environment(\.scenePhase) private var scenePhase
    private var chat: ChatClient { .shared }
    @State private var recent: [ChatItem] = []
    @State private var okFlags: [UUID: Bool] = [:]
    @State private var schedule: [ScheduleJob]? = nil
    @State private var loaded = false
    @State private var err = ""
    @State private var launching: Set<String> = []

    var body: some View {
        PageScaffold(title: "任务", tab: .tasks) {
            PillTabs(titles: ["任务", "定时"], selection: Binding(get: { Nav.shared.tasksSection }, set: { Nav.shared.tasksSection = $0 }))
            switch Nav.shared.tasksSection {
            case 0:
                if !allRunning.isEmpty { runningCard }
                recentCard
            default: scheduleCard
            }
            if !err.isEmpty { Note(text: err, icon: "wifi.exclamationmark") }
            if !chat.taskError.isEmpty { Note(text: chat.taskError, icon: "exclamationmark.circle") }
        }
        .task(id: "\(chat.jobsVersion)-\(chat.connected)-\(scenePhase)-\(Nav.shared.tasksSection)") { await load() }
    }

    private func load() async {
        let version = chat.jobsVersion
        do {
            async let jobsResponse = Api.json("/api/jobs")
            async let stateResponse = Api.json("/api/state")
            let (r, st) = try await (jobsResponse, stateResponse)
            guard version == chat.jobsVersion, !Task.isCancelled else { return }
            chat.applyJobs(r["running"] as? [[String: Any]] ?? [], version: version)
            var flags: [UUID: Bool] = [:]
            recent = (r["recent"] as? [[String: Any]] ?? []).compactMap { j in
                guard let item = ChatClient.item(j) else { return nil }
                flags[item.id] = j["ok"] as? Bool ?? true
                return item
            }
            okFlags = flags
            schedule = (st["schedule"] as? [[String: Any]] ?? []).map {
                ScheduleJob(id: $0["id"] as? String ?? "", name: $0["name"] as? String ?? ($0["id"] as? String ?? ""),
                            cron: $0["cron"] as? String ?? "", kind: $0["kind"] as? String ?? "")
            }
            err = ""
        } catch {
            guard !Task.isCancelled else { return }
            err = "读不到：\(error.localizedDescription)"
            if schedule == nil { schedule = [] }
        }
        loaded = true
    }

    /// Server list plus live sub-agent tasks from the socket (which the server's job list doesn't track).
    private var allRunning: [LiveTask] {
        chat.live + chat.backgroundTasks.map { LiveTask(id: "task:" + $0.id, label: $0.description, started: $0.startedAt, detail: $0.summary.isEmpty ? "后台任务" : $0.summary) }
    }

    private var runningCard: some View {
        TimelineView(.animation(minimumInterval: 30, paused: !active)) { ctx in
            Group {
                if allRunning.isEmpty {
                    Note(text: loaded ? "现在没有在跑的任务" : "加载中…", icon: "checkmark.circle")
                } else {
                    Rows(items: allRunning) { t in
                        ListRow(icon: t.id.hasPrefix("job:") ? "clock" : "arrow.triangle.branch", tint: Color(hex: 0x3F7F87),
                                title: t.label, subtitle: "\(t.detail) · 已运行 \(Fmt.duration(ctx.date.timeIntervalSince(t.started)))") {
                            ActiveProgress().controlSize(.small)
                            if t.id.hasPrefix("task:") {
                                let id = String(t.id.dropFirst(5))
                                Button(chat.stoppingTasks.contains(id) ? "停止中…" : "停止") { chat.stopTask(id) }
                                    .buttonStyle(SoftButtonStyle()).disabled(chat.stoppingTasks.contains(id))
                            }
                        }
                    }
                }
            }
            .card(radius: 22, padding: 10)
        }
    }

    private var recentCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            if recent.isEmpty && allRunning.isEmpty {
                Note(text: loaded ? "还没有任务" : "加载中…", icon: "tray").card(radius: 22, padding: 16)
            } else {
                ForEach(["今天", "近 7 天", "更早"], id: \.self) { group in
                    let entries = recent.filter { Self.completedGroup($0.ts) == group }.sorted { ($0.ts ?? .distantPast) > ($1.ts ?? .distantPast) }
                    if !entries.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            SectionTitle(text: group)
                            Rows(items: entries) { item in
                                let ok = okFlags[item.id] ?? true
                                ListRow(icon: ok ? "checkmark.circle" : "exclamationmark.triangle", tint: ok ? Color(hex: 0x3F7F87) : Theme.danger,
                                        title: item.text.isEmpty ? item.label : item.text, subtitle: item.ts.map(Fmt.when) ?? "",
                                        action: item.outputs.isEmpty ? nil : { Nav.shared.open(item.outputs[0], title: item.label) }) {
                                    if ok { GoldTag(text: "完成") } else { Text("出错").font(.system(size: 11.5, weight: .medium)).foregroundStyle(Theme.danger) }
                                }
                            }.card(radius: 22, padding: 10)
                        }
                    }
                }
            }
        }
    }

    static func completedGroup(_ date: Date?, now: Date = Date()) -> String {
        guard let date else { return "更早" }
        if Calendar.current.isDate(date, inSameDayAs: now) { return "今天" }
        let start = Calendar.current.date(byAdding: .day, value: -7, to: Calendar.current.startOfDay(for: now)) ?? now
        return date >= start ? "近 7 天" : "更早"
    }

    private var scheduleCard: some View {
        Group {
            if let schedule, !schedule.isEmpty {
                Rows(items: schedule) { j in
                    ListRow(icon: !j.isSystem ? "clock" : "gearshape.2", tint: !j.isSystem ? Color(hex: 0x3F7F87) : Theme.faint,
                            title: j.name, subtitle: cronText(j.cron) + (!j.isSystem ? "" : " · 系统任务")) {
                        if !j.isSystem {
                            if launching.contains(j.id) || chat.live.contains(where: { $0.id == "job:" + j.name }) {
                                Text(launching.contains(j.id) ? "启动中…" : "进行中").font(.system(size: 12)).foregroundStyle(Theme.sub)
                            } else {
                                Button("立即运行") { run(j) }.buttonStyle(SoftButtonStyle())
                            }
                        }
                    }
                }
            } else {
                Note(text: schedule == nil ? "加载中…" : "还没有定时任务")
            }
        }
        .card(radius: 22, padding: 10)
    }

    private func run(_ j: ScheduleJob) {
        guard !j.isSystem, !launching.contains(j.id) else { return }
        launching.insert(j.id)
        Task { @MainActor in
            defer { launching.remove(j.id) }
            do {
                _ = try await Api.json("/api/run", method: "POST", body: ["id": j.id])
                await load()
                Nav.shared.show("「\(j.name)」已排队，好了会出现在聊天和今日里")
            } catch {
                Nav.shared.show("没跑起来：\(error.localizedDescription)")
            }
        }
    }

}
