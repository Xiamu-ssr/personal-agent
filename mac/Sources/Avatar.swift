import SwiftUI
import AVFoundation
import AppKit

@MainActor private enum AvatarAssets {
    static let stills: NSCache<NSString, NSImage> = {
        let cache = NSCache<NSString, NSImage>(); cache.countLimit = 8; cache.totalCostLimit = 8 << 20; return cache
    }()
    static func still(_ state: AvatarState) -> NSImage? {
        let key = state.rawValue as NSString
        if let image = stills.object(forKey: key) { return image }
        guard let url = Bundle.main.resourceURL?.appendingPathComponent("Mascot/\(state.rawValue)/still.png"), let image = NSImage(contentsOf: url) else { return nil }
        stills.setObject(image, forKey: key, cost: Int(image.size.width * image.size.height * 4)); return image
    }
}

/// All five server states use the same asset contract. Missing final videos use the candidate still.
struct AgentAvatar: View {
    var size: CGFloat=88
    var state: AvatarState?=nil
    var expressive = false
    @Environment(\.interactiveWindow) private var active
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var visible=true
    @State private var hovering=false
    @State private var greeting=false
    @State private var motion: UUID?
    @State private var lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
    private var current: AvatarState { state ?? ChatClient.shared.avatarState }
    private var peeking: Bool { expressive && active && !reduceMotion && (hovering || greeting) }
    private var still: NSImage? { AvatarAssets.still(current) }
    private var mayAnimate: Bool { expressive && active && visible && !reduceMotion && !lowPower }
    private var video: URL? {
        guard let u=Bundle.main.resourceURL?.appendingPathComponent("Mascot/\(current.rawValue)/\(Theme.dark ? "dark" : "light").mp4"), FileManager.default.fileExists(atPath:u.path) else { return nil }; return u
    }
    var body: some View {
        ZStack {
            if peeking {
                Ellipse().fill(Theme.userBubble).frame(width: size * 0.85, height: size * 0.24).offset(y: size * 0.37)
            }
            ZStack {
                Circle().fill(Theme.card)
                if let still { Image(nsImage:still).resizable().scaledToFill() }
                else { Image(systemName:"face.smiling").resizable().scaledToFit().padding(size*0.18).foregroundStyle(Theme.ink) }
                if mayAnimate, motion != nil, !peeking, let video { MascotVideo(url:video,playing:true) }
            }.frame(width: size, height: size).clipShape(Circle()).opacity(peeking ? 0 : 1)
            if peeking, let still {
                Image(nsImage: still).resizable().scaledToFit().frame(width: size * 1.34, height: size * 1.34)
                    .offset(y: -size * 0.06).rotationEffect(.degrees(hovering ? -4 : 3))
                    .shadow(color: .black.opacity(0.1), radius: 6, y: 5)
                    .transition(.opacity.combined(with: .scale(scale: 0.93)))
            }
        }
        .frame(width:size,height:size)
        .overlay { if !peeking { Circle().strokeBorder(Theme.line,lineWidth:0.6) } }
        .shadow(color:.black.opacity(Theme.dark ? 0.22 : 0.07),radius:5,y:2)
        .background(MediaVisibility { visible=$0 })
        .accessibilityLabel("豆豆 · "+current.rawValue)
        .onHover { hovering = $0 && expressive }
        .animation(reduceMotion ? nil : .spring(response: 0.38, dampingFraction: 0.78), value: peeking)
        .onReceive(NotificationCenter.default.publisher(for: .NSProcessInfoPowerStateDidChange)) { _ in lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled }
        .task(id: "\(current.rawValue)-\(mayAnimate)") {
            // A small reaction on entry/state change, then release the decoder.
            // Sidebars and other non-expressive avatars never allocate a player.
            let token = UUID(); motion = mayAnimate ? token : nil
            guard mayAnimate else { return }
            try? await Task.sleep(nanoseconds: current == .happy || current == .waiting ? 4_900_000_000 : 2_500_000_000)
            if motion == token { motion = nil }
        }
        .task(id: current) {
            greeting = false
            guard expressive, !reduceMotion, current == .happy || current == .waiting else { return }
            greeting = true
            try? await Task.sleep(nanoseconds: 2_400_000_000)
            if !Task.isCancelled { greeting = false }
        }
    }
}
struct MascotVideo: NSViewRepresentable {
    let url: URL
    let playing: Bool
    func makeNSView(context:Context)->ReactionView { ReactionView() }
    func updateNSView(_ view:ReactionView,context:Context) { view.configure(url,playing:playing) }
    static func dismantleNSView(_ view:ReactionView,coordinator:()) { view.stop() }
    final class ReactionView:NSView {
        private var url:URL?
        private var player:AVPlayer?
        private var playing=false
        private let playerLayer=AVPlayerLayer()
        override init(frame:NSRect) { super.init(frame:frame); wantsLayer=true; layer?.addSublayer(playerLayer); playerLayer.videoGravity = .resizeAspectFill; layer?.masksToBounds=true }
        required init?(coder:NSCoder) { fatalError() }
        override func layout() { super.layout(); playerLayer.frame=bounds; layer?.cornerRadius=min(bounds.width,bounds.height)/2 }
        override func viewDidMoveToWindow() {super.viewDidMoveToWindow();updatePlayback()}
        func configure(_ url:URL,playing:Bool) {
            if self.url != url {
                stop(); self.url=url
                let player=AVPlayer(url:url); player.isMuted=true
                self.player=player; playerLayer.player=player
            }
            self.playing=playing;updatePlayback()
        }
        private func updatePlayback(){if playing && window != nil{player?.play()}else{player?.pause()}}
        func stop() { playing=false;player?.pause();player?.replaceCurrentItem(with:nil);player=nil;playerLayer.player=nil;url=nil }
    }
}
struct AvatarHeader:View {
    var sideChat=false
    private var status: String {
        if sideChat { return "旁聊" }
        if !ChatClient.shared.avatarText.isEmpty && ChatClient.shared.avatarState != .idle { return ChatClient.shared.avatarText }
        switch ChatClient.shared.avatarState {
        case .working: return "正在处理"
        case .waiting: return "等你回应"
        case .happy: return "这件事办好了"
        case .error: return "需要看一眼"
        default: return ""
        }
    }
    var body:some View {
        Button { Nav.shared.console=true } label: {
            VStack(spacing:0) {
                AgentAvatar(size:44, expressive:true)
                Text(ProfileStore.shared.agentName).font(Theme.font(size:13,weight:.medium)).lineLimit(1).padding(.top,5)
                if !status.isEmpty {
                    HStack(spacing: 5) {
                        Circle().fill(ChatClient.shared.avatarState == .error ? Theme.danger : Theme.accent).frame(width: 5, height: 5)
                        Text(status).lineLimit(1)
                    }.font(Theme.font(size:11)).foregroundStyle(Theme.sub).padding(.top,4)
                }
            }.foregroundStyle(Theme.ink).frame(height:82,alignment:.top)
        }.buttonStyle(.plain).help("打开控制台").verificationAction("floating-avatar")
    }
}
