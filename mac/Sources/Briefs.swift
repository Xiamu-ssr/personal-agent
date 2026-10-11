import SwiftUI

struct BriefHTMLCard: Equatable {
    let html: String
}

struct BriefItem: Identifiable {
    let date: String
    let name: String
    let time: Date
    let path: String
    let cards: [BriefHTMLCard]
    var id: String { path }

    static func validPath(_ path: String) -> Bool {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        return parts.count == 4 && parts[0] == "data" && parts[1] == "briefs" &&
            Fmt.dayKey.date(from: String(parts[2])) != nil && parts[3].hasSuffix(".html") &&
            !parts.contains("..") && !path.contains("\\")
    }

    static func parse(_ row: [String: Any]) -> BriefItem? {
        guard let path = row["path"] as? String, validPath(path),
              let date = row["date"] as? String, let name = row["name"] as? String,
              let time = ProductTime.date(row["time"]),
              let raw = row["cards"] as? [[String: Any]], (1...6).contains(raw.count) else { return nil }
        let cards = raw.compactMap { card -> BriefHTMLCard? in
            guard let html = card["html"] as? String, !html.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            return BriefHTMLCard(html: html)
        }
        guard cards.count == raw.count else { return nil }
        return BriefItem(date: date, name: name, time: time, path: path, cards: cards)
    }

    static func fetch(days: Int = 7) async throws -> [BriefItem] {
        let response = try await Api.json("/api/briefs?days=\(days)")
        return (response["items"] as? [[String: Any]] ?? []).compactMap(parse).sorted { $0.time > $1.time }
    }

    /// The endpoint supplies complete card documents, including for older completion links.
    static func fetch(path: String) async throws -> BriefItem? {
        guard validPath(path) else { return nil }
        return try await fetch(days: 365).first { $0.path == path }
    }
}

private struct BriefWindowHeightKey: EnvironmentKey { static let defaultValue: CGFloat = 640 }
extension EnvironmentValues {
    var briefWindowHeight: CGFloat {
        get { self[BriefWindowHeightKey.self] }
        set { self[BriefWindowHeightKey.self] = newValue }
    }
}

/// Geometry callbacks only enqueue visibility; they never mutate SwiftUI state during that layout turn.
private final class BriefVisibilityUpdates {
    private var work: DispatchWorkItem?
    private var next = false
    @MainActor func schedule(_ visible: Bool, apply: @escaping (Bool) -> Void) {
        next = visible
        guard work == nil else { return }
        let update = DispatchWorkItem { [weak self] in
            guard let self else { return }; work = nil; apply(next)
        }
        work = update
        DispatchQueue.main.async(execute: update)
    }
    func cancel() { work?.cancel(); work = nil }
    deinit { work?.cancel() }
}

/// Only visible cards stay mounted. A measured placeholder retains scroll position after recycling.
struct BriefCardView: View {
    let card: BriefHTMLCard
    let viewport: CGSize
    @Environment(\.briefWindowHeight) private var windowHeight
    @State private var documentHeight: CGFloat = 1
    @State private var visible = false
    @State private var loading = true
    @State private var failed = ""
    @State private var visibilityUpdates = BriefVisibilityUpdates()

    private var height: CGFloat { min(documentHeight > 1 ? documentHeight : 200, max(1, windowHeight * 0.75)) }

    var body: some View {
        ZStack {
            if visible {
                BriefWebView(html: card.html, documentHeight: $documentHeight, loading: $loading, failed: $failed)
                    .frame(height: documentHeight > 1 ? height : 1)
            }
            if loading && visible { ActiveProgress().controlSize(.small) }
            if !failed.isEmpty { Note(text: failed, icon: "exclamationmark.triangle") }
        }
        .frame(maxWidth: 480)
        .frame(height: height)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 24))
        .clipShape(RoundedRectangle(cornerRadius: 24))
        .overlay(RoundedRectangle(cornerRadius: 24).strokeBorder(.white.opacity(0.9), lineWidth: 1))
        .shadow(color: Color(hex: 0x253751, alpha: 0.055), radius: 14, y: 6)
        .background {
            GeometryReader { geometry in
                let frame = geometry.frame(in: .named("briefViewport"))
                Color.clear
                    .onAppear { updateVisibility(frame) }
                    .onChange(of: frame) { updateVisibility(frame) }
                    .onChange(of: viewport) { updateVisibility(frame) }
            }
        }
        .onDisappear { visibilityUpdates.cancel(); visible = false }
        .onChange(of: card.html) { documentHeight = 1; loading = true; failed = "" }
    }

    private func updateVisibility(_ frame: CGRect) {
        let next = frame.intersects(CGRect(origin: .zero, size: viewport))
        visibilityUpdates.schedule(next) { if $0 != visible { visible = $0 } }
    }
}

