import Observation
import SwiftUI

// MARK: - Shared data for 连接应用 / 设备

struct CloudConnector: Identifiable, Hashable {
    let name: String
    let title: String
    let description: String
    var id: String { name }
}

struct RemoteCap: Identifiable, Hashable {
    let name: String
    let title: String
    let description: String
    let enabled: Bool
    var id: String { name }
}

struct RemoteDevice: Identifiable, Hashable {
    let id: String
    let name: String
    let kind: String
    let online: Bool
    let lastSeen: Date?
    let caps: [RemoteCap]

    var icon: String { kind == "android" ? "iphone" : kind == "mac" ? "laptopcomputer" : "desktopcomputer" }

    var status: String {
        if online { return "在线" }
        return "离线" + (lastSeen.map { " · 上次在线 " + Fmt.ago($0) } ?? "")
    }
}

/// GET /api/connectors, shared by the settings pages; reloads when devices come and go.
@Observable
final class ConnectorStore {
    static let shared = ConnectorStore()

    var builtin: [CloudConnector] = []
    var installed: [CloudConnector] = []
    var catalog: [CloudConnector] = []
    var devices: [RemoteDevice] = []
    var loaded = false
    var error = ""
    var cloudOnline = false
    var cloudName = "云电脑"
    private var generation = 0

    var others: [RemoteDevice] { devices.filter { $0.id != Prefs.deviceId } }
    var connected: [CloudConnector] { builtin + installed }

    func reset() {
        generation += 1
        builtin = []; installed = []; catalog = []; devices = []
        loaded = false; error = ""; cloudOnline = false
    }

    func load() async {
        let version = generation
        do {
            let r = try await Api.json("/api/connectors")
            guard generation == version, !Task.isCancelled else { return }
            let cloud = r["cloud"] as? [String: Any] ?? [:]
            cloudOnline = cloud["online"] as? Bool ?? false
            cloudName = cloud["name"] as? String ?? "云电脑"
            let conns = { (k: String) in (cloud[k] as? [[String: Any]] ?? []).map {
                CloudConnector(name: $0["name"] as? String ?? "", title: $0["title"] as? String ?? ($0["name"] as? String ?? ""),
                               description: $0["description"] as? String ?? "")
            } }
            builtin = conns("builtin")
            installed = conns("installed")
            catalog = conns("catalog")
            devices = (r["devices"] as? [[String: Any]] ?? []).map { d in
                RemoteDevice(
                    id: d["id"] as? String ?? "", name: d["name"] as? String ?? "", kind: d["kind"] as? String ?? "",
                    online: d["online"] as? Bool ?? false,
                    lastSeen: (d["lastSeen"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) },
                    caps: (d["capabilities"] as? [[String: Any]] ?? []).map {
                        RemoteCap(name: $0["name"] as? String ?? "", title: $0["title"] as? String ?? ($0["name"] as? String ?? ""),
                                  description: $0["description"] as? String ?? "", enabled: $0["enabled"] as? Bool ?? true)
                    })
            }
            error = ""
        } catch {
            guard generation == version, !Task.isCancelled else { return }
            self.error = "读不到：\(error.localizedDescription)"
        }
        loaded = true
    }
}

// MARK: - Local capability switch

struct CapRow: View {
    let cap: Capability
    @State private var on: Bool
    @State private var note = ""
    @State private var asking = false
    @State private var folder = Prefs.folder

    init(cap: Capability) {
        self.cap = cap
        _on = State(initialValue: cap.enabled)
    }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            IconTile(icon: cap.icon, tint: Color(hex: 0x487FA6), size: 34)
            VStack(alignment: .leading, spacing: 3) {
                Text(cap.title).font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.ink)
                Text(note.isEmpty ? (cap.hint ?? cap.description) : note)
                    .font(.system(size: 12)).foregroundStyle(note.isEmpty ? Theme.sub : Theme.danger).lineLimit(2)
                if cap.name == "folder" {
                    HStack(spacing: 8) {
                        Text(folder.map { ($0 as NSString).abbreviatingWithTildeInPath } ?? "还没选文件夹")
                            .font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Theme.faint).lineLimit(1).truncationMode(.middle)
                        Button(folder == nil ? "选择…" : "更换…") { _ = pickFolder() }.buttonStyle(.plain)
                            .font(.system(size: 11.5, weight: .medium)).foregroundStyle(Theme.accent)
                    }
                }
            }
            Spacer(minLength: 10)
            if asking { ProgressView().controlSize(.small) }
            Toggle("", isOn: Binding(get: { on }, set: set)).toggleStyle(.switch).labelsHidden().tint(Color(hex: 0xC9A869)).disabled(asking)
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 6)
    }

    private func set(_ want: Bool) {
        guard !asking else { return }
        note = ""
        guard want else {
            on = false
            Prefs.setGranted(cap.name, false)
            DeviceClient.shared.reregister()
            return
        }
        if cap.name == "folder" && Prefs.folder == nil && !pickFolder() { return }
        on = true
        Task { @MainActor in
            if let permit = cap.permit {
                asking = true
                let why = await permit()
                asking = false
                if let why {
                    note = why
                    on = false
                    Prefs.setGranted(cap.name, false)
                    DeviceClient.shared.reregister()
                    return
                }
            }
            Prefs.setGranted(cap.name, true)
            DeviceClient.shared.reregister()
        }
    }

    private func pickFolder() -> Bool {
        let p = NSOpenPanel()
        p.canChooseDirectories = true
        p.canChooseFiles = false
        p.prompt = "授权给豆豆"
        guard p.runModal() == .OK, let url = p.url else { return false }
        Prefs.folder = url.path
        folder = url.path
        DeviceClient.shared.reregister()
        return true
    }
}

