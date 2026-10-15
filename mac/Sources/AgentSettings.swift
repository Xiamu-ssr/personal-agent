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
    let model: String
    let permissionMode: String
    let models: [AgentOption]
    let permissionModes: [AgentOption]

    static func parse(_ row: [String: Any]) throws -> AgentSettingsSnapshot {
        guard let model = row["model"] as? String, let mode = row["permissionMode"] as? String,
              let rawModels = row["models"] as? [[String: Any]], let rawModes = row["permissionModes"] as? [[String: Any]] else {
            throw ApiError(code: 0, message: "模型和权限设置暂时读不到")
        }
        let models = rawModels.compactMap(AgentOption.parse), modes = rawModes.compactMap(AgentOption.parse)
        guard models.count == rawModels.count, modes.count == rawModes.count,
              models.contains(where: { $0.id == model }), modes.contains(where: { $0.id == mode }),
              Set(models.map(\.id)).count == models.count, Set(modes.map(\.id)).count == modes.count else {
            throw ApiError(code: 0, message: "模型和权限选项不完整，请重试")
        }
        return AgentSettingsSnapshot(model: model, permissionMode: mode, models: models, permissionModes: modes)
    }
    func selected(_ setting: AgentSetting) -> String { setting == .model ? model : permissionMode }
    func options(_ setting: AgentSetting) -> [AgentOption] { setting == .model ? models : permissionModes }
    func label(_ setting: AgentSetting) -> String { options(setting).first { $0.id == selected(setting) }?.label ?? "加载中…" }
}

@MainActor @Observable
final class AgentSettingsStore {
    static let shared = AgentSettingsStore()
    private(set) var snapshot: AgentSettingsSnapshot?
    private(set) var loading = false
    private(set) var saving = false
    var error = ""

    func load() async {
        guard !loading, !saving else { return }
        loading = true
        defer { loading = false }
        do {
            let response = try await Api.json("/api/settings")
            try Task.checkCancellation()
            snapshot = try AgentSettingsSnapshot.parse(response); error = ""
        } catch is CancellationError {
        } catch { self.error = error.localizedDescription }
    }

    func select(_ setting: AgentSetting, id: String) async {
        guard !saving, !loading, let snapshot, snapshot.selected(setting) != id,
              snapshot.options(setting).contains(where: { $0.id == id }) else { return }
        saving = true; error = ""
        defer { saving = false }
        do {
            let response = try await Api.json("/api/settings", method: "PUT", body: [setting.rawValue: id])
            self.snapshot = try AgentSettingsSnapshot.parse(response)
        } catch { self.error = error.localizedDescription }
    }
}

struct AgentSettingPage: View {
    let setting: AgentSetting
    private var store: AgentSettingsStore { .shared }
    @Environment(\.interactiveWindow) private var active

    var body: some View {
        SubPage(title: setting.title, subtitle: "从下一轮开始生效") {
            if let snapshot = store.snapshot {
                Rows(items: snapshot.options(setting)) { option in
                    Button { Task { await store.select(setting, id: option.id) } } label: {
                        HStack(spacing: 16) {
                            Image(systemName: snapshot.selected(setting) == option.id ? "largecircle.fill.circle" : "circle")
                                .font(Theme.font(size: 20)).foregroundStyle(snapshot.selected(setting) == option.id ? Theme.actionText : Theme.faint)
                            VStack(alignment: .leading, spacing: 7) {
                                Text(option.label).font(Theme.font(size: 16, weight: .medium)).foregroundStyle(Theme.ink)
                                Text(option.note).font(Theme.font(size: 13)).foregroundStyle(Theme.sub).lineLimit(1)
                            }
                            Spacer()
                        }
                        .padding(.horizontal, 10).padding(.vertical, 18).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(option.label)
                    .verificationAction(option.label)
                    .accessibilityValue(snapshot.selected(setting) == option.id ? "已选择" : "未选择")
                    .disabled(store.saving || store.loading)
                }
                .card(radius: 16, padding: 14)
            } else if store.loading { Note(text: "加载中…").card() }
            if store.saving { HStack { ActiveProgress().controlSize(.small); Text("正在保存…").font(Theme.font(size: 13)).foregroundStyle(Theme.sub) } }
            if !store.error.isEmpty {
                Note(text: store.error, icon: "wifi.exclamationmark")
                Button("重试") { Task { await store.load() } }.buttonStyle(SoftButtonStyle())
            }
        }
        .task(id: "\(ChatClient.shared.connected)-\(active)") {
            await store.load()
            while active && !Task.isCancelled { do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { return }; await store.load() }
        }
    }
}
