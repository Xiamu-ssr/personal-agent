import AppKit
import AVKit
import Observation
import SwiftUI

enum MediaPresentation {
    case image, video, audio, file
    static func forItem(_ item: MediaItem) -> MediaPresentation {
        let ext = (item.path as NSString).pathExtension.lowercased()
        switch item.kind {
        case .image: return .image
        case .video: return ext == "webm" ? .file : .video
        case .audio: return ["ogg", "opus"].contains(ext) ? .file : .audio
        case .file: return .file
        }
    }
}

@MainActor enum MediaPlaybackFocus {
    private static var owner: UUID?
    private static var pauseCurrent: (() -> Void)?
    static func claim(_ id: UUID, pause: @escaping () -> Void) {
        if owner != id { pauseCurrent?() }
        owner = id; pauseCurrent = pause
    }
    static func release(_ id: UUID) {
        if owner == id { owner = nil; pauseCurrent = nil }
    }
}

@MainActor @Observable final class MediaPlayback {
    private let id = UUID()
    private(set) var player: AVPlayer?
    private(set) var playing = false
    private(set) var loading = false
    private(set) var failed = false
    private(set) var unsupported = false
    private(set) var usingCache = false
    private(set) var time = 0.0
    private(set) var duration = 0.0
    var fullScreen = false
    @ObservationIgnored private var asset: AVURLAsset?
    @ObservationIgnored private var rateObserver: NSKeyValueObservation?
    @ObservationIgnored private var statusObserver: NSKeyValueObservation?
    @ObservationIgnored private var timeObserver: Any?
    @ObservationIgnored private var cleanupPlayer: AVPlayer?
    @ObservationIgnored private var work: Task<Void, Never>?
    @ObservationIgnored private var fallback: (() -> Void)?
    private var generation = 0

    static func streamAsset(_ path: String, server: String = Prefs.server, token: String = Api.authToken) -> AVURLAsset? {
        guard let url = Api.fileURL(path, server: server) else { return nil }
        return AVURLAsset(url: url, options: ["AVURLAssetHTTPHeaderFieldsKey": ["Authorization": "Bearer " + token]])
    }

    func prepare(_ item: MediaItem, server: String = Prefs.server, token: String = Api.authToken) async {
        release()
        let version = generation
        loading = true
        guard let remote = Self.streamAsset(item.path, server: server, token: token) else { loading = false; failed = true; return }
        asset = remote
        do {
            let playable = try await remote.load(.isPlayable)
            try Task.checkCancellation()
            guard generation == version else { return }
            if playable {
                let length = try await remote.load(.duration)
                try Task.checkCancellation()
                guard generation == version else { return }
                install(remote, duration: length.seconds)
                fallback = { [weak self] in
                    guard let self else { return }
                    work = Task { @MainActor [weak self] in
                        await self?.prepareCached(item, server: server, token: token, version: version)
                    }
                }
                return
            }
        } catch is CancellationError { return } catch {}
        await prepareCached(item, server: server, token: token, version: version)
    }

    private func prepareCached(_ item: MediaItem, server: String, token: String, version: Int) async {
        guard generation == version, !Task.isCancelled else { return }
        clearPlayer(); asset?.cancelLoading(); fallback = nil
        loading = true; usingCache = true
        do {
            let url = try await Api.download(item.path, server: server, token: token)
            try Task.checkCancellation()
            guard generation == version else { return }
            let local = AVURLAsset(url: url)
            asset = local
            let playable = try await local.load(.isPlayable)
            try Task.checkCancellation()
            guard generation == version else { return }
            if !playable { loading = false; unsupported = true; return }
            let length = try await local.load(.duration)
            try Task.checkCancellation()
            guard generation == version else { return }
            install(local, duration: length.seconds)
        } catch is CancellationError {} catch {
            if generation == version { loading = false; failed = true; asset?.cancelLoading(); asset = nil }
        }
    }

