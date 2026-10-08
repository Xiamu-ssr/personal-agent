import ServiceManagement
import SwiftUI
import UserNotifications

func markdown(_ s: String) -> AttributedString {
    (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
}

/// Server URL + a 6-digit pairing code (or the raw token), checked live against /api/state.
struct ConnectionFields: View {
    let okLabel: String
    let onOk: () -> Void
    @State private var server = Prefs.server
    @State private var token = Prefs.token
    @State private var code = ""
    @State private var useToken = !Prefs.token.isEmpty
    @State private var status = ""
    @State private var checking = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("云端地址", text: $server).textFieldStyle(.roundedBorder)
            if useToken {
                SecureField("口令（AGENT_TOKEN）", text: $token).textFieldStyle(.roundedBorder)
            } else {
                TextField("6 位配对码", text: $code).textFieldStyle(.roundedBorder)
                    .onChange(of: code) { _, v in
                        let f = String(v.filter { $0.isASCII && $0.isNumber }.prefix(6))
                        if f != v { code = f }
                    }
            }
            HStack {
                Button(checking ? "检查中…" : okLabel, action: connect)
                    .disabled(checking || (useToken ? token.isEmpty : code.count != 6))
                    .keyboardShortcut(.defaultAction)
                Button(useToken ? "用配对码" : "我有口令") { useToken.toggle() }.buttonStyle(.link)
                Spacer()
            }
            if !status.isEmpty { Text(status).font(.caption).foregroundStyle(.secondary) }
        }
    }

    private func connect() {
        let oldServer = Prefs.server
        let oldToken = Prefs.token
        Prefs.server = server
        checking = true
        Task { @MainActor in
            do {
                if useToken {
                    Prefs.token = token
                } else {
                    Prefs.token = ""
                    let r = try await Api.json("/api/pair", method: "POST", body: ["code": code])
                    guard let t = r["token"] as? String else { throw ApiError(code: 0, message: "云端没给口令") }
                    Prefs.token = t
                }
                let st = try await Api.json("/api/state")
                status = "连上了 · " + ((st["model"] as? String ?? "").split(separator: "/").last.map(String.init) ?? "")
                token = Prefs.token
                useToken = true
                code = ""
                onOk()
            } catch {
                status = "连不上：\(error.localizedDescription)"
                Prefs.server = oldServer
                Prefs.token = oldToken
            }
            checking = false
        }
    }
}

// MARK: - Menu-bar window

struct MenuView: View {
    @Environment(\.openWindow) private var openWindow
    @State private var input = ""
    private var chat: ChatClient { .shared }
    private var device: DeviceClient { .shared }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if chat.configured {
                messages
                Divider()
                composer
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    Text("先连上你的云端").font(.headline)
                    Text("在手机 App 的设置里点「生成配对码」，把 6 位码填在这里。").font(.caption).foregroundStyle(.secondary)
                    ConnectionFields(okLabel: "连接") {
                        ChatClient.shared.reconnect()
                        DeviceClient.shared.reregister()
                    }
                    Spacer()
                }
                .padding(16)
            }
        }
        .frame(width: 380, height: 540)
    }

    private var statusText: String {
        if !chat.configured { return "未连接" }
        if !chat.connected { return chat.error.isEmpty ? "连接中…" : chat.error }
        if chat.busy { return chat.toolHint.isEmpty ? "在想…" : chat.toolHint }
        return device.online ? "在线 · 本机已接入" : "在线"
    }

    private var header: some View {
        HStack(spacing: 8) {
            Circle().fill(chat.connected ? Color.green : Color.secondary.opacity(0.5)).frame(width: 8, height: 8)
            Text("豆豆").font(.headline)
            Text(statusText).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            Spacer()
            Button {
                openWindow(id: "settings")
                NSApp.activate(ignoringOtherApps: true)
            } label: { Image(systemName: "gearshape") }
                .buttonStyle(.borderless).help("设置")
            Button { NSApp.terminate(nil) } label: { Image(systemName: "power") }
                .buttonStyle(.borderless).help("退出豆豆")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var messages: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(chat.items) { ItemRow(item: $0) }
                    if !chat.streaming.isEmpty { Bubble(text: chat.streaming, mine: false) }
                    if chat.busy {
                        Text(chat.toolHint.isEmpty ? "豆豆在想…" : chat.toolHint).font(.caption).foregroundStyle(.secondary)
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(12)
            }
            .onAppear { proxy.scrollTo("end", anchor: .bottom) }
            .onChange(of: chat.items.count) { proxy.scrollTo("end", anchor: .bottom) }
            .onChange(of: chat.streaming) { proxy.scrollTo("end", anchor: .bottom) }
        }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("跟豆豆说…（⌥↩ 换行）", text: $input, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...6)
                .onSubmit(send)
            if chat.busy {
                Button { chat.interrupt() } label: { Image(systemName: "stop.circle.fill").font(.title2) }
                    .buttonStyle(.borderless).help("停下")
            } else {
                Button(action: send) { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                    .buttonStyle(.borderless)
                    .disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(12)
    }

    private func send() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        chat.send(text)
        input = ""
    }
}

