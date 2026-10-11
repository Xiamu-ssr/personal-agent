import SwiftUI

struct BriefItem: Identifiable {
    let date: String
    let name: String
    let time: Date
    let path: String
    let cards: [BriefCard]
    var id: String { path }

    static func parse(_ row: [String: Any]) -> BriefItem? {
        guard let path = row["path"] as? String, path.hasPrefix("data/briefs/"), path.hasSuffix(".json"),
              let brief = row["brief"] as? [String: Any], (brief["v"] as? Int) == 1 else { return nil }
        let cards = (brief["cards"] as? [[String: Any]] ?? []).prefix(5).compactMap(BriefCard.parse)
        guard !cards.isEmpty else { return nil }
        let iso = ISO8601DateFormatter()
        let timeText = row["time"] as? String ?? brief["time"] as? String ?? ""
        var time = iso.date(from: timeText)
        if time == nil { iso.formatOptions.insert(.withFractionalSeconds); time = iso.date(from: timeText) }
        return BriefItem(date: row["date"] as? String ?? "", name: row["name"] as? String ?? brief["name"] as? String ?? "简报",
                         time: time ?? .distantPast, path: path, cards: cards)
    }

    static func fetch() async throws -> [BriefItem] {
        let response = try await Api.json("/api/briefs?days=7")
        return (response["items"] as? [[String: Any]] ?? []).compactMap(parse).sorted { $0.time > $1.time }
    }

    /// A completed task can link to a JSON brief outside the default seven-day list.
    static func fetch(path: String) async throws -> BriefItem? {
        guard path.hasPrefix("data/briefs/"), path.hasSuffix(".json") else { return nil }
        let data = Data(try await Api.text(path).utf8)
        guard let brief = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return parse(["path": path, "date": String(path.split(separator: "/").dropFirst(2).first ?? ""), "brief": brief])
    }
}

struct BriefCard {
    let chip: String
    let title: String
    let summary: String
    let blocks: [BriefBlock]
    let actionLabel: String
    let actionPrompt: String

    static func parse(_ json: [String: Any]) -> BriefCard? {
        guard let title = json["title"] as? String, !title.isEmpty else { return nil }
        let action = json["action"] as? [String: Any] ?? [:]
        return BriefCard(chip: json["chip"] as? String ?? "", title: title, summary: json["summary"] as? String ?? "",
                         blocks: (json["blocks"] as? [[String: Any]] ?? []).prefix(4).compactMap(BriefBlock.parse),
                         actionLabel: action["label"] as? String ?? "", actionPrompt: action["prompt"] as? String ?? "")
    }
}

struct BriefBlock {
    let type: String
    let text: String
    let items: [[String: String]]

    static func parse(_ json: [String: Any]) -> BriefBlock? {
        guard let type = json["type"] as? String else { return nil }
        if type == "note" {
            guard let text = json["text"] as? String, !text.isEmpty else { return nil }
            return BriefBlock(type: type, text: text, items: [])
        }
        let required: [String]
        let limit: Int
        switch type {
        case "timeline": required = ["when", "label"]; limit = 4
        case "tiles": required = ["title", "text"]; limit = 3
        case "metrics": required = ["label", "value"]; limit = 4
        case "list": required = ["text"]; limit = 6
        default: return nil
        }
        let items = (json["items"] as? [[String: Any]] ?? []).prefix(limit).compactMap { row -> [String: String]? in
            let values = row.compactMapValues { $0 as? String }
            return required.allSatisfy { !(values[$0] ?? "").isEmpty } ? values : nil
        }
        guard !items.isEmpty else { return nil }
        return BriefBlock(type: type, text: "", items: items)
    }
}

struct BriefCardView: View {
    let card: BriefCard
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if !card.chip.isEmpty {
                Text(card.chip).font(.system(size: 11.5, weight: .medium)).foregroundStyle(Theme.goldText)
                    .padding(.horizontal, 11).padding(.vertical, 5).background(Theme.goldWash, in: Capsule())
            }
            Text(card.title).font(.system(size: 22, weight: .semibold)).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
            if !card.summary.isEmpty { Text(card.summary).font(.system(size: 14)).foregroundStyle(Theme.sub).lineSpacing(5) }
            ForEach(card.blocks.indices, id: \.self) { i in BriefBlockView(block: card.blocks[i]) }
            if !card.actionLabel.isEmpty && !card.actionPrompt.isEmpty {
                Button(card.actionLabel) { Nav.shared.ask(card.actionPrompt) }.buttonStyle(SoftButtonStyle())
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(radius: 24, padding: 22)
    }
}