    private func install(_ asset: AVURLAsset, duration: Double) {
        self.duration = duration.isFinite ? max(0, duration) : 0
        let item = AVPlayerItem(asset: asset), player = AVPlayer(playerItem: item)
        self.player = player
        cleanupPlayer = player
        loading = false
        let version = generation
        rateObserver = player.observe(\.rate, options: [.new]) { [weak self, weak player] _, _ in
            Task { @MainActor in
                guard let self, let player, self.player === player, self.generation == version else { return }
                self.playing = player.rate > 0
                if self.playing { self.claimPlayback() }
                else { MediaPlaybackFocus.release(self.id) }
            }
        }
        statusObserver = item.observe(\.status, options: [.initial, .new]) { [weak self, weak player] item, _ in
            guard item.status == .failed else { return }
            Task { @MainActor in
                guard let self, let player, self.player === player, self.generation == version else { return }
                if let fallback = self.fallback { self.fallback = nil; fallback() }
                else { self.clearPlayer(); self.failed = true }
            }
        }
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.2, preferredTimescale: 600), queue: .main) { [weak self, weak player] time in
            Task { @MainActor in
                guard let self, let player, self.player === player, self.generation == version else { return }
                self.time = time.seconds.isFinite ? max(0, time.seconds) : 0
                let length = player.currentItem?.duration.seconds ?? 0
                if length.isFinite && length > 0 { self.duration = length }
            }
        }
    }

    private func claimPlayback() {
        MediaPlaybackFocus.claim(id) { [weak self] in self?.pause() }
    }

    func toggle() {
        guard let player else { return }
        if player.rate > 0 { pause() }
        else {
            if duration > 0 && time >= duration - 0.1 { seek(0) }
            claimPlayback(); player.play(); playing = true
        }
    }

    func pause() {
        player?.pause(); playing = false
        MediaPlaybackFocus.release(id)
    }

    func seek(_ seconds: Double) {
        let next = min(max(0, seconds), duration)
        time = next
        player?.seek(to: CMTime(seconds: next, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
    }

    private func clearPlayer() {
        pause()
        rateObserver?.invalidate(); rateObserver = nil
        statusObserver?.invalidate(); statusObserver = nil
        if let player, let timeObserver { player.removeTimeObserver(timeObserver) }
        timeObserver = nil
        player?.replaceCurrentItem(with: nil); player = nil; cleanupPlayer = nil
        time = 0; duration = 0
    }

    func release() {
        generation += 1
        work?.cancel(); work = nil; fallback = nil
        asset?.cancelLoading(); asset = nil
        clearPlayer()
        loading = false; failed = false; unsupported = false; usingCache = false; fullScreen = false
    }

    deinit {
        work?.cancel(); asset?.cancelLoading()
        rateObserver?.invalidate(); statusObserver?.invalidate()
        if let cleanupPlayer, let timeObserver { cleanupPlayer.removeTimeObserver(timeObserver) }
        cleanupPlayer?.pause(); cleanupPlayer?.replaceCurrentItem(with: nil)
    }

    static func clock(_ seconds: Double) -> String {
        let value = seconds.isFinite ? Int(max(0, seconds)) : 0
        return String(format: "%d:%02d", value / 60, value % 60)
    }
}

struct ReplyMediaView: View {
    let item: MediaItem
    var body: some View {
        switch MediaPresentation.forItem(item) {
        case .image:
            RemoteImage(path: item.path, maxSide: 240, failureText: "文件不可用")
                .onTapGesture { Nav.shared.preview = item.path }
                .frame(maxWidth: .infinity, alignment: .leading)
        case .video, .audio: MediaPlayerCard(item: item)
        case .file: MediaFileCard(item: item)
        }
    }
}

struct MediaFileCard: View {
    let item: MediaItem
    var unavailable = false
    @State private var failed = false
    @State private var loading = false

    var body: some View {
        Button {
            loading = true
            Task { @MainActor in
                defer { loading = false }
                do {
                    _ = try await Api.data(Api.filePath(item.path), method: "HEAD")
                    Nav.shared.open(item.path, title: item.name, onFailure: { failed = true })
                } catch { failed = true }
            }
        } label: {
            HStack(spacing: 10) {
                IconTile(icon: Self.icon(item.path), size: 34)
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.name).font(Theme.font(size: 13, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(1)
                    Text(failed || unavailable ? "文件不可用" : Fmt.size(item.size)).font(Theme.font(size: 11)).foregroundStyle(Theme.sub)
                }.frame(maxWidth: .infinity, alignment: .leading)
                if loading { ActiveProgress().controlSize(.small) }
                else { Image(systemName: "arrow.up.right").font(Theme.font(size: 11)).foregroundStyle(Theme.faint) }
            }.padding(12)
        }.buttonStyle(.plain).disabled(loading)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.line, lineWidth: 0.5))
            .modifier(MediaFileActions(item: item, failed: $failed))
    }

    static func icon(_ path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "pdf", "doc", "docx": return "doc.richtext"
        case "xls", "xlsx", "csv", "numbers": return "tablecells"
        case "zip", "gz", "tar", "rar", "7z": return "doc.zipper"
        case "mp3", "m4a", "aac", "wav", "ogg", "opus", "flac": return "waveform"
        case "mp4", "m4v", "mov", "webm": return "film"
        default: return "doc.text"
        }
    }
}

