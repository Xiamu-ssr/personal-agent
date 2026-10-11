import SwiftUI

struct HealthMetric {
    let key: String
    let label: String
    let value: String
    let unit: String
}

enum MemorySummary {
    static func preview(_ text: String) -> String {
        text.components(separatedBy: "\n").filter { !$0.hasPrefix("更新：") && !$0.hasPrefix("# ") && !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            .prefix(4).joined(separator: "\n\n")
    }
    static func health(_ json: [String: Any]) -> [HealthMetric] {
        (json["metrics"] as? [[String: Any]] ?? []).compactMap { item in
            guard let key = item["key"] as? String else { return nil }
            let value = ConnectorField.string(item["value"])
            return HealthMetric(key: key, label: item["label"] as? String ?? "", value: value.isEmpty ? "--" : value, unit: item["unit"] as? String ?? "")
        }
    }
}

struct MemoryPage: View {
    private var chat: ChatClient { .shared }
    @State private var profile: String?
    @State private var categories: [(dir: String, files: [TreeEntry])]?
    @State private var health: [HealthMetric] = []
    @State private var healthUpdated = ""
    @State private var error = ""

    var body: some View {
        PageScaffold(title: "记忆", tab: .memory) {
            profileCard
            VStack(alignment: .leading, spacing: 16) {
                SectionTitle(text: "全部")
                healthCard
                voiceCard
                if let categories {
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 16), GridItem(.flexible(), spacing: 16)], spacing: 16) {
                        ForEach(categories.filter { $0.dir != "health" && $0.dir != "voice-notes" }, id: \.dir) { c in
                            CategoryCard(dir: c.dir, count: c.files.count, latest: c.files.first?.name ?? "")
                        }
                    }
                }
            }
            if !error.isEmpty { Note(text: error, icon: "wifi.exclamationmark") }
        }
        .task(id: chat.filesVersion) { await load() }
    }

    private func load() async {
        async let profileText = try? Api.text("data/memory/profile/总档.md")
        async let latest = try? Api.text("data/memory/health/latest.json")
        profile = await profileText ?? ""
        health = []
        if let data = await latest?.data(using: .utf8), let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            health = MemorySummary.health(json)
            healthUpdated = json["updated"] as? String ?? ""
        } else { healthUpdated = "" }
        do {
            let dirs = try await Api.tree("data/memory").filter { $0.dir && Theme.categories.map(\.dir).contains($0.name) }
            var byDir: [String: [TreeEntry]] = [:]
            await withTaskGroup(of: (String, [TreeEntry]).self) { group in
                for dir in dirs {
                    group.addTask {
                        let files = ((try? await Api.tree("data/memory/\(dir.name)")) ?? []).filter { !$0.dir && $0.name.hasSuffix(".md") }.sorted { $0.mtime > $1.mtime }
                        return (dir.name, files)
                    }
                }
                for await (dir, files) in group { byDir[dir] = files }
            }
            categories = Theme.categories.compactMap { c in
                guard let files = byDir[c.dir], !files.isEmpty else { return nil }
                return (c.dir, files)
            }
            error = ""
        } catch { categories = []; self.error = "记忆读不到：\(error.localizedDescription)" }
    }

    private var profileCard: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top) {
                Text("我对 \(ProfileStore.shared.userCall) 的了解").font(.system(size: 22, weight: .bold)).foregroundStyle(Theme.ink)
                Spacer()
                Image(systemName: "sparkle").font(.system(size: 22)).foregroundStyle(Theme.goldText)
                    .frame(width: 34, height: 34).background(GoldBase(radius: 12)).rotationEffect(.degrees(8))
            }
            if profile == nil { Note(text: "加载中…") }
            else if MemorySummary.preview(profile ?? "").isEmpty { Note(text: "聊得越多，了解越完整") }
            else {
                MarkdownView(text: MemorySummary.preview(profile ?? ""), size: 15, lineHeight: 24) { ref in
                    Nav.shared.push(.doc(title: ((ref as NSString).lastPathComponent as NSString).deletingPathExtension, path: "data/memory/" + ref))
                }.textSelection(.enabled)
            }
            Button("查看全部") { Nav.shared.push(.doc(title: "我对 \(ProfileStore.shared.userCall) 的了解", path: "data/memory/profile/总档.md")) }
                .buttonStyle(SoftButtonStyle())
        }.card(radius: 24, padding: 24)
    }

    private var healthCard: some View {
        let defaults = [("sleep", "睡眠", "小时"), ("resting_heart_rate", "静息心率", "次/分"), ("steps", "步数", "步"), ("hrv", "心率变异性", "ms")]
        return VStack(alignment: .leading, spacing: 18) {
            Button { Nav.shared.push(.memoryCategory("health")) } label: {
                HStack { Text("健康").font(.system(size: 16, weight: .semibold)); Spacer(); Image(systemName: "chevron.right").font(.system(size: 11)) }
                    .foregroundStyle(Theme.ink).contentShape(Rectangle())
            }.buttonStyle(.plain)
            HStack(alignment: .top, spacing: 14) {
                ForEach(defaults.indices, id: \.self) { i in
                    let d = defaults[i]
                    let m = health.first { $0.key == d.0 || $0.label == d.1 }
                    VStack(alignment: .leading, spacing: 8) {
                        Text(d.1).font(.system(size: 12)).foregroundStyle(Theme.sub)
                        HStack(alignment: .firstTextBaseline, spacing: 4) {
                            Text(m?.value ?? "--").font(.system(size: 24, weight: .bold)).foregroundStyle(Theme.ink)
                            Text(m?.unit ?? d.2).font(.system(size: 10.5)).foregroundStyle(Theme.sub)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            if health.isEmpty { Text("还没有健康数据").font(.system(size: 11.5)).foregroundStyle(Theme.faint) }
            else if !healthUpdated.isEmpty { Text("更新于 " + healthUpdated.prefix(10)).font(.system(size: 11.5)).foregroundStyle(Theme.faint) }
        }.card(radius: 22, padding: 22)
    }

    private var voiceCard: some View {
        let files = categories?.first { $0.dir == "voice-notes" }?.files ?? []
        return Button { Nav.shared.push(.memoryCategory("voice-notes")) } label: {
            HStack(spacing: 16) {
                IconTile(icon: "waveform", size: 40)
                VStack(alignment: .leading, spacing: 6) {
                    Text("语音笔记").font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.ink)
                    Text(files.isEmpty ? "按住说话发的语音笔记会出现在这里" : "\(files.count) 条 · 最近一条 " + Fmt.when(files[0].mtime))
                        .font(.system(size: 12.5)).foregroundStyle(Theme.sub)
                }
                Spacer(); Image(systemName: "chevron.right").font(.system(size: 11)).foregroundStyle(Theme.faint)
            }.frame(maxWidth: .infinity, alignment: .leading).card(radius: 22, padding: 22).contentShape(Rectangle())
        }.buttonStyle(.plain)
    }
}

struct CategoryCard: View {
    let dir: String
    let count: Int
    var latest = ""
    var body: some View {
        let category = Theme.category(dir)
        Button { Nav.shared.push(.memoryCategory(dir)) } label: {
            VStack(alignment: .leading, spacing: 10) {
                HStack { Text(category.name).font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.ink); Spacer(); Text("\(count) 项").font(.system(size: 12)).foregroundStyle(Theme.sub) }
                Text((latest as NSString).deletingPathExtension).font(.system(size: 12.5)).foregroundStyle(Theme.sub).lineLimit(1)
            }
            .frame(maxWidth: .infinity, minHeight: 54, alignment: .leading)
            .padding(20).padding(.top, 12)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 20))
            .overlay(alignment: .topLeading) {
                UnevenRoundedRectangle(topLeadingRadius: 8, topTrailingRadius: 8).fill(category.color.opacity(0.15))
                    .frame(width: 72, height: 10).offset(x: 20, y: -7)
            }
            .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(.white.opacity(0.9), lineWidth: 1))
            .contentShape(Rectangle())
        }.buttonStyle(.plain).padding(.top, 7)
    }
}