private struct BriefBlockView: View {
    let block: BriefBlock
    private func tone(_ value: String?) -> Color {
        switch value {
        case "ok": return Theme.online
        case "warn": return Color(hex: 0xA77936)
        default: return Theme.accent
        }
    }
    var body: some View {
        if block.type == "note" {
            Text(block.text).font(.system(size: 12)).foregroundStyle(Theme.sub)
                .padding(11).frame(maxWidth: .infinity, alignment: .leading).background(Theme.field, in: RoundedRectangle(cornerRadius: 12))
        } else if block.type == "list" {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(block.items.indices, id: \.self) { i in
                    let item = block.items[i]
                    HStack(alignment: .top, spacing: 9) {
                        Circle().fill(Theme.accent.opacity(0.5)).frame(width: 4, height: 4).padding(.top, 6)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(item["text"] ?? "").font(.system(size: 14)).foregroundStyle(Theme.ink)
                            if let meta = item["meta"], !meta.isEmpty { Text(meta).font(.system(size: 11.5)).foregroundStyle(Theme.sub) }
                        }
                    }
                }
            }
        } else {
            HStack(alignment: .top, spacing: 12) {
                ForEach(block.items.indices, id: \.self) { i in
                    let item = block.items[i]
                    VStack(alignment: .leading, spacing: 6) {
                        if block.type == "metrics" {
                            Text(item["label"] ?? "").font(.system(size: 12)).foregroundStyle(Theme.sub)
                            HStack(alignment: .firstTextBaseline, spacing: 4) {
                                Text(item["value"] ?? "").font(.system(size: 26, weight: .bold)).foregroundStyle(Theme.ink)
                                Text(item["unit"] ?? "").font(.system(size: 11)).foregroundStyle(Theme.sub)
                            }
                            if let delta = item["delta"] { Text(delta).font(.system(size: 11.5)).foregroundStyle(Theme.sub) }
                        } else if block.type == "timeline" {
                            Text(item["when"] ?? "").font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.accent)
                            Text(item["label"] ?? "").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink)
                            if let text = item["text"] { Text(text).font(.system(size: 11.5)).foregroundStyle(Theme.sub) }
                        } else {
                            Text(item["title"] ?? "").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.ink)
                            Text(item["text"] ?? "").font(.system(size: 12)).foregroundStyle(Theme.sub)
                            if let tag = item["tag"], !tag.isEmpty {
                                Text(tag).font(.system(size: 10.5, weight: .medium)).foregroundStyle(tone(item["tone"]))
                                    .padding(.horizontal, 8).padding(.vertical, 3).background(tone(item["tone"]).opacity(0.1), in: Capsule())
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(block.type == "tiles" ? 12 : 0)
                    .background(block.type == "tiles" ? Theme.field : .clear, in: RoundedRectangle(cornerRadius: 14))
                }
            }
        }
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
        ScrollViewReader { proxy in
            PageScaffold(title: "今日", tab: .today) {
                PillTabs(titles: ["简报", "站点"], selection: Binding(get: { nav.todaySection }, set: { nav.todaySection = $0 }))
                if nav.todaySection == 0 { briefList } else { siteGrid }
                if !error.isEmpty { Note(text: error, icon: "wifi.exclamationmark") }
            }
            .task(id: chat.filesVersion) {
                await load()
                await focus(proxy)
            }
            .onChange(of: nav.briefFocus) { Task { await focus(proxy) } }
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
        guard nav.briefFocus == path else { return }
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
    private var briefList: some View {
        if let briefs, !briefs.isEmpty {
            let days = Array(Set(briefs.map(\.date))).sorted(by: >)
            ForEach(days, id: \.self) { day in
                VStack(alignment: .leading, spacing: 14) {
                    SectionTitle(text: Self.dayLabel(day))
                    ForEach(briefs.filter { $0.date == day }) { brief in
                        VStack(alignment: .leading, spacing: 12) {
                            Text("\(Fmt.hm.string(from: brief.time)) \(brief.name)").font(.system(size: 12)).foregroundStyle(Theme.sub).padding(.leading, 4)
                            ForEach(brief.cards.indices, id: \.self) { i in BriefCardView(card: brief.cards[i]) }
                        }.id(brief.path)
                    }
                }
            }
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
