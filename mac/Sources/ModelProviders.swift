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
    let usage: UsageSnapshot?
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
        usage = UsageSnapshot(row["usage"] as? [String: Any])
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
    var managementKey = ""
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
        if !trimmed(managementKey).isEmpty { body["managementKey"] = trimmed(managementKey) }
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
            self.error = ProviderSecret.safeError(ProviderSecret.safeError(error.localizedDescription, key: submittedKey), key: draft.managementKey)
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
    @State private var cardID: String?
    private let ink = Color(red: 0.28, green: 0.21, blue: 0.11)
    var body: some View {
        SubPage(title: "模型", subtitle: "滑动切换供应商，选择适合这次工作的模型", trailing: {
            Button { Task { await store.load() } } label: { Image(systemName: "arrow.clockwise") }.buttonStyle(SoftButtonStyle()).help("刷新余量")
        }, content: {
            if let snapshot = store.snapshot {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 16) {
                        ForEach(snapshot.providers) { provider in
                            providerCard(provider, selected: snapshot.model.provider == provider.id)
                                .frame(width: 390, height: 226).id(provider.id)
                        }
                        Button { Nav.shared.push(.modelProvider(nil)) } label: {
                            VStack(spacing: 12) {
                                Image(systemName: "plus").font(Theme.font(size: 30, weight: .light)).foregroundStyle(Theme.accent)
                                Text("添加模型服务").font(Theme.font(size: 17, weight: .medium)).foregroundStyle(Theme.ink)
                                Text("你的下一张卡片").font(Theme.font(size: 12)).foregroundStyle(Theme.sub)
                            }.frame(width: 390, height: 226).background(Theme.field, in: RoundedRectangle(cornerRadius: 24))
                                .overlay(RoundedRectangle(cornerRadius: 24).strokeBorder(Theme.line, lineWidth: 1))
                        }.buttonStyle(.plain).verificationAction("provider-add").id("add")
                    }.scrollTargetLayout().padding(.vertical, 8)
                }.scrollTargetBehavior(.viewAligned).scrollPosition(id: $cardID, anchor: .leading)
                HStack(spacing: 8) {
                    ForEach(snapshot.providers.map(\.id) + ["add"], id: \.self) { id in
                        Button { withAnimation(.easeInOut(duration: 0.25)) { cardID = id } } label: {
                            Capsule().fill(cardID == id ? Theme.accent : Theme.line).frame(width: cardID == id ? 18 : 6, height: 6).padding(.vertical, 8)
                        }.buttonStyle(.plain).verificationAction("provider-card-" + id).accessibilityLabel(id == "add" ? "新增供应商" : snapshot.providers.first { $0.id == id }?.name ?? "供应商")
                    }
                }.frame(maxWidth: .infinity)
                if let provider = snapshot.providers.first(where: { $0.id == (cardID ?? snapshot.model.provider) }) {
                    HStack { Text("选择模型").font(Theme.font(size: 17, weight: .medium)); Spacer(); Text(provider.name).font(Theme.font(size: 12)).foregroundStyle(Theme.sub) }
                    VStack(spacing: 0) {
                        ForEach(provider.models) { model in
                            let selection = ModelSelection(provider: provider.id, id: model.id)
                            Button { Task { await store.selectModel(selection) } } label: {
                                HStack(spacing: 16) {
                                    VStack(alignment: .leading, spacing: 6) {
                                        Text(model.name).font(Theme.font(size: 15, weight: .medium)).foregroundStyle(Theme.ink)
                                        Text(model.note.isEmpty ? model.id : model.note).font(Theme.font(size: 12)).foregroundStyle(Theme.sub).lineLimit(1)
                                    }
                                    Spacer()
                                    Image(systemName: snapshot.model == selection ? "checkmark.circle.fill" : "circle").font(Theme.font(size: 20)).foregroundStyle(snapshot.model == selection ? Theme.accent : Theme.sub.opacity(0.5))
                                }.padding(.horizontal, 18).padding(.vertical, 16).contentShape(Rectangle())
                            }.buttonStyle(.plain).disabled(store.saving || store.loading).verificationAction("model-" + provider.id + "-" + model.id)
                            if model.id != provider.models.last?.id { Divider().overlay(Theme.line).padding(.horizontal, 18) }
                        }
                    }.card(radius: 16, padding: 0)
                }
            } else if store.loading { ActiveProgress().frame(maxWidth: .infinity).padding(30) }
            if !store.error.isEmpty { Note(text: store.error) }
        })
        .task(id: ChatClient.shared.settingsVersion) { await store.load(); if cardID == nil { cardID = store.snapshot?.model.provider } }
        .onChange(of: cardID) { _, id in
            guard let snapshot = store.snapshot, let provider = snapshot.providers.first(where: { $0.id == id }), provider.id != snapshot.model.provider, !store.saving else { return }
            Task { await store.selectModel(ModelSelection(provider: provider.id, id: provider.models[0].id)) }
        }
    }
    private func providerCard(_ provider: ModelProvider, selected: Bool) -> some View {
        ZStack(alignment: .trailing) {
            RoundedRectangle(cornerRadius: 24).fill(LinearGradient(colors: [Color(red: 0.93, green: 0.85, blue: 0.67), Color(red: 0.98, green: 0.93, blue: 0.81), Color(red: 0.79, green: 0.68, blue: 0.47)], startPoint: .topLeading, endPoint: .bottomTrailing))
            Text(provider.name.uppercased()).font(Theme.font(size: 64, weight: .black)).foregroundStyle(ink.opacity(0.055)).fixedSize().offset(x: 12, y: 14)
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("DOUDOU  /  MODEL ACCESS").font(Theme.font(size: 9)).tracking(1.2).foregroundStyle(ink.opacity(0.55))
                        Text(provider.name).font(Theme.font(size: 24, weight: .medium)).foregroundStyle(ink)
                    }
                    Spacer()
                    if !provider.builtin { Button { Nav.shared.push(.modelProvider(provider.id)) } label: { Image(systemName: "ellipsis").font(Theme.font(size: 18)).frame(width: 30, height: 30).foregroundStyle(ink) }.buttonStyle(.plain).help("编辑供应商").verificationAction("provider-edit-" + provider.id) }
                }
                Spacer()
                HStack(alignment: .bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        if let usage=provider.usage,usage.visible {
                            if let first=usage.items.first {Text(first.label).font(Theme.font(size:10)).foregroundStyle(ink.opacity(0.55))}
                            Text(usage.headline).font(Theme.font(size:usage.items.isEmpty ? 13:27,weight:.medium)).foregroundStyle(ink)
                        } else {Text("已连接").font(Theme.font(size:13)).foregroundStyle(ink.opacity(0.75))}
                        if let second = provider.usage?.items.dropFirst().first { Text(second.label + " · " + second.amount).font(Theme.font(size: 10)).foregroundStyle(ink.opacity(0.6)) }
                        if let fraction = provider.usage?.items.first?.fraction {
                            GeometryReader { proxy in Capsule().fill(ink.opacity(0.12)).overlay(alignment: .leading) { Capsule().fill(ink.opacity(0.65)).frame(width: proxy.size.width * fraction) } }.frame(width: 170, height: 3)
                        }
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 8) {
                        if selected { Text("● 使用中").font(Theme.font(size: 10)).foregroundStyle(ink) }
                        Text(provider.keyHint ?? "SERVER ACCOUNT").font(Theme.font(size: 10)).foregroundStyle(ink.opacity(0.6))
                    }
                }
            }.padding(24)
        }.clipShape(RoundedRectangle(cornerRadius: 24)).overlay(RoundedRectangle(cornerRadius: 24).strokeBorder(.white.opacity(0.5), lineWidth: 1))
    }
}

