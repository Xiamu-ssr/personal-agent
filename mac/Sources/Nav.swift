import AppKit
import Observation
import SwiftUI

enum Tab: String, CaseIterable {
    case chat, today, tasks, memory, home, settings

    var title: String {
        switch self {
        case .chat: "聊天"
        case .today: "今日"
        case .tasks: "任务"
        case .memory: "记忆"
        case .home: "豆豆"
        case .settings: "设置"
        }
    }

    var icon: String {
        switch self {
        case .chat: "bubble.left"
        case .today: "calendar"
        case .tasks: "list.bullet.rectangle"
        case .memory: "sparkles"
        case .home: "person"
        case .settings: "gearshape"
        }
    }

    /// Each tab's own cool tint when not selected (spec §四).
    var tint: Color {
        switch self {
        case .chat: Color(hex: 0x487FA6)
        case .today: Color(hex: 0x527AAA)
        case .tasks: Color(hex: 0x3F7F87)
        case .memory: Color(hex: 0x776AA3)
        case .home: Color(hex: 0x637DA0)
        case .settings: Color(hex: 0x6B7C90)
        }
    }

    /// Composer placeholder on the pages that have one.
    var prompt: String? {
        switch self {
        case .chat: "说说你想做什么…"
        case .today: "告诉我今天的安排…"
        case .tasks: "交给豆豆一个任务…"
        case .memory: "告诉豆豆更多关于你的事…"
        default: nil
        }
    }
}

enum Route: Hashable {
    /// A site (or any file the web view can show).
    case web(title: String, path: String)
    /// A Markdown/text file rendered natively.
    case doc(title: String, path: String)
    case memoryCategory(String)
    case diaries
    case connectors(tab: Int, focus: String? = nil)
    case connector(String)
    case connectorForm(name: String, accountID: String?)
    case devices
    case skills
}

/// Which page is showing: a sidebar tab, plus a stack of pages pushed inside it.
@Observable
final class Nav {
    static let shared = Nav()

    var tab: Tab = .chat
    var stacks: [Tab: [Route]] = [:]
    /// Full-window image viewer.
    var preview: String? = nil
    var toast = ""
    var briefFocus: String?
    var todaySection = 0
    var tasksSection = 0

    func go(_ t: Tab) {
        if t == .today { todaySection = 0 }
        if t == .tasks { tasksSection = 0 }
        if tab == t || t == .settings { stacks[t] = [] }
        tab = t
    }

    func push(_ r: Route, in t: Tab? = nil) {
        let t = t ?? tab
        tab = t
        stacks[t, default: []].append(r)
    }

    /// Keep the selected host tab when returning from a connector detail.
    func openConnector(_ name: String, from hostTab: Int, focus: String? = nil) {
        if var stack = stacks[tab], case .connectors? = stack.last {
            stack[stack.count - 1] = .connectors(tab: hostTab, focus: focus)
            stacks[tab] = stack
        }
        push(.connector(name))
    }

    func pop() {
        if !(stacks[tab]?.isEmpty ?? true) { stacks[tab]?.removeLast() }
    }

    func show(_ message: String) {
        toast = message
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            if self?.toast == message { self?.toast = "" }
        }
    }

    private static let imageExts: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "tiff"]
    private static let textExts: Set<String> = ["md", "txt", "csv", "json", "log"]

    /// Open a data/ path the best way we can: web view, Markdown page, image viewer, or the default app.
    func open(_ path: String, title: String? = nil) {
        if path.hasPrefix("data/briefs/") {
            guard path.hasSuffix(".json") else { show("这份简报不是 JSON 格式"); return }
            stacks[.today] = []
            todaySection = 0
            tab = .today
            briefFocus = path
            return
        }
        let ext = (path as NSString).pathExtension.lowercased()
        let name = title ?? ((path as NSString).lastPathComponent as NSString).deletingPathExtension
        if Self.imageExts.contains(ext) {
            preview = path
        } else if Self.textExts.contains(ext) {
            push(.doc(title: name, path: path))
        } else if ext.isEmpty || ext == "html" || ext == "htm" || ext == "svg" {
            push(.web(title: name, path: path))
        } else {
            Task { @MainActor in
                do { try await Api.openExternally(path) } catch { show("打不开：\(error.localizedDescription)") }
            }
        }
    }

    /// Say something in the chat on the user's behalf (推荐任务, 连接 a catalog connector) and jump there.
    func ask(_ text: String) {
        if ChatClient.shared.send(text) {
            go(.chat)
            stacks[.chat] = []
        } else {
            show("还没连上，稍等再试")
        }
    }
}
