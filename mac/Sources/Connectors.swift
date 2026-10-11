import Observation
import SwiftUI

struct ConnectorOption: Identifiable {
    let value: String
    let label: String
    var id: String { value }
}

struct ConnectorField: Identifiable {
    let key: String
    let label: String
    let type: String
    let placeholder: String
    let required: Bool
    let defaultValue: String
    let options: [ConnectorOption]
    let showIf: [String: String]
    let helpText: String
    let presetHelp: [String: String]
    var id: String { key }

    init(_ json: [String: Any]) {
        key = json["key"] as? String ?? ""
        label = json["label"] as? String ?? key
        type = json["type"] as? String ?? "text"
        placeholder = json["placeholder"] as? String ?? ""
        required = json["required"] as? Bool ?? false
        defaultValue = Self.string(json["default"])
        options = (json["options"] as? [[String: Any]] ?? []).map {
            ConnectorOption(value: Self.string($0["value"]), label: Self.string($0["label"]))
        }
        showIf = (json["showIf"] as? [String: Any] ?? [:]).mapValues(Self.string)
        helpText = json["help"] as? String ?? ""
        presetHelp = json["help"] as? [String: String] ?? [:]
    }

    static func string(_ value: Any?) -> String {
        if let value = value as? String { return value }
        if let value = value as? NSNumber { return value.stringValue }
        return ""
    }
    func visible(_ values: [String: String]) -> Bool { showIf.allSatisfy { values[$0.key] == $0.value } }
    func help(_ values: [String: String]) -> String { presetHelp[values["preset"] ?? ""] ?? helpText }
}

struct ConnectorAccount: Identifiable {
    let id: String
    let label: String
    let status: String
    let error: String
    let checkedAt: Date?
    let values: [String: String]?
}

struct CloudConnector: Identifiable {
    let name: String
    let title: String
    let description: String
    let icon: String
    let fields: [ConnectorField]?
    let multiAccount: Bool
    let accounts: [ConnectorAccount]
    let builtin: Bool
    let custom: Bool
    var id: String { name }
    var canAdd: Bool { !builtin && !custom && fields != nil && (multiAccount || accounts.isEmpty) }

    init(_ json: [String: Any], builtin: Bool = false, custom: Bool = false) {
        name = json["name"] as? String ?? ""
        title = json["title"] as? String ?? name
        description = json["description"] as? String ?? ""
        icon = connectorIcon(json["icon"] as? String ?? name)
        fields = (json["fields"] as? [[String: Any]])?.map(ConnectorField.init)
        multiAccount = json["multiAccount"] as? Bool ?? true
        self.builtin = builtin
        self.custom = custom || json["custom"] as? Bool == true
        let secrets = Set((fields ?? []).filter { $0.type == "secret" }.map(\.key))
        accounts = (json["accounts"] as? [[String: Any]] ?? []).map { row in
            // A misconfigured server cannot prefill a secret into a visible text field.
            var values = (row["values"] as? [String: Any])?.mapValues(ConnectorField.string)
            for key in secrets where values?[key] != nil { values?[key] = "••••" }
            return ConnectorAccount(id: row["id"] as? String ?? "", label: row["label"] as? String ?? "账号",
                                    status: row["status"] as? String ?? "", error: row["error"] as? String ?? "",
                                    checkedAt: (row["checkedAt"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue / 1000) }, values: values)
        }
    }
}

func connectorIcon(_ name: String) -> String {
    switch name {
    case "web_search", "tavily": return "magnifyingglass"
    case "web_fetch": return "globe"
    case "shell": return "terminal"
    case "files": return "folder"
    case "schedule": return "clock"
    case "transcribe": return "waveform"
    case "email", "envelope": return "envelope"
    case "calendar": return "calendar"
    case "github": return "chevron.left.forwardslash.chevron.right"
    case "feishu": return "paperplane"
    case "notion": return "note.text"
    case "rss": return "dot.radiowaves.up.forward"
    default: return "puzzlepiece.extension"
    }
}

