import AppKit
import Observation
import SwiftUI

/// Pure scroll decisions shared by main chat, tasks and the menu-bar window.
@Observable final class ChatScrollState {
    private(set) var atBottom = true
    private(set) var showReturn = false
    private(set) var unread = 0
    @ObservationIgnored private var known: Set<UUID>?
    @ObservationIgnored private var countedStreams: Set<UUID> = []
    @ObservationIgnored private var newestMessageDate: Date?
    @ObservationIgnored private var streamPrefixes: [UUID: String] = [:]
    func report(distance: CGFloat, viewport: CGFloat, positionChanged: Bool) {
        // Content growth and focusing an editor preserve a bottom reader's follow intent.
        if positionChanged || !atBottom {
            atBottom = distance <= 80
            showReturn = !atBottom && distance > max(100, viewport * 0.85)
            if atBottom { unread = 0; countedStreams.removeAll(keepingCapacity: true); streamPrefixes.removeAll(keepingCapacity: true) }
        }
    }
    func messages(_ ids: [UUID]) {
        let current = Set(ids)
        if let known, !atBottom { unread += current.subtracting(known).subtracting(countedStreams).count }
        known = current
    }
    /// A reconnect/history refill can recreate view IDs; old history is not newly arrived chat.
    func messages(_ items: [ChatItem]) {
        let current = Set(items.map(\.id))
        if let known, !atBottom {
            let added = current.subtracting(known).subtracting(countedStreams)
            let replacement = !known.isEmpty && known.isDisjoint(with: current)
            for item in items where added.contains(item.id) {
                let historical = item.ts.flatMap { time in newestMessageDate.map { time <= $0 } } ?? false
                let alreadyStreamed = replacement && item.kind == .assistant && streamPrefixes.values.contains { !($0.isEmpty) && item.text.hasPrefix($0) }
                if alreadyStreamed { continue }
                if (replacement || added.count > 1) && historical { continue }
                unread += 1
            }
        }
        known = current
        if let newest = items.compactMap(\.ts).max(), newest > (newestMessageDate ?? .distantPast) { newestMessageDate = newest }
        streamPrefixes = streamPrefixes.filter { !current.contains($0.key) }
    }
    func stream(_ id: UUID, text: String = "") {
        guard !atBottom else { return }
        if !text.isEmpty { streamPrefixes[id] = String(text.prefix(128)) }
        guard !countedStreams.contains(id) else { return }
        countedStreams.insert(id); unread += 1
    }
    func returnToBottom() { atBottom = true; showReturn = false; unread = 0; countedStreams.removeAll(keepingCapacity: true); streamPrefixes.removeAll(keepingCapacity: true) }
}

struct ReturnToBottom: View {
    let state: ChatScrollState
    let action: () -> Void
    var body: some View {
        if state.showReturn {
            Button(action: action) {
                HStack(spacing: 8) {
                    Image(systemName: "arrow.down")
                    Text("回到底部")
                    if state.unread > 0 { Text("\(state.unread)").font(Theme.font(size: 12, weight: .semibold)) }
                }.font(Theme.font(size: 13)).foregroundStyle(Theme.accent)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(Theme.card, in: Capsule())
                    .overlay(Capsule().strokeBorder(Theme.line, lineWidth: 0.5))
                    .shadow(color: Theme.ink.opacity(0.06), radius: 6, y: 2)
            }.buttonStyle(.plain).accessibilityLabel("回到底部").verificationAction("回到底部")
                .padding(.trailing, 30).padding(.bottom, 14)
        }
    }
}

/// Observe native clip bounds. No SwiftUI geometry/layout state feedback or periodic measurements.
struct ChatScrollReader: NSViewRepresentable {
    let state: ChatScrollState
    func makeNSView(context: Context) -> ChatScrollObserver { ChatScrollObserver(state: state) }
    func updateNSView(_ view: ChatScrollObserver, context: Context) { view.state = state }
    static func dismantleNSView(_ view: ChatScrollObserver, coordinator: ()) { view.detach() }
}

final class ChatScrollObserver: NSView {
    var state: ChatScrollState
    private weak var scroll: NSScrollView?
    private var observations: [NSObjectProtocol] = []
    private var pending: DispatchWorkItem?
    private var wheelMonitor: Any?
    private var userScrollUntil: TimeInterval = 0
    private var lastY: CGFloat?
    private var lastHeight: CGFloat?
    private var lastViewport: CGFloat?
    init(state: ChatScrollState) { self.state = state; super.init(frame: .zero) }
    required init?(coder: NSCoder) { fatalError() }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        detach()
        guard window != nil else { return }
        DispatchQueue.main.async { [weak self] in self?.attach() }
    }
    private func attach() {
        guard let scroll = enclosingScrollView, let doc = scroll.documentView else { return }
        self.scroll = scroll
        scroll.contentView.postsBoundsChangedNotifications = true
        doc.postsFrameChangedNotifications = true
        let center = NotificationCenter.default
        observations = [center.addObserver(forName: NSView.boundsDidChangeNotification, object: scroll.contentView, queue: .main) { [weak self] _ in self?.schedule() },
                        center.addObserver(forName: NSView.frameDidChangeNotification, object: doc, queue: .main) { [weak self] _ in self?.schedule() }]
        wheelMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self, weak scroll] event in
            guard let self, let scroll, event.window === scroll.window,
                  scroll.visibleRect.contains(scroll.convert(event.locationInWindow, from: nil)),
                  abs(event.scrollingDeltaY) > abs(event.scrollingDeltaX) else { return event }
            self.userScrollUntil = ProcessInfo.processInfo.systemUptime + 0.5
            return event
        }
        schedule()
    }
    private func schedule() {
        guard pending == nil else { return }
        let work = DispatchWorkItem { [weak self] in self?.pending = nil; self?.report() }
        pending = work; DispatchQueue.main.async(execute: work)
    }
    private func report() {
        guard let scroll, let doc = scroll.documentView else { return }
        let clip = scroll.contentView.bounds, height = doc.bounds.height
        let distance = doc.isFlipped ? height - clip.maxY : clip.minY
        let dimensionsUnchanged = lastHeight == height && lastViewport == clip.height
        let positionChanged = lastY != nil && lastY != clip.minY && (dimensionsUnchanged || ProcessInfo.processInfo.systemUptime < userScrollUntil)
        state.report(distance: max(0, distance), viewport: clip.height, positionChanged: positionChanged)
        lastY = clip.minY; lastHeight = height; lastViewport = clip.height
    }
    func detach() {
        observations.forEach(NotificationCenter.default.removeObserver); observations = []
        if let wheelMonitor { NSEvent.removeMonitor(wheelMonitor); self.wheelMonitor = nil }
        pending?.cancel(); pending = nil; scroll = nil
        lastY = nil; lastHeight = nil; lastViewport = nil
    }
    deinit { detach() }
}
