import AppKit
import EventKit
import UserNotifications

/// One thing this Mac can do for the agent. All of them are registered; the agent only sees the enabled ones.
struct Capability: Identifiable {
    let name: String
    let title: String
    /// SF Symbol shown in 连接应用 → 本机.
    let icon: String
    /// Written for the model.
    let description: String
    let args: String
    /// What the user sees in settings, when it should differ from [description].
    var hint: String? = nil
    /// Ask for the system permission this needs; returns why it can't be switched on, or nil.
    var permit: (() async -> String?)? = nil
    let run: ([String: Any]) async throws -> Any

    var id: String { name }

    var enabled: Bool { Prefs.granted(name) && (name != "folder" || Prefs.folder != nil) }

    var json: [String: Any] {
        var j: [String: Any] = ["name": name, "title": title, "description": description, "args": args, "sync": false,
                                "source": name, "enabled": enabled]
        if let hint { j["hint"] = hint }
        return j
    }
}

struct CapError: LocalizedError {
    let errorDescription: String?
    init(_ s: String) { errorDescription = s }
}

enum Capabilities {
    static let all: [Capability] = [
        Capability(name: "battery", title: "电量", icon: "battery.75percent", description: "Mac 电量和是否接着电源（台式机没有电池）", args: "{}") { _ in
            let out = try await shell("/usr/bin/pmset", ["-g", "batt"])
            let pct = out.range(of: #"\d+%"#, options: .regularExpression).flatMap { Int(out[$0].dropLast()) }
            let r: [String: Any] = ["percent": pct ?? -1, "on_power": out.contains("AC Power")]
            return r
        },
        Capability(name: "notify", title: "发通知", icon: "bell.badge", description: "在 Mac 上弹一条通知提醒用户",
                   args: #"{"title":"标题","text":"正文"}"#, permit: {
                       await requestNotifications() ? nil : "系统通知没打开，去「系统设置 → 通知 → 豆豆」允许"
                   }) { a in
            guard await notifyAllowed() else { throw CapError("系统通知没打开") }
            let c = UNMutableNotificationContent()
            c.title = a["title"] as? String ?? "豆豆"
            c.body = a["text"] as? String ?? ""
            c.sound = .default
            try await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
            return "已通知"
        },
        Capability(name: "calendar_events", title: "日历", icon: "calendar", description: "读 Mac 日历（含 iCloud 等已同步的账户）里的日程",
                   args: #"{"from":"YYYY-MM-DD，默认今天","days":"天数，默认1"}"#,
                   permit: permitCalendar) { a in try await calendar(a) },
        Capability(name: "clipboard_read", title: "读剪贴板", icon: "doc.on.clipboard", description: "读 Mac 剪贴板里的文字", args: "{}") { _ in
            await MainActor.run { String((NSPasteboard.general.string(forType: .string) ?? "").prefix(20000)) }
        },
        Capability(name: "clipboard_write", title: "写剪贴板", icon: "clipboard", description: "把文字放进 Mac 剪贴板，方便用户直接粘贴",
                   args: #"{"text":"内容"}"#) { a in
            let text = a["text"] as? String ?? ""
            await MainActor.run {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(text, forType: .string)
            }
            return "已放进剪贴板"
        },
        Capability(name: "open_url", title: "打开网页", icon: "safari", description: "在 Mac 的默认浏览器里打开一个网址给用户看",
                   args: #"{"url":"https://…"}"#) { a in
            guard let s = a["url"] as? String, let u = URL(string: s), ["http", "https"].contains(u.scheme?.lowercased() ?? "") else {
                throw CapError("只能打开 http/https 网址")
            }
            _ = await MainActor.run { NSWorkspace.shared.open(u) }
            return "已打开"
        },
        Capability(name: "frontmost_app", title: "当前应用", icon: "macwindow", description: "用户此刻在 Mac 上用的是哪个应用", args: "{}") { _ in
            await MainActor.run {
                let app = NSWorkspace.shared.frontmostApplication
                let r: [String: Any] = ["name": app?.localizedName ?? "", "bundle_id": app?.bundleIdentifier ?? ""]
                return r
            }
        },
        Capability(name: "shortcuts", title: "快捷指令", icon: "square.stack.3d.up", description: "运行用户 Mac 上的快捷指令；不给 name 就列出全部快捷指令",
                   args: #"{"name":"快捷指令名，可选","input":"传给它的文字，可选"}"#,
                   hint: "豆豆能列出和运行你的快捷指令，能做什么取决于你建了哪些") { a in
            guard let name = a["name"] as? String, !name.isEmpty else {
                return try await shell("/usr/bin/shortcuts", ["list"]).split(separator: "\n").map(String.init)
            }
            let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("doudou-sc-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: tmp) }
            let outFile = tmp.appendingPathComponent("out")
            var args = ["run", name, "-o", outFile.path]
            if let input = a["input"] as? String, !input.isEmpty {
                let inFile = tmp.appendingPathComponent("in.txt")
                try input.write(to: inFile, atomically: true, encoding: .utf8)
                args += ["-i", inFile.path]
            }
            _ = try await shell("/usr/bin/shortcuts", args, timeout: 120)
            guard let d = try? Data(contentsOf: outFile), !d.isEmpty else { return "已运行" }
            return String(data: d.prefix(20000), encoding: .utf8) ?? "已运行（输出不是文字，\(d.count) 字节）"
        },
        Capability(name: "folder", title: "文件夹", icon: "folder",
                   description: "读写用户授权的一个 Mac 文件夹。op=list 列目录，op=read 读文本文件（200KB 以内），op=write 写文本文件。path 是相对这个文件夹的路径",
                   args: #"{"op":"list|read|write","path":"相对路径，默认根目录","text":"write 时的内容"}"#,
                   hint: "只限你在下面选的那个文件夹，可读可写") { a in try folder(a) },
    ]

    static var enabled: [Capability] { all.filter(\.enabled) }

    static func notifyAllowed() async -> Bool {
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        return status == .authorized || status == .provisional
    }

    /// Ask once; later calls just report the current answer.
    @discardableResult
    static func requestNotifications() async -> Bool {
        let c = UNUserNotificationCenter.current()
        if await c.notificationSettings().authorizationStatus == .notDetermined {
            return (try? await c.requestAuthorization(options: [.alert, .sound])) ?? false
        }
        return await notifyAllowed()
    }

    private static let calendarDenied = "日历权限没给，去「系统设置 → 隐私与安全性 → 日历」打开豆豆"

    private static func permitCalendar() async -> String? {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .fullAccess: return nil
        case .notDetermined:
            let ok = (try? await EKEventStore().requestFullAccessToEvents()) ?? false
            return ok ? nil : calendarDenied
        default: return calendarDenied
        }
    }

