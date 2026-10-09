import SwiftUI

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255, opacity: alpha)
    }
}

/// Silver-blue metal with champagne gold (spec §四).
enum Theme {
    static let ink = Color(hex: 0x252E38)
    static let sub = Color(hex: 0x728093)
    static let faint = Color(hex: 0x8F99A6)
    static let line = Color(hex: 0x7589A0, alpha: 0.12)
    static let card = Color(hex: 0xFBFCFE, alpha: 0.84)
    static let field = Color(hex: 0xF1F4F8)
    static let userBubble = Color(hex: 0xDCE4EE)
    static let goldText = Color(hex: 0x6C4A25)
    static let online = Color(hex: 0x4FA37A)
    static let danger = Color(hex: 0xB65A5A)
    static let accent = Color(hex: 0x4E79A3)

    static let canvas = LinearGradient(stops: [
        .init(color: Color(hex: 0xC9D3DF), location: 0),
        .init(color: Color(hex: 0xE5E9EE), location: 0.45),
        .init(color: Color(hex: 0xEEF1F4), location: 1),
    ], startPoint: .top, endPoint: .bottom)

    static let gold = LinearGradient(stops: [
        .init(color: Color(hex: 0xFFFBED), location: 0),
        .init(color: Color(hex: 0xF3DFB0), location: 0.28),
        .init(color: Color(hex: 0xE2C88E), location: 0.55),
        .init(color: Color(hex: 0xEAD299), location: 0.78),
        .init(color: Color(hex: 0x9C7440), location: 1),
    ], startPoint: UnitPoint(x: 0.2, y: 0), endPoint: UnitPoint(x: 0.8, y: 1))

    /// The pale champagne wash behind the selected sidebar row.
    static let goldWash = LinearGradient(colors: [Color(hex: 0xFBF3DF), Color(hex: 0xF1E2BE)], startPoint: .topLeading, endPoint: .bottomTrailing)

    // Memory categories (spec §三.6 / §四).
    static let categories: [(dir: String, name: String, icon: String, color: Color)] = [
        ("work", "工作", "briefcase", Color(hex: 0x417DAC)),
        ("project", "项目", "folder", Color(hex: 0x428B94)),
        ("life", "生活", "house", Color(hex: 0x9F7E51)),
        ("health", "健康", "heart", Color(hex: 0xC36577)),
        ("people", "人际", "person.2", Color(hex: 0x597AC0)),
        ("preferences", "偏好", "slider.horizontal.3", Color(hex: 0x7E6BA5)),
        ("interests", "兴趣", "sparkles", Color(hex: 0xA06C8E)),
        ("finance", "财务", "yensign.circle", accent),
        ("feedback", "反馈", "text.bubble", accent),
        ("history", "历史", "clock.arrow.circlepath", accent),
        ("automation-prefs", "自动化偏好", "gearshape.2", accent),
        ("voice-notes", "语音笔记", "waveform", accent),
        ("role", "角色", "person.crop.circle", accent),
    ]

    static func category(_ dir: String) -> (name: String, icon: String, color: Color) {
        if let c = categories.first(where: { $0.dir == dir }) { return (c.name, c.icon, c.color) }
        return (dir == "profile" ? "总档" : dir, "doc.text", accent)
    }
}

struct CardStyle: ViewModifier {
    var radius: CGFloat = 22
    var padding: CGFloat = 18

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(.white.opacity(0.9), lineWidth: 1))
            .shadow(color: Color(hex: 0x253751, alpha: 0.055), radius: 17, y: 12)
    }
}

extension View {
    func card(radius: CGFloat = 22, padding: CGFloat = 18) -> some View { modifier(CardStyle(radius: radius, padding: padding)) }
}

/// The champagne-gold metallic capsule used for selected states, 已连接 and primary buttons.
struct GoldBase: View {
    var radius: CGFloat = 999

    var body: some View {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
            .fill(Theme.gold)
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous)
                .strokeBorder(LinearGradient(colors: [.white.opacity(0.85), Color(hex: 0x9C7440, alpha: 0.35)], startPoint: .top, endPoint: .bottom), lineWidth: 1))
            .shadow(color: Color(hex: 0x9C7440, alpha: 0.28), radius: 4, y: 2)
    }
}

struct GoldButtonStyle: ButtonStyle {
    var height: CGFloat = 40

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 14, weight: .semibold))
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
            .font(.system(size: 12.5, weight: .medium))
            .foregroundStyle(Color(hex: 0x4A6587))
            .padding(.horizontal, 14)
            .frame(height: 28)
            .background(Capsule().fill(Color(hex: 0xE4EBF3)))
            .overlay(Capsule().strokeBorder(.white, lineWidth: 1))
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
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Theme.ink.opacity(0.8))
                .frame(width: 36, height: 36)
                .background(Circle().fill(Theme.card))
                .overlay(Circle().strokeBorder(.white, lineWidth: 1))
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
            .font(.system(size: size * 0.45, weight: .medium))
            .foregroundStyle(tint)
            .frame(width: size, height: size)
            .background(RoundedRectangle(cornerRadius: size * 0.3, style: .continuous).fill(tint.opacity(0.1)))
            .overlay(RoundedRectangle(cornerRadius: size * 0.3, style: .continuous).strokeBorder(.white.opacity(0.9), lineWidth: 1))
    }
}

struct PageTitle: View {
    let title: String
    var subtitle = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 30, weight: .bold)).foregroundStyle(Theme.ink)
            if !subtitle.isEmpty { Text(subtitle).font(.system(size: 13)).foregroundStyle(Theme.sub) }
        }
    }
}

struct SectionTitle: View {
    let text: String
    var trailing: AnyView? = nil

    var body: some View {
        HStack {
            Text(text).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink)
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
            if let icon { Image(systemName: icon).font(.system(size: 22, weight: .light)).foregroundStyle(Theme.faint) }
            Text(text).font(.system(size: 13)).foregroundStyle(Theme.sub).multilineTextAlignment(.center)
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
                Text(title).font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(1)
                if !subtitle.isEmpty { Text(subtitle).font(.system(size: 12)).foregroundStyle(Theme.sub).lineLimit(2) }
            }
            Spacer(minLength: 8)
            trailing()
            if action != nil { Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.faint) }
        }
        .padding(.vertical, 11)
        .padding(.horizontal, 6)
        .background(RoundedRectangle(cornerRadius: 12).fill(hover && action != nil ? Color(hex: 0xEEF2F7, alpha: 0.8) : .clear))
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
                        .font(.system(size: 13, weight: selection == i ? .semibold : .regular))
                        .foregroundStyle(selection == i ? Theme.goldText : Theme.sub)
                        .padding(.horizontal, 14)
                        .frame(height: 30)
                        .background { if selection == i { GoldBase() } }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
    }
}

/// Gold 已连接 tag.
struct GoldTag: View {
    let text: String

    var body: some View {
        Text(text).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(Theme.goldText)
            .padding(.horizontal, 12).frame(height: 24).background(GoldBase())
    }
}

struct Dot: View {
    let on: Bool

    var body: some View {
        Circle().fill(on ? Theme.online : Theme.faint.opacity(0.6)).frame(width: 7, height: 7)
            .overlay(Circle().strokeBorder(.white, lineWidth: 1))
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
