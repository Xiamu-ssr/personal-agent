import SwiftUI

// MARK: - 记忆

struct MemoryPage: View {
    private var chat: ChatClient { .shared }
    @State private var profile: String? = nil
    @State private var cats: [(dir: String, count: Int)]? = nil
    @State private var err = ""

    var body: some View {
        PageScaffold(title: "记忆", subtitle: "我对你的了解", tab: .memory) {
            profileCard
            VStack(alignment: .leading, spacing: 10) {
                SectionTitle(text: "分类")
                if let cats, !cats.isEmpty {
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)], spacing: 14) {
                        ForEach(cats, id: \.dir) { c in CategoryCard(dir: c.dir, count: c.count) }
                    }
                } else {
                    Note(text: cats == nil ? "加载中…" : "还没有分类记忆，聊得越多越完整").card(radius: 22, padding: 6)
                }
            }
            if !err.isEmpty { Note(text: err, icon: "wifi.exclamationmark") }
        }
        .task(id: chat.filesVersion) { await load() }
    }

    private func load() async {
        var profileError = ""
        do { profile = try await Api.text("data/memory/profile/总档.md") } catch {
            profile = ""
            profileError = "总档读不到：\(error.localizedDescription)"
        }
        do {
            let dirs = try await Api.tree("data/memory").filter { $0.dir && Theme.categories.map(\.dir).contains($0.name) }.map(\.name)
            var counts: [String: Int] = [:]
            await withTaskGroup(of: (String, Int).self) { g in
                for d in dirs {
                    g.addTask { (d, ((try? await Api.tree("data/memory/\(d)")) ?? []).filter { !$0.dir && $0.name.hasSuffix(".md") }.count) }
                }
                for await (d, n) in g { counts[d] = n }
            }
            let order = Theme.categories.map(\.dir)
            cats = dirs.filter { (counts[$0] ?? 0) > 0 }
                .sorted { (order.firstIndex(of: $0) ?? 99, $0) < (order.firstIndex(of: $1) ?? 99, $1) }
                .map { ($0, counts[$0] ?? 0) }
            err = profileError
        } catch {
            err = "读不到：\(error.localizedDescription)"
            if cats == nil { cats = [] }
        }
    }

    /// 总档 without its "更新：" stamp and top heading (the card has its own title).
    private var profileBody: String {
        (profile ?? "").components(separatedBy: "\n")
            .enumerated().filter { !$0.element.hasPrefix("更新：") && !($0.offset == 0 && $0.element.hasPrefix("# ")) }.map(\.element)
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var updated: String {
        (profile ?? "").components(separatedBy: "\n").first { $0.hasPrefix("更新：") }?.replacingOccurrences(of: "更新：", with: "更新于 ") ?? ""
    }

    private var profileCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                IconTile(icon: "person.text.rectangle", tint: Color(hex: 0x776AA3), size: 34)
                VStack(alignment: .leading, spacing: 2) {
                    Text("总档").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink)
                    if !updated.isEmpty { Text(updated).font(.system(size: 11.5)).foregroundStyle(Theme.faint) }
                }
                Spacer()
                Button("全文") { Nav.shared.push(.doc(title: "我对你的了解", path: "data/memory/profile/总档.md")) }
                    .buttonStyle(SoftButtonStyle())
            }
            if profile == nil {
                Note(text: "加载中…")
            } else if profileBody.isEmpty {
                Note(text: "还是空的，聊得越多越完整")
            } else {
                MarkdownView(text: profileBody, size: 13.5) { ref in
                    Nav.shared.push(.doc(title: ((ref as NSString).lastPathComponent as NSString).deletingPathExtension, path: "data/memory/" + ref))
                }
                .textSelection(.enabled)
            }
        }
        .card(radius: 24, padding: 22)
    }
}

struct CategoryCard: View {
    let dir: String
    let count: Int
    @State private var hover = false

