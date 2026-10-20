import Observation
import SwiftUI

// MARK: - Shared data for 连接应用 / 设备

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

    var installed: [CloudConnector] = []
    var catalog: [CloudConnector] = []
    var devices: [RemoteDevice] = []
    var loaded = false
    var error = ""
    var cloudOnline = false
    var cloudName = "云端"
    private var generation = 0

    var others: [RemoteDevice] { devices.filter { $0.id != Prefs.deviceId } }
    var connected: [CloudConnector] { installed }

    func connector(_ name: String) -> CloudConnector? { (connected + catalog).first { $0.name == name } }

    func reset() {
        generation += 1
        installed = []; catalog = []; devices = []
        loaded = false; error = ""; cloudOnline = false
    }

    func load() async {
        generation += 1
        let version = generation
        do {
            let r = try await Api.json("/api/connectors")
            guard generation == version, !Task.isCancelled else { return }
            let cloud = r["cloud"] as? [String: Any] ?? [:]
            cloudOnline = cloud["online"] as? Bool ?? false
            cloudName = "云端"
            installed = (cloud["installed"] as? [[String: Any]] ?? []).map { CloudConnector($0) }
            catalog = (cloud["catalog"] as? [[String: Any]] ?? []).map { CloudConnector($0) }
            devices = (r["devices"] as? [[String: Any]] ?? []).map { d in
                RemoteDevice(
                    id: d["id"] as? String ?? "", name: d["name"] as? String ?? "", kind: d["kind"] as? String ?? "",
                    online: d["online"] as? Bool ?? false,
                    lastSeen: (d["lastSeen"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) },
                    caps: (d["capabilities"] as? [[String: Any]] ?? []).map {
                        RemoteCap(name: $0["name"] as? String ?? "", title: $0["title"] as? String ?? ($0["name"] as? String ?? ""),
                                  description: ($0["enabled"] as? Bool == false ? $0["unavailableReason"] as? String : nil) ?? ($0["description"] as? String ?? ""), enabled: $0["enabled"] as? Bool ?? true)
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
    init(cap: Capability) { self.cap = cap; _on = State(initialValue: cap.enabled) }
    var body: some View {
        HStack(spacing: 12) {
            AppIcon(style:.capability(cap.name),size:36)
            VStack(alignment: .leading, spacing: 3) {
                Text(cap.title).font(Theme.font(size: 14, weight: .medium)).foregroundStyle(Theme.ink)
                Text(note.isEmpty ? (Prefs.granted(cap.name) ? cap.permissionFailure : nil) ?? cap.hint ?? cap.description : note).font(Theme.font(size: 12)).foregroundStyle(note.isEmpty ? Theme.sub : Theme.danger).lineLimit(3)
            }
            Spacer(minLength: 10)
            if asking { ActiveProgress().controlSize(.small) }
            Toggle("", isOn: Binding(get: { on }, set: set)).toggleStyle(.switch).labelsHidden().tint(Color(red:0.20,green:0.65,blue:0.39)).disabled(asking)
                .accessibilityLabel(cap.title)
        }.padding(.vertical, 10).padding(.horizontal, 6)
            .onReceive(NotificationCenter.default.publisher(for:NSApplication.didBecomeActiveNotification)) { _ in
                on=cap.enabled; DeviceClient.shared.reregister()
            }
    }
    private func set(_ want: Bool) {
        guard !asking else { return }
        note = ""
        guard want else {
            on = false; Prefs.setGranted(cap.name, false); DeviceClient.shared.reregister(); return
        }
        asking = true
        Task { @MainActor in
            let why = await cap.permit?()
            asking = false
            on = why == nil
            note = why ?? ""
            Prefs.setGranted(cap.name, on)
            DeviceClient.shared.reregister()
        }
    }
}

private struct DeviceOwnershipSection: View {
    @State private var role = Prefs.deviceRole
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("这台设备属于谁").font(Theme.titleFont(18))
            ForEach(["owner", "agent"], id: \.self) { value in
                Button {
                    role = value
                    Prefs.deviceRole = value
                    DeviceClient.shared.reregister()
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: role == value ? "largecircle.fill.circle" : "circle")
                        VStack(alignment: .leading, spacing: 5) {
                            Text(value == "agent" ? "豆豆专用" : "我日常使用").font(Theme.font(size: 15, weight: .medium))
                            Text(value == "agent" ? "让豆豆用它操作应用、处理事务" : "平时读取信息；操作应用按我交代的任务来")
                                .font(Theme.font(size: 12)).foregroundStyle(Theme.sub)
                        }
                        Spacer()
                    }.card(radius: 16, padding: 16)
                }.buttonStyle(.plain).verificationAction("device-owner-" + value)
            }
        }
    }
}