    private static let day: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.dateFormat = "yyyy-MM-dd"
        f.isLenient = false
        return f
    }()

    private static func calendar(_ a: [String: Any]) async throws -> Any {
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else { throw CapError(calendarDenied) }
        let cal = Calendar.current
        let from = (a["from"] as? String).flatMap { day.date(from: $0) } ?? Date()
        let start = cal.startOfDay(for: from)
        let days = min(max(Int("\(a["days"] ?? 1)") ?? 1, 1), 31)
        let end = cal.date(byAdding: .day, value: days, to: start) ?? start
        let store = EKEventStore()
        let events = store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: nil))
        return events.sorted { $0.startDate < $1.startDate }.map { e -> [String: Any] in
            ["title": e.title ?? "", "begin": stamp.string(from: e.startDate), "end": stamp.string(from: e.endDate),
             "all_day": e.isAllDay, "location": e.location ?? "", "calendar": e.calendar?.title ?? ""]
        }
    }

    private static let stamp: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm"
        return f
    }()

    private static func folder(_ a: [String: Any]) throws -> Any {
        guard let rootPath = Prefs.folder else { throw CapError("用户还没选文件夹") }
        let root = URL(fileURLWithPath: rootPath).standardizedFileURL.resolvingSymlinksInPath()
        let rel = (a["path"] as? String ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/ "))
        let target = (rel.isEmpty ? root : root.appendingPathComponent(rel)).standardizedFileURL.resolvingSymlinksInPath()
        guard target.path == root.path || target.path.hasPrefix(root.path + "/") else { throw CapError("路径超出授权文件夹") }
        let fm = FileManager.default
        switch a["op"] as? String ?? "list" {
        case "list":
            let keys: [URLResourceKey] = [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey]
            let items = try fm.contentsOfDirectory(at: target, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles])
            return items.prefix(500).map { u -> [String: Any] in
                let v = try? u.resourceValues(forKeys: Set(keys))
                return ["name": u.lastPathComponent, "dir": v?.isDirectory ?? false, "size": v?.fileSize ?? 0,
                        "modified": v?.contentModificationDate.map(stamp.string) ?? ""]
            }
        case "read":
            let size = (try fm.attributesOfItem(atPath: target.path)[.size] as? Int) ?? 0
            guard size <= 200_000 else { throw CapError("文件太大（\(size / 1024)KB），只读 200KB 以内的文本") }
            guard let s = String(data: try Data(contentsOf: target), encoding: .utf8) else { throw CapError("不是文本文件") }
            return s
        case "write":
            guard !rel.isEmpty else { throw CapError("要给文件路径") }
            try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            try (a["text"] as? String ?? "").write(to: target, atomically: true, encoding: .utf8)
            return "已写入 \(rel)"
        default:
            throw CapError("op 只能是 list / read / write")
        }
    }

    /// Run a command, returning stdout+stderr; throws on a non-zero exit. Killed after [timeout] seconds.
    static func shell(_ exe: String, _ args: [String], timeout: Double = 30) async throws -> String {
        try await withCheckedThrowingContinuation { cont in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: exe)
            p.arguments = args
            let pipe = Pipe()
            p.standardOutput = pipe
            p.standardError = pipe
            do { try p.run() } catch { return cont.resume(throwing: error) }
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { if p.isRunning { p.terminate() } }
            DispatchQueue.global().async {
                let s = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                p.waitUntilExit()
                if p.terminationStatus == 0 { cont.resume(returning: s) } else {
                    cont.resume(throwing: CapError(s.isEmpty ? "退出码 \(p.terminationStatus)" : String(s.prefix(2000))))
                }
            }
        }
    }
}
