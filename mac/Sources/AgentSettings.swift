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

struct AgentSettingsSnapshot {
    let model: ModelSelection
    let providers: [ModelProvider]
    let providerPresets: [ProviderPreset]
    static func parse(_ row: [String: Any]) throws -> AgentSettingsSnapshot {
        guard row["kernel"] as? String == "openclaw", let model = (row["model"] as? [String:Any]).flatMap(ModelSelection.init), let raw = row["providers"] as? [[String:Any]] else { throw ApiError(code:0,message:"请升级云端至豆豆 1.0") }
        let providers = raw.compactMap(ModelProvider.init)
        guard providers.count == raw.count, Set(providers.map(\.id)).count == providers.count, providers.contains(where: { $0.id == model.provider && $0.models.contains(where: { $0.id == model.id }) }) else { throw ApiError(code:0,message:"模型设置不完整") }
        let rawPresets = row["providerPresets"] as? [[String: Any]] ?? []
        let presets = rawPresets.compactMap(ProviderPreset.init)
        guard presets.count == rawPresets.count, Set(presets.map(\.id)).count == presets.count else { throw ApiError(code: 0, message: "供应商预设不完整") }
        return AgentSettingsSnapshot(model:model, providers:providers, providerPresets:presets)
    }
    var modelLabel: String {
        providers.first { $0.id == model.provider }?.models.first { $0.id == model.id }?.name ?? "加载中…"
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
    private func update(_ body: [String: Any]) async {
        guard !saving, !loading else { return }
        saving = true; error = ""
        defer { saving = false; finish() }
        do { snapshot = try AgentSettingsSnapshot.parse(await Api.json("/api/settings", method: "PUT", body: body)) }
        catch { self.error = error.localizedDescription }
    }
}