struct LocalCapabilityList: View {
    @State private var enabling = false
    @State private var progress = ""
    @State private var failures: [String: String] = [:]
    @State private var revision = 0
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Button(enabling ? "正在申请…" : "申请本机权限") { enable() }.buttonStyle(PrimaryButtonStyle(height: 36)).disabled(enabling)
                Text(progress).font(Theme.font(size: 12)).foregroundStyle(Theme.sub)
            }
            Rows(items: Capabilities.all) { CapRow(cap: $0).id($0.name) }.id(revision).disabled(enabling).card(radius: 16, padding: 10)
            ForEach(Capabilities.all.filter { failures[$0.name] != nil }) { cap in
                Text("\(cap.title)：\(failures[cap.name] ?? "")").font(Theme.font(size: 12)).foregroundStyle(Theme.danger)
            }
        }
    }
    private func enable() {
        guard !enabling else { return }
        enabling = true; failures = [:]; progress = "按系统顺序申请授权"
        Task { @MainActor in
            await Capabilities.enableAll { name, reason in
                DispatchQueue.main.async {
                    let title = Capabilities.all.first { $0.name == name }?.title ?? name
                    progress = title + (reason == nil ? "已开启" : "未开启")
                    failures[name] = reason
                    revision += 1
                }
            }
            revision += 1; enabling = false
            DeviceClient.shared.reregister()
        }
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
                    .buttonStyle(PrimaryButtonStyle(height: 32))
                    .disabled(working)
                if !code.isEmpty {
                    Text(code.map(String.init).joined(separator: " "))
                        .font(Theme.font(size: 24, weight: .semibold, design: .monospaced)).foregroundStyle(Theme.ink).textSelection(.enabled)
                }
            }
            Text(err.isEmpty ? "24 小时内有效，只能用一次，会顶掉之前没用的码" : err)
                .font(Theme.font(size: 12)).foregroundStyle(err.isEmpty ? Theme.sub : Theme.danger)
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
            Text(title).font(Theme.font(size: 13, weight: .medium)).foregroundStyle(Theme.sub).padding(.horizontal, 6)
            VStack(alignment: .leading, spacing: 0) { content() }.card(radius: 16, padding: 10)
        }
    }
}

struct RowDivider: View {
    var body: some View { Rectangle().fill(Theme.line).frame(height: 1).padding(.leading, 50) }
}

// MARK: - 设置

struct SettingsPage: View {
    @Environment(\.interactiveWindow) private var active
    private var chat: ChatClient { .shared }
    private var device: DeviceClient { .shared }
    private var store: ConnectorStore { .shared }
    @State private var notify = Prefs.notifyMessages
    @State private var notifyNote = ""
    @State private var confirmSignOut = false
    @State private var serverEditor = false