    var body: some View {
        let c = Theme.category(dir)
        Button { Nav.shared.push(.memoryCategory(dir)) } label: {
            VStack(alignment: .leading, spacing: 14) {
                IconTile(icon: c.icon, tint: c.color, size: 38)
                VStack(alignment: .leading, spacing: 3) {
                    Text(c.name).font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.ink)
                    Text("\(count) 项").font(.system(size: 12)).foregroundStyle(Theme.sub)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .card(radius: 22, padding: 18)
            .offset(y: hover ? -2 : 0)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { h in withAnimation(.easeOut(duration: 0.15)) { hover = h } }
    }
}

struct MemoryCategoryPage: View {
    let dir: String
    private var chat: ChatClient { .shared }
    @State private var files: [TreeEntry]? = nil
    @State private var err = ""

    var body: some View {
        let c = Theme.category(dir)
        SubPage(title: c.name, subtitle: files.map { "\($0.count) 项记忆" } ?? "") {
            Group {
                if let files, !files.isEmpty {
                    Rows(items: files) { f in
                        ListRow(icon: c.icon, tint: c.color, title: (f.name as NSString).deletingPathExtension, subtitle: "更新于 " + Fmt.when(f.mtime)) {
                            Nav.shared.push(.doc(title: (f.name as NSString).deletingPathExtension, path: "data/memory/\(dir)/\(f.name)"))
                        }
                    }
                } else {
                    Note(text: !err.isEmpty ? err : files == nil ? "加载中…" : "这里还是空的")
                }
            }
            .card(radius: 22, padding: 10)
        }
        .task(id: chat.filesVersion) {
            do { files = try await Api.tree("data/memory/\(dir)").filter { !$0.dir && $0.name.hasSuffix(".md") }; err = "" } catch { files = []; err = error.localizedDescription }
        }
    }
}

// MARK: - 豆豆

struct Diary: Identifiable, Hashable {
    let file: String
    var title = ""
    var summary = ""
    var id: String { file }
    var path: String { "data/diary/\(file)" }

    var dateLabel: String {
        let key = (file as NSString).deletingPathExtension
        guard let d = Fmt.dayKey.date(from: String(key.prefix(10))) else { return key }
        return Fmt.mdShortWeek.string(from: d)
    }

    /// First heading as the title, first paragraph as the summary.
    static func parse(_ file: String, _ text: String) -> Diary {
        var d = Diary(file: file)
        for raw in text.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("---") { continue }
            if d.title.isEmpty, line.hasPrefix("#") {
                d.title = line.trimmingCharacters(in: CharacterSet(charactersIn: "# "))
            } else if !line.hasPrefix("#") {
                if d.title.isEmpty { d.title = String(line.prefix(24)) } else {
                    d.summary = String(line.replacingOccurrences(of: "**", with: "").prefix(90))
                    break
                }
            }
        }
        return d
    }
}

struct HomePage: View {
    private var chat: ChatClient { .shared }
    @State private var diaries: [Diary]? = nil
    @State private var firstChat: Double? = nil
    @State private var err = ""

    var body: some View {
        PageScaffold(title: "", tab: .home) {
            VStack(spacing: 14) {
                Orb(size: 132).padding(.top, 4)
                Text("豆豆").font(.system(size: 28, weight: .bold)).foregroundStyle(Theme.ink)
                Text(Self.intro(firstChat: firstChat)).font(.system(size: 14)).foregroundStyle(Theme.sub)
            }
            .frame(maxWidth: .infinity)
            .padding(.bottom, 8)

            VStack(alignment: .leading, spacing: 10) {
                SectionTitle(text: "最近的日记", trailing: (diaries?.isEmpty ?? true) ? nil : AnyView(
                    Button("查看所有日记") { Nav.shared.push(.diaries) }.buttonStyle(.plain)
                        .font(.system(size: 12.5)).foregroundStyle(Theme.accent)))
                if let diaries, !diaries.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 14) {
                            ForEach(diaries.prefix(8)) { d in DiaryCard(diary: d) }
                        }
                        .padding(.vertical, 14)
                        .padding(.horizontal, 4)
                    }
                    .padding(.vertical, -14)
                } else {
                    Note(text: diaries == nil ? "加载中…" : "豆豆每晚 22:30 写一篇日记", icon: "book.closed").card(radius: 22, padding: 6)
                }
            }