/// 生成配对码: issue a one-time code for another device (replaces any unused one).
struct PairCodeView: View {
    @State private var code = ""
    @State private var err = ""
    @State private var working = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 14) {
                Button(working ? "生成中…" : (code.isEmpty ? "生成配对码" : "重新生成")) { generate() }
                    .buttonStyle(GoldButtonStyle(height: 32))
                    .disabled(working)
                if !code.isEmpty {
                    Text(code.map(String.init).joined(separator: " "))
                        .font(.system(size: 24, weight: .semibold, design: .monospaced)).foregroundStyle(Theme.ink).textSelection(.enabled)
                }
            }
            Text(err.isEmpty ? "24 小时内有效，只能用一次，会顶掉之前没用的码" : err)
                .font(.system(size: 12)).foregroundStyle(err.isEmpty ? Theme.sub : Theme.danger)
        }
    }

    private func generate() {
        working = true
        Task { @MainActor in
            do {
                code = try await Api.json("/api/pair/new", method: "POST")["code"] as? String ?? ""
                err = ""
            } catch {
                err = "失败：\(error.localizedDescription)"
            }
            working = false
        }
    }
}

/// White card with a small heading above it.
struct CardSection<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.sub).padding(.horizontal, 6)
            VStack(alignment: .leading, spacing: 0) { content() }.card(radius: 22, padding: 10)
        }
    }
}

struct RowDivider: View {
    var body: some View { Rectangle().fill(Theme.line).frame(height: 1).padding(.leading, 50) }
}

// MARK: - 设置

struct SettingsPage: View {
    private var chat: ChatClient { .shared }
    private var device: DeviceClient { .shared }
    private var store: ConnectorStore { .shared }
    @State private var model = ""
    @State private var notify = Prefs.notifyMessages
    @State private var notifyNote = ""
    @State private var confirmSignOut = false

