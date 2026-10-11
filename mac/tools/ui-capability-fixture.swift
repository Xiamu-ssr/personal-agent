// Explicit UI contract double, compiled ONLY with tools/verify.sh --ui-contract.
// No permission requests, tool execution, preference writes or device registration.
import AppKit
import Observation

@Observable
final class DeviceClient {
    static let shared = DeviceClient()
    var online = false
    func start() {}
    func stop() {}
    func reregister() {}
}

struct CapError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

struct Capability: Identifiable {
    let name: String
    let title: String
    let description: String
    let args = "{}"
    var hint: String? { nil }
    var permit: (() async -> String?)? { { "本地界面验收不申请系统授权" } }
    var run: ([String: Any]) async throws -> Any { { _ in throw CapError("界面 fixture 不执行设备工具") } }
    var enabled: Bool { false }
    var id: String { name }
    var json: [String: Any] { ["name": name, "title": title, "description": description, "args": args, "enabled": false] }
    var appIcon: NSImage {
        let bundle: String
        switch name {
        case "shell": bundle = "com.apple.Terminal"
        case "browser": bundle = "com.google.Chrome"
        case "calendar_events": bundle = "com.apple.iCal"
        case "notify": bundle = "com.apple.notificationcenterui"
        default: bundle = "com.apple.finder"
        }
        if name.hasPrefix("folder_") { return NSWorkspace.shared.icon(forFile: NSHomeDirectory()) }
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) { return NSWorkspace.shared.icon(forFile: url.path) }
        return NSWorkspace.shared.icon(forFile: "/System/Applications")
    }
}

enum Capabilities {
    static let all: [Capability] = [
        Capability(name: "shell", title: "Mac 命令行", description: "以用户身份在 zsh 里执行命令"),
        Capability(name: "folder_desktop", title: "Mac 桌面", description: "允许命令行访问桌面"),
        Capability(name: "folder_documents", title: "Mac 文稿", description: "允许命令行访问文稿"),
        Capability(name: "folder_downloads", title: "Mac 下载", description: "允许命令行访问下载"),
        Capability(name: "computer_use", title: "操作电脑", description: "截屏与鼠标键盘操作"),
        Capability(name: "browser", title: "浏览器", description: "通过豆豆 Chrome 扩展操作浏览器"),
        Capability(name: "notify", title: "发通知", description: "豆豆的原生通知"),
        Capability(name: "calendar_events", title: "Mac 日历", description: "读取日历事件")
    ]
    static var enabled: [Capability] { [] }
    static func requestNotifications() async -> Bool { false }
    static func notifyAllowed() async -> Bool { false }
    static func enableAll(progress: @escaping (String, String?) -> Void) async {
        for cap in all { progress(cap.name, "本地界面验收不申请系统授权") }
    }
}
