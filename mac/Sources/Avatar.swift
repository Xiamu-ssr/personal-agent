import SwiftUI

/// Shared Android / Mac parameters: unit square, sRGB, closed cubic paths, no bitmap.
/// IDs: bean/girl/boy/cat; mist/dusk/mint/sakura.
/// palette  skyTop  skyMid  skyBottom glow
/// mist     8EAECD  CEDDEC  EEF4FA    FFEAC5
/// dusk     CCAA91  EAD2AB  FCF0D4    FFF6CF
/// mint     88B8B0  C5E1D7  EAF7EF    FFECCE
/// sakura   C3A3BE  EAD1DF  FBEFF2    FFF0D1
/// sky stops 0/.55/1; warm glow center (.32,.25), radius .48, alpha .70 -> 0;
/// white glow center (.67,.42), radius .40, alpha .60 -> 0.
/// clouds (x,y,w,h,alpha): (-.15,.60,.80,.20,.45),(.30,.52,.80,.22,.50),
/// (-.08,.72,1.20,.28,.68),(.20,.83,.92,.18,.45); white, vertical alpha -> 0.
/// Each path below: first pair=M, subsequent six values=C(control1,control2,end), then Z.
struct DreamAvatar: View {
    var choice: AvatarChoice = AvatarChoice()
    static func colors(_ palette: String) -> [Color] {
        let hex: [UInt32]
        switch palette {
        case "dusk": hex = [0xCCAA91, 0xEAD2AB, 0xFCF0D4, 0xFFF6CF]
        case "mint": hex = [0x88B8B0, 0xC5E1D7, 0xEAF7EF, 0xFFECCE]
        case "sakura": hex = [0xC3A3BE, 0xEAD1DF, 0xFBEFF2, 0xFFF0D1]
        default: hex = [0x8EAECD, 0xCEDDEC, 0xEEF4FA, 0xFFEAC5]
        }
        return hex.map { Color(hex: $0) }
    }
    static func silhouette(_ shape: String) -> Path {
        let rows: [String: [[CGFloat]]] = [
            "girl": [
                [0.45, 0.05],
                [0.20, 0.02, 0.14, 0.23, 0.19, 0.46],
                [0.12, 0.61, 0.17, 0.74, 0.26, 0.80],
                [0.16, 0.86, 0.12, 0.93, 0.12, 0.96],
                [0.35, 1, 0.72, 1, 0.91, 0.96],
                [0.89, 0.82, 0.71, 0.77, 0.63, 0.72],
                [0.64, 0.66, 0.66, 0.62, 0.69, 0.57],
                [0.82, 0.57, 0.84, 0.51, 0.80, 0.47],
                [0.86, 0.43, 0.88, 0.42, 0.84, 0.37],
                [0.76, 0.28, 0.78, 0.07, 0.57, 0.05],
                [0.52, 0.04, 0.48, 0.04, 0.45, 0.05]
            ],
            "boy": [
                [0.43, 0.07],
                [0.20, 0.08, 0.16, 0.27, 0.24, 0.42],
                [0.19, 0.52, 0.23, 0.66, 0.35, 0.70],
                [0.35, 0.77, 0.24, 0.79, 0.17, 0.86],
                [0.12, 0.90, 0.10, 0.94, 0.10, 0.97],
                [0.38, 1, 0.71, 1, 0.93, 0.96],
                [0.89, 0.81, 0.72, 0.76, 0.63, 0.72],
                [0.64, 0.66, 0.65, 0.63, 0.69, 0.58],
                [0.79, 0.58, 0.84, 0.54, 0.80, 0.49],
                [0.87, 0.47, 0.88, 0.44, 0.83, 0.39],
                [0.74, 0.32, 0.79, 0.20, 0.68, 0.12],
                [0.61, 0.04, 0.51, 0.04, 0.43, 0.07]
            ],
            "cat": [
                [0.19, 0.41],
                [0.13, 0.28, 0.12, 0.12, 0.17, 0.08],
                [0.22, 0.06, 0.32, 0.15, 0.38, 0.21],
                [0.46, 0.18, 0.55, 0.18, 0.63, 0.21],
                [0.71, 0.12, 0.80, 0.06, 0.84, 0.09],
                [0.89, 0.14, 0.88, 0.30, 0.83, 0.42],
                [1, 0.65, 0.85, 0.91, 0.66, 0.95],
                [0.54, 0.99, 0.41, 0.99, 0.30, 0.94],
                [0.10, 0.88, 0.01, 0.64, 0.19, 0.41]
            ],
            "bean": [
                [0.50, 0.06],
                [0.22, 0.03, 0.08, 0.28, 0.12, 0.55],
                [0.15, 0.84, 0.40, 0.99, 0.66, 0.89],
                [0.92, 0.80, 1, 0.52, 0.81, 0.37],
                [0.64, 0.25, 0.74, 0.10, 0.50, 0.06]
            ]
        ]
        let coordinates = rows[shape] ?? rows["bean"]!
        var path = Path()
        path.move(to: CGPoint(x: coordinates[0][0], y: coordinates[0][1]))
        for p in coordinates.dropFirst() {
            path.addCurve(to: CGPoint(x: p[4], y: p[5]), control1: CGPoint(x: p[0], y: p[1]), control2: CGPoint(x: p[2], y: p[3]))
        }
        path.closeSubpath()
        return path
    }
    var body: some View {
        Canvas { context, size in
            let palette = Self.colors(choice.palette)
            context.scaleBy(x: size.width, y: size.height)
            let path = Self.silhouette(choice.shape)
            context.clip(to: path)
            context.fill(path, with: .linearGradient(Gradient(stops: [.init(color: palette[0], location: 0), .init(color: palette[1], location: 0.55), .init(color: palette[2], location: 1)]), startPoint: .zero, endPoint: CGPoint(x: 0, y: 1)))
            context.fill(path, with: .radialGradient(Gradient(colors: [palette[3].opacity(0.70), .clear]), center: CGPoint(x: 0.32, y: 0.25), startRadius: 0, endRadius: 0.48))
            context.fill(path, with: .radialGradient(Gradient(colors: [.white.opacity(0.60), .clear]), center: CGPoint(x: 0.67, y: 0.42), startRadius: 0, endRadius: 0.40))
            let clouds: [[CGFloat]] = [[-0.15,0.60,0.80,0.20,0.45], [0.30,0.52,0.80,0.22,0.50], [-0.08,0.72,1.20,0.28,0.68], [0.20,0.83,0.92,0.18,0.45]]
            for c in clouds {
                context.fill(Path(ellipseIn: CGRect(x: c[0], y: c[1], width: c[2], height: c[3])), with: .linearGradient(Gradient(colors: [.white.opacity(c[4]), .clear]), startPoint: CGPoint(x: 0, y: c[1]), endPoint: CGPoint(x: 0, y: c[1] + c[3])))
            }
        }
        .accessibilityLabel("\(AvatarChoice.shapeTitles[AvatarChoice.shapes.firstIndex(of: choice.shape) ?? 0])头像")
    }
}

struct AgentAvatar: View {
    var size: CGFloat = 40
    var body: some View { DreamAvatar(choice: ProfileStore.shared.avatar).frame(width: size, height: size) }
}

struct AgentStatusDot: View {
    private var chat: ChatClient { .shared }
    @Environment(\.interactiveWindow) private var active
    var body: some View {
        TimelineView(.animation(minimumInterval: 0.12, paused: !chat.busy || !active)) { ctx in
            Circle().fill(!chat.connected ? Theme.faint : chat.busy ? Color(hex: 0xC9A869) : Theme.online)
                .opacity(chat.busy && active ? 0.65 + 0.35 * sin(ctx.date.timeIntervalSinceReferenceDate * .pi) : 1)
                .frame(width: 8, height: 8)
                .overlay(Circle().strokeBorder(.white, lineWidth: 1))
        }
        .accessibilityLabel(!chat.connected ? "离线" : chat.busy ? "忙碌" : "在线")
    }
}
