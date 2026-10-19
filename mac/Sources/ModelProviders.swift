import SwiftUI
import Observation

struct ModelSelection: Equatable, Hashable {
    let provider: String
    let id: String
    init(provider: String, id: String) { self.provider = provider; self.id = id }
    init?(_ row: [String: Any]) {
        guard let provider = row["provider"] as? String, !provider.isEmpty,
              let id = row["id"] as? String, !id.isEmpty else { return nil }
        self.init(provider: provider, id: id)
    }
    var json: [String: Any] { ["provider": provider, "id": id] }
}

struct ProviderModel: Identifiable, Equatable {
    let id: String
    let name: String
    let note: String
    init?(_ row: [String: Any]) {
        guard let id = row["id"] as? String, !id.isEmpty,
              let name = row["name"] as? String, !name.isEmpty,
              row["note"] == nil || row["note"] is String else { return nil }
        self.id = id; self.name = name; note = row["note"] as? String ?? ""
    }
}

struct ProviderPreset: Identifiable, Equatable {
    let id: String
    let name: String
    let protocolName: String
    let baseURL: String
    let hint: String
    let models: [ProviderModel]
    init?(_ row: [String: Any]) {
        guard let id = row["id"] as? String, !id.isEmpty, let name = row["name"] as? String, !name.isEmpty,
              let protocolName = row["protocol"] as? String, ["anthropic", "openai"].contains(protocolName),
              let baseURL = row["baseUrl"] as? String, Api.serverURL(baseURL) != nil,
              let hint = row["hint"] as? String, let raw = row["models"] as? [[String: Any]], !raw.isEmpty else { return nil }
        let models = raw.compactMap(ProviderModel.init)
        guard models.count == raw.count, models.count <= 20, Set(models.map(\.id)).count == models.count else { return nil }
        self.id = id; self.name = name; self.protocolName = protocolName; self.baseURL = baseURL; self.hint = hint; self.models = models
    }
}

/// Only public provider metadata enters settings state. API keys are never decoded here.
struct ModelProvider: Identifiable, Equatable {
    let id: String
    let name: String
    let protocolName: String
    let builtin: Bool
    let baseURL: String?
    let keyHint: String?
    let models: [ProviderModel]
    init?(_ row: [String: Any]) {
        guard let id = row["id"] as? String, !id.isEmpty,
              let name = row["name"] as? String, !name.isEmpty,
              let builtin = row["builtin"] as? Bool, let protocolName=row["protocol"] as? String, ["anthropic","openai"].contains(protocolName),
              let raw = row["models"] as? [[String: Any]], !raw.isEmpty else { return nil }
        let models = raw.compactMap(ProviderModel.init)
        guard models.count == raw.count, Set(models.map(\.id)).count == models.count else { return nil }
        if !builtin {
            guard let url = row["baseUrl"] as? String, Api.serverURL(url) != nil,
                  row["keyHint"] == nil || row["keyHint"] is String else { return nil }
        }
        self.protocolName=protocolName; self.id = id; self.name = name; self.builtin = builtin; self.models = models
        baseURL = builtin ? nil : row["baseUrl"] as? String
        if !builtin, let hint = row["keyHint"] as? String, !hint.isEmpty { keyHint = "••••" + hint.suffix(4) }
        else { keyHint = nil }
    }
}

struct ProviderModelDraft: Identifiable, Equatable {
    var id = UUID()
    var modelID = ""
    var name = ""
}

/// Debug descriptions deliberately exclude all field values, including URLs and key material.
struct ProviderDraft: CustomStringConvertible, CustomDebugStringConvertible {
    var name = ""
    var baseURL = ""
    var apiKey = ""
    var protocolName = "anthropic"
    var models = [ProviderModelDraft()]
    init(provider: ModelProvider? = nil) {
        if let provider {
            protocolName=provider.protocolName; name = provider.name; baseURL = provider.baseURL ?? ""
            models = provider.models.map { ProviderModelDraft(modelID: $0.id, name: $0.name) }
        }
    }
    init(preset: ProviderPreset) {
        name = preset.name; baseURL = preset.baseURL; protocolName = preset.protocolName
        models = preset.models.map { ProviderModelDraft(modelID: $0.id, name: $0.name) }
    }
    var description: String { "ProviderDraft(fields: redacted, models: \(models.count))" }
    var debugDescription: String { description }

