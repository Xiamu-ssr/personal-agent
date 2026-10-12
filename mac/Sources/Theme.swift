import AppKit
import Observation
import SwiftUI

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255, opacity: alpha)
    }
}

enum Skin: String, CaseIterable, Identifiable {
    case silver, paper, night
    var id: String { rawValue }
    var title: String { switch self { case .silver: "银蓝"; case .paper: "纸墨"; case .night: "夜幕" } }
    var palette: [UInt32] {
        switch self {
        case .silver: [0xF3F5F8, 0xFFFFFF, 0x1E2733, 0x6B7686, 0xE3E7ED, 0x4A78A8, 0xE6EEF7, 0xB89A5E, 0x3E8E6A, 0xC2873A, 0x4A78A8]
        case .paper: [0xF5F0E6, 0xFBF8F2, 0x231F1A, 0x7A7065, 0xE6DDCD, 0xB4442E, 0xF3E3DA, 0x9C7A3C, 0x5B7F4E, 0xB0782C, 0x5E6F8C]
        case .night: [0x0F1216, 0x181C22, 0xE6E8EB, 0x8C95A1, 0x262B33, 0x5CCFB0, 0x1E3330, 0xE0A54B, 0x5CCFB0, 0xE0A54B, 0x7BA7E0]
        }
    }
}

@Observable final class SkinStore {
    static let shared = SkinStore(defaults: Prefs.uiDefaults)
    private(set) var skin: Skin
    @ObservationIgnored private let defaults: UserDefaults
    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        skin = defaults.string(forKey: "skin").flatMap(Skin.init) ?? .silver
    }
    func select(_ skin: Skin) {
        guard self.skin != skin else { return }
        self.skin = skin
        defaults.set(skin.rawValue, forKey: "skin")
    }
}

/// Every lookup observes the local skin, without replacing a page or its native views.
enum Theme {
    static var skin: Skin { SkinStore.shared.skin }
    private static func color(_ i: Int) -> Color { Color(hex: skin.palette[i]) }
    static var background: Color { color(0) }
    static var card: Color { color(1) }
    static var ink: Color { color(2) }
    static var sub: Color { color(3) }
    static var faint: Color { sub }
    static var line: Color { color(4) }
    static var accent: Color { color(5) }
    static var field: Color { background }
    static var userBubble: Color { color(6) }
    static var ornament: Color { color(7) }
    static var online: Color { color(8) }
    static var warning: Color { color(9) }
    static var info: Color { color(10) }
    static var danger: Color { skin == .night ? Color(hex: 0xE49B91) : Color(hex: 0xB4442E) }
    static var goldText: Color { accent }
    static var canvas: LinearGradient { LinearGradient(colors: [background, background], startPoint: .top, endPoint: .bottom) }
    static var gold: LinearGradient { goldWash }
    static var goldWash: LinearGradient { LinearGradient(colors: [userBubble, userBubble], startPoint: .top, endPoint: .bottom) }
    static var scheme: ColorScheme { skin == .night ? .dark : .light }
    static var appearance: NSAppearance? { NSAppearance(named: skin == .night ? .darkAqua : .aqua) }
    static var sidebar: Color { card }
    static var bodySize: CGFloat { 15 }
    static var secondarySize: CGFloat { 13 }
    static var cardTitleSize: CGFloat { 17 }
    static func font(size: CGFloat, weight: Font.Weight = .regular, design: Font.Design = .default) -> Font {
        Font.system(size: size, weight: skin == .night && weight == .regular ? .light : weight, design: design).monospacedDigit()
    }
    static func titleFont(_ size: CGFloat, weight: Font.Weight = .semibold) -> Font {
        skin == .paper ? .custom("Songti SC", size: size).weight(weight).monospacedDigit() : font(size: size, weight: weight)
    }
    static var categories: [(dir: String, name: String, icon: String, color: Color)] {
        [("work", "工作", "briefcase", accent), ("project", "项目", "folder", accent),
         ("life", "生活", "house", ornament), ("health", "健康", "heart", online),
         ("people", "人际", "person.2", accent), ("preferences", "偏好", "slider.horizontal.3", accent),
         ("interests", "兴趣", "sparkles", ornament), ("finance", "财务", "yensign.circle", accent),
         ("feedback", "反馈", "text.bubble", accent), ("history", "历史", "clock.arrow.circlepath", accent),
         ("automation-prefs", "自动化偏好", "gearshape.2", accent), ("voice-notes", "语音笔记", "waveform", accent),
         ("role", "角色", "person.crop.circle", accent)]
    }
    static func category(_ dir: String) -> (name: String, icon: String, color: Color) {
        if let c = categories.first(where: { $0.dir == dir }) { return (c.name, c.icon, c.color) }
        return (dir == "profile" ? "总档" : dir, "doc.text", accent)
    }
}

struct CardStyle: ViewModifier {
    var radius: CGFloat = 16
    var padding: CGFloat = 18

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Theme.line, lineWidth: 0.5))
            .shadow(color: Theme.ink.opacity(0.025), radius: 6, y: 2)
    }
}