private struct MediaFileActions: ViewModifier {
    let item: MediaItem
    @Binding var failed: Bool
    func body(content: Content) -> some View {
        content.contextMenu {
            Button("用默认应用打开") {
                Task { @MainActor in do { try await Api.openExternally(item.path) } catch { failed = true } }
            }
            Button("存储到…") {
                let panel = NSSavePanel()
                panel.nameFieldStringValue = (item.path as NSString).lastPathComponent
                guard panel.runModal() == .OK, let destination = panel.url else { return }
                Task { @MainActor in
                    do {
                        let file = try await Api.download(item.path)
                        let staging = destination.deletingLastPathComponent().appendingPathComponent(".doudou-\(UUID())")
                        defer { try? FileManager.default.removeItem(at: staging) }
                        try FileManager.default.copyItem(at: file, to: staging)
                        if FileManager.default.fileExists(atPath: destination.path) { _ = try FileManager.default.replaceItemAt(destination, withItemAt: staging) }
                        else { try FileManager.default.moveItem(at: staging, to: destination) }
                    } catch { failed = true }
                }
            }
        }
    }
}

private struct MediaPlayerCard: View {
    let item: MediaItem
    @State private var playback = MediaPlayback()
    @State private var visible = false
    @State private var failed = false
    @Environment(\.interactiveWindow) private var active
    private var available: Bool { (visible && active) || playback.fullScreen }

