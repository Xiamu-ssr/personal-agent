import SwiftUI
import AVFoundation
import AppKit

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
    private var current: AvatarState { state ?? ChatClient.shared.avatarState }
    private var peeking: Bool { expressive && active && !reduceMotion && (hovering || greeting) }
    private var directory: URL? { Bundle.main.resourceURL?.appendingPathComponent("Mascot/"+current.rawValue) }
    private var still: NSImage? {
        guard let d=directory else { return nil }; return NSImage(contentsOf:d.appendingPathComponent("still.png"))
    }
    private var video: URL? {
        guard let u=directory?.appendingPathComponent(Theme.dark ? "dark.mp4" : "light.mp4"), FileManager.default.fileExists(atPath:u.path) else { return nil }; return u
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
                if let video, !reduceMotion { MascotVideo(url:video,playing:active && visible && !peeking) }
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
    func makeNSView(context:Context)->LoopView { LoopView() }
    func updateNSView(_ view:LoopView,context:Context) { view.configure(url,playing:playing) }
    static func dismantleNSView(_ view:LoopView,coordinator:()) { view.stop() }
    final class LoopView:NSView {
        private var url:URL?
        private var player:AVQueuePlayer?
        private var looper:AVPlayerLooper?
        private let playerLayer=AVPlayerLayer()
        override init(frame:NSRect) { super.init(frame:frame); wantsLayer=true; layer?.addSublayer(playerLayer); playerLayer.videoGravity = .resizeAspectFill; layer?.masksToBounds=true }
        required init?(coder:NSCoder) { fatalError() }
        override func layout() { super.layout(); playerLayer.frame=bounds; layer?.cornerRadius=min(bounds.width,bounds.height)/2 }
        func configure(_ url:URL,playing:Bool) {
            if self.url != url {
                stop(); self.url=url
                let player=AVQueuePlayer(); player.isMuted=true
                self.player=player; looper=AVPlayerLooper(player:player,templateItem:AVPlayerItem(url:url)); playerLayer.player=player
            }
            if playing && window?.occlusionState.contains(.visible) == true { player?.play() } else { player?.pause() }
        }
        func stop() { player?.pause(); looper?.disableLooping(); looper=nil; player?.removeAllItems(); player=nil; playerLayer.player=nil; url=nil }
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
                AgentAvatar(size:88, expressive:true)
                    .overlay(alignment:.bottom) {
                        Text(ProfileStore.shared.agentName).font(Theme.font(size:12,weight:.medium)).lineLimit(1)
                            .padding(.horizontal,12).padding(.vertical,5).background(Theme.card,in:Capsule())
                            .overlay(Capsule().strokeBorder(Theme.line,lineWidth:0.5)).offset(y:10)
                    }
                if !status.isEmpty {
                    HStack(spacing: 5) {
                        Circle().fill(ChatClient.shared.avatarState == .error ? Theme.danger : Theme.accent).frame(width: 5, height: 5)
                        Text(status).lineLimit(1)
                    }.font(Theme.font(size:11)).foregroundStyle(Theme.sub).padding(.top,20)
                }
            }.foregroundStyle(Theme.ink).frame(height:146,alignment:.top)
        }.buttonStyle(.plain).help("打开控制台").verificationAction("floating-avatar")
    }
}