            if !err.isEmpty { Note(text: err, icon: "wifi.exclamationmark") }
            VStack(spacing: 0) {
                ListRow(icon: "person.crop.circle", tint: Color(hex: 0x637DA0), title: "豆豆的设定", subtitle: "豆豆怎么说话、怎么做事") {
                    Nav.shared.push(.doc(title: "豆豆的设定", path: "data/memory/role/角色.md"))
                }
            }
            .card(radius: 22, padding: 10)
        }
        .task(id: chat.filesVersion) { await load() }
    }

    static func intro(firstChat: Double?, now: Date = Date()) -> String {
        guard let firstChat, firstChat.isFinite, firstChat > 0 else { return "从第一次对话开始，慢慢了解你" }
        let days = Calendar.current.dateComponents([.day], from: Calendar.current.startOfDay(for: Date(timeIntervalSince1970: firstChat / 1000)),
                                                   to: Calendar.current.startOfDay(for: now)).day ?? 0
        return days <= 0 ? "从今天第一次对话开始，慢慢了解你" : "从 \(days) 天前第一次对话开始，慢慢了解你"
    }

    /// The server provides this small metadata field; a missing/null field never falls back to history or a local cache.
    static func fetchFirstChat() async -> Double? {
        (try? await Api.json("/api/state"))?["firstChat"] as? Double
    }

    private func load() async {
        firstChat = await Self.fetchFirstChat()
        do { diaries = try await DiaryListPage.fetch(limit: 8); err = "" } catch { diaries = []; err = "日记读不到：\(error.localizedDescription)" }
    }
}

struct DiaryCard: View {
    let diary: Diary
    @State private var hover = false

    var body: some View {
        Button { Nav.shared.push(.doc(title: diary.title.isEmpty ? diary.dateLabel : diary.title, path: diary.path)) } label: {
            VStack(alignment: .leading, spacing: 8) {
                Text(diary.dateLabel).font(.system(size: 11.5)).foregroundStyle(Theme.faint)
                Text(diary.title.isEmpty ? "日记" : diary.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(2)
                Text(diary.summary).font(.system(size: 12.5)).foregroundStyle(Theme.sub).lineLimit(3).lineSpacing(2)
                Spacer(minLength: 0)
            }
            .frame(width: 220, height: 128, alignment: .topLeading)
            .card(radius: 22, padding: 18)
            .offset(y: hover ? -2 : 0)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { h in withAnimation(.easeOut(duration: 0.15)) { hover = h } }
    }
}

struct DiaryListPage: View {
    private var chat: ChatClient { .shared }
    @State private var diaries: [Diary]? = nil

    @State private var err = ""

    static func fetch(limit: Int) async throws -> [Diary] {
        let files = try await Api.tree("data/diary")
        let names = files.filter { !$0.dir && $0.name.hasSuffix(".md") }.map(\.name).sorted(by: >).prefix(limit)
        var out: [Diary] = []
        for n in names {
            out.append(Diary.parse(n, (try? await Api.text("data/diary/\(n)")) ?? ""))
        }
        return out
    }

    var body: some View {
        SubPage(title: "豆豆的日记", subtitle: "每晚 22:30 写一篇") {
            Group {
                if let diaries, !diaries.isEmpty {
                    Rows(items: diaries) { d in
                        ListRow(icon: "book.closed", tint: Color(hex: 0x637DA0), title: d.title.isEmpty ? d.dateLabel : d.title,
                                subtitle: d.dateLabel + (d.summary.isEmpty ? "" : " · " + d.summary)) {
                            Nav.shared.push(.doc(title: d.title.isEmpty ? d.dateLabel : d.title, path: d.path))
                        }
                    }
                } else {
                    Note(text: !err.isEmpty ? err : diaries == nil ? "加载中…" : "豆豆每晚 22:30 写一篇日记")
                }
            }
            .card(radius: 22, padding: 10)
        }
        .task(id: chat.filesVersion) {
            do { diaries = try await Self.fetch(limit: Int.max); err = "" } catch { diaries = []; err = "读不到：\(error.localizedDescription)" }
        }
    }
}