    var body: some View {
        Group {
            if playback.unsupported || playback.failed { MediaFileCard(item: item, unavailable: playback.failed) }
            else {
                VStack(alignment: .leading, spacing: 8) {
                    if item.kind == .video {
                        Text(item.name).font(Theme.font(size: 13, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(1)
                        if let player = playback.player { MediaVideo(player: player, playback: playback).frame(height: 220) }
                        else { RoundedRectangle(cornerRadius: 10).fill(Theme.field).frame(height: 220).overlay { if playback.loading { ActiveProgress().controlSize(.small) } else { Image(systemName: "film").foregroundStyle(Theme.faint) } } }
                    } else {
                        HStack(spacing: 8) {
                            Button { playback.toggle() } label: {
                                Image(systemName: playback.playing ? "pause.fill" : "play.fill").foregroundStyle(Theme.accent).frame(width: 28, height: 28)
                            }.buttonStyle(.plain).disabled(playback.player == nil).accessibilityLabel(playback.playing ? "暂停" : "播放")
                            Text(item.name).font(Theme.font(size: 12, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(1).frame(maxWidth: 110, alignment: .leading)
                            if playback.loading { ActiveProgress().controlSize(.mini) }
                            Slider(value: Binding(get: { min(playback.time, max(playback.duration, 1)) }, set: { playback.seek($0) }), in: 0...max(playback.duration, 1))
                                .tint(Theme.accent).disabled(playback.duration <= 0).accessibilityLabel("播放进度")
                            Text(MediaPlayback.clock(playback.time) + " / " + MediaPlayback.clock(playback.duration))
                                .font(Theme.font(size: 10.5).monospacedDigit()).foregroundStyle(Theme.sub).fixedSize()
                        }
                    }
                    if failed { Text("文件不可用").font(Theme.font(size: 12)).foregroundStyle(Theme.sub) }
                }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.card, in: RoundedRectangle(cornerRadius: 14))
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                    .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.line, lineWidth: 0.5))
                    .modifier(MediaFileActions(item: item, failed: $failed))
            }
        }
        .background(MediaVisibility { visible = $0 })
        .task(id: available ? item : nil) {
            if available { await playback.prepare(item) } else { playback.release() }
        }
        .onDisappear { playback.release() }
    }
}

private struct MediaVideo: NSViewRepresentable {
    let player: AVPlayer
    let playback: MediaPlayback
    func makeCoordinator() -> Coordinator { Coordinator(playback) }
    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        view.controlsStyle = .inline; view.showsFullScreenToggleButton = true
        view.delegate = context.coordinator; view.player = player
        return view
    }
    func updateNSView(_ view: AVPlayerView, context: Context) { view.player = player; view.appearance = Theme.appearance }
    static func dismantleNSView(_ view: AVPlayerView, coordinator: Coordinator) { view.player = nil; view.delegate = nil }
    final class Coordinator: NSObject, AVPlayerViewDelegate {
        let playback: MediaPlayback
        init(_ playback: MediaPlayback) { self.playback = playback }
        func playerViewWillEnterFullScreen(_ playerView: AVPlayerView) { Task { @MainActor [weak playback] in playback?.fullScreen = true } }
        func playerViewDidExitFullScreen(_ playerView: AVPlayerView) { Task { @MainActor [weak playback] in playback?.fullScreen = false } }
    }
}

/// Lazy stacks retain offscreen rows; clip bounds, rather than disappearance alone, gate decoder lifetime.
struct MediaVisibility: NSViewRepresentable {
    let changed: (Bool) -> Void
    func makeNSView(context: Context) -> MediaVisibilityObserver { MediaVisibilityObserver(changed: changed) }
    func updateNSView(_ view: MediaVisibilityObserver, context: Context) { view.changed = changed; view.schedule() }
    static func dismantleNSView(_ view: MediaVisibilityObserver, coordinator: ()) { view.detach() }
}

final class MediaVisibilityObserver: NSView {
    var changed: (Bool) -> Void
    private var observations: [NSObjectProtocol] = []
    private var pending: DispatchWorkItem?
    private var last: Bool?
    init(changed: @escaping (Bool) -> Void) { self.changed = changed; super.init(frame: .zero) }
    required init?(coder: NSCoder) { fatalError() }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow(); detach()
        DispatchQueue.main.async { [weak self] in self?.attach() }
    }
    override func layout() { super.layout(); schedule() }
    private func attach() {
        guard window != nil else { return }
        let center = NotificationCenter.default
        if let scroll = enclosingScrollView {
            scroll.contentView.postsBoundsChangedNotifications = true
            observations.append(center.addObserver(forName: NSView.boundsDidChangeNotification, object: scroll.contentView, queue: .main) { [weak self] _ in self?.schedule() })
            if let doc = scroll.documentView {
                doc.postsFrameChangedNotifications = true
                observations.append(center.addObserver(forName: NSView.frameDidChangeNotification, object: doc, queue: .main) { [weak self] _ in self?.schedule() })
            }
        }
        schedule()
    }
    static func visible(bounds: NSRect, clipped: NSRect) -> Bool { !bounds.isEmpty && !bounds.intersection(clipped).isEmpty }
    func schedule() {
        guard pending == nil else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }; pending = nil
            let next = window != nil && !isHiddenOrHasHiddenAncestor && Self.visible(bounds: bounds, clipped: visibleRect)
            if next != last { last = next; changed(next) }
        }
        pending = work; DispatchQueue.main.async(execute: work)
    }
    func detach() {
        pending?.cancel(); pending = nil
        observations.forEach(NotificationCenter.default.removeObserver); observations = []
        last = nil
    }
    deinit { detach() }
}
