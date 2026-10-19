import AppKit
import EventKit
import UserNotifications
import ApplicationServices

/// Folder entries are permission switches. Only entries with a run closure are device tools.
struct Capability: Identifiable {
    let name: String
    let title: String
    let description: String
    let args: String
    var hint: String? = nil
    var permit: (() async -> String?)? = nil
    var run: (([String: Any]) async throws -> Any)? = nil

    var id: String { name }
    var enabled: Bool { Prefs.granted(name) && permissionFailure == nil }
    var permissionFailure: String? {
        if name == "computer_use" {
            if !CGPreflightScreenCaptureAccess() { return "屏幕录制尚未授权，请在这台 Mac 的豆豆中开启操作电脑" }
            if !AXIsProcessTrusted() { return "辅助功能尚未授权，请在这台 Mac 的豆豆中开启操作电脑" }
        }
        if name == "calendar_events" && EKEventStore.authorizationStatus(for: .event) != .fullAccess { return "日历尚未授权或权限已收回" }
        return nil
    }

    var appIcon: NSImage {
        let key = (FolderPermission.directory(for: name)?.path ?? name) as NSString
        if let image = CapabilityIcons.cache.object(forKey: key) { return image }
        let workspace = NSWorkspace.shared
        if let folder = FolderPermission.directory(for: name) {
            let image = workspace.icon(forFile: folder.path)
            CapabilityIcons.cache.setObject(image, forKey: key)
            return image
        }
        let bundle: String
        let path: String
        switch name {
        case "shell":
            bundle = "com.apple.Terminal"; path = "/System/Applications/Utilities/Terminal.app"
        case "computer_use":
            bundle = "com.apple.systempreferences"; path = "/System/Applications/System Settings.app"
        case "browser":
            bundle = "com.apple.Safari"; path = "/Applications/Safari.app"
        case "notify":
            bundle = "com.apple.notificationcenterui"; path = "/System/Library/CoreServices/NotificationCenter.app"
        case "calendar_events":
            bundle = "com.apple.iCal"; path = "/System/Applications/Calendar.app"
        default:
            bundle = "com.apple.finder"; path = "/System/Library/CoreServices/Finder.app"
        }
        let image = workspace.icon(forFile: workspace.urlForApplication(withBundleIdentifier: bundle)?.path ?? path)
        CapabilityIcons.cache.setObject(image, forKey: key)
        return image
    }

    var json: [String: Any] {
        var value: [String: Any] = ["name": name, "title": title, "description": description,
                                  "args": args, "sync": false, "source": name, "enabled": enabled]
        if let hint { value["hint"] = hint }
        value["status"] = enabled ? "ready" : Prefs.granted(name) ? "permission_required" : "off"
        if !enabled { value["unavailableReason"] = Prefs.granted(name) ? permissionFailure ?? "系统授权尚未开启" : "请在这台 Mac 的豆豆中开启「\(title)」" }
        return value
    }
}

struct CapError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

enum Capabilities {
    static let all: [Capability] = [
        Capability(name: "shell", title: "Mac 命令行",
                   description: "以当前用户身份用 /bin/zsh -lc 执行命令，默认目录为用户主目录。timeout 是秒，默认 30，最大 300；超时杀掉整个进程组，exit=124。返回 stdout、stderr、exit；总输出最多 20000 字，截断会注明。桌面、文稿、下载访问需要分别开启文件夹授权。",
                   args: #"{"command":"命令","cwd":"工作目录，可选","timeout":30}"#,
                   hint: "豆豆能执行命令、读写文件；受 macOS 隐私授权限制",
                   run: { try await ShellTool.run($0) }),
        folderSwitch("folder_desktop", "Mac 桌面"),
        folderSwitch("folder_documents", "Mac 文稿"),
        folderSwitch("folder_downloads", "Mac 下载"),
        Capability(name: "computer_use", title: "操作电脑",
                   description: "截屏及鼠标键盘操作。op=screenshot 返回 JPEG、width、height、display，长边最多 1440 像素。click/scroll/drag 的 x,y/from/to 均为最近一次 screenshot 图片中的像素坐标，原点在左上角，内部按该图片尺寸映射到对应屏幕的逻辑坐标（含多屏偏移、Retina 缩放）；先截图再操作，改变显示器布局后要重新截图。type 逐字输入；key 的 keys 为按键名数组或 Cmd+Shift+A 形式的组合。需要屏幕录制及辅助功能授权。",
                   args: #"{"op":"screenshot|click|type|key|scroll|drag","display":"显示器 ID，截图可选","x":100,"y":100,"button":"left|right|middle","double":false,"text":"文字","keys":["CMD","A"],"dx":0,"dy":200,"from":{"x":100,"y":100},"to":{"x":200,"y":200}}"#,
                   hint: "豆豆能看到屏幕并操作鼠标键盘，需要你在系统设置里授权",
                   permit: { await DevicePermissions.computerUse() },
                   run: { try await ComputerTool.shared.run($0) }),
        Capability(name: "browser", title: "豆豆浏览器",
                   description: "App 内置、用户可接手的多标签浏览器，独立持久登录状态，与 Safari/Chrome 隔离，无需扩展。op=tabs/open/snapshot/click/type/scroll/screenshot/back/close。open 可传 tab 在原标签打开，否则新建；其他操作要传 tab。snapshot 是层级无障碍树，可操作节点带 [ref=eN]，最多 12000 字。click/type 用 snapshot 的 ref 发送原生事件，随后等待导航结束或 DOM 静止 500ms（最多 10 秒）并返回新 snapshot。页面变化后使用新 snapshot 的 ref。type 追加文字，submit=true 按回车；scroll 的 dy 是 CSS 像素，正数向下。截图返回 image/mime。首次调用会打开豆豆浏览器窗口。",
                   args: #"{"op":"tabs|open|snapshot|click|type|scroll|screenshot|back|close","url":"https://…，open 必填","tab":"标签 ID","ref":"e1","text":"文字","submit":false,"dy":500}"#,
                   hint: "使用内置浏览器；你可以在窗口里操作和登录",
                   run: { try await DoudouBrowser.shared.run($0) }),
        Capability(name: "notify", title: "发通知", description: "在 Mac 上以豆豆的名义弹一条通知提醒用户",
                   args: #"{"title":"标题","text":"正文"}"#,
                   permit: { await requestNotifications() ? nil : "系统通知没打开，去「系统设置 → 通知 → 豆豆」允许" },
                   run: { args in
                       guard await notifyAllowed() else { throw CapError("系统通知没打开") }
                       let content = UNMutableNotificationContent()
                       content.title = args["title"] as? String ?? "豆豆"
                       content.body = args["text"] as? String ?? ""
                       content.sound = .default
                       try await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
                       return "已通知"
                   }),
        Capability(name: "calendar_events", title: "Mac 日历", description: "读 Mac 日历（含 iCloud 等已同步的账户）里的日程",
                   args: #"{"from":"YYYY-MM-DD，默认今天","days":"天数，默认1，最多31"}"#,
                   permit: permitCalendar, run: { try await calendar($0) }),
    ]