struct ItemRow: View {
    let item: ChatItem

    var body: some View {
        switch item.kind {
        case .user: Bubble(text: item.text, mine: true)
        case .assistant: Bubble(text: item.text, mine: false)
        case .note: Text(item.text).font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity)
        case .card: CardRow(title: item.text, path: item.path)
        }
    }
}

struct Bubble: View {
    let text: String
    let mine: Bool

    var body: some View {
        HStack {
            if mine { Spacer(minLength: 40) }
            Text(markdown(text))
                .textSelection(.enabled)
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(mine ? Color.accentColor.opacity(0.18) : Color.secondary.opacity(0.10), in: RoundedRectangle(cornerRadius: 10))
            if !mine { Spacer(minLength: 40) }
        }
    }
}

/// A brief or site the agent produced; opens in the default app.
struct CardRow: View {
    let title: String
    let path: String?
    @State private var err = ""

    var body: some View {
        Button {
            guard let path else { return }
            Task { @MainActor in
                do { try await Api.openFile(path); err = "" } catch { err = "打不开：\(error.localizedDescription)" }
            }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "doc.richtext").font(.title3)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title.isEmpty ? "简报" : title).fontWeight(.medium)
                    Text(err.isEmpty ? (path ?? "") : err).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
                Spacer()
            }
            .padding(10)
            .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(path == nil)
    }
}

// MARK: - Settings window

struct CapToggle: View {
    let cap: Capability
    @State private var on: Bool

    init(cap: Capability) {
        self.cap = cap
        _on = State(initialValue: Prefs.granted(cap.name))
    }

    var body: some View {
        Toggle(isOn: Binding(get: { on }, set: { v in
            on = v
            Prefs.setGranted(cap.name, v)
            if v && cap.name == "notify" {
                UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
            }
            DeviceClient.shared.reregister()
        })) {
            VStack(alignment: .leading, spacing: 2) {
                Text(cap.title)
                Text(cap.hint ?? cap.description).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

struct SettingsView: View {
    @State private var name = Prefs.deviceName
    @State private var folder = Prefs.folder
    @State private var loginItem = SMAppService.mainApp.status == .enabled
    @State private var loginNote = ""
    @State private var pairCode = ""
    private var device: DeviceClient { .shared }

    private var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    }

    var body: some View {
        Form {
            Section("这台 Mac 的能力") {
                Text(device.online ? "已接入云端 · 设备名「\(Prefs.deviceName)」" : "未接入（检查网络或口令）")
                    .font(.caption).foregroundStyle(.secondary)
                ForEach(Capabilities.all) { CapToggle(cap: $0) }
                HStack {
                    Text("授权文件夹")
                    Spacer()
                    Text(folder.map { ($0 as NSString).abbreviatingWithTildeInPath } ?? "未选")
                        .foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    Button("选择…", action: pickFolder)
                }
                HStack {
                    TextField("设备名（豆豆这样叫这台 Mac）", text: $name)
                    Button("保存") {
                        Prefs.deviceName = name
                        device.reregister()
                    }
                }
            }
            Section("连接") {
                ConnectionFields(okLabel: "保存并重连") {
                    ChatClient.shared.reconnect()
                    device.reregister()
                }
            }
            Section("给另一台设备配对") {
                HStack {
                    Button("生成配对码", action: newCode).disabled(!Prefs.configured)
                    if !pairCode.isEmpty {
                        Text(pairCode).font(.system(.title3, design: .monospaced)).textSelection(.enabled)
                    }
                }
                Text("新码 24 小时内有效、只能用一次；会顶掉之前没用的码。").font(.caption).foregroundStyle(.secondary)
            }
            Section("其他") {
                Toggle("登录时自动打开", isOn: Binding(get: { loginItem }, set: setLogin))
                if !loginNote.isEmpty { Text(loginNote).font(.caption).foregroundStyle(.secondary) }
                Text("版本 \(version)").font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .frame(width: 480, height: 660)
    }

    private func pickFolder() {
        let p = NSOpenPanel()
        p.canChooseDirectories = true
        p.canChooseFiles = false
        p.prompt = "授权给豆豆"
        guard p.runModal() == .OK, let url = p.url else { return }
        Prefs.folder = url.path
        folder = url.path
        device.reregister()
    }

    private func newCode() {
        Task { @MainActor in
            do {
                pairCode = try await Api.json("/api/pair/new", method: "POST")["code"] as? String ?? ""
            } catch {
                pairCode = "失败：\(error.localizedDescription)"
            }
        }
    }

    private func setLogin(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            loginNote = ""
        } catch {
            loginNote = "设置失败：\(error.localizedDescription)（先把豆豆拖进「应用程序」再试）"
        }
        loginItem = SMAppService.mainApp.status == .enabled
    }
}
