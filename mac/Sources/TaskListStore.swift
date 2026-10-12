import Foundation
import Observation

@MainActor @Observable final class TaskListStore {
    private(set) var recent: [TaskSummary] = []
    private(set) var next: Double?
    private(set) var loaded = false
    private(set) var loading = false
    var error = ""
    @ObservationIgnored private var generation = 0

    static func group(_ date: Date?, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let date else { return "更早" }
        let start = calendar.startOfDay(for: now)
        if calendar.isDate(date, inSameDayAs: now) { return "今天" }
        let week = calendar.date(byAdding: .day, value: -7, to: start) ?? start
        return date >= week && date < start ? "近 7 天" : "更早"
    }
    func refresh(version: Int? = nil) async {
        generation += 1
        let current = generation
        loading = true
        defer { if current == generation { loading = false } }
        do {
            let response = try await Api.json("/api/jobs?limit=30")
            try Task.checkCancellation()
            guard current == generation else { return }
            if let version { ChatClient.shared.applyJobs(response["running"] as? [[String: Any]] ?? [], version: version) }
            recent = unique((response["recent"] as? [[String: Any]] ?? []).compactMap(TaskSummary.parse))
            next = (response["next"] as? NSNumber)?.doubleValue
            loaded = true; error = ""
        } catch is CancellationError {} catch { if current == generation { self.error = error.localizedDescription } }
    }
    func loadNext() async {
        guard !loading, let cursor = next else { return }
        let current = generation
        loading = true
        defer { if current == generation { loading = false } }
        do {
            let response = try await Api.json("/api/jobs?before=\(String(format: "%.0f", cursor))&limit=30")
            try Task.checkCancellation()
            guard current == generation else { return }
            recent = unique(recent + (response["recent"] as? [[String: Any]] ?? []).compactMap(TaskSummary.parse))
            let candidate = (response["next"] as? NSNumber)?.doubleValue
            // A repeated cursor must not generate an infinite request loop.
            next = candidate.flatMap { $0 < cursor ? $0 : nil }
            error = ""
        } catch is CancellationError {} catch { if current == generation { self.error = error.localizedDescription } }
    }
    private func unique(_ items: [TaskSummary]) -> [TaskSummary] {
        var seen: Set<String> = []
        return items.filter { seen.insert($0.id).inserted }.sorted { ($0.time ?? .distantPast) > ($1.time ?? .distantPast) }
    }
}
