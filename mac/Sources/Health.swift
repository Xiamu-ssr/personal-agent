import SwiftUI
import Observation

struct HealthDay: Equatable, Identifiable {
    let date: String
    let sleepMinutes: Double?
    let restingHr: Double?
    let hrv: Double?
    let steps: Double?
    var id: String { date }
    func value(_ metric: HealthKind) -> Double? {
        switch metric { case .sleep: sleepMinutes; case .restingHr: restingHr; case .hrv: hrv; case .steps: steps }
    }
}

enum HealthKind: String, CaseIterable, Identifiable {
    case sleep, restingHr, hrv, steps
    var id: String { rawValue }
    var title: String { switch self { case .sleep: "睡眠"; case .restingHr: "静息心率"; case .hrv: "HRV"; case .steps: "步数" } }
    var icon: String { switch self { case .sleep: "moon.fill"; case .restingHr, .hrv: "heart.fill"; case .steps: "figure.walk" } }
    var unit: String { switch self { case .sleep: "小时"; case .restingHr: "次/分"; case .hrv: "ms"; case .steps: "步" } }
    var bars: Bool { self == .sleep || self == .steps }
    var color: Color { switch self { case .sleep, .steps: Theme.accent; case .restingHr: Theme.warning; case .hrv: Theme.ornament } }
    func formatted(_ value: Double?) -> String {
        guard let value else { return "--" }
        if self == .sleep { return String(format: "%.1f", value / 60) }
        return Int(value.rounded()).formatted(.number.grouping(.automatic))
    }
}

struct HealthWeekly: Identifiable, Equatable {
    let name: String
    let path: String
    let date: String
    let range: String
    let summary: String
    var id: String { path }
}
struct HealthRecord: Identifiable, Equatable {
    let path: String
    let title: String
    let updated: String?
    let preview: String
    var id: String { path }
}
struct HealthSnapshot: Equatable {
    let syncedAt: Date?
    let device: String?
    let note: String?
    let days: [HealthDay]
    let weekly: [HealthWeekly]
    let records: [HealthRecord]
    func today(now: Date = Date()) -> HealthDay? { days.first { $0.date == Fmt.dayKey.string(from: now) } }
    static func parse(_ json: [String: Any]) throws -> HealthSnapshot {
        guard let raw = json["days"] as? [[String: Any]], let weeks = json["weekly"] as? [[String: Any]],
              let records = json["records"] as? [[String: Any]] else { throw ApiError(code: 0, message: "健康数据暂时读不到") }
        func number(_ value: Any?) -> Double? {
            guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite, n.doubleValue >= 0 else { return nil }
            return n.doubleValue
        }
        let days = raw.compactMap { row -> HealthDay? in
            guard let date = row["date"] as? String, Fmt.dayKey.date(from: date) != nil else { return nil }
            return HealthDay(date: date, sleepMinutes: number(row["sleepMinutes"]), restingHr: number(row["restingHr"]), hrv: number(row["hrv"]), steps: number(row["steps"]))
        }.sorted { $0.date < $1.date }
        let weekly = weeks.compactMap { row -> HealthWeekly? in
            guard let path = row["path"] as? String, BriefItem.validPath(path), let name = row["name"] as? String,
                  let date = row["date"] as? String, let range = row["range"] as? String, let summary = row["summary"] as? String else { return nil }
            return HealthWeekly(name: name, path: path, date: date, range: range, summary: summary)
        }
        let mapped = records.compactMap { row -> HealthRecord? in
            guard let path = row["path"] as? String, path.hasPrefix("data/memory/health/"), path.hasSuffix(".md"),
                  path.split(separator: "/").count == 4, !path.contains(".."), !path.contains("\\"),
                  let title = row["title"] as? String, let preview = row["preview"] as? String else { return nil }
            return HealthRecord(path: path, title: title, updated: row["updated"] as? String, preview: preview)
        }
        return HealthSnapshot(syncedAt: ProductTime.date(json["syncedAt"]), device: json["device"] as? String, note: json["note"] as? String,
                              days: Array(days.suffix(7)), weekly: weekly, records: mapped)
    }
}

@Observable final class MemoryReadState {
    static let shared = MemoryReadState()
    private(set) var seen: [String: Double] = Prefs.uiDefaults.dictionary(forKey: "memoryReadAt") as? [String: Double] ?? [:]
    func isNew(_ path: String, updated: Date?) -> Bool { (updated?.timeIntervalSince1970 ?? 0) > (seen[path] ?? -1) }
    func read(_ path: String) { seen[path] = Date().timeIntervalSince1970; Prefs.uiDefaults.set(seen, forKey: "memoryReadAt") }
}
struct NewMark: View {
    var body: some View { Text("新").font(Theme.font(size: 11, weight: .medium)).foregroundStyle(Theme.accent).padding(.horizontal, 6).padding(.vertical, 2).background(Theme.userBubble, in: Capsule()) }
}