extension View {
    func card(radius: CGFloat = 16, padding: CGFloat = 18) -> some View { modifier(CardStyle(radius: radius, padding: padding)) }
}

/// The champagne-gold metallic capsule used for selected states, 已连接 and primary buttons.
struct GoldBase: View {
    var radius: CGFloat = 999

    var body: some View {
        RoundedRectangle(cornerRadius: radius, style: .continuous).fill(Theme.userBubble)
    }
}

struct GoldButtonStyle: ButtonStyle {
    var height: CGFloat = 40

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.font(size: 14, weight: .semibold))
            .foregroundStyle(Theme.goldText)
            .padding(.horizontal, 20)
            .frame(height: height)
            .background(GoldBase())
            .opacity(configuration.isPressed ? 0.8 : 1)
            .contentShape(Capsule())
    }
}

/// Light blue-gray pill (e.g. 连接, 立即运行).
struct SoftButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.font(size: 12.5, weight: .medium))
            .foregroundStyle(Theme.accent)
            .padding(.horizontal, 14)
            .frame(height: 28)
            .background(Capsule().fill(Theme.userBubble))
            .overlay(Capsule().strokeBorder(Theme.line, lineWidth: 0.5))
            .opacity(configuration.isPressed ? 0.7 : 1)
            .contentShape(Capsule())
    }
}

/// Round white icon button (search, settings).
struct CircleIconButton: View {
    let icon: String
    var help = ""
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(Theme.font(size: 14, weight: .medium))
                .foregroundStyle(Theme.ink.opacity(0.8))
                .frame(width: 36, height: 36)
                .background(Circle().fill(Theme.card))
                .overlay(Circle().strokeBorder(Theme.line, lineWidth: 0.5))
                .shadow(color: Color(hex: 0x253751, alpha: 0.06), radius: 8, y: 4)
        }
        .buttonStyle(.plain)
        .help(help)
        .accessibilityLabel(help)
    }
}

/// The silver metal ball that stands in for 豆豆.
struct Orb: View {
    var size: CGFloat = 40

    var body: some View {
        ZStack {
            Circle().fill(RadialGradient(colors: [.white, Color(hex: 0xDCE6F2), Color(hex: 0xAFC0D3)],
                                         center: UnitPoint(x: 0.35, y: 0.3), startRadius: 0, endRadius: size * 0.62))
            Circle().fill(RadialGradient(colors: [Color(hex: 0x8EA2BA, alpha: 0.55), .clear],
                                         center: UnitPoint(x: 0.7, y: 0.85), startRadius: 0, endRadius: size * 0.5))
            Ellipse().fill(.white.opacity(0.9)).frame(width: size * 0.3, height: size * 0.18)
                .blur(radius: size * 0.03).offset(x: -size * 0.14, y: -size * 0.22)
            Circle().strokeBorder(.white.opacity(0.8), lineWidth: max(1, size / 40))
        }
        .frame(width: size, height: size)
        .shadow(color: Color(hex: 0x4A5F7A, alpha: 0.25), radius: size / 8, y: size / 16)
    }
}

/// An SF Symbol on a light rounded tile, tinted.
struct IconTile: View {
    let icon: String
    var tint: Color = Theme.accent
    var size: CGFloat = 34

    var body: some View {
        Image(systemName: icon)
            .font(Theme.font(size: size * 0.45, weight: .medium))
            .foregroundStyle(tint)
            .frame(width: size, height: size)
            .background(RoundedRectangle(cornerRadius: size * 0.3, style: .continuous).fill(tint.opacity(0.1)))
            .overlay(RoundedRectangle(cornerRadius: size * 0.3, style: .continuous).strokeBorder(Theme.line, lineWidth: 0.5))
    }
}

struct PageTitle: View {
    let title: String
    var subtitle = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(Theme.titleFont(28)).foregroundStyle(Theme.ink)
            if !subtitle.isEmpty { Text(subtitle).font(Theme.font(size: 13)).foregroundStyle(Theme.sub) }
        }
    }
}

struct SectionTitle: View {
    let text: String
    var trailing: AnyView? = nil

    var body: some View {
        HStack {
            Text(text).font(Theme.titleFont(20)).foregroundStyle(Theme.ink)
            Spacer()
            trailing
        }
        .padding(.horizontal, 4)
    }
}

/// Muted centered text for loading / empty / error states.
struct Note: View {
    let text: String
    var icon: String? = nil

    var body: some View {
        VStack(spacing: 8) {
            if let icon { Image(systemName: icon).font(Theme.font(size: 22, weight: .light)).foregroundStyle(Theme.faint) }
            Text(text).font(Theme.font(size: 13)).foregroundStyle(Theme.sub).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 22)
    }
}

/// A tappable list row inside a card: icon, title, subtitle, chevron.
struct ListRow<Trailing: View>: View {
    var icon: String? = nil
    var tint: Color = Theme.accent
    let title: String
    var subtitle = ""
    var action: (() -> Void)? = nil
    @ViewBuilder var trailing: () -> Trailing
    @State private var hover = false

