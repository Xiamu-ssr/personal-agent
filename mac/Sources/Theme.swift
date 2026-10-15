import AppKit
import Observation
import SwiftUI

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(.sRGB, red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255,
                  blue: Double(hex & 255) / 255, opacity: alpha)
    }
}
enum AppAppearance: String, CaseIterable, Identifiable {
    case system, light, dark
    var id: String { rawValue }
    var title: String { switch self { case .system: "跟随系统"; case .light: "浅色"; case .dark: "深色" } }
}
@Observable final class AppearanceStore {
    static let shared = AppearanceStore()
    var selection = AppAppearance(rawValue: Prefs.uiDefaults.string(forKey: "appearance") ?? "") ?? .system
    var systemDark = NSApp?.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    func select(_ value: AppAppearance) { selection = value; Prefs.uiDefaults.set(value.rawValue, forKey: "appearance") }
}
enum Theme {
    static var dark: Bool { AppearanceStore.shared.selection == .dark || (AppearanceStore.shared.selection == .system && AppearanceStore.shared.systemDark) }
    static var scheme: ColorScheme? { switch AppearanceStore.shared.selection { case .system: nil; case .light: .light; case .dark: .dark } }
    static var appearance: NSAppearance? { AppearanceStore.shared.selection == .system ? nil : NSAppearance(named: dark ? .darkAqua : .aqua) }
    static var background: Color { dark ? .black : .white }
    static var card: Color { Color(hex: dark ? 0x1C1C1E : 0xF3F3F3) }
    static var ink: Color { dark ? .white : .black }
    static var sub: Color { Color(hex: dark ? 0x99999E : 0x77777B) }
    static var faint: Color { sub }
    static var line: Color { ink.opacity(0.09) }
    static var accent: Color { ink }
    static var link: Color { Color(hex: dark ? 0x64A8FF : 0x007AFF) }
    static var field: Color { card }
    static var userBubble: Color { Color(hex: dark ? 0x303033 : 0xE8E8EA) }
    static var ornament: Color { sub }
    static var online: Color { ink }
    static var warning: Color { ink }
    static var info: Color { ink }
    static var danger: Color { ink }
    static var actionText: Color { ink }
    static var canvas: Color { background }
    static var selection: Color { userBubble }
    static var sidebar: Color { background }
    static var bodySize: CGFloat { 15 }
    static var secondarySize: CGFloat { 13 }
    static func font(size: CGFloat, weight: Font.Weight = .regular, design: Font.Design = .default) -> Font { .system(size: size, weight: weight, design: design) }
    static func titleFont(_ size: CGFloat, weight: Font.Weight = .semibold) -> Font { font(size: size, weight: weight) }
    static var categories: [(dir: String, name: String, icon: String, color: Color)] {
        [("profile","总档","person.text.rectangle",ink),("work","工作","briefcase",ink),("project","项目","folder",ink),
         ("life","生活","house",ink),("health","健康","heart",ink),("people","人际","person.2",ink),
         ("preferences","偏好","slider.horizontal.3",ink),("interests","兴趣","sparkles",ink),("finance","财务","yensign.circle",ink),
         ("feedback","反馈","text.bubble",ink),("history","历史","clock",ink),("automation-prefs","自动化偏好","gearshape.2",ink),("voice-notes","语音笔记","waveform",ink)]
    }
    static func category(_ dir: String) -> (name: String, icon: String, color: Color) {
        let c = categories.first { $0.dir == dir }; return (c?.name ?? dir,c?.icon ?? "doc.text",ink)
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

/// Monochrome capsule for actions and selected states.
struct CapsuleBase: View {
    var radius: CGFloat = 999

    var body: some View {
        RoundedRectangle(cornerRadius: radius, style: .continuous).fill(Theme.userBubble)
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    var height: CGFloat = 40

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.font(size: 14, weight: .semibold))
            .foregroundStyle(Theme.actionText)
            .padding(.horizontal, 20)
            .frame(height: height)
            .background(CapsuleBase())
            .opacity(configuration.isPressed ? 0.8 : 1)
            .contentShape(Capsule())
    }
}

/// Secondary capsule action.
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

        }
        .buttonStyle(.plain)
        .help(help)
        .accessibilityLabel(help)
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

/// Capsule navigation.
struct PillTabs: View {
    let titles: [String]
    @Binding var selection: Int

    var body: some View {
        HStack(spacing: 6) {
            ForEach(titles.indices, id: \.self) { i in
                Button { selection = i } label: {
                    Text(titles[i])
                        .font(Theme.font(size: 13, weight: selection == i ? .semibold : .regular))
                        .foregroundStyle(selection == i ? Theme.actionText : Theme.sub)
                        .padding(.horizontal, 14)
                        .frame(height: 30)
                        .background { if selection == i { CapsuleBase() } }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .verificationAction("pill-"+titles[i])
                .accessibilityLabel(titles[i])
            }
        }
    }
}

/// Status tag.
struct StatusTag: View {
    let text: String

    var body: some View {
        Text(text).font(Theme.font(size: 11.5, weight: .semibold)).foregroundStyle(Theme.actionText)
            .padding(.horizontal, 12).frame(height: 24).background(CapsuleBase())
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