    static var enabled: [Capability] { all.filter(\.enabled) }
    /// The cloud turns every registered enabled capability into an MCP tool; omit permission-only rows.
    static var tools: [Capability] { all.filter { $0.run != nil } }

    private static func folderSwitch(_ name: String, _ title: String) -> Capability {
        Capability(name: name, title: title, description: "允许 Mac 命令行访问\(title.dropFirst(4))文件夹；仅授权开关，没有工具",
                   args: "{}", hint: "开启时 macOS 会申请这个文件夹的访问权限",
                   permit: { await FolderPermission.request(name) })
    }

    /// The callback reports each finished switch on the main actor, including a denial or timeout.
    @MainActor
    static func enableAll(progress: @escaping (String, String?) -> Void) async {
        for name in ["notify", "calendar_events", "folder_desktop", "folder_documents", "folder_downloads", "computer_use", "shell", "browser"] {
            guard let cap = all.first(where: { $0.name == name }) else { continue }
            let reason = await cap.permit?()
            Prefs.setGranted(name, reason == nil)
            progress(name, reason)
        }
    }

    static func notifyAllowed() async -> Bool {
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        return status == .authorized || status == .provisional
    }

    @discardableResult
    static func requestNotifications() async -> Bool {
        let center = UNUserNotificationCenter.current()
        if await center.notificationSettings().authorizationStatus == .notDetermined {
            return (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
        }
        return await notifyAllowed()
    }

    private static let calendarDenied = "日历权限没给，去「系统设置 → 隐私与安全性 → 日历」打开豆豆"
    private static func permitCalendar() async -> String? {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .fullAccess: return nil
        case .notDetermined:
            return (try? await EKEventStore().requestFullAccessToEvents()) == true ? nil : calendarDenied
        default: return calendarDenied
        }
    }

    private static func calendar(_ args: [String: Any]) async throws -> Any {
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else { throw CapError(calendarDenied) }
        let day = DateFormatter()
        day.locale = Locale(identifier: "en_US_POSIX")
        day.calendar = Calendar(identifier: .gregorian)
        day.dateFormat = "yyyy-MM-dd"
        day.isLenient = false
        let stamp = DateFormatter()
        stamp.dateFormat = "yyyy-MM-dd HH:mm"
        let cal = Calendar.current
        let from = (args["from"] as? String).flatMap { day.date(from: $0) } ?? Date()
        let start = cal.startOfDay(for: from)
        let days = min(max(Int("\(args["days"] ?? 1)") ?? 1, 1), 31)
        let end = cal.date(byAdding: .day, value: days, to: start) ?? start
        let store = EKEventStore()
        return store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: nil))
            .sorted { $0.startDate < $1.startDate }.map { event -> [String: Any] in
                ["title": event.title ?? "", "begin": stamp.string(from: event.startDate), "end": stamp.string(from: event.endDate),
                 "all_day": event.isAllDay, "location": event.location ?? "", "calendar": event.calendar?.title ?? ""]
            }
    }
}

private enum CapabilityIcons {
    static let cache: NSCache<NSString, NSImage> = { let cache = NSCache<NSString, NSImage>(); cache.countLimit = 24; return cache }()
}
