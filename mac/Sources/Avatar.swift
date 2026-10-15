import SwiftUI
import AVFoundation
import AppKit

/// All five server states use the same asset contract. Missing final videos use the candidate still.
struct AgentAvatar: View {
    var size: CGFloat=88
    var state: AvatarState?=nil
    @Environment(\.interactiveWindow) private var active
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var visible=true
    private var current: AvatarState { state ?? ChatClient.shared.avatarState }
    private var directory: URL? { Bundle.main.resourceURL?.appendingPathComponent("Mascot/"+current.rawValue) }
    private var still: NSImage? {
        guard let d=directory else { return nil }; return NSImage(contentsOf:d.appendingPathComponent("still.png"))
    }
    private var video: URL? {
        guard let u=directory?.appendingPathComponent(Theme.dark ? "dark.mp4" : "light.mp4"), FileManager.default.fileExists(atPath:u.path) else { return nil }; return u
    }
    var body: some View {
        ZStack {
            Circle().fill(Theme.background)
            if let still { Image(nsImage:still).resizable().scaledToFill() }
            else { Image(systemName:"face.smiling").resizable().scaledToFit().padding(size*0.18).foregroundStyle(Theme.ink) }
            if let video, !reduceMotion { MascotVideo(url:video,playing:active && visible) }
        }
        .frame(width:size,height:size).clipShape(Circle())
        .overlay(Circle().strokeBorder(Theme.ink.opacity(0.07),lineWidth:0.7))
        .shadow(color:.black.opacity(Theme.dark ? 0.25 : 0.09),radius:3,y:1)
        .background(MediaVisibility { visible=$0 })
        .accessibilityLabel("豆豆 · "+current.rawValue)
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
    var body:some View {
        Button { Nav.shared.console=true } label: {
            VStack(spacing:0) {
                AgentAvatar(size:88)
                    .overlay(alignment:.bottom) {
                        Text(ProfileStore.shared.agentName).font(Theme.font(size:12,weight:.medium)).lineLimit(1)
                            .padding(.horizontal,11).padding(.vertical,4).background(Theme.userBubble,in:Capsule()).offset(y:10)
                    }
                Group {
                    if sideChat {Text("旁聊")}
                    else if ChatClient.shared.avatarState == .working {Text(ChatClient.shared.avatarText.isEmpty ? "努力工作中" : ChatClient.shared.avatarText)}
                }.font(Theme.font(size:11)).foregroundStyle(Theme.sub).padding(.top,18)
            }.foregroundStyle(Theme.ink).frame(height:137,alignment:.top)
        }.buttonStyle(.plain).help("打开控制台").verificationAction("floating-avatar")
    }
}
