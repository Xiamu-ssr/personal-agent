import SwiftUI
import Observation

enum ProductTime {
    static func date(_ value: Any?) -> Date? {
        if let number = value as? NSNumber { return Date(timeIntervalSince1970: number.doubleValue / 1000) }
        guard let text = value as? String else { return nil }
        let iso = ISO8601DateFormatter()
        if let date = iso.date(from: text) { return date }
        iso.formatOptions.insert(.withFractionalSeconds)
        return iso.date(from: text)
    }
}

struct AgentOption: Identifiable, Equatable {
    let id: String
    let label: String
    let note: String
    static func parse(_ row: [String: Any]) -> AgentOption? {
        guard let id = row["id"] as? String, !id.isEmpty, let label = row["label"] as? String,
              let note = row["note"] as? String else { return nil }
        return AgentOption(id: id, label: label, note: note)
    }
}

enum AgentSetting: String, Hashable {
    case model, permissionMode
    var title: String { self == .model ? "模型" : "权限" }
    var icon: String { self == .model ? "sparkles" : "checkmark.shield" }
}

struct AgentSettingsSnapshot {
    let model: ModelSelection
    let permissionMode: String
    let providers: [ModelProvider]
    let permissionModes: [AgentOption]

    static func parse(_ row: [String: Any]) throws -> AgentSettingsSnapshot {
        guard let model = (row["model"] as? [String: Any]).flatMap(ModelSelection.init),
              let mode = row["permissionMode"] as? String,
              let rawProviders = row["providers"] as? [[String: Any]],
              let rawModes = row["permissionModes"] as? [[String: Any]] else {
            throw ApiError(code: 0, message: "模型和权限设置暂时读不到")
        }
        let providers = rawProviders.compactMap(ModelProvider.init), modes = rawModes.compactMap(AgentOption.parse)
        guard providers.count == rawProviders.count, modes.count == rawModes.count,
              Set(providers.map(\.id)).count == providers.count,
              Set(modes.map(\.id)).count == modes.count,
              providers.contains(where: { $0.id == model.provider && $0.models.contains(where: { $0.id == model.id }) }),
              modes.contains(where: { $0.id == mode }) else {
            throw ApiError(code: 0, message: "模型和权限选项不完整，请重试")
        }
        return AgentSettingsSnapshot(model: model, permissionMode: mode, providers: providers, permissionModes: modes)
    }
    func label(_ setting: AgentSetting) -> String {
        if setting == .model { return providers.first { $0.id == model.provider }?.models.first { $0.id == model.id }?.name ?? "加载中…" }
        return permissionModes.first { $0.id == permissionMode }?.label ?? "加载中…"
    }
}

@MainActor @Observable final class AgentSettingsStore {
    static let shared = AgentSettingsStore()
    private(set) var snapshot: AgentSettingsSnapshot?
    private(set) var loading = false
    private(set) var saving = false
    @ObservationIgnored private var reloadRequested = false
    var error = ""

    private func finish() {
        if reloadRequested { reloadRequested = false; Task { await self.load() } }
    }
    func load() async {
        guard !loading, !saving else { reloadRequested = true; return }
        loading = true
        defer { loading = false; finish() }
        do {
            let response = try await Api.json("/api/settings")
            try Task.checkCancellation()
            snapshot = try AgentSettingsSnapshot.parse(response); error = ""
        } catch is CancellationError {} catch { self.error = error.localizedDescription }
    }
    func selectModel(_ model: ModelSelection) async {
        guard let snapshot, snapshot.model != model,
              snapshot.providers.contains(where: { $0.id == model.provider && $0.models.contains(where: { $0.id == model.id }) }) else { return }
        await update(["model": model.json])
    }
    func selectPermission(_ id: String) async {
        guard let snapshot, snapshot.permissionMode != id, snapshot.permissionModes.contains(where: { $0.id == id }) else { return }
        await update(["permissionMode": id])
    }
    private func update(_ body: [String: Any]) async {
        guard !saving, !loading else { return }
        saving = true; error = ""
        defer { saving = false; finish() }
        do { snapshot = try AgentSettingsSnapshot.parse(await Api.json("/api/settings", method: "PUT", body: body)) }
        catch { self.error = error.localizedDescription }
    }
}

struct AgentSettingPage: View {
    let setting: AgentSetting
    private var store: AgentSettingsStore { .shared }
    @Environment(\.interactiveWindow) private var active
    var body: some View {
        Group {
            if setting == .model { ModelSettingsPage() }
            else { SubPage(title: setting.title, subtitle: "从下一轮开始生效") {
                if let snapshot = store.snapshot {
                    Rows(items: snapshot.permissionModes) { option in
                        Button { Task { await store.selectPermission(option.id) } } label: {
                            HStack(spacing: 16) {
                                Image(systemName: snapshot.permissionMode == option.id ? "largecircle.fill.circle" : "circle").font(Theme.font(size: 20))
                                VStack(alignment: .leading, spacing: 7) {
                                    Text(option.label).font(Theme.font(size: 16, weight: .medium))
                                    Text(option.note).font(Theme.font(size: 13)).foregroundStyle(Theme.sub).lineLimit(1)
                                }; Spacer()
                            }.padding(.horizontal, 10).padding(.vertical, 18).contentShape(Rectangle())
                        }.buttonStyle(.plain)
                            .accessibilityLabel(option.label)
                            .accessibilityValue(snapshot.permissionMode == option.id ? "已选择" : "未选择")
                            .verificationAction(option.label).disabled(store.saving || store.loading)
                    }.card(radius: 16, padding: 14)
                }
                if !store.error.isEmpty { Note(text: store.error) }
            } }
        }.task(id: "\(ChatClient.shared.settingsVersion)-\(ChatClient.shared.connected)-\(active)") {
            await store.load()
            while active && !Task.isCancelled { do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { return }; await store.load() }
        }
    }
}