    func payload(editing: Bool) throws -> [String: Any] {
        func trimmed(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }
        func invalid(_ text: String) -> ApiError { ApiError(code: 0, message: text) }
        let name = trimmed(name), url = trimmed(baseURL), key = trimmed(apiKey)
        guard (1...40).contains(name.count) else { throw invalid("名称请填 1–40 个字") }
        guard Api.serverURL(url) != nil else { throw invalid("Base URL 请填 http 或 https 地址，不带 query 和 hash") }
        guard editing || !key.isEmpty else { throw invalid("请填写 API Key") }
        guard (1...20).contains(models.count) else { throw invalid("请添加 1–20 个模型") }
        var ids = Set<String>(), rows = [[String: Any]]()
        for (index, model) in models.enumerated() {
            let id = trimmed(model.modelID), name = trimmed(model.name)
            guard (1...200).contains(id.count) else { throw invalid("第 \(index + 1) 个模型的 ID 请填 1–200 个字") }
            guard (1...40).contains(name.count) else { throw invalid("第 \(index + 1) 个模型的显示名请填 1–40 个字") }
            guard ids.insert(id).inserted else { throw invalid("同一服务里的模型 ID 不能重复") }
            rows.append(["id": id, "name": name])
        }
        var normalized = url
        while normalized.hasSuffix("/") { normalized.removeLast() }
        var body: [String: Any] = ["protocol":protocolName,"name": name, "baseUrl": normalized, "models": rows]
        if !key.isEmpty { body["apiKey"] = key }
        return body
    }
}

enum ProviderSecret {
    /// Upstream error messages can echo a submitted credential. Keep the useful error, remove the secret.
    static func safeError(_ text: String, key: String) -> String {
        var result = text
        let key = key.trimmingCharacters(in: .whitespacesAndNewlines)
        if !key.isEmpty {
            result = result.replacingOccurrences(of: key, with: "[已隐藏]")
            if let encoded = key.addingPercentEncoding(withAllowedCharacters: .alphanumerics), encoded != key {
                result = result.replacingOccurrences(of: encoded, with: "[已隐藏]", options: .caseInsensitive)
            }
        }
        for pattern in [#"(?i)\bsk-[A-Za-z0-9_.\-]+"#,
                        #"(?i)(bearer\s+)[^\s\"',;]+"#,
                        #"(?i)((?:x-api-key|api_?key|authorization)[\"']?\s*[:=]\s*[\"']?)[^\s\"',;}]+"#] {
            if let regex = try? NSRegularExpression(pattern: pattern) {
                result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: regex.numberOfCaptureGroups > 0 ? "$1[已隐藏]" : "[已隐藏]")
            }
        }
        return result
    }
}

@MainActor @Observable final class ProviderFormModel: CustomStringConvertible, CustomDebugStringConvertible {
    let provider: ModelProvider?
    let presets: [ProviderPreset]
    var presetID: String
    var draft: ProviderDraft
    private(set) var working = false
    private(set) var deleting = false
    private(set) var error = ""
    init(provider: ModelProvider? = nil, presets: [ProviderPreset] = []) {
        self.provider = provider; self.presets = presets; presetID = ""
        draft = ProviderDraft(provider: provider)
        if provider == nil, let first = presets.first { presetID = first.id; draft = ProviderDraft(preset: first) }
    }
    func choosePreset(_ id: String) {
        guard provider == nil, !working, id != presetID else { return }
        presetID = id
        // A key entered for one vendor must never silently move to another endpoint.
        draft = presets.first(where: { $0.id == id }).map(ProviderDraft.init(preset:)) ?? ProviderDraft()
        error = ""
    }
    nonisolated var description: String { "ProviderFormModel(fields: redacted)" }
    nonisolated var debugDescription: String { description }