    private var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    }

    var body: some View {
        PageScaffold(title: "设置", tab: .settings) {
            HStack(spacing: 16) {
                Orb(size: 58)
                VStack(alignment: .leading, spacing: 4) {
                    Text("豆豆 · Personal Agent").font(.system(size: 18, weight: .semibold)).foregroundStyle(Theme.ink)
                    HStack(spacing: 6) {
                        Dot(on: chat.connected)
                        Text(statusLine(chat, device)).font(.system(size: 12.5)).foregroundStyle(Theme.sub)
                    }
                }
                Spacer()
            }
            .card(radius: 24, padding: 20)

            LazyVGrid(columns: [GridItem(.adaptive(minimum: 380), spacing: 18, alignment: .top)], alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 18) {
                    CardSection(title: "模型") {
                        ListRow(icon: "cpu", tint: Color(hex: 0x637DA0), title: "当前模型", subtitle: "由云端配置") {
                            Text(model.isEmpty ? "—" : model).font(.system(size: 13, design: .monospaced)).foregroundStyle(Theme.sub)
                        }
                    }
                    CardSection(title: "能力与连接") {
                        ListRow(icon: "square.grid.2x2", tint: Color(hex: 0x487FA6), title: "连接应用",
                                subtitle: "本机 \(Capabilities.enabled.count) 项已开启 · 云端 \(store.connected.count) 项已连接") {
                            Nav.shared.push(.connectors(tab: 0))
                        }
                        RowDivider()
                        ListRow(icon: "laptopcomputer.and.iphone", tint: Color(hex: 0x527AAA), title: "设备",
                                subtitle: store.loaded ? "\((device.online ? 1 : 0) + store.others.filter(\.online).count + (store.cloudOnline ? 1 : 0)) 台在线（含云电脑）" : "本机、云电脑和其他设备") {
                            Nav.shared.push(.devices)
                        }
                        RowDivider()
                        ListRow(icon: "wand.and.stars", tint: Color(hex: 0x776AA3), title: "技能", subtitle: "豆豆整理出来的常用做法") {
                            Nav.shared.push(.skills)
                        }
                    }
                    CardSection(title: "通知") {
                        ListRow(icon: "bell", tint: Color(hex: 0x3F7F87), title: "接收消息通知",
                                subtitle: notifyNote.isEmpty ? "豆豆回复或任务完成时，豆豆不在前台就弹系统通知" : notifyNote) {
                            Toggle("", isOn: Binding(get: { notify }, set: setNotify)).toggleStyle(.switch).labelsHidden().tint(Color(hex: 0xC9A869))
                        }
                    }
                }
                VStack(alignment: .leading, spacing: 18) {
                    CardSection(title: "账号") {
                        ListRow(icon: "cloud", tint: Color(hex: 0x487FA6), title: "云端地址", subtitle: Prefs.server)
                        RowDivider()
                        VStack(alignment: .leading, spacing: 10) {
                            HStack(spacing: 12) {
                                IconTile(icon: "number", tint: Color(hex: 0x9F7E51), size: 32)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text("给另一台设备配对").font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.ink)
                                    Text("在那台设备的登录页，密码填这个 6 位码").font(.system(size: 12)).foregroundStyle(Theme.sub)
                                }
                            }
                            PairCodeView().padding(.leading, 44)
                        }
                        .padding(.vertical, 11)
                        .padding(.horizontal, 6)
                        RowDivider()
                        ListRow(icon: "rectangle.portrait.and.arrow.right", tint: Theme.danger, title: "退出登录", subtitle: "清掉这台 Mac 上的口令，回到登录页") {
                            confirmSignOut = true
                        }
                    }
                    Text("版本 \(version)").font(.system(size: 12)).foregroundStyle(Theme.faint).padding(.horizontal, 6)
                }
            }
        }
        .task(id: chat.devicesVersion) {
            if let st = try? await Api.json("/api/state") {
                let current = st["model"] as? String ?? ""
                model = current.hasPrefix("anthropic/") ? String(current.dropFirst(10)) : current
            }
            await store.load()
        }
        .alert("退出登录？", isPresented: $confirmSignOut) {
            Button("退出登录", role: .destructive) { Session.shared.signOut() }
            Button("取消", role: .cancel) {}
        } message: {
            Text("会清掉这台 Mac 上保存的口令，本机能力也会断开。之后要用配对码或口令重新登录。")
        }
    }

    private func setNotify(_ on: Bool) {
        notify = on
        Prefs.notifyMessages = on
        notifyNote = ""
        guard on else { return }
        Task { @MainActor in
            if !(await Capabilities.requestNotifications()) {
                notifyNote = "系统通知没打开，去「系统设置 → 通知 → 豆豆」允许"
            }
        }
    }

}

// MARK: - 连接应用

struct ConnectorsPage: View {
    let initialTab: Int
    let focus: String?
    private var store: ConnectorStore { .shared }
    private var chat: ChatClient { .shared }
    @State private var tab = 0
    @State private var query = ""

    init(initialTab: Int, focus: String?) {
        self.initialTab = initialTab
        self.focus = focus
        _tab = State(initialValue: initialTab)
    }

    var body: some View {
        ScrollViewReader { proxy in
            SubPage(title: "连接应用", subtitle: "连接设备和服务，豆豆就能替你做更多事") {
                PillTabs(titles: ["本机 · \(Capabilities.all.count)",
                                  "云端 · \(store.connected.count + store.catalog.count)",
                                  "其他设备 · \(store.others.reduce(0) { $0 + $1.caps.count })"], selection: $tab)
                switch tab {
                case 0: local
                case 1: cloud
                default: others
                }
                if !store.error.isEmpty { Note(text: store.error, icon: "wifi.exclamationmark") }
            }
            .task(id: chat.devicesVersion) {
                await store.load()
                if let focus { withAnimation { proxy.scrollTo(focus, anchor: .top) } }
            }
        }
    }

