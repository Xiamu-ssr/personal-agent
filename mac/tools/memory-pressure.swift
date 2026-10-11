// Owned windows + explicit loopback only. Never starts device capabilities or asks for permissions.
import AppKit
import Darwin
import SwiftUI
import WebKit

final class PerfProbe {
    static let shared = PerfProbe()
    private let lock = NSLock()
    private var beat = ProcessInfo.processInfo.systemUptime
    private var counts: [String: Int] = [:]
    private var state: [String: Any] = [:]
    func record(_ key: String) { lock.lock(); counts[key, default: 0] += 1; lock.unlock() }
    func heartbeat(_ value: [String: Any]) {
        lock.lock(); beat = ProcessInfo.processInfo.systemUptime; state = value; lock.unlock()
    }
    func snapshot() -> (Double, [String: Int], [String: Any]) {
        lock.lock(); defer { lock.unlock() }; return (beat, counts, state)
    }
}

struct StressBrief: View {
    let html: String
    @State private var height: CGFloat = 1
    @State private var loading = true
    @State private var failed = ""
    var body: some View {
        BriefWebView(html: html, documentHeight: $height, loading: $loading, failed: $failed)
            .frame(height: min(max(1, height), 330))
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}

@main struct MemoryPressureRun {
    static var timers: [DispatchSourceTimer] = []
    static func phase(_ seconds: Double) -> String {
        if seconds < 150 { return "foreground" }
        if seconds < 300 { return "background" }
        if seconds < 450 { return "occluded" }
        if seconds < 600 { return "minimized" }
        return "restored_idle"
    }
    static func usage() -> (Double, Double, Double) {
        var cpu = rusage(); getrusage(RUSAGE_SELF, &cpu)
        let seconds = Double(cpu.ru_utime.tv_sec + cpu.ru_stime.tv_sec) +
            Double(cpu.ru_utime.tv_usec + cpu.ru_stime.tv_usec) / 1_000_000
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout.size(ofValue: info) / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        return (seconds, result == KERN_SUCCESS ? Double(info.resident_size) / 1_048_576 : 0,
                result == KERN_SUCCESS ? Double(info.phys_footprint) / 1_048_576 : 0)
    }
    static func main() {
        guard LocalVerification.explicitLoopback, CommandLine.arguments.count >= 3 else {
            print("FAIL: memory pressure requires an explicit loopback -server"); exit(1)
        }
        NSApplication.shared.setActivationPolicy(.regular)
        let label = CommandLine.arguments[1]
        let directory = URL(fileURLWithPath: CommandLine.arguments[2])
        try! FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(label + ".jsonl")
        FileManager.default.createFile(atPath: url.path, contents: nil)
        let file = try! FileHandle(forWritingTo: url)
        let started = ProcessInfo.processInfo.systemUptime
        let duration = Double(ProcessInfo.processInfo.environment["STRESS_SECONDS"] ?? "630") ?? 630
        let monitor = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        var lastTime = started, lastCPU = usage().0, lastReport = -30.0
        var reportTime = started, reportCPU = lastCPU
        monitor.schedule(deadline: .now(), repeating: 1)
        monitor.setEventHandler {
            let now = ProcessInfo.processInfo.systemUptime, elapsed = now - started
            let sample = usage(), probe = PerfProbe.shared.snapshot()
            let cpu = (sample.0 - lastCPU) / max(0.001, now - lastTime) * 100
            let hung = now - probe.0 > 30
            let excessive = sample.2 > 800 || sample.1 > 1100
            if elapsed - lastReport >= 29.9 || hung || excessive || elapsed >= duration {
                var row: [String: Any] = ["seconds": elapsed, "phase": phase(elapsed), "rss_mb": sample.1,
                    "footprint_mb": sample.2, "cpu_percent_last_second": cpu,
                    "cpu_percent_interval": (sample.0 - reportCPU) / max(0.001, now - reportTime) * 100,
                    "cpu_total_seconds": sample.0, "main_heartbeat_age_seconds": now - probe.0,
                    "counts": probe.1, "window_state": probe.2, "pid": getpid()]
                if hung || excessive || elapsed >= duration { row["end"] = hung ? "main_thread_hang" : excessive ? "memory_limit" : "completed" }
                try! file.write(contentsOf: JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) + Data([10]))
                print("SAMPLE \(label) \(Int(elapsed))s \(phase(elapsed)) rss=\(Int(sample.1))MB footprint=\(Int(sample.2))MB cpu=\(String(format: "%.2f", cpu))%"); fflush(stdout)
                lastReport = elapsed
                reportTime = now; reportCPU = sample.0
                if hung || excessive || elapsed >= duration { try! file.close(); exit(hung || excessive ? 2 : 0) }
            }
            lastTime = now; lastCPU = sample.0
        }
        monitor.resume(); timers.append(monitor)
        Task { @MainActor in
            do { try await setup(started: started, directory: directory) }
            catch { print("FAIL: local stress fixture setup \(error.localizedDescription)"); exit(1) }
        }
        NSApplication.shared.run()
    }
    @MainActor static func setup(started: Double, directory: URL) async throws {
        let scenario = ProcessInfo.processInfo.environment["STRESS_SCENARIO"] == "memory-pressure-burst" ? "memory-pressure-burst" : "memory-pressure"
        _ = try await Api.json("/verify/scenario?name=" + scenario)
        Session.shared.configured = true; Session.shared.onboarded = true
        ChatClient.shared.start()
        Nav.shared.go(.memory)
        Nav.shared.push(.doc(title: "压力测试总档", path: "data/memory/profile/总档.md"))
        let main = window("豆豆 · 本地内存压力", size: NSSize(width: 1100, height: 760), root: MainView())
        let task = window("豆豆 · 本地任务轮询", size: NSSize(width: 550, height: 600),
                          root: TaskDetailPage(id: "report", title: "本地进行中任务", briefPath: nil))
        let briefs = try await Api.json("/api/briefs?days=7")
        let cards = (briefs["items"] as! [[String: Any]])[0]["cards"] as! [[String: String]]
        let brief = window("豆豆 · 本地简报 WebView", size: NSSize(width: 480, height: 470),
                           root: ScrollView { VStack { ForEach(0..<cards.count, id: \.self) { StressBrief(html: cards[$0]["html"]!) } } })
        let owned = [main, task, brief]
        task.setFrameOrigin(NSPoint(x: 20, y: 50)); brief.setFrameOrigin(NSPoint(x: 600, y: 50))
        main.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        let cover = NSWindow(contentRect: NSScreen.main!.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        cover.isReleasedWhenClosed = false; cover.backgroundColor = .windowBackgroundColor; cover.isOpaque = true
        cover.level = .floating; cover.title = "本地压力验证遮挡窗口"
        var previous = "", previousPage = -1
        let pulse = DispatchSource.makeTimerSource(queue: .main)
        pulse.schedule(deadline: .now(), repeating: 0.25)
        pulse.setEventHandler {
            let elapsed = ProcessInfo.processInfo.systemUptime - started, current = phase(elapsed)
            if previous != current {
                previous = current
                if current == "foreground" || current == "restored_idle" {
                    cover.orderOut(nil); owned.forEach { $0.deminiaturize(nil); $0.orderFront(nil) }
                    main.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
                } else if current == "background" { NSApp.deactivate() }
                else if current == "occluded" { cover.orderFrontRegardless(); NSApp.deactivate() }
                else { cover.orderOut(nil); owned.forEach { $0.miniaturize(nil) }; NSApp.deactivate() }
                print("PHASE: \(current)"); fflush(stdout)
            }
            // Exercise actual production navigation. Leave each phase's last 60 s idle.
            let within = elapsed.truncatingRemainder(dividingBy: 150)
            let page = elapsed >= 600 ? 0 : within < 30 ? 0 : within < 60 ? 1 : 2
            if page != previousPage {
                previousPage = page
                if page == 0 { Nav.shared.go(.memory); Nav.shared.push(.doc(title: "压力测试总档", path: "data/memory/profile/总档.md")) }
                else { Nav.shared.go(page == 1 ? .chat : .today) }
                PerfProbe.shared.record("navigation")
            }
            PerfProbe.shared.heartbeat(["app_active": NSApp.isActive, "miniaturized": main.isMiniaturized,
                "visible": main.isVisible, "occlusion_visible": main.occlusionState.contains(.visible), "page": page,
                "chat_items": ChatClient.shared.items.count, "webviews": webCount(main.contentView!) + webCount(brief.contentView!)])
        }
        pulse.resume(); timers.append(pulse)
    }
    @MainActor static func window<V: View>(_ title: String, size: NSSize, root: V) -> NSWindow {
        let w = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        w.title = title; w.isReleasedWhenClosed = false; w.contentView = NSHostingView(rootView: root.preferredColorScheme(.light)); w.center(); w.orderFront(nil); return w
    }
    @MainActor static func webCount(_ view: NSView) -> Int { (view is WKWebView ? 1 : 0) + view.subviews.reduce(0) { $0 + webCount($1) } }
}