/// The draft stays in memory. A blank/masked secret is omitted from PUT so the server keeps it.
struct ConnectorDraft {
    let connector: CloudConnector
    let editing: Bool
    let partialEdit: Bool
    let initial: [String: String]

    init(connector: CloudConnector, account: ConnectorAccount? = nil) {
        self.connector = connector
        editing = account != nil
        partialEdit = account != nil && account?.values == nil
        initial = Dictionary(uniqueKeysWithValues: (connector.fields ?? []).map { field in
            (field.key, account == nil ? field.defaultValue : field.type == "secret" ? "" : account?.values?[field.key] ?? "")
        })
    }

    func payload(_ values: [String: String]) throws -> [String: Any] {
        var out: [String: Any] = [:]
        for field in connector.fields ?? [] where field.visible(values) {
            let raw = values[field.key] ?? ""
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if field.type == "secret", trimmed.isEmpty || raw == "••••" {
                if !editing && field.required { throw ApiError(code: 0, message: "请填写\(field.label)") }
                continue
            }
            if partialEdit && trimmed.isEmpty { continue }
            if field.required && trimmed.isEmpty { throw ApiError(code: 0, message: "请填写\(field.label)") }
            if field.type == "number", !trimmed.isEmpty {
                guard let number = Double(trimmed), number.isFinite else { throw ApiError(code: 0, message: "\(field.label)请填写数字") }
                out[field.key] = number
            } else { out[field.key] = field.type == "secret" ? raw : trimmed }
        }
        return out
    }

    func safeError(_ error: Error, values: [String: String]) -> String {
        var message = error.localizedDescription
        for field in connector.fields ?? [] where field.type == "secret" {
            let secret = values[field.key] ?? ""
            if !secret.isEmpty && secret != "••••" { message = message.replacingOccurrences(of: secret, with: "••••") }
        }
        return message
    }
}

/// Path components are encoded independently; account IDs can contain reserved URL characters.
enum ConnectorAPI {
    static func component(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/%?#"))) ?? ""
    }
    static func path(_ name: String, _ id: String? = nil) -> String {
        "/api/connectors/" + component(name) + "/accounts" + (id.map { "/" + component($0) } ?? "")
    }
    static func save(name: String, id: String?, values: [String: Any]) async throws {
        _ = try await Api.json(path(name, id), method: id == nil ? "POST" : "PUT", body: ["values": values])
    }
    static func test(name: String, id: String) async throws {
        _ = try await Api.json(path(name, id) + "/test", method: "POST")
    }
    static func delete(name: String, id: String) async throws {
        _ = try await Api.json(path(name, id), method: "DELETE")
    }
    static func removeDevice(_ id: String) async throws {
        _ = try await Api.json("/api/devices/" + component(id), method: "DELETE")
    }
}

struct ConnectorDetailPage: View {
    let name: String
    private var store: ConnectorStore { .shared }
    private var chat: ChatClient { .shared }
    @State private var working: String? = nil
    @State private var error = ""
    @State private var deleting: ConnectorAccount? = nil

    var body: some View {
        let connector = store.connector(name)
        SubPage(title: connector?.title ?? "连接器", subtitle: connector?.description ?? "") {
            if let connector {
                HStack(spacing: 16) {
                    IconTile(icon: connector.icon, tint: Theme.accent, size: 56)
                    Text(connector.custom ? "豆豆自建" : connector.builtin ? "内置能力" : "账号 · \(connector.accounts.count) 个")
                        .font(.system(size: 13)).foregroundStyle(Theme.sub)
                    Spacer()
                    if connector.custom || connector.builtin { GoldTag(text: connector.custom ? "豆豆自建" : "已连接") }
                }
                .card(radius: 22, padding: 20)
                if !error.isEmpty { Note(text: error, icon: "exclamationmark.circle") }
                if !store.error.isEmpty { Note(text: store.error, icon: "wifi.exclamationmark") }
                if connector.custom {
                    Note(text: "这是豆豆自建的连接器，配置由豆豆维护。这里只展示已接入的服务。")
                        .card(radius: 22, padding: 12)
                } else if connector.builtin {
                    Note(text: "这是豆豆的内置能力，无需另外配置账号。")
                        .card(radius: 22, padding: 12)
                } else {
                    accounts(connector)
                    if connector.canAdd {
                        Button("添加账号") { Nav.shared.push(.connectorForm(name: name, accountID: nil)) }
                            .buttonStyle(GoldButtonStyle(height: 40)).disabled(working != nil)
                    } else {
                        Text(connector.fields == nil ? "账号表单即将支持" : "这个连接器支持一个账号，可以编辑或删除后重新添加")
                            .font(.system(size: 12)).foregroundStyle(Theme.sub)
                    }
                }
            } else { Note(text: store.loaded ? "这个连接器已不在目录中，返回后刷新试试" : "加载中…") }
        }
        .task(id: chat.devicesVersion) { await store.load() }
        .alert("删除账号？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
            Button("删除", role: .destructive) { if let account = deleting { remove(account) } }
            Button("取消", role: .cancel) { deleting = nil }
        } message: { Text("删除「\(deleting?.label ?? "")」后，豆豆将无法继续读取这个账号。") }
    }