@MainActor @Observable final class HealthStore {
    private(set) var snapshot: HealthSnapshot?
    private(set) var loading = false
    private(set) var syncing = false
    var error = ""
    func load(sync: Bool = false) async {
        guard !loading && !syncing else { return }
        if sync { syncing = true } else { loading = true }
        defer { loading = false; syncing = false }
        do {
            let json = try await Api.json(sync ? "/api/health/sync" : "/api/health", method: sync ? "POST" : "GET")
            try Task.checkCancellation()
            let updated = try HealthSnapshot.parse(json)
            if snapshot != updated { snapshot = updated }
            error = ""
        } catch is CancellationError {} catch { self.error = error.localizedDescription }
    }
}

struct HealthPage: View {
    @State private var store = HealthStore()
    var body: some View {
        SubPage(title: "健康", scrolls: false) {
            HStack(spacing: 10) {
                Text(store.snapshot?.syncedAt.map { "上次同步 " + Fmt.when($0) } ?? "尚未同步")
                    .font(Theme.font(size: 12)).foregroundStyle(Theme.sub)
                Button { Task { await store.load(sync: true) } } label: {
                    if store.syncing { ActiveProgress().controlSize(.small).frame(width: 36, height: 36) }
                    else { Image(systemName: "icloud.and.arrow.down").font(Theme.font(size: 17)).foregroundStyle(Theme.accent).frame(width: 36, height: 36).background(Theme.card, in: Circle()) }
                }.buttonStyle(.plain).disabled(store.loading || store.syncing).accessibilityLabel("同步健康").verificationAction("同步健康")
            }
        } content: {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if let note = store.snapshot?.note, !note.isEmpty { Text(note).font(Theme.font(size: 13)).foregroundStyle(Theme.sub) }
                    if !store.error.isEmpty { Note(text: store.error); Button("重试") { Task { await store.load() } }.buttonStyle(SoftButtonStyle()) }
                    SectionTitle(text: "今天")
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)], spacing: 14) {
                        ForEach(HealthKind.allCases) { kind in HealthMetricCard(kind: kind, days: store.snapshot?.days ?? [], today: store.snapshot?.today()) }
                    }
                    SectionTitle(text: "周报")
                    if let weeks = store.snapshot?.weekly, !weeks.isEmpty {
                        VStack(spacing: 12) {
                            ForEach(weeks) { week in
                                Button {
                                    MemoryReadState.shared.read(week.path)
                                    Nav.shared.push(.healthBrief(path: week.path, title: week.name))
                                } label: {
                                    HStack(spacing: 14) {
                                        IconTile(icon: "doc.richtext", size: 38)
                                        VStack(alignment: .leading, spacing: 6) {
                                            HStack { Text(week.name + " · " + week.range).font(Theme.titleFont(17)); if MemoryReadState.shared.isNew(week.path, updated: Fmt.dayKey.date(from: week.date)) { NewMark() } }
                                            Text(week.summary).font(Theme.font(size: 13)).foregroundStyle(Theme.sub).lineLimit(2)
                                        }
                                        Spacer(minLength: 0)
                                        Image(systemName: "chevron.right").font(Theme.font(size: 11)).foregroundStyle(Theme.faint)
                                    }.foregroundStyle(Theme.ink).frame(maxWidth: .infinity, alignment: .leading).card(padding: 18).contentShape(Rectangle())
                                }.buttonStyle(.plain).verificationAction("健康周报 " + week.date)
                            }
                        }
                    } else { Note(text: store.loading ? "加载中…" : "还没有健康周报").card(padding: 12) }
                    SectionTitle(text: "健康记录")
                    if let records = store.snapshot?.records, !records.isEmpty {
                        LazyVGrid(columns: [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)], spacing: 14) {
                            ForEach(records) { record in
                                Button {
                                    MemoryReadState.shared.read(record.path)
                                    Nav.shared.push(.doc(title: record.title, path: record.path))
                                } label: {
                                    VStack(alignment: .leading, spacing: 10) {
                                        HStack { Text(record.title).font(Theme.titleFont(17)); Spacer(); if MemoryReadState.shared.isNew(record.path, updated: record.updated.flatMap(Fmt.dayKey.date)) { NewMark() } }
                                        Text(record.updated.map { "更新于 " + $0 } ?? "暂无更新日期").font(Theme.font(size: 12)).foregroundStyle(Theme.sub)
                                        Rectangle().fill(Theme.line).frame(height: 0.5)
                                        Text(record.preview).font(Theme.font(size: 13)).foregroundStyle(Theme.sub).lineLimit(2).lineSpacing(5)
                                    }.foregroundStyle(Theme.ink).frame(maxWidth: .infinity, minHeight: 122, alignment: .topLeading).card(padding: 18).contentShape(Rectangle())
                                }.buttonStyle(.plain).verificationAction("健康记录 " + record.title)
                            }
                        }
                    } else { Note(text: "还没有健康记录").card(padding: 12) }
                }.frame(maxWidth: 660, alignment: .leading).padding(28).frame(maxWidth: .infinity)
            }.scrollContentBackground(.hidden)
        }.task(id: ChatClient.shared.filesVersion) { await store.load() }
    }
}