    func save() async -> Bool {
        guard !working, provider?.builtin != true else { return false }
        let submittedKey = draft.apiKey
        error = ""
        do {
            let body = try draft.payload(editing: provider != nil)
            working = true; defer { working = false }
            let path = provider.map { "/api/providers/" + Api.query($0.id) } ?? "/api/providers"
            let response = try await Api.json(path, method: provider == nil ? "POST" : "PATCH", body: body)
            guard let row = response["provider"] as? [String: Any], let saved = ModelProvider(row), !saved.builtin,
                  provider == nil || saved.id == provider?.id else { throw ApiError(code: 0, message: "服务返回的数据不完整，请重试") }
            draft.apiKey = ""
            await AgentSettingsStore.shared.load()
            return true
        } catch {
            self.error = ProviderSecret.safeError(error.localizedDescription, key: submittedKey)
            return false
        }
    }
    func delete() async -> Bool {
        guard !working, let provider, !provider.builtin else { return false }
        working = true; deleting = true; error = ""
        defer { working = false; deleting = false }
        do {
            _ = try await Api.json("/api/providers/" + Api.query(provider.id), method: "DELETE")
            draft.apiKey = ""
            await AgentSettingsStore.shared.load()
            return true
        } catch { self.error = ProviderSecret.safeError(error.localizedDescription, key: draft.apiKey); return false }
    }
}

private struct ProviderIcon: View {
    let name: String
    var body: some View {
        Text(String(name.prefix(1)).uppercased()).font(Theme.font(size: 15, weight: .semibold))
            .frame(width: 32, height: 32).background(Theme.userBubble, in: RoundedRectangle(cornerRadius: 10))
    }
}

struct ModelSettingsPage: View {
    private var store: AgentSettingsStore { .shared }
    var body: some View {
        SubPage(title: "模型", subtitle: "选中即保存，从下一轮开始生效", trailing: {
            Button { Nav.shared.push(.modelProvider(nil)) } label: { Label("添加模型服务", systemImage: "plus") }
                .buttonStyle(SoftButtonStyle()).verificationAction("provider-add")
        }, content: {
            if let snapshot = store.snapshot {
                ForEach(snapshot.providers.filter(\.builtin) + snapshot.providers.filter { !$0.builtin }) { provider in
                    VStack(alignment: .leading, spacing: 12) {
                        HStack(spacing: 10) {
                            ProviderIcon(name: provider.name)
                            Text(provider.builtin ? provider.name + "（内置）" : provider.name).font(Theme.font(size: 14, weight: .semibold))
                            Spacer()
                            if !provider.builtin {
                                Button("编辑") { Nav.shared.push(.modelProvider(provider.id)) }.buttonStyle(SoftButtonStyle())
                                    .verificationAction("provider-edit-" + provider.id)
                            }
                        }.padding(.horizontal, 4)
                        VStack(spacing: 0) {
                            ForEach(provider.models) { model in
                                let selection = ModelSelection(provider: provider.id, id: model.id)
                                Button { Task { await store.selectModel(selection) } } label: {
                                    HStack(spacing: 16) {
                                        Image(systemName: snapshot.model == selection ? "largecircle.fill.circle" : "circle").font(Theme.font(size: 20))
                                        VStack(alignment: .leading, spacing: 6) {
                                            Text(model.name).font(Theme.font(size: 15, weight: .medium))
                                            Text(model.note.isEmpty ? model.id : model.note).font(Theme.font(size: 12)).foregroundStyle(Theme.sub).lineLimit(1)
                                        }; Spacer()
                                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 18).padding(.vertical, 16).contentShape(Rectangle())
                                }.buttonStyle(.plain).disabled(store.saving || store.loading)
                                    .accessibilityLabel(provider.name + "，" + model.name)
                                    .accessibilityValue(snapshot.model == selection ? "已选择" : "未选择")
                                    .verificationAction("model-" + provider.id + "-" + model.id)
                                if model.id != provider.models.last?.id { Divider().overlay(Theme.line).padding(.leading, 54) }
                            }
                        }.card(radius: 16, padding: 0)
                    }
                }
            } else if store.loading { ActiveProgress().frame(maxWidth: .infinity).padding(30) }
            if !store.error.isEmpty { Note(text: store.error) }
        }).task(id: ChatClient.shared.settingsVersion) { await store.load() }
    }
}