    private func accounts(_ connector: CloudConnector) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionTitle(text: "账号")
            if connector.accounts.isEmpty {
                Note(text: "还没有添加账号\n添加后，豆豆就能使用这个服务", icon: "person.crop.circle.badge.plus")
                    .card(radius: 22, padding: 14)
            }
            ForEach(connector.accounts) { account in
                HStack(alignment: .top, spacing: 18) {
                    VStack(alignment: .leading, spacing: 7) {
                        Text(account.label).font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.ink)
                        HStack(spacing: 6) {
                            Circle().fill(account.status == "ok" ? Theme.online : Theme.danger).frame(width: 7, height: 7)
                            Text(account.status == "ok" ? "已连接" : "连接异常")
                            if let checked = account.checkedAt { Text("· " + Fmt.ago(checked) + "验证") }
                        }
                        .font(.system(size: 11.5)).foregroundStyle(Theme.sub)
                        if account.status != "ok" {
                            Text(account.error.isEmpty ? "尚未通过验证" : account.error).font(.system(size: 12)).foregroundStyle(Theme.danger)
                        }
                    }
                    Spacer(minLength: 4)
                    HStack(spacing: 8) {
                        if connector.fields != nil {
                            Button("编辑") { Nav.shared.push(.connectorForm(name: name, accountID: account.id)) }.buttonStyle(SoftButtonStyle())
                        }
                        Button(working == account.id ? "正在测试…" : "重新测试") { test(account) }.buttonStyle(SoftButtonStyle())
                        Button("删除") { deleting = account }.buttonStyle(SoftButtonStyle()).foregroundStyle(Theme.danger)
                    }
                    .disabled(working != nil)
                }
                .card(radius: 20, padding: 18)
            }
        }
    }

    private func test(_ account: ConnectorAccount) {
        guard working == nil else { return }
        working = account.id; error = ""
        Task { @MainActor in
            defer { working = nil }
            do { try await ConnectorAPI.test(name: name, id: account.id) }
            catch { self.error = error.localizedDescription }
            await store.load()
        }
    }
    private func remove(_ account: ConnectorAccount) {
        guard working == nil else { return }
        deleting = nil; working = account.id; error = ""
        Task { @MainActor in
            defer { working = nil }
            do { try await ConnectorAPI.delete(name: name, id: account.id); await store.load() }
            catch { self.error = error.localizedDescription }
        }
    }
}

struct ConnectorFormPage: View {
    let name: String
    let accountID: String?
    private var store: ConnectorStore { .shared }
    @State private var draft: ConnectorDraft?
    @State private var values: [String: String] = [:]
    @State private var verifying = false
    @State private var error = ""