struct HealthMetricCard: View {
    let kind: HealthKind
    let days: [HealthDay]
    let today: HealthDay?
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label(kind.title, systemImage: kind.icon).font(Theme.titleFont(17)).foregroundStyle(kind.color)
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text(kind.formatted(today?.value(kind))).font(Theme.font(size: 28, weight: .semibold)).foregroundStyle(Theme.ink)
                if today?.value(kind) != nil { Text(kind.unit).font(Theme.font(size: 12)).foregroundStyle(Theme.sub) }
            }
            HealthChart(values: days.map { $0.value(kind) }, bars: kind.bars, color: kind.color).frame(height: 60)
            HStack { Text(days.first?.date.suffix(5) ?? "近 7 天"); Spacer(); Text(days.last?.date.suffix(5) ?? "") }.font(Theme.font(size: 11)).foregroundStyle(Theme.faint)
        }.frame(maxWidth: .infinity, alignment: .leading).card(padding: 20)
    }
}

/// Paths are drawn in the existing canvas; no NSImage, ImageRenderer or retained chart bitmap.
struct HealthChart: View {
    let values: [Double?]
    let bars: Bool
    let color: Color
    var body: some View {
        Canvas { context, size in
            let known = values.compactMap { $0 }
            let count = max(7, values.count)
            let high = max(1, known.max() ?? 1), low = bars ? 0 : max(0, (known.min() ?? 0) - 5)
            let range = max(1, high - low + (bars ? 0 : 5))
            let step = size.width / CGFloat(count)
            if bars {
                for i in 0..<count {
                    let value = i < values.count ? values[i] : nil
                    let height = value.map { max(2, CGFloat($0 / high) * (size.height - 4)) } ?? 2
                    let rect = CGRect(x: CGFloat(i) * step + 2, y: size.height - height, width: max(1, step - 5), height: height)
                    context.fill(Path(roundedRect: rect, cornerRadius: 4), with: .color(value == nil ? Theme.line : color.opacity(0.45)))
                }
            } else {
                for fraction in [0.25, 0.65] {
                    var guide = Path(); let y = size.height * fraction
                    guide.move(to: CGPoint(x: 0, y: y)); guide.addLine(to: CGPoint(x: size.width, y: y))
                    context.stroke(guide, with: .color(Theme.line), style: StrokeStyle(lineWidth: 0.5, dash: [3, 3]))
                }
                var line = Path(), connected = false
                for i in 0..<count {
                    guard i < values.count, let value = values[i] else { connected = false; continue }
                    let point = CGPoint(x: (CGFloat(i) + 0.5) * step, y: size.height - 4 - CGFloat((value - low) / range) * (size.height - 8))
                    if connected { line.addLine(to: point) } else { line.move(to: point); connected = true }
                    context.fill(Path(ellipseIn: CGRect(x: point.x - 2.5, y: point.y - 2.5, width: 5, height: 5)), with: .color(color))
                }
                context.stroke(line, with: .color(color.opacity(0.7)), lineWidth: 1.5)
            }
        }.accessibilityLabel("近七天趋势")
    }
}

struct HealthBriefPage: View {
    let path: String
    let title: String
    @State private var item: BriefItem?
    @State private var error = ""
    var body: some View {
        GeometryReader { viewport in
            SubPage(title: title) {
                if let item {
                    VStack(spacing: 14) { ForEach(item.cards.indices, id: \.self) { BriefCardView(card: item.cards[$0], viewport: viewport.size) } }
                        .frame(maxWidth: 440).frame(maxWidth: .infinity)
                } else { Note(text: error.isEmpty ? "加载中…" : error) }
            }.coordinateSpace(name: "briefViewport")
        }.task(id: path) {
            do { item = try await BriefItem.fetch(path: path); if item == nil { error = "没有这份健康周报" } }
            catch { self.error = (error as? ApiError)?.code == 404 ? "没有这份健康周报" : error.localizedDescription }
        }
    }
}