struct TodayPage: View {
    private var chat: ChatClient { .shared }
    private var nav: Nav { .shared }
    @State private var briefs: [BriefItem]?
    @State private var sites: [TreeEntry]?
    @State private var morningTime = ""
    @State private var error = ""

    var body: some View {
        GeometryReader { viewport in
            ScrollViewReader { proxy in
                PageScaffold(title: "今日", tab: .today) {
                    PillTabs(titles: ["简报", "站点"], selection: Binding(get: { nav.todaySection }, set: { nav.todaySection = $0 }))
                    if nav.todaySection == 0 { briefList(viewport: viewport.size) } else { siteGrid }
                    if !error.isEmpty { Note(text: error, icon: "wifi.exclamationmark") }
                }
                .task(id: chat.filesVersion) {
                    await load()
                    await focus(proxy)
                }
                .onChange(of: nav.briefFocus) { Task { await focus(proxy) } }
            }
            .coordinateSpace(name: "briefViewport")
        }
    }

    @MainActor
    private func focus(_ proxy: ScrollViewProxy) async {
        guard let path = nav.briefFocus else { return }
        nav.todaySection = 0
        if briefs?.contains(where: { $0.path == path }) == false, let linked = try? await BriefItem.fetch(path: path) {
            guard nav.briefFocus == path else { return }
            briefs = ((briefs ?? []) + [linked]).sorted { $0.time > $1.time }
        }
        try? await Task.sleep(nanoseconds: 150_000_000)
        guard !Task.isCancelled, nav.briefFocus == path else { return }
        if briefs?.contains(where: { $0.path == path }) == true { proxy.scrollTo(path, anchor: .top) }
        else if briefs != nil { Nav.shared.show("这份简报暂时读不到") }
        nav.briefFocus = nil
    }

    private func load() async {
        async let b = BriefItem.fetch()
        async let s = Api.tree("data/sites")
        async let state = try? Api.json("/api/state")
        do { briefs = try await b; error = "" } catch { briefs = []; self.error = "简报读不到：\(error.localizedDescription)" }
        do { sites = try await s.filter { $0.dir || $0.name.hasSuffix(".html") } } catch { sites = []; self.error = "站点读不到：\(error.localizedDescription)" }
        if let jobs = await state?["schedule"] as? [[String: Any]],
           let morning = jobs.first(where: { ($0["name"] as? String ?? "").contains("晨报") }), let cron = morning["cron"] as? String {
            morningTime = cronText(cron).replacingOccurrences(of: "每天 ", with: "")
        } else { morningTime = "" }
    }

    @ViewBuilder
    private func briefList(viewport: CGSize) -> some View {
        if let briefs, !briefs.isEmpty {
            LazyVStack(alignment: .leading, spacing: 22) {
                let days = Array(Set(briefs.map(\.date))).sorted(by: >)
                ForEach(days, id: \.self) { day in
                    SectionTitle(text: Self.dayLabel(day))
                    ForEach(briefs.filter { $0.date == day }) { brief in
                        VStack(alignment: .leading, spacing: 12) {
                            Text("\(Fmt.hm.string(from: brief.time)) \(brief.name)").font(.system(size: 12)).foregroundStyle(Theme.sub).padding(.leading, 4)
                            ForEach(brief.cards.indices, id: \.self) { i in
                                BriefCardView(card: brief.cards[i], viewport: viewport)
                            }
                        }.id(brief.path)
                    }
                }
            }
            .frame(maxWidth: 480, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
        } else {
            Note(text: briefs == nil ? "加载中…" : "今天还没有简报" + (morningTime.isEmpty ? "" : " · 晨报 \(morningTime)"), icon: "sun.horizon")
                .card(radius: 24, padding: 20)
        }
    }

    static func dayLabel(_ day: String) -> String {
        guard let date = Fmt.dayKey.date(from: day) else { return day }
        if Calendar.current.isDateInToday(date) { return "今天" }
        if Calendar.current.isDateInYesterday(date) { return "昨天" }
        return Fmt.mdShortWeek.string(from: date).replacingOccurrences(of: " · ", with: " ")
    }

    @ViewBuilder
    private var siteGrid: some View {
        if let sites, !sites.isEmpty {
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 18), GridItem(.flexible(), spacing: 18)], spacing: 18) {
                ForEach(sites) { SiteCard(entry: $0) }
            }
        } else { Note(text: sites == nil ? "加载中…" : "还没有站点", icon: "globe").card(padding: 20) }
    }
}