    private var local: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("开了的，豆豆可以随时用；没开的，它碰不到。要系统权限的会先问你。")
                .font(.system(size: 12.5)).foregroundStyle(Theme.sub).padding(.horizontal, 6)
            Rows(items: Capabilities.all) { CapRow(cap: $0) }.card(radius: 22, padding: 10)
        }
    }

    private func matches(_ c: CloudConnector) -> Bool {
        let q = query.trimmingCharacters(in: .whitespaces)
        return q.isEmpty || c.title.localizedCaseInsensitiveContains(q) || c.description.localizedCaseInsensitiveContains(q) || c.name.localizedCaseInsensitiveContains(q)
    }

    private var cloud: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").font(.system(size: 13)).foregroundStyle(Theme.faint)
                TextField("搜索应用", text: $query).textFieldStyle(.plain).font(.system(size: 13.5))
            }
            .padding(.horizontal, 16)
            .frame(height: 40)
            .background(Capsule().fill(Theme.card))
            .overlay(Capsule().strokeBorder(.white, lineWidth: 1))

            let on = store.connected.filter(matches)
            let off = store.catalog.filter(matches)
            VStack(alignment: .leading, spacing: 10) {
                SectionTitle(text: "已接入")
                Group {
                    if on.isEmpty { Note(text: store.loaded ? "没有匹配的" : "加载中…") } else {
                        Rows(items: on) { c in
                            ListRow(icon: cloudIcon(c.name), tint: Color(hex: 0x487FA6), title: c.title, subtitle: c.description) { GoldTag(text: "已连接") }
                        }
                    }
                }
                .card(radius: 22, padding: 10)
            }
            VStack(alignment: .leading, spacing: 10) {
                SectionTitle(text: "可以接入")
                Text("点「连接」后豆豆会在聊天里帮你接入，需要账号时会问你。").font(.system(size: 12)).foregroundStyle(Theme.sub).padding(.horizontal, 4)
                Group {
                    if off.isEmpty { Note(text: store.loaded ? "没有更多可接入的了" : "加载中…") } else {
                        Rows(items: off) { c in
                            ListRow(icon: cloudIcon(c.name), tint: Theme.faint, title: c.title, subtitle: c.description) {
                                Button("连接") { Nav.shared.ask("帮我接入「\(c.title)」连接器") }.buttonStyle(SoftButtonStyle())
                            }
                        }
                    }
                }
                .card(radius: 22, padding: 10)
            }
        }
    }

    private func cloudIcon(_ name: String) -> String {
        switch name {
        case "web_search", "tavily": "magnifyingglass"
        case "web_fetch": "globe"
        case "shell": "terminal"
        case "files": "folder"
        case "schedule": "clock"
        case "transcribe": "waveform"
        case "email": "envelope"
        case "calendar": "calendar"
        case "github": "chevron.left.forwardslash.chevron.right"
        case "feishu": "paperplane"
        case "notion": "note.text"
        case "rss": "dot.radiowaves.up.forward"
        default: "puzzlepiece.extension"
        }
    }

    private var others: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("其他设备上的能力在那台设备上开关，这里只能看。").font(.system(size: 12.5)).foregroundStyle(Theme.sub).padding(.horizontal, 6)
            if store.others.isEmpty {
                Note(text: store.loaded ? "还没有其他设备。去「设备 → 连接更多设备」接入手机或另一台 Mac" : "加载中…", icon: "iphone")
                    .card(radius: 22, padding: 6)
            }
            ForEach(store.others) { d in
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 8) {
                        Image(systemName: d.icon).foregroundStyle(Theme.sub)
                        Text(d.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink)
                        Dot(on: d.online)
                        Text(d.status).font(.system(size: 12)).foregroundStyle(Theme.sub)
                    }
                    .padding(.horizontal, 4)
                    Group {
                        if d.caps.isEmpty { Note(text: "这台设备没有上报能力") } else {
                            Rows(items: d.caps) { c in
                                ListRow(icon: "circle.grid.2x2", tint: c.enabled ? Color(hex: 0x487FA6) : Theme.faint, title: c.title, subtitle: c.description) {
                                    Text(c.enabled ? "已开启" : "未开启").font(.system(size: 12, weight: .medium))
                                        .foregroundStyle(c.enabled ? Theme.online : Theme.faint)
                                }
                            }
                        }
                    }
                    .card(radius: 22, padding: 10)
                }
                .opacity(d.online ? 1 : 0.6)
                .id(d.id)
            }
        }
    }
}

// MARK: - 设备

struct DevicesPage: View {
    private var store: ConnectorStore { .shared }
    private var chat: ChatClient { .shared }
    private var device: DeviceClient { .shared }
    @State private var expanded: String? = nil

