// Local-only performance reproduction; no socket start, user send, upload or cloud task.
import AppKit
import Darwin
import SwiftUI

final class PerfProbe {
    static let shared = PerfProbe()
    private let lock = NSLock()
    private var beat = ProcessInfo.processInfo.systemUptime
    private var lag = 0.0
    private var counts: [String: Int] = [:]
    func record(_ key: String) { lock.lock(); counts[key, default: 0] += 1; lock.unlock() }
    func heartbeat() {
        let now = ProcessInfo.processInfo.systemUptime
        lock.lock(); lag = max(lag, max(0, now - beat - 0.1)); beat = now; lock.unlock()
    }
    func snapshot() -> (Double, Double, [String: Int]) {
        lock.lock(); defer { lock.unlock() }
        return (beat, lag, counts)
    }
}

final class DenyNetwork: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        PerfProbe.shared.record("blocked_network")
        client?.urlProtocol(self, didFailWithError: NSError(domain: "LocalPerformanceOnly", code: 1))
    }
    override func stopLoading() {}
}

@main
struct PerformanceRun {
    static var timers: [DispatchSourceTimer] = []
    static func phase(_ seconds: Double) -> String {
        if seconds < 20 { return "idle_before" }
        if seconds < 140 { return "stream_resize_draft" }
        if seconds < 160 { return "idle_after" }
        if seconds < 180 { return "hidden_command" }
        return "idle_visible"
    }
    static func cpu() -> (Double, Double) {
        var usage = rusage()
        getrusage(RUSAGE_SELF, &usage)
        let seconds = Double(usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) +
                      Double(usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1_000_000
        return (seconds, Double(usage.ru_maxrss) / 1_048_576)
    }
    static func main() {
        NSApplication.shared.setActivationPolicy(.regular)
        Task { @MainActor in setup() }
        NSApplication.shared.run()
    }
    @MainActor
    static func setup() {
        let label = CommandLine.arguments[1]
        let directory = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
        try! FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(label + ".jsonl")
        FileManager.default.createFile(atPath: url.path, contents: nil)
        let file = try! FileHandle(forWritingTo: url)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DenyNetwork.self]
        Api.session = URLSession(configuration: config)
        Session.shared.configured = true; Session.shared.onboarded = true
        let chat = ChatClient.shared
        chat.connected = true; chat.configured = true
        chat.items = (0..<400).map { i in
            ChatItem(kind: i % 3 == 0 ? .user : .assistant,
                     text: "# 本地假数据 \(i)\n\n**中文** 和 English 0123456789。\n\n- 第一条说明\n- 第二条说明\n\n" +
                           String(repeating: "本地历史消息测试内容，不连接云端。", count: 6),
                     ts: Date(timeIntervalSince1970: 1_700_000_000 + Double(i)))
        }
        Composer.shared.text = ""
        Nav.shared.tab = .chat; Nav.shared.stacks = [:]
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760),
                              styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "豆豆 · 本地性能测试 · " + label
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: MainView())
        window.center(); window.makeKeyAndOrderFront(nil)
        let menu = NSWindow(contentRect: NSRect(x: 30, y: 60, width: 380, height: 540),
                            styleMask: [.titled, .closable], backing: .buffered, defer: false)
        menu.title = "豆豆 · 本地菜单输入测试"
        menu.isReleasedWhenClosed = false
        menu.contentView = NSHostingView(rootView: MenuView())
        menu.orderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        let started = ProcessInfo.processInfo.systemUptime
        var tick = 0, draftIndex = -1, turnIndex = -1
        var turnText = ""
        var previousPhase = ""
        var activatedAt = -1.0
        let drafts = [
            String(repeating: "中文长草稿和组字测试，第二行继续输入。\n", count: 60),
            String(repeating: "abcdefghijklmnopqrstuvwxyz0123456789", count: 110),
            String(repeating: "多行中文\n无空格英文ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n", count: 45)
        ]
        let delta = "本地流式增量 English0123456789。\n"
        let pulse = DispatchSource.makeTimerSource(queue: .main)
        pulse.schedule(deadline: .now(), repeating: 0.1, leeway: .milliseconds(5))
        pulse.setEventHandler { PerfProbe.shared.heartbeat() }
        pulse.resume(); timers.append(pulse)
        let stream = DispatchSource.makeTimerSource(queue: .main)
        stream.schedule(deadline: .now(), repeating: 0.05, leeway: .milliseconds(2))
        stream.setEventHandler {
            let seconds = ProcessInfo.processInfo.systemUptime - started
            let current = phase(seconds)
            if previousPhase != current {
                previousPhase = current
                print("PHASE: " + current); fflush(stdout)
                if current == "idle_after" || current == "idle_visible" {
                    if chat.busy { chat.handle(["t": "turn_end", "text": turnText]) }
                    chat.busy = false; chat.streaming = ""; chat.live = []; chat.toolHint = ""
                    Composer.shared.text = ""; injectMenu(menu, text: "")
                }
                if current == "hidden_command" {
                    chat.busy = true; chat.toolHint = "在跑本地模拟命令"
                    chat.live = [LiveTask(id: "fixture", label: "本地假任务", started: Date())]
                    window.orderOut(nil); menu.orderOut(nil); NSApp.deactivate()
                }
                if current == "idle_visible" { window.makeKeyAndOrderFront(nil); menu.orderFront(nil); NSApp.activate(ignoringOtherApps: true) }
            }
            guard current == "stream_resize_draft" else { return }
            if seconds - activatedAt > 2 {
                activatedAt = seconds
                if !NSApp.isActive { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
            }
            PerfProbe.shared.record(NSApp.isActive ? "foreground_ticks" : "background_ticks")
            let elapsed = seconds - 20
            let turn = Int(elapsed / (label.contains("long-turn") ? 300 : 8))
            if turn != turnIndex {
                if turnIndex >= 0 { chat.handle(["t": "turn_end", "text": turnText]) }
                turnText = ""
                turnIndex = turn
                chat.busy = true; chat.streaming = ""
                chat.live = [LiveTask(id: "fixture", label: "本地假任务", started: Date())]
            }
            turnText += delta
            chat.handle(["t": "delta", "text": delta])
            PerfProbe.shared.record("deltas")
            tick += 1
            if tick % 5 == 0 && !label.contains("steady") {
                let widths: [CGFloat] = [940, 1100, 1280, 1450, 1010]
                window.setContentSize(NSSize(width: widths[(tick / 5) % widths.count], height: 760))
                PerfProbe.shared.record("resizes")
            }
            let index = Int(elapsed / 2) % drafts.count
            if !label.contains("stream-only") && index != draftIndex {
                draftIndex = index
                Composer.shared.text = drafts[index]
                injectMenu(menu, text: drafts[index])
                PerfProbe.shared.record("draft_changes")
            }
        }
        stream.resume(); timers.append(stream)

        let monitor = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        var lastTime = started, lastCPU = cpu().0
        monitor.schedule(deadline: .now() + 1, repeating: 1)
        monitor.setEventHandler {
            let now = ProcessInfo.processInfo.systemUptime
            let seconds = now - started
            let usage = cpu()
            let snapshot = PerfProbe.shared.snapshot()
            let age = now - snapshot.0
            let row: [String: Any] = [
                "seconds": seconds, "phase": phase(seconds),
                "cpu_percent": (usage.0 - lastCPU) / max(0.001, now - lastTime) * 100,
                "cpu_total_seconds": usage.0, "main_heartbeat_age_seconds": age,
                "max_main_lag_seconds": snapshot.1, "peak_rss_mb": usage.1,
                "counts": snapshot.2
            ]
            let data = try! JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
            try! file.write(contentsOf: data + Data([10]))
            lastCPU = usage.0; lastTime = now
            if Int(seconds) % 20 == 0 {
                print("METRIC: phase=\(phase(seconds)), cpu=\(String(format: "%.1f", row["cpu_percent"] as! Double))%, heartbeat=\(String(format: "%.3f", age))s")
                fflush(stdout)
            }
            if age > 6 || usage.1 > 1024 || seconds >= 201 {
                let reason = age > 6 ? "main_thread_hang" : usage.1 > 1024 ? "memory_limit" : "completed"
                try! file.write(contentsOf: try! JSONSerialization.data(withJSONObject: ["end": reason, "seconds": seconds]) + Data([10]))
                try! file.close()
                print("END: " + reason); fflush(stdout)
                exit(reason == "completed" ? 0 : 2)
            }
        }
        monitor.resume(); timers.append(monitor)
    }

    @MainActor
    static func injectMenu(_ window: NSWindow, text: String) {
        func find(_ view: NSView) -> NSView? {
            if let field = view as? NSTextField, field.placeholderString?.contains("跟豆豆") == true { return field }
            if let editor = view as? NSTextView, editor.isEditable && !editor.isFieldEditor { return editor }
            for child in view.subviews { if let found = find(child) { return found } }
            return nil
        }
        guard let root = window.contentView, let input = find(root) else { return }
        if let field = input as? NSTextField {
            field.stringValue = text
            field.delegate?.controlTextDidChange?(Notification(name: NSControl.textDidChangeNotification, object: field))
        } else if let editor = input as? NSTextView {
            editor.string = text; editor.didChangeText()
        }
        PerfProbe.shared.record("menu_draft_changes")
    }
}