    var body: some View {
        let row = HStack(spacing: 12) {
            if let icon { IconTile(icon: icon, tint: tint, size: 32) }
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(Theme.titleFont(Theme.bodySize, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(1)
                if !subtitle.isEmpty { Text(subtitle).font(Theme.font(size: Theme.secondarySize)).foregroundStyle(Theme.sub).lineLimit(2) }
            }
            Spacer(minLength: 8)
            trailing()
            if action != nil { Image(systemName: "chevron.right").font(Theme.font(size: 11, weight: .semibold)).foregroundStyle(Theme.faint) }
        }
        .padding(.vertical, 11)
        .padding(.horizontal, 6)
        .background(RoundedRectangle(cornerRadius: 12).fill(hover && action != nil ? Theme.field : .clear))
        .contentShape(Rectangle())
        if let action {
            Button(action: action) { row }.buttonStyle(.plain).onHover { hover = $0 }
        } else {
            row
        }
    }
}

extension ListRow where Trailing == EmptyView {
    init(icon: String? = nil, tint: Color = Theme.accent, title: String, subtitle: String = "", action: (() -> Void)? = nil) {
        self.init(icon: icon, tint: tint, title: title, subtitle: subtitle, action: action, trailing: { EmptyView() })
    }
}

/// Rows separated by the faint divider.
struct Rows<Item: Identifiable, Row: View>: View {
    let items: [Item]
    @ViewBuilder let row: (Item) -> Row

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { i, item in
                if i > 0 { Rectangle().fill(Theme.line).frame(height: 1).padding(.leading, 50) }
                row(item)
            }
        }
    }
}

/// Champagne capsule tabs: 进行中 · 已完成 · 定时, 本机 · 云端 · 其他设备.
struct PillTabs: View {
    let titles: [String]
    @Binding var selection: Int

    var body: some View {
        HStack(spacing: 6) {
            ForEach(titles.indices, id: \.self) { i in
                Button { selection = i } label: {
                    Text(titles[i])
                        .font(Theme.font(size: 13, weight: selection == i ? .semibold : .regular))
                        .foregroundStyle(selection == i ? Theme.goldText : Theme.sub)
                        .padding(.horizontal, 14)
                        .frame(height: 30)
                        .background { if selection == i { GoldBase() } }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(titles[i])
            }
        }
    }
}

/// Gold 已连接 tag.
struct GoldTag: View {
    let text: String

    var body: some View {
        Text(text).font(Theme.font(size: 11.5, weight: .semibold)).foregroundStyle(Theme.goldText)
            .padding(.horizontal, 12).frame(height: 24).background(GoldBase())
    }
}

struct Dot: View {
    let on: Bool

    var body: some View {
        Circle().fill(on ? Theme.online : Theme.faint.opacity(0.6)).frame(width: 7, height: 7)
            .overlay(Circle().strokeBorder(Theme.line, lineWidth: 0.5))
    }
}

/// Simple wrapping layout for tags.
struct Flow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, maxX: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width { x = 0; y += line + spacing; line = 0 }
            x += size.width + spacing
            maxX = max(maxX, x - spacing)
            line = max(line, size.height)
        }
        return CGSize(width: maxX, height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX { x = bounds.minX; y += line + spacing; line = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            line = max(line, size.height)
        }
    }
}

enum Fmt {
    private static func f(_ format: String) -> DateFormatter {
        let d = DateFormatter()
        d.locale = Locale(identifier: "zh_CN")
        d.dateFormat = format
        return d
    }

    static let dayKey = f("yyyy-MM-dd")
    static let hm = f("HH:mm")
    static let md = f("M月d日")
    static let mdw = f("M月d日 · EEEE")
    static let mdShortWeek = f("M月d日 · EEE")

    /// "14:05", "昨天 14:05", "10月3日 14:05".
    static func when(_ d: Date) -> String {
        let cal = Calendar.current
        if cal.isDateInToday(d) { return hm.string(from: d) }
        if cal.isDateInYesterday(d) { return "昨天 " + hm.string(from: d) }
        return md.string(from: d) + " " + hm.string(from: d)
    }

    /// "3 分钟", "1 小时 5 分钟".
    static func duration(_ s: TimeInterval) -> String {
        let m = max(0, Int(s) / 60)
        if m < 1 { return "不到 1 分钟" }
        if m < 60 { return "\(m) 分钟" }
        return m % 60 == 0 ? "\(m / 60) 小时" : "\(m / 60) 小时 \(m % 60) 分钟"
    }

    /// "刚刚", "5 分钟前", "3 小时前", "2 天前".
    static func ago(_ d: Date) -> String {
        let s = Date().timeIntervalSince(d)
        if s < 60 { return "刚刚" }
        if s < 3600 { return "\(Int(s / 60)) 分钟前" }
        if s < 86400 { return "\(Int(s / 3600)) 小时前" }
        return "\(Int(s / 86400)) 天前"
    }

    static func size(_ n: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(n), countStyle: .file)
    }
}