    var body: some View {
        SubPage(title: "设备", subtitle: "豆豆能用到的每一台设备") {
            VStack(spacing: 0) {
                deviceRow(icon: "laptopcomputer", name: Prefs.deviceName, tag: "本机", online: device.online,
                          detail: (device.online ? "在线" : "未接入") + " · \(Capabilities.enabled.count) 项能力已开启") {
                    Nav.shared.push(.connectors(tab: 0))
                }
                RowDivider()
                deviceRow(icon: "cloud", name: store.cloudName, tag: "云端", online: store.cloudOnline,
                          detail: (store.cloudOnline ? "在线" : "离线") + " · \(store.connected.count) 项已连接") {
                    Nav.shared.push(.connectors(tab: 1))
                }
                ForEach(store.others) { d in
                    RowDivider()
                    deviceRow(icon: d.icon, name: d.name, tag: nil, online: d.online,
                              detail: d.status + " · \(d.caps.filter(\.enabled).count) 项能力已开启") {
                        Nav.shared.push(.connectors(tab: 2, focus: d.id))
                    }
                    .opacity(d.online ? 1 : 0.6)
                }
            }
            .card(radius: 22, padding: 10)

            VStack(alignment: .leading, spacing: 10) {
                SectionTitle(text: "连接更多设备")
                VStack(spacing: 0) {
                    more(id: "mac", icon: "laptopcomputer", title: "连接 Mac")
                    RowDivider()
                    more(id: "android", icon: "iphone", title: "连接安卓手机")
                }
                .card(radius: 22, padding: 10)
            }
        }
        .task(id: chat.devicesVersion) { await store.load() }
    }

    private func deviceRow(icon: String, name: String, tag: String?, online: Bool, detail: String, action: @escaping () -> Void) -> some View {
        ListRow(icon: icon, tint: Color(hex: 0x527AAA), title: name, subtitle: detail, action: action) {
            HStack(spacing: 8) {
                if let tag { GoldTag(text: tag) }
                Dot(on: online)
            }
        }
    }

    private func more(id: String, icon: String, title: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ListRow(icon: icon, tint: Color(hex: 0x637DA0), title: title, subtitle: "装上豆豆，用配对码登录") {
                Image(systemName: expanded == id ? "chevron.up" : "chevron.down").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.faint)
            }
            .contentShape(Rectangle())
            .onTapGesture { withAnimation(.easeOut(duration: 0.2)) { expanded = expanded == id ? nil : id } }
            if expanded == id {
                VStack(alignment: .leading, spacing: 12) {
                    Text(id == "mac"
                         ? "1. 在那台 Mac 上下载豆豆（.dmg），拖进「应用程序」打开\n2. 登录页「账号」保持默认云端地址，「密码」填下面生成的 6 位配对码"
                         : "1. 在手机上下载豆豆（.apk）并安装\n2. 登录页「账号」保持默认云端地址，「密码」填下面生成的 6 位配对码")
                        .font(.system(size: 12.5)).foregroundStyle(Theme.ink.opacity(0.85)).lineSpacing(4)
                    Link(destination: URL(string: "https://github.com/Xiamu-ssr/personal-agent/releases")!) {
                        Label("下载地址：github.com/Xiamu-ssr/personal-agent/releases", systemImage: "arrow.down.circle")
                            .font(.system(size: 12.5, weight: .medium))
                    }
                    .foregroundStyle(Theme.accent)
                    PairCodeView()
                }
                .padding(.leading, 50)
                .padding(.bottom, 12)
                .padding(.trailing, 10)
            }
        }
    }
}

// MARK: - 技能

struct SkillsPage: View {
    @State private var skills: [(name: String, description: String)]? = nil
    @State private var err = ""

    var body: some View {
        SubPage(title: "技能", subtitle: "豆豆把常做的事整理成的固定做法") {
            Group {
                if let skills, !skills.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(Array(skills.enumerated()), id: \.offset) { i, s in
                            if i > 0 { RowDivider() }
                            ListRow(icon: "wand.and.stars", tint: Color(hex: 0x776AA3), title: s.name, subtitle: s.description)
                        }
                    }
                } else {
                    Note(text: !err.isEmpty ? err : skills == nil ? "加载中…" : "豆豆把常做的事整理成技能后会出现在这里", icon: "wand.and.stars")
                }
            }
            .card(radius: 22, padding: 10)
        }
        .task {
            do {
                skills = (try await Api.json("/api/skills")["skills"] as? [[String: Any]] ?? []).map {
                    ($0["name"] as? String ?? "", $0["description"] as? String ?? "")
                }
            } catch {
                err = "读不到：\(error.localizedDescription)"
            }
        }
    }
}