struct ModelProviderFormPage: View {
    let providerID: String?
    @State private var form: ProviderFormModel
    @State private var showKey = false
    @State private var confirmDeletion = false
    @State private var showPresetMenu = false
    @State private var showDetails = false
    @State private var showModels = false
    @FocusState private var focusedField: String?
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
                        Button { showPresetMenu = true } label: {
                            HStack(spacing: 12) {
                                Text("供应商").font(Theme.font(size: 13)).foregroundStyle(Theme.sub)
                                Spacer()
                                Text(form.presets.first { $0.id == form.presetID }?.name ?? "自定义").font(Theme.font(size: 14, weight: .medium))
                                Image(systemName: "chevron.down").font(Theme.font(size: 10, weight: .semibold)).foregroundStyle(Theme.sub)
                            }.foregroundStyle(Theme.ink).padding(16).background(Theme.field, in: RoundedRectangle(cornerRadius: 14))
                                .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.line, lineWidth: 0.6))
                        }.buttonStyle(.plain).verificationAction("provider-preset")
                        .popover(isPresented: $showPresetMenu, arrowEdge: .top) {
                            ScrollView {
                                VStack(spacing: 4) {
                                    ForEach(form.presets) { preset in
                                        presetOption(preset.name, id: preset.id)
                                    }
                                    Divider().padding(.vertical, 4)
                                    presetOption("自定义", id: "")
                                }.padding(10)
                            }.frame(width: 280, height: 380).background(Theme.card)
                        }
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
                                .focused($focusedField, equals: "provider-key")
                                .accessibilityIdentifier("provider-key").verificationAction("provider-key")
                            Button { showKey.toggle() } label: { Image(systemName: showKey ? "eye.slash" : "eye").foregroundStyle(Theme.sub).frame(width: 32, height: 32).contentShape(Rectangle()) }
                                .buttonStyle(.plain).help(showKey ? "隐藏 Key" : "显示 Key").accessibilityLabel(showKey ? "隐藏 Key" : "显示 Key")
                                .verificationAction("provider-key-eye")
                        }.padding(.horizontal, 14).frame(height: 46).background(Theme.field, in: RoundedRectangle(cornerRadius: 14))
                            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(focusedField == "provider-key" ? Theme.accent.opacity(0.5) : Theme.line, lineWidth: focusedField == "provider-key" ? 1 : 0.6).allowsHitTesting(false))
                        if form.provider != nil { Text("已保存 \(form.provider?.keyHint ?? "••••") · 留空表示不改").font(Theme.font(size: 12)).foregroundStyle(Theme.sub) }
                    }
                    if form.draft.baseURL.contains("zenmux.ai") {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("管理 Key · 可选").font(Theme.font(size: 13, weight: .medium))
                            SecureField(form.provider == nil ? "用于查询订阅额度和余额" : "留空保持不变", text: $form.draft.managementKey)
                                .textFieldStyle(.plain).privacySensitive().padding(14).background(Theme.field, in: RoundedRectangle(cornerRadius: 14))
                            Text("ZenMux 的额度查询需要单独的 Management API Key。").font(Theme.font(size: 11)).foregroundStyle(Theme.sub)
                        }
                    }
                    VStack(alignment: .leading, spacing: 12) {
                        fold("服务设置", expanded: $showDetails, marker: "provider-details")
                        if showDetails {
                        VStack(alignment: .leading, spacing: 14) {
                            field("名称", placeholder: "例如：我的模型服务", value: $form.draft.name, marker: "provider-name")
                            field("Base URL", placeholder: "https://example.test", value: $form.draft.baseURL, marker: "provider-url")
                            HStack { Text("协议").font(Theme.font(size: 13, weight: .medium)); Spacer(); Picker("协议",selection:$form.draft.protocolName) { Text("Anthropic").tag("anthropic"); Text("OpenAI").tag("openai") }.labelsHidden().pickerStyle(.segmented).frame(width:200) }
                        }.padding(.top, 12)
                        }
                    }
                }
                Text(modelSummary)
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
                        Button { confirmDeletion = true } label: { Text(form.deleting ? "正在删除…" : "删除服务") }
                            .buttonStyle(SoftButtonStyle()).verificationAction("provider-delete")
                    }
                }
            }
        }.disabled(form.working).onDisappear { form.draft.apiKey = ""; form.draft.managementKey = ""; showKey = false }
        .confirmationDialog("删除模型服务？", isPresented: $confirmDeletion) {
            Button("删除服务", role: .destructive) { Task { if await form.delete() { leave() } } }
        } message: { Text("将移除这个服务及其模型；正在使用时，会切换到其他已配置的服务。") }
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
    private var modelSummary: String {
        let names = form.draft.models.map(\.name).filter { !$0.isEmpty }
        return names.prefix(3).joined(separator: " · ") + (names.count > 3 ? " 等 \(names.count) 个模型" : "")
    }
    private func presetOption(_ name: String, id: String) -> some View {
        Button {
            form.choosePreset(id); showKey = false; showDetails = id.isEmpty; showModels = id.isEmpty; showPresetMenu = false
        } label: {
            HStack {
                Text(name).font(Theme.font(size: 13)); Spacer()
                if form.presetID == id { Image(systemName: "checkmark").font(Theme.font(size: 12, weight: .semibold)).foregroundStyle(Theme.accent) }
            }.padding(11).background(form.presetID == id ? Theme.field : .clear, in: RoundedRectangle(cornerRadius: 10))
                .contentShape(Rectangle())
        }.buttonStyle(.plain).foregroundStyle(Theme.ink).verificationAction("provider-preset-option-" + id)
    }
    private func field(_ title: String, placeholder: String, value: Binding<String>, marker: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(Theme.font(size: 13, weight: .medium))
            TextField(placeholder, text: value).textFieldStyle(.plain).font(Theme.font(size: 14))
                .focused($focusedField, equals: marker)
                .padding(.horizontal, 14).frame(height: 46).background(Theme.field, in: RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(focusedField == marker ? Theme.accent.opacity(0.5) : Theme.line, lineWidth: focusedField == marker ? 1 : 0.6).allowsHitTesting(false))
                .accessibilityIdentifier(marker).verificationAction(marker)
        }
    }
}

#if MAC_VERIFY
@MainActor enum ProviderFormVerification { static weak var current: ProviderFormModel? }
#endif
