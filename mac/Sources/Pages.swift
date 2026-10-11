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

// MARK: - 今日

struct BriefFile: Identifiable, Hashable {
    let day: String
    let name: String
    let mtime: Date
    var displayTitle: String? = nil
    var path: String { "data/briefs/\(day)/\(name)" }
    var title: String { displayTitle ?? (name as NSString).deletingPathExtension }
    var id: String { path }
}

struct TodayPage: View {
    private var chat: ChatClient { .shared }
    @State private var briefs: [BriefFile]? = nil
    @State private var sites: [TreeEntry]? = nil
    @State private var err = ""

    private var today: String { Fmt.dayKey.string(from: Date()) }

    var body: some View {
        PageScaffold(title: "今日", subtitle: Fmt.mdw.string(from: Date()), tab: .today) {
            latest
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 18) {
                    VStack(alignment: .leading, spacing: 22) { todayList; recent }.frame(minWidth: 420, maxWidth: .infinity)
                    sitesCard.frame(width: 330)
                }
                VStack(alignment: .leading, spacing: 22) { todayList; recent; sitesCard }
            }
            if !err.isEmpty { Note(text: err, icon: "wifi.exclamationmark") }
        }
        .task(id: chat.filesVersion) { await load() }
    }

    private func load() async {
        do {
            let days = try await Api.tree("data/briefs").filter { $0.dir && Fmt.dayKey.date(from: $0.name) != nil && $0.name <= today }.sorted { $0.name > $1.name }.prefix(8)
            var out: [BriefFile] = []
            for d in days {
                let files = (try? await Api.tree("data/briefs/\(d.name)")) ?? []
                out += files.filter { !$0.dir && ($0.name.hasSuffix(".html") || $0.name.hasSuffix(".md")) }
                    .map { BriefFile(day: d.name, name: $0.name, mtime: $0.mtime) }
            }
            await withTaskGroup(of: BriefFile.self) { group in
                for brief in out {
                    group.addTask {
                        var brief = brief
                        if let text = try? await Api.text(brief.path) {
                            if brief.name.hasSuffix(".md") {
                                brief.displayTitle = text.components(separatedBy: "\n").first { $0.hasPrefix("# ") }?.dropFirst(2).description
                            } else if let r = text.range(of: "(?is)<title[^>]*>.*?</title>", options: .regularExpression) {
                                brief.displayTitle = String(text[r]).replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
                                    .replacingOccurrences(of: "&amp;", with: "&").trimmingCharacters(in: .whitespacesAndNewlines)
                            }
                            if brief.displayTitle?.isEmpty == true { brief.displayTitle = nil }
                        }
                        return brief
                    }
                }
                var titled: [BriefFile] = []
                for await brief in group { titled.append(brief) }
                out = titled.sorted { $0.mtime > $1.mtime }
            }
            briefs = out
            sites = try await Api.tree("data/sites").filter { $0.dir || $0.name.hasSuffix(".html") }
            err = ""
        } catch {
            err = "读不到：\(error.localizedDescription)"
            if briefs == nil { briefs = [] }
            if sites == nil { sites = [] }
        }
    }

    private var todays: [BriefFile] { (briefs ?? []).filter { $0.day == today }.sorted { $0.mtime > $1.mtime } }

    private var latest: some View {
        let b = todays.first
        return Button { if let b { Nav.shared.open(b.path, title: b.title) } } label: {
            HStack(alignment: .center, spacing: 18) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("最新简报").font(.system(size: 12)).foregroundStyle(Theme.sub)
                    Text(b?.title ?? (briefs == nil ? "加载中…" : "今天还没有简报"))
                        .font(.system(size: 22, weight: .semibold)).foregroundStyle(Theme.ink)
                    Text(b.map { "\(Fmt.hm.string(from: $0.mtime)) 生成 · 点开查看" } ?? "晨报 7:30")
                        .font(.system(size: 13)).foregroundStyle(Theme.sub)
                }
                Spacer()
                if b != nil {
                    HStack(spacing: 4) {
                        Text("查看").font(.system(size: 13, weight: .medium))
                        Image(systemName: "arrow.right").font(.system(size: 11, weight: .semibold))
                    }
                    .foregroundStyle(Theme.goldText)
                    .padding(.horizontal, 16).frame(height: 34).background(GoldBase())
                } else {
                    IconTile(icon: "sun.horizon", tint: Color(hex: 0x527AAA), size: 52)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .card(radius: 24, padding: 24)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(b == nil)
    }

    @ViewBuilder
    private var todayList: some View {
        if todays.count > 1 {
            VStack(alignment: .leading, spacing: 10) {
                SectionTitle(text: "今天的简报")
                Rows(items: todays) { b in
                    ListRow(icon: "doc.richtext", tint: Color(hex: 0x527AAA), title: b.title, subtitle: Fmt.hm.string(from: b.mtime)) {
                        Nav.shared.open(b.path, title: b.title)
                    }
                }
                .card(radius: 22, padding: 10)
            }
        }
    }

    private var recent: some View {
        let older = (briefs ?? []).filter { $0.day != today }
        let days = Array(Set(older.map(\.day))).sorted(by: >).prefix(7)
        return VStack(alignment: .leading, spacing: 10) {
            SectionTitle(text: "最近")
            if days.isEmpty {
                Note(text: briefs == nil ? "加载中…" : "前几天的简报会出现在这里").card(radius: 22, padding: 6)
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(days, id: \.self) { day in
                        Text(dayLabel(day)).font(.system(size: 12)).foregroundStyle(Theme.faint).padding(.horizontal, 8).padding(.top, 6)
                        Rows(items: older.filter { $0.day == day }) { b in
                            ListRow(icon: "doc.richtext", tint: Color(hex: 0x527AAA), title: b.title, subtitle: Fmt.hm.string(from: b.mtime)) {
                                Nav.shared.open(b.path, title: "\(b.title) · \(dayLabel(day))")
                            }
                        }
                    }
                }
                .card(radius: 22, padding: 10)
            }
        }
    }

    private func dayLabel(_ day: String) -> String {
        guard let d = Fmt.dayKey.date(from: day) else { return day }
        return Calendar.current.isDateInYesterday(d) ? "昨天 · " + Fmt.md.string(from: d) : Fmt.mdShortWeek.string(from: d)
    }

    private var sitesCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionTitle(text: "站点")
            Group {
                if let sites, !sites.isEmpty {
                    Rows(items: sites) { s in
                        ListRow(icon: "globe", tint: Color(hex: 0x428B94), title: s.name, subtitle: "更新于 " + Fmt.when(s.mtime)) {
                            Nav.shared.push(.web(title: s.name, path: "data/sites/\(s.name)" + (s.dir ? "/" : "")))
                        }
                    }
                } else {
                    Note(text: sites == nil ? "加载中…" : "还没有站点。\n让豆豆帮你做个页面试试，比如「做个记账图表」")
                }
            }
            .card(radius: 22, padding: 10)
        }
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
    @State private var seg = 0
    @State private var recent: [ChatItem] = []
    @State private var okFlags: [UUID: Bool] = [:]
    @State private var schedule: [ScheduleJob]? = nil
    @State private var loaded = false
    @State private var err = ""
    @State private var launching: Set<String> = []

    var body: some View {
        PageScaffold(title: "任务", tab: .tasks) {
            PillTabs(titles: ["进行中", "已完成", "定时"], selection: $seg)
            switch seg {
            case 0: runningCard
            case 1: recentCard
            default: scheduleCard
            }
            if !err.isEmpty { Note(text: err, icon: "wifi.exclamationmark") }
            suggestions
        }
        .task(id: "\(chat.jobsVersion)-\(chat.connected)-\(scenePhase)") { await load() }
    }

    private func load() async {
        let version = chat.jobsVersion
        do {
            let r = try await Api.json("/api/jobs")
            guard version == chat.jobsVersion, !Task.isCancelled else { return }
            chat.applyJobs(r["running"] as? [[String: Any]] ?? [], version: version)
            var flags: [UUID: Bool] = [:]
            recent = (r["recent"] as? [[String: Any]] ?? []).compactMap { j in
                guard let item = ChatClient.item(j) else { return nil }
                flags[item.id] = j["ok"] as? Bool ?? true
                return item
            }
            okFlags = flags
            let st = try await Api.json("/api/state")
            guard version == chat.jobsVersion, !Task.isCancelled else { return }
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
                        }
                    }
                }
            }
            .card(radius: 22, padding: 10)
        }
    }

    private var recentCard: some View {
        Group {
            if recent.isEmpty {
                Note(text: loaded ? "还没有完成的任务" : "加载中…", icon: "tray")
            } else {
                Rows(items: recent) { item in
                    let ok = okFlags[item.id] ?? true
                    ListRow(icon: ok ? "checkmark.circle" : "exclamationmark.triangle", tint: ok ? Color(hex: 0x3F7F87) : Theme.danger,
                            title: item.label.isEmpty ? item.text : item.label,
                            subtitle: [item.ts.map(Fmt.when) ?? "", ok ? (item.text == item.label ? "" : item.text) : "出错：" + item.text.replacingOccurrences(of: "出错：", with: "")]
                                .filter { !$0.isEmpty }.joined(separator: " · "),
                            action: item.outputs.isEmpty ? nil : { Nav.shared.open(item.outputs[0], title: item.label) }) {
                        if ok { GoldTag(text: "完成") } else { Text("出错").font(.system(size: 11.5, weight: .medium)).foregroundStyle(Theme.danger) }
                    }
                }
            }
        }
        .card(radius: 22, padding: 10)
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
                Nav.shared.show("「\(j.name)」开始跑了，好了会出现在聊天和今日里")
            } catch {
                Nav.shared.show("没跑起来：\(error.localizedDescription)")
            }
        }
    }

    private static let picks: [(title: String, detail: String, icon: String, ask: String)] = [
        ("每日新闻速览", "每天早上挑几条你会关心的新闻", "newspaper", "每天早上 8 点给我一份新闻速览，挑我会关心的几条"),
        ("每周开销小结", "每周日晚上看看这周花了多少", "yensign.circle", "每周日晚上 9 点给我做一份本周开销小结"),
        ("生日提醒", "记忆里有人过生日，提前一天提醒", "gift", "每天检查记忆里有没有人明天过生日，有就提前提醒我"),
    ]

    private var suggestions: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionTitle(text: "为你推荐")
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 250), spacing: 14)], spacing: 14) {
                ForEach(Self.picks, id: \.title) { p in
                    Button { Nav.shared.ask("帮我加一个定时任务：\(p.ask)") } label: {
                        HStack(spacing: 12) {
                            IconTile(icon: p.icon, tint: Color(hex: 0x3F7F87), size: 36)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(p.title).font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.ink)
                                Text(p.detail).font(.system(size: 12)).foregroundStyle(Theme.sub).lineLimit(2)
                            }
                            Spacer(minLength: 4)
                            Image(systemName: "plus").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.faint)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .card(radius: 20, padding: 14)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("在聊天里让豆豆加上这个定时任务")
                }
            }
        }
        .padding(.top, 6)
    }
}