    private var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    }

    var body: some View {
        PageScaffold(title: "设置", tab: .settings) {
            CardSection(title: "外观") {
                HStack {
                    Text("外观").font(Theme.font(size: 14, weight: .medium))
                    Spacer()
                    Picker("外观", selection: Binding(get: { AppearanceStore.shared.selection }, set: { AppearanceStore.shared.select($0) })) {
                        ForEach(AppAppearance.allCases) { Text($0.title).tag($0) }
                    }.labelsHidden().frame(width: 180)
                }.padding(12)
            }

            LazyVGrid(columns: [GridItem(.adaptive(minimum: 380), spacing: 18, alignment: .top)], alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 18) {
                    CardSection(title: "模型") {
                        ListRow(icon: "sparkles", tint: Theme.accent, title: "模型",
                                subtitle: AgentSettingsStore.shared.snapshot?.modelLabel ?? "加载中…") {
                            Nav.shared.push(.models)
                        }
                        .accessibilityLabel("模型")
                        .verificationAction("模型")
                    }
                    CardSection(title: "能力与连接") {
                        ListRow(icon: "square.grid.2x2", appStyle:.connector("tavily"), title: "连接应用",
                                subtitle: "本机 \(Capabilities.enabled.count) 项已开启 · 云端 \(store.connected.count) 项已连接") {
                            Nav.shared.push(.connectors(tab: 0))
                        }
                        RowDivider()
                        ListRow(icon: "laptopcomputer.and.iphone", appStyle:.capability("computer_use"), title: "设备",
                                subtitle: store.loaded ? "\((device.online ? 1 : 0) + store.others.filter(\.online).count + (store.cloudOnline ? 1 : 0)) 台在线（含云电脑）" : "本机、云电脑和其他设备") {
                            Nav.shared.push(.devices)
                        }
                        RowDivider()
                        ListRow(icon: "wand.and.stars", tint: Theme.accent, title: "技能", subtitle: "豆豆整理出来的常用做法") {
                            Nav.shared.push(.skills)
                        }
                    }
                    CardSection(title: "通知") {
                        ListRow(icon: "bell", appStyle:.capability("notify"), title: "接收消息通知",
                                subtitle: notifyNote.isEmpty ? "豆豆说话时，App 不在前台就弹系统通知" : notifyNote) {
                            Toggle("", isOn: Binding(get: { notify }, set: setNotify)).toggleStyle(.switch).labelsHidden().tint(Theme.accent)
                        }
                    }
                }
                VStack(alignment: .leading, spacing: 18) {
                    CardSection(title: "账号") {
                        ListRow(icon: "cloud", tint: Theme.accent, title: "云端地址", subtitle: Prefs.server) { serverEditor = true }
                        RowDivider()
                        VStack(alignment: .leading, spacing: 10) {
                            HStack(spacing: 12) {
                                IconTile(icon: "number", tint: Theme.ornament, size: 32)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text("给另一台设备配对").font(Theme.font(size: 14, weight: .medium)).foregroundStyle(Theme.ink)
                                    Text("在那台设备的登录页，密码填这个 6 位码").font(Theme.font(size: 12)).foregroundStyle(Theme.sub)
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
                    Text("版本 \(version)").font(Theme.font(size: 12)).foregroundStyle(Theme.faint).padding(.horizontal, 6)
                }
            }
        }
        .task(id: "\(chat.devicesVersion)-\(chat.settingsVersion)-\(active)") {
            await AgentSettingsStore.shared.load()
            await ProfileStore.shared.load()
            await store.load()
            while active && !Task.isCancelled { do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { return }; await AgentSettingsStore.shared.load() }
        }
        .sheet(isPresented: $serverEditor) { ServerAddressEditor() }
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
            if let permit = Capabilities.all.first(where: { $0.name == "notify" })?.permit, let reason = await permit() { notifyNote = reason }
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
        VStack(alignment: .leading, spacing: 18) {
            DeviceOwnershipSection()
            Text("本机能力与授权").font(Theme.titleFont(18))
            LocalCapabilityList()
            Note(text: DeviceClient.shared.online ? "设备已接入云端，已授权能力可用" : "设备正在连接云端")
        }
    }

    private func matches(_ c: CloudConnector) -> Bool {
        let q = query.trimmingCharacters(in: .whitespaces)
        return q.isEmpty || c.title.localizedCaseInsensitiveContains(q) || c.description.localizedCaseInsensitiveContains(q) || c.name.localizedCaseInsensitiveContains(q)
    }

    private var cloud: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").font(Theme.font(size: 13)).foregroundStyle(Theme.faint)
                TextField("搜索应用", text: $query).textFieldStyle(.plain).font(Theme.font(size: 13.5))
            }
            .padding(.horizontal, 16)
            .frame(height: 40)
            .background(Capsule().fill(Theme.card))
            .overlay(Capsule().strokeBorder(Theme.line, lineWidth: 0.5))

            let on = store.connected.filter(matches)
            let off = store.catalog.filter(matches)
            VStack(alignment: .leading, spacing: 10) {
                SectionTitle(text: "已连接")
                Group {
                    if on.isEmpty { Note(text: store.loaded ? "没有匹配的" : "加载中…") } else {
                        Rows(items: on) { c in
                            ConnectorListRow(connector: c, connected: true) { Nav.shared.openConnector(c.name, from: tab, focus: focus) }
                        }
                    }
                }
                .card(radius: 16, padding: 10)
            }
            let featured = off.filter { ["qq-mail", "gmail", "github", "tavily"].contains($0.name) }
            if !featured.isEmpty { connectorGroup("精选", items: featured) }
            connectorGroup("邮箱", items: off.filter { ["qq-mail", "netease-163", "netease-126", "gmail", "exmail", "aliyun-mail", "imap"].contains($0.name) })
            connectorGroup("调研与阅读", items: off.filter { ["tavily", "weread"].contains($0.name) })
            connectorGroup("工作与金融", items: off.filter { ["github", "wind", "tencent-quotes"].contains($0.name) })
            connectorGroup("出行与位置", items: off.filter { $0.name == "amap" })
            let known = Set(["qq-mail", "netease-163", "netease-126", "gmail", "exmail", "aliyun-mail", "imap", "tavily", "weread", "github", "wind", "tencent-quotes", "amap"])
            connectorGroup("更多应用", items: off.filter { !known.contains($0.name) })
        }
    }

    @ViewBuilder private func connectorGroup(_ title: String, items: [CloudConnector]) -> some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                SectionTitle(text: title)
                Rows(items: items) { c in ConnectorListRow(connector: c, connected: false) { Nav.shared.openConnector(c.name, from: tab, focus: focus) } }
                    .card(radius: 16, padding: 10)
            }
        }
    }

    private var others: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("其他设备上的能力在那台设备上开关，这里只能看。").font(Theme.font(size: 12.5)).foregroundStyle(Theme.sub).padding(.horizontal, 6)
            if store.others.isEmpty {
                Note(text: store.loaded ? "还没有其他设备。去「设备 → 连接更多设备」接入手机或另一台 Mac" : "加载中…", icon: "iphone")
                    .card(radius: 16, padding: 6)
            }
            ForEach(store.others) { d in
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 8) {
                        Image(systemName: d.icon).foregroundStyle(Theme.sub)
                        Text(d.name).font(Theme.font(size: 15, weight: .semibold)).foregroundStyle(Theme.ink)
                        Dot(on: d.online)
                        Text(d.status).font(Theme.font(size: 12)).foregroundStyle(Theme.sub)
                    }
                    .padding(.horizontal, 4)
                    Group {
                        if d.caps.isEmpty { Note(text: "这台设备没有上报能力") } else {
                            Rows(items: d.caps) { c in
                                ListRow(appStyle:.capability(c.name), title: c.title, subtitle: c.description) {
                                    Text(c.enabled ? "已开启" : "未开启").font(Theme.font(size: 12, weight: .medium))
                                        .foregroundStyle(c.enabled ? Theme.online : Theme.faint)
                                }
                            }
                        }
                    }
                    .card(radius: 16, padding: 10)
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
    @State private var removing: RemoteDevice? = nil
    @State private var removingID: String? = nil

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
                    HStack(spacing: 10) {
                        deviceRow(icon: d.icon, name: d.name, tag: nil, online: d.online,
                                  detail: d.status + " · \(d.caps.filter(\.enabled).count) 项能力已开启") {
                            Nav.shared.push(.connectors(tab: 2, focus: d.id))
                        }
                        .opacity(d.online ? 1 : 0.6)
                        if !d.online {
                            Button(removingID == d.id ? "移除中…" : "移除") { removing = d }
                                .buttonStyle(SoftButtonStyle()).disabled(removingID != nil).padding(.trailing, 6)
                        }
                    }
                }
            }
            .card(radius: 16, padding: 10)

            VStack(alignment: .leading, spacing: 10) {
                SectionTitle(text: "连接更多设备")
                VStack(spacing: 0) {
                    more(id: "mac", icon: "laptopcomputer", title: "连接 Mac")
                    RowDivider()
                    more(id: "android", icon: "iphone", title: "连接安卓手机")
                }
                .card(radius: 16, padding: 10)
            }
        }
        .task(id: chat.devicesVersion) { await store.load() }
        .alert("移除设备？", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
            Button("移除", role: .destructive) { if let device = removing { remove(device) } }
            Button("取消", role: .cancel) { removing = nil }
        } message: { Text("移除离线设备「\(removing?.name ?? "")」后，它将不再出现在设备列表里。") }
    }

    private func remove(_ device: RemoteDevice) {
        guard !device.online, removingID == nil else { return }
        removing = nil; removingID = device.id
        Task { @MainActor in
            defer { removingID = nil }
            do { try await ConnectorAPI.removeDevice(device.id); await store.load() }
            catch { Nav.shared.show("移除失败：\(error.localizedDescription)") }
        }
    }

    private func deviceRow(icon: String, name: String, tag: String?, online: Bool, detail: String, action: @escaping () -> Void) -> some View {
        ListRow(icon: icon, tint: Theme.accent, title: name, subtitle: detail, action: action) {
            HStack(spacing: 8) {
                if let tag { StatusTag(text: tag) }
                Dot(on: online)
            }
        }
    }

    private func more(id: String, icon: String, title: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ListRow(icon: icon, tint: Theme.accent, title: title, subtitle: "装上豆豆，用配对码登录") {
                Image(systemName: expanded == id ? "chevron.up" : "chevron.down").font(Theme.font(size: 11, weight: .semibold)).foregroundStyle(Theme.faint)
            }
            .contentShape(Rectangle())
            .onTapGesture { withAnimation(.easeOut(duration: 0.2)) { expanded = expanded == id ? nil : id } }
            if expanded == id {
                VStack(alignment: .leading, spacing: 12) {
                    Text(id == "mac"
                         ? "1. 在那台 Mac 上下载豆豆（.dmg），拖进「应用程序」打开\n2. 登录页填写同一个云端地址，配对码填下面生成的 6 位码"
                         : "1. 在手机上下载豆豆（.apk）并安装\n2. 登录页填写同一个云端地址，配对码填下面生成的 6 位码")
                        .font(Theme.font(size: 12.5)).foregroundStyle(Theme.ink.opacity(0.85)).lineSpacing(4)
                    Link(destination: URL(string: "https://github.com/Xiamu-ssr/personal-agent/releases")!) {
                        Label("下载地址：github.com/Xiamu-ssr/personal-agent/releases", systemImage: "arrow.down.circle")
                            .font(Theme.font(size: 12.5, weight: .medium))
                    }
                    .foregroundStyle(Theme.link)
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
                            ListRow(icon: "wand.and.stars", tint: Theme.accent, title: s.name, subtitle: s.description)
                        }
                    }
                } else {
                    Note(text: !err.isEmpty ? err : skills == nil ? "加载中…" : "豆豆把常做的事整理成技能后会出现在这里", icon: "wand.and.stars")
                }
            }
            .card(radius: 16, padding: 10)
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