struct MemoryCategoryPage: View {
    let dir: String
    private var chat: ChatClient { .shared }
    @State private var files: [TreeEntry]?
    @State private var error = ""
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
                } else { Note(text: !error.isEmpty ? error : files == nil ? "加载中…" : "这里还是空的") }
            }.card(radius: 22, padding: 10)
        }
        .task(id: chat.filesVersion) {
            do { files = try await Api.tree("data/memory/\(dir)").filter { !$0.dir && $0.name.hasSuffix(".md") }; error = "" }
            catch { files = []; self.error = error.localizedDescription }
        }
    }
}

struct Diary: Identifiable, Hashable {
    let file: String
    var title = ""
    var summary = ""
    var id: String { file }
    var path: String { "data/diary/\(file)" }
    var date: Date? { Fmt.dayKey.date(from: String(file.prefix(10))) }
    var dateLabel: String { date.map { Fmt.mdShortWeek.string(from: $0) } ?? (file as NSString).deletingPathExtension }
    var weekday: Int { date.map { Calendar.current.component(.weekday, from: $0) - 1 } ?? 0 }
    static func parse(_ file: String, _ text: String) -> Diary {
        var d = Diary(file: file)
        for raw in text.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("---") { continue }
            if d.title.isEmpty, line.hasPrefix("#") { d.title = line.trimmingCharacters(in: CharacterSet(charactersIn: "# ")) }
            else if !line.hasPrefix("#") {
                if d.title.isEmpty { d.title = String(line.prefix(24)) }
                else { d.summary = String(line.replacingOccurrences(of: "**", with: "").prefix(90)); break }
            }
        }
        return d
    }
}