    var body: some View {
        SubPage(title: accountID == nil ? "添加账号" : "编辑账号", subtitle: draft?.connector.title ?? "") {
            if let draft {
                if draft.editing {
                    Text(draft.partialEdit ? "只填写要修改的项，未填写的配置会保留。授权码不修改请留空。" : "授权码不修改请留空，保存时会重新验证。")
                        .font(.system(size: 12.5)).foregroundStyle(Theme.sub)
                }
                VStack(alignment: .leading, spacing: 20) {
                    ForEach((draft.connector.fields ?? []).filter { $0.visible(values) }) { field in
                        ConnectorFieldView(field: field, values: $values, editing: draft.editing, partialEdit: draft.partialEdit)
                    }
                }
                .disabled(verifying)
                .card(radius: 22, padding: 24)
                .frame(maxWidth: 640, alignment: .leading)
                if !error.isEmpty { Note(text: error, icon: "exclamationmark.circle").frame(maxWidth: 640, alignment: .leading) }
                Button(verifying ? "正在验证…" : draft.editing ? "保存并验证" : "验证并添加") { save(draft) }
                    .buttonStyle(GoldButtonStyle(height: 42)).disabled(verifying)
            } else { Note(text: "找不到这个账号的表单，返回后刷新试试") }
        }
        .task {
            guard draft == nil, let connector = store.connector(name), connector.fields != nil, !connector.custom, !connector.builtin else { return }
            let account = connector.accounts.first { $0.id == accountID }
            guard accountID == nil || account != nil else { return }
            let seeded = ConnectorDraft(connector: connector, account: account)
            draft = seeded; values = seeded.initial
        }
    }

    private func save(_ draft: ConnectorDraft) {
        guard !verifying else { return }
        do {
            let body = try draft.payload(values)
            verifying = true; error = ""
            Task { @MainActor in
                defer { verifying = false }
                do {
                    try await ConnectorAPI.save(name: name, id: accountID, values: body)
                    values = [:] // Drop the secret before leaving the form.
                    await store.load()
                    if Nav.shared.stacks[Nav.shared.tab]?.last == .connectorForm(name: name, accountID: accountID) {
                        Nav.shared.pop()
                    }
                } catch { self.error = draft.safeError(error, values: values) }
            }
        } catch { self.error = draft.safeError(error, values: values) }
    }
}

private struct ConnectorFieldView: View {
    let field: ConnectorField
    @Binding var values: [String: String]
    let editing: Bool
    let partialEdit: Bool
    @State private var shown = false

    private var value: Binding<String> {
        Binding(get: { values[field.key] ?? "" }, set: { values[field.key] = $0 })
    }
    private var placeholder: String { editing && field.type == "secret" ? "不修改请留空" : partialEdit ? "留空保持原值" : field.placeholder }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(field.label + (field.required ? " *" : "")).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink)
            if field.type == "select" {
                Picker(field.label, selection: value) {
                    Text(partialEdit ? "保持原设置" : "请选择").tag("")
                    ForEach(field.options) { option in Text(option.label).tag(option.value) }
                }
                .labelsHidden().pickerStyle(.menu).frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("connector-field-" + field.key)
            } else {
                HStack(spacing: 8) {
                    if field.type == "secret" && !shown {
                        SecureField(placeholder, text: value).textFieldStyle(.plain).privacySensitive()
                            .accessibilityLabel(field.label).accessibilityIdentifier("connector-field-" + field.key)
                    } else {
                        TextField(placeholder, text: value).textFieldStyle(.plain)
                            .accessibilityLabel(field.label).accessibilityIdentifier("connector-field-" + field.key)
                            .privacySensitive(field.type == "secret")
                    }
                    if field.type == "secret" {
                        Button { shown.toggle() } label: { Image(systemName: shown ? "eye.slash" : "eye") }
                            .buttonStyle(.plain).foregroundStyle(Theme.sub).help(shown ? "隐藏\(field.label)" : "显示\(field.label)")
                    }
                }
                .font(.system(size: 14)).foregroundStyle(Theme.ink)
                .padding(.horizontal, 12).frame(height: 40)
                .background(RoundedRectangle(cornerRadius: 12).fill(Theme.field))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.line, lineWidth: 1))
            }
            let help = field.help(values)
            if !help.isEmpty { Text(help).font(.system(size: 11.5)).foregroundStyle(Theme.sub).fixedSize(horizontal: false, vertical: true) }
        }
    }
}