struct ModelProviderFormPage: View {
    let providerID: String?
    @State private var form: ProviderFormModel
    @State private var showKey = false
    @State private var showDetails = false
    @State private var showModels = false
    init(providerID: String?) {
        self.providerID = providerID
        let snapshot = AgentSettingsStore.shared.snapshot
        _form = State(initialValue: ProviderFormModel(provider: snapshot?.providers.first { $0.id == providerID }, presets: snapshot?.providerPresets ?? []))
        _showDetails = State(initialValue: providerID != nil || snapshot?.providerPresets.isEmpty != false)
        _showModels = State(initialValue: providerID != nil || snapshot?.providerPresets.isEmpty != false)
    }
    private func leave() {
        if Nav.shared.stacks[Nav.shared.tab]?.last == .modelProvider(providerID) { Nav.shared.pop() }
    }
    var body: some View {
        @Bindable var form = form
        SubPage(title: providerID == nil ? "添加模型服务" : "编辑模型服务") {
            if providerID != nil && form.provider == nil { Note(text: "这个服务已不存在，请返回模型列表") }
            else {
                VStack(alignment: .leading, spacing: 18) {
                    if providerID == nil && !form.presets.isEmpty {
                        Picker("供应商", selection: Binding(get: { form.presetID }, set: { form.choosePreset($0); showKey = false; showDetails = $0.isEmpty; showModels = $0.isEmpty })) {
                            ForEach(form.presets) { Text($0.name).tag($0.id) }
                            Text("自定义").tag("")
                        }.verificationAction("provider-preset")
                        if let preset = form.presets.first(where: { $0.id == form.presetID }) {
                            Text(preset.hint).font(Theme.font(size: 12)).foregroundStyle(Theme.sub)
                        }
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        Text("API Key").font(Theme.font(size: 13, weight: .medium))
                        HStack(spacing: 10) {
                            Group {
                                if showKey { TextField(form.provider?.keyHint ?? "填写 API Key", text: $form.draft.apiKey) }
                                else { SecureField(form.provider?.keyHint ?? "填写 API Key", text: $form.draft.apiKey) }
                            }.textFieldStyle(.plain).font(Theme.font(size: 14)).privacySensitive()
                                .accessibilityIdentifier("provider-key").verificationAction("provider-key")
                            Button { showKey.toggle() } label: { Image(systemName: showKey ? "eye.slash" : "eye").foregroundStyle(Theme.sub) }
                                .buttonStyle(.plain).help(showKey ? "隐藏 Key" : "显示 Key").accessibilityLabel(showKey ? "隐藏 Key" : "显示 Key")
                                .verificationAction("provider-key-eye")
                        }.padding(.horizontal, 12).frame(height: 42).background(Theme.field, in: RoundedRectangle(cornerRadius: 12))
                        if form.provider != nil { Text("已保存 \(form.provider?.keyHint ?? "••••") · 留空表示不改").font(Theme.font(size: 12)).foregroundStyle(Theme.sub) }
                    }
                    VStack(alignment: .leading, spacing: 12) {
                        fold("服务设置", expanded: $showDetails, marker: "provider-details")
                        if showDetails {
                        VStack(alignment: .leading, spacing: 14) {
                            field("名称", placeholder: "例如：我的模型服务", value: $form.draft.name, marker: "provider-name")
                            field("Base URL", placeholder: "https://example.test", value: $form.draft.baseURL, marker: "provider-url")
                            HStack { Text("协议").font(Theme.font(size: 13, weight: .medium)); Spacer(); Picker("协议",selection:$form.draft.protocolName) { Text("Anthropic").tag("anthropic"); Text("OpenAI").tag("openai") }.labelsHidden().frame(width:140) }
                        }.padding(.top, 12)
                        }
                    }
                }
                Text(form.draft.models.map(\.name).filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(Theme.font(size: 12)).foregroundStyle(Theme.sub).fixedSize(horizontal: false, vertical: true)
                fold("模型（\(form.draft.models.count)）", expanded: $showModels, marker: "provider-models")
                if showModels {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Text("模型").font(Theme.font(size: 14, weight: .semibold)); Spacer()
                        Button { form.draft.models.append(ProviderModelDraft()) } label: { Label("添加模型", systemImage: "plus") }
                            .buttonStyle(SoftButtonStyle()).disabled(form.draft.models.count >= 20).verificationAction("provider-model-add")
                    }
                    ForEach($form.draft.models) { $model in
                        HStack(alignment: .bottom, spacing: 10) {
                            field("模型 ID", placeholder: "发给服务的模型 ID", value: $model.modelID, marker: "provider-model-id-" + model.id.uuidString)
                            field("显示名", placeholder: "App 里显示的名称", value: $model.name, marker: "provider-model-name-" + model.id.uuidString)
                            Button { form.draft.models.removeAll { $0.id == model.id } } label: { Image(systemName: "minus.circle").font(Theme.font(size: 18)).frame(width: 32, height: 42) }
                                .buttonStyle(.plain).help("删除模型").accessibilityLabel("删除模型").verificationAction("provider-model-remove-" + model.id.uuidString)
                        }
                    }
                    Text("可以添加 1–20 个模型；保存前会用第一个模型测试连接。")
                        .font(Theme.font(size: 12)).foregroundStyle(Theme.sub)
                }.padding(.top, 12)
                }
                if !form.error.isEmpty {
                    Text(form.error).font(Theme.font(size: 13)).foregroundStyle(Theme.ink).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(14)
                        .background(Theme.card, in: RoundedRectangle(cornerRadius: 12)).verificationAction("provider-error")
                }
                HStack(spacing: 12) {
                    Button { Task { if await form.save() { leave() } } } label: {
                        HStack(spacing: 8) { if form.working && !form.deleting { ActiveProgress().controlSize(.small) }; Text(form.working && !form.deleting ? "正在测试并保存…" : "测试并保存") }
                    }.buttonStyle(PrimaryButtonStyle()).verificationAction("provider-save")
                    Spacer()
                    if form.provider != nil {
                        Button { Task { if await form.delete() { leave() } } } label: { Text(form.deleting ? "正在删除…" : "删除服务") }
                            .buttonStyle(SoftButtonStyle()).verificationAction("provider-delete")
                    }
                }
            }
        }.disabled(form.working).onDisappear { form.draft.apiKey = ""; showKey = false }
        #if MAC_VERIFY
        .onAppear { ProviderFormVerification.current = form }
        #endif
    }
    private func fold(_ title: String, expanded: Binding<Bool>, marker: String) -> some View {
        Button { expanded.wrappedValue.toggle() } label: {
            HStack(spacing: 8) {
                Image(systemName: expanded.wrappedValue ? "chevron.down" : "chevron.right").font(Theme.font(size: 11)).foregroundStyle(Theme.sub)
                Text(title).font(Theme.font(size: 14, weight: .medium)); Spacer()
            }.padding(.vertical, 8).contentShape(Rectangle())
        }.buttonStyle(.plain).verificationAction(marker)
    }
    private func field(_ title: String, placeholder: String, value: Binding<String>, marker: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(Theme.font(size: 13, weight: .medium))
            TextField(placeholder, text: value).textFieldStyle(.plain).font(Theme.font(size: 14))
                .padding(.horizontal, 12).frame(height: 42).background(Theme.field, in: RoundedRectangle(cornerRadius: 12))
                .accessibilityIdentifier(marker).verificationAction(marker)
        }
    }
}

#if MAC_VERIFY
@MainActor enum ProviderFormVerification { static weak var current: ProviderFormModel? }
#endif