struct HomePage: View {
    private var chat: ChatClient { .shared }
    private var profile: ProfileStore { .shared }
    @State private var diaries: [Diary]?
    @State private var choosing = false
    @State private var error = ""
    var body: some View {
        PageScaffold(title: "", tab: .home) {
            VStack(spacing: 10) {
                Button { choosing = true } label: {
                    DreamAvatar(choice: profile.avatar).frame(width: 272, height: 272)
                        .frame(maxWidth: .infinity).background(RadialGradient(colors: [.white.opacity(0.65), .clear], center: .center, startRadius: 10, endRadius: 280))
                        .contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityLabel("更换头像")
                Text(profile.agentName).font(.system(size: 28, weight: .bold)).foregroundStyle(Theme.ink)
                Text(Self.intro(firstChat: profile.firstChat, userCall: profile.userCall)).font(.system(size: 14)).foregroundStyle(Theme.sub)
            }.frame(maxWidth: .infinity)
            VStack(alignment: .leading, spacing: 12) {
                SectionTitle(text: "日记", trailing: AnyView(Button("查看所有日记") { Nav.shared.push(.diaries) }
                    .buttonStyle(.plain).font(.system(size: 12.5)).foregroundStyle(Theme.accent)))
                if let diaries, !diaries.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 18) { ForEach(diaries.prefix(8)) { DiaryCard(diary: $0) } }.padding(.vertical, 10).padding(.horizontal, 5)
                    }.padding(.vertical, -10)
                } else { Note(text: diaries == nil ? "加载中…" : "豆豆每晚 22:30 写一篇日记").card(padding: 12) }
            }
            if !error.isEmpty { Note(text: error) }
            ListRow(icon: "person.crop.circle", tint: Color(hex: 0x637DA0), title: "豆豆的设定") {
                Nav.shared.push(.doc(title: "豆豆的设定", path: "data/memory/role/角色.md"))
            }.card(radius: 22, padding: 10)
        }
        .task(id: chat.filesVersion) {
            await profile.load()
            do { diaries = try await DiaryListPage.fetch(limit: 8); error = "" } catch { diaries = []; self.error = "日记读不到：\(error.localizedDescription)" }
        }
        .sheet(isPresented: $choosing) { AvatarPicker() }
    }
    static func intro(firstChat: Double?, userCall: String = "你", now: Date = Date()) -> String {
        guard let firstChat, firstChat.isFinite, firstChat > 0 else { return "从第一次对话起陪伴 \(userCall)" }
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "zh_CN"); formatter.dateFormat = "yyyy年M月d日"
        return "从 \(formatter.string(from: Date(timeIntervalSince1970: firstChat / 1000)))起陪伴 \(userCall)"
    }
    static func fetchFirstChat() async -> Double? { ((try? await Api.json("/api/state"))?["firstChat"] as? NSNumber)?.doubleValue }
}

