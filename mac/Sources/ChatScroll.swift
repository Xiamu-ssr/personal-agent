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