struct ServerAddressEditor:View {
    @Environment(\.dismiss) private var dismiss
    @State private var address=Prefs.server
    @State private var code=""
    @State private var saving=false
    @State private var error=""
    var body:some View {
        VStack(alignment:.leading,spacing:20) {
            Text("云端地址").font(Theme.titleFont(22))
            TextField("https://你的服务器/agent",text:$address).textFieldStyle(.roundedBorder)
            SecureField("新服务器的配对码",text:$code).textFieldStyle(.roundedBorder)
            Text("填写新服务器生成的配对码后连接。").font(Theme.font(size:12)).foregroundStyle(Theme.sub)
            if !error.isEmpty {Text(error).font(Theme.font(size:12))}
            HStack {Button("取消"){dismiss()}.buttonStyle(SoftButtonStyle());Spacer();Button(saving ? "连接中…":"连接"){save()}.buttonStyle(PrimaryButtonStyle()).disabled(saving || code.isEmpty)}
        }.padding(30).frame(width:460).background(Theme.background).foregroundStyle(Theme.ink).preferredColorScheme(Theme.scheme)
    }
    private func save() {
        saving=true;Task {defer{saving=false};do {
            let address=address.trimmingCharacters(in:.whitespacesAndNewlines).trimmingCharacters(in:CharacterSet(charactersIn:"/"))
            let token=try await Api.authenticate(server:address,password:code)
            ChatClient.shared.stop();ConnectorStore.shared.reset();ProfileStore.shared.reset();Api.clearCache()
            Prefs.server=address;Prefs.token=token;Session.shared.signedIn();dismiss()
        }catch{self.error=error.localizedDescription}}
    }
}