struct AvatarPicker: View {
    @Environment(\.dismiss) private var dismiss
    @State private var choice = ProfileStore.shared.avatar
    private var profile: ProfileStore { .shared }
    var body: some View {
        VStack(spacing: 22) {
            Text("更换头像").font(.system(size: 22, weight: .bold)).foregroundStyle(Theme.ink)
            DreamAvatar(choice: choice).frame(width: 190, height: 180)
            HStack(spacing: 12) {
                ForEach(AvatarChoice.shapes.indices, id: \.self) { i in
                    Button { choice.shape = AvatarChoice.shapes[i] } label: {
                        VStack(spacing: 4) { DreamAvatar(choice: AvatarChoice(shape: AvatarChoice.shapes[i], palette: choice.palette)).frame(width: 66, height: 66); Text(AvatarChoice.shapeTitles[i]).font(.system(size: 12)) }
                            .padding(8).background(choice.shape == AvatarChoice.shapes[i] ? Theme.goldText.opacity(0.08) : .clear, in: RoundedRectangle(cornerRadius: 16))
                    }.buttonStyle(.plain).accessibilityLabel(AvatarChoice.shapeTitles[i])
                }
            }
            HStack(spacing: 10) {
                ForEach(AvatarChoice.palettes.indices, id: \.self) { i in
                    Button { choice.palette = AvatarChoice.palettes[i] } label: {
                        VStack(spacing: 6) {
                            Circle().fill(LinearGradient(colors: Array(DreamAvatar.colors(AvatarChoice.palettes[i]).prefix(2)), startPoint: .top, endPoint: .bottom))
                                .frame(width: 26, height: 26).overlay(Circle().strokeBorder(choice.palette == AvatarChoice.palettes[i] ? Theme.goldText : .white, lineWidth: 2))
                            Text(AvatarChoice.paletteTitles[i]).font(.system(size: 11.5)).foregroundStyle(Theme.sub)
                        }.frame(width: 76)
                    }.buttonStyle(.plain)
                }
            }
            if !profile.error.isEmpty { Text(profile.error).font(.system(size: 12)).foregroundStyle(Theme.danger) }
            HStack(spacing: 14) {
                Button("取消") { dismiss() }.buttonStyle(SoftButtonStyle())
                Button(profile.saving ? "保存中…" : "保存") {
                    Task { @MainActor in await profile.save(choice); if profile.error.isEmpty { dismiss() } }
                }.buttonStyle(GoldButtonStyle(height: 36)).disabled(profile.saving)
            }
        }.padding(28).frame(width: 440).background(Theme.canvas).preferredColorScheme(.light)
    }
}

struct DiaryCard: View {
    let diary: Diary
    var fluid = false
    var body: some View {
        let papers: [UInt32] = [0xFBF0D9, 0xE9F1FB, 0xEDF4E5, 0xF5EAF1, 0xE8F2F0, 0xF4EBDD, 0xEEEAF7]
        Button { Nav.shared.push(.doc(title: diary.title.isEmpty ? diary.dateLabel : diary.title, path: diary.path)) } label: {
            VStack(alignment: .leading, spacing: 13) {
                VStack(spacing: 0) {
                    Text(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][diary.weekday]).font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.goldText)
                        .frame(width: 42, height: 18).background(.white.opacity(0.45))
                    Text(diary.date.map { String(Calendar.current.component(.day, from: $0)) } ?? "—").font(.system(size: 25, weight: .bold)).foregroundStyle(Theme.ink).frame(width: 42, height: 34)
                }.background(.white.opacity(0.5), in: RoundedRectangle(cornerRadius: 8)).clipShape(RoundedRectangle(cornerRadius: 8))
                Text(diary.title.isEmpty ? "日记" : diary.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                Text(diary.summary).font(.system(size: 12.5)).foregroundStyle(Theme.sub).lineLimit(3).lineSpacing(5)
                Spacer(minLength: 0)
            }
            .frame(width: fluid ? nil : 220, height: 164, alignment: .topLeading).frame(maxWidth: fluid ? .infinity : nil, alignment: .leading)
            .padding(20).background(Color(hex: papers[diary.weekday]), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.white.opacity(0.7), lineWidth: 1))
            .shadow(color: Theme.ink.opacity(0.06), radius: 7, y: 6)
            .rotationEffect(.degrees(diary.weekday % 2 == 0 ? -1.5 : 1.5)).contentShape(Rectangle())
        }.buttonStyle(.plain)
    }
}

struct DiaryListPage: View {
    private var chat: ChatClient { .shared }
    @State private var diaries: [Diary]?
    @State private var error = ""
    static func fetch(limit: Int) async throws -> [Diary] {
        let files = try await Api.tree("data/diary").filter { !$0.dir && $0.name.hasSuffix(".md") }.map(\.name).sorted(by: >).prefix(limit)
        var result: [Diary] = []
        for file in files { result.append(Diary.parse(file, (try? await Api.text("data/diary/\(file)")) ?? "")) }
        return result
    }
    var body: some View {
        SubPage(title: "豆豆的日记") {
            if let diaries, !diaries.isEmpty {
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 24), GridItem(.flexible(), spacing: 24)], spacing: 24) {
                    ForEach(diaries) { DiaryCard(diary: $0, fluid: true) }
                }.padding(.horizontal, 5).padding(.vertical, 8)
            } else { Note(text: !error.isEmpty ? error : diaries == nil ? "加载中…" : "豆豆每晚 22:30 写一篇日记").card(padding: 12) }
        }.task(id: chat.filesVersion) {
            do { diaries = try await Self.fetch(limit: Int.max); error = "" } catch { diaries = []; self.error = error.localizedDescription }
        }
    }
}
