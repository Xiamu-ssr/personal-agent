import SwiftUI

struct BackgroundTask: Identifiable, Equatable {
    let id: String
    var description: String
    var startedAt: Date
    var summary = ""
    var title: String { description.isEmpty ? "后台任务" : description }
}

/// Shared by the main composer and the menu chat. The clock observes only an individual elapsed label.
struct TaskControls: View {
    var compact = false
    private var chat: ChatClient { .shared }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            if !chat.queueNotice.isEmpty {
                HStack(spacing: 8) {
                    Text(chat.queueNotice).font(.system(size: 11.5)).foregroundStyle(Theme.sub)
                    Spacer()
                    Button { chat.queueNotice = "" } label: { Image(systemName: "xmark") }
                        .buttonStyle(.plain).font(.system(size: 10)).foregroundStyle(Theme.faint)
                }.padding(.horizontal, 8)
            }
            if !chat.backgroundTasks.isEmpty { BackgroundTasksBar(compact: compact) }
            if chat.busy {
                HStack(spacing: 7) {
                    ActiveProgress().controlSize(.mini)
                    Text(chat.replyStatus).font(.system(size: compact ? 11.5 : 12)).foregroundStyle(Theme.sub)
                        .lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                    Button { chat.interrupt() } label: { Label("停止", systemImage: "stop.fill") }
                        .buttonStyle(.plain).font(.system(size: 11.5)).foregroundStyle(Theme.ink.opacity(0.8))
                        .help("只停止当前回复，后台任务继续")
                }
                .padding(.horizontal, 8)
            }
            if !chat.taskError.isEmpty {
                HStack(alignment: .top, spacing: 5) {
                    Label(chat.taskError, systemImage: "exclamationmark.circle")
                        .font(.system(size: 11.5)).foregroundStyle(Theme.danger)
                    Spacer(minLength: 0)
                    Button { chat.taskError = "" } label: { Image(systemName: "xmark") }
                        .buttonStyle(.plain).font(.system(size: 10)).foregroundStyle(Theme.faint)
                }
                .padding(.horizontal, 8)
            }
        }
    }
}

struct BackgroundTasksBar: View {
    var compact = false
    private var chat: ChatClient { .shared }
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { expanded.toggle() } label: {
                HStack(spacing: 7) {
                    Image(systemName: "arrow.triangle.branch").foregroundStyle(Theme.accent)
                    Text("后台还有 \(chat.backgroundTasks.count) 个任务在跑").foregroundStyle(Theme.ink.opacity(0.85))
                    Spacer(minLength: 0)
                    Image(systemName: expanded ? "chevron.up" : "chevron.down").foregroundStyle(Theme.faint)
                }
                .font(.system(size: 12)).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if expanded {
                ScrollView {
                    VStack(alignment: .leading, spacing: 9) {
                        ForEach(chat.backgroundTasks) { task in
                            HStack(alignment: .center, spacing: 10) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(task.title).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.ink)
                                        .lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                                    TaskElapsed(startedAt: task.startedAt)
                                }
                                Button(chat.stoppingTasks.contains(task.id) ? "停止中…" : "停止") { chat.stopTask(task.id) }
                                    .buttonStyle(SoftButtonStyle()).font(.system(size: 11.5))
                                    .disabled(chat.stoppingTasks.contains(task.id))
                            }
                        }
                    }
                }
                .frame(maxHeight: compact ? 120 : 160)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
        .background(RoundedRectangle(cornerRadius: 14).fill(.white.opacity(0.65)))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(.white, lineWidth: 1))
    }
}

private struct TaskElapsed: View {
    let startedAt: Date
    @Environment(\.interactiveWindow) private var active

    var body: some View {
        TimelineView(.animation(minimumInterval: 1, paused: !active)) { context in
            Text("已运行 " + Self.duration(context.date.timeIntervalSince(startedAt)))
                .font(.system(size: 11).monospacedDigit()).foregroundStyle(Theme.faint)
        }
    }

    private static func duration(_ elapsed: TimeInterval) -> String {
        let seconds = max(0, Int(elapsed))
        if seconds < 60 { return "\(seconds) 秒" }
        if seconds < 3600 { return "\(seconds / 60) 分 \(seconds % 60) 秒" }
        return "\(seconds / 3600) 小时 \(seconds % 3600 / 60) 分 \(seconds % 60) 秒"
    }
}
