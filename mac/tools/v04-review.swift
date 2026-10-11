import AppKit
import SwiftUI

@MainActor
enum V04Review {
    static let output = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("verification/v0.4.0/screenshots")
    static func window() -> NSWindow {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 820), styleMask: [.titled, .closable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        w.title = "豆豆 · 0.4.0 本地验收"; w.identifier = NSUserInterfaceItemIdentifier("main")
        w.titleVisibility = .hidden; w.titlebarAppearsTransparent = true; w.isReleasedWhenClosed = false
        w.contentView = NSHostingView(rootView: MainView()); w.center(); return w
    }
    static func capture(_ view: NSView, _ name: String) throws {
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        view.layoutSubtreeIfNeeded()
        guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { throw VerificationError(description: "v0.4 native snapshot") }
        view.cacheDisplay(in: view.bounds, to: bitmap)
        guard let data = bitmap.representation(using: .png, properties: [:]) else { throw VerificationError(description: "v0.4 PNG snapshot") }
        try data.write(to: output.appendingPathComponent(name + ".png")); print("Snapshot: \(name).png"); fflush(stdout)
    }
    static func pause(_ ms: UInt64 = 600) async throws { try await Task.sleep(nanoseconds: ms * 1_000_000) }
    static func scenario(_ name: String) async throws { _ = try await Api.json("/verify/scenario?name=" + name); try await pause() }
    static func scroll(_ view: NSView, toEnd: Bool) {
        func collect(_ v: NSView) -> [NSScrollView] { (v as? NSScrollView).map { [$0] } ?? v.subviews.flatMap(collect) }
        guard let s = collect(view).max(by: { $0.bounds.height < $1.bounds.height }), let d = s.documentView else { return }
        s.contentView.scroll(to: NSPoint(x: 0, y: toEnd ? max(0, d.bounds.height - s.contentView.bounds.height) : 0)); s.reflectScrolledClipView(s.contentView)
    }
    static func input(_ view: NSView) -> ComposerTextView? {
        if let e = view as? ComposerTextView, e.isEditable { return e }
        return view.subviews.compactMap(input).first
    }
    static func run() async throws {
        try check(LocalVerification.explicitLoopback, "UI review requires explicit loopback server")
        Session.shared.configured = true; Session.shared.onboarded = true
        let chat = ChatClient.shared; chat.start()
        let w = window(); w.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        defer { chat.stop(); w.close() }
        for _ in 0..<100 where !chat.connected { try await pause(30) }
        try check(chat.connected, "v0.4 fake service websocket")
        func capture(_ name: String, wait: UInt64 = 650) async throws { try await pause(wait); try self.capture(w.contentView!, name) }
        func tab(_ tab: Tab, _ name: String) async throws { Nav.shared.go(tab); try await capture(name) }
        try await scenario("idle"); try await capture("01-chat-capsule-brief")
        try await tab(.today, "02-today-multicard-top")
        let briefs = try await BriefItem.fetch(); try check(briefs.first?.cards.count == 3, "today fixture has multiple native cards")
        scroll(w.contentView!, toEnd: true); try await capture("03-today-multicard-bottom", wait: 200); scroll(w.contentView!, toEnd: false); try await pause(200)
        Nav.shared.todaySection = 1; try await capture("04-today-sites-thumbnails-fallback", wait: 3500)
        let mtime = Date(timeIntervalSince1970: 1000); SitePreviewCache.shared.clear()
        let first = await SitePreviewCache.shared.preview(path: "data/sites/本周支出/index.html", mtime: mtime, fallback: "本周支出")
        try check(first.image != nil && first.title == "本周支出" && first.description.contains("这周"), "offscreen WK metadata and phone snapshot")
        let a = try await Api.json("/verify/stats")
        _ = await SitePreviewCache.shared.preview(path: "data/sites/本周支出/index.html", mtime: mtime, fallback: "本周支出")
        let b = try await Api.json("/verify/stats")
        try check((a["operations"] as? [String: Int])?["site"] == (b["operations"] as? [String: Int])?["site"], "path plus mtime cache avoids another site load")
        let changed = await SitePreviewCache.shared.preview(path: "data/sites/本周支出/index.html", mtime: Date(timeIntervalSince1970: 2000), fallback: "本周支出")
        try check(changed.image != nil, "mtime change refreshes thumbnail")
        let fallback = await SitePreviewCache.shared.preview(path: "data/sites/暂时无法加载/index.html", mtime: mtime, fallback: "暂时无法加载")
        try check(fallback.image == nil && fallback.title == "暂时无法加载", "failed thumbnail keeps gradient/initial fallback")
        try await scenario("empty"); try await tab(.today, "05-today-empty-brief")
        try await scenario("sites-empty"); Nav.shared.go(.today); try await pause()
        Nav.shared.todaySection = 1; try await capture("06-today-empty-sites", wait: 200)
        try await scenario("tasks"); try await tab(.tasks, "07-tasks-combined-list")
        try check(chat.backgroundTasks.count == 2, "combined task list uses server snapshot")
        scroll(w.contentView!, toEnd: true); try await capture("08-tasks-completed-groups", wait: 200); scroll(w.contentView!, toEnd: false); try await pause(200)
        chat.stopTask("report"); try await capture("09-task-stopping", wait: 200)
        try await pause(1700); try check(chat.backgroundTasks.count == 1, "terminal event removes only stopped task")
        chat.stopTask("table"); try await capture("10-task-stop-error", wait: 300)
        try check(!chat.taskError.isEmpty, "failed task stop restores button")
        Nav.shared.tasksSection = 1; try await capture("11-tasks-schedule", wait: 200)
        try await scenario("idle"); try await tab(.memory, "12-memory-health-profile")
        scroll(w.contentView!, toEnd: true); try await capture("13-memory-folders-voice", wait: 200)
        try await scenario("health-empty"); try await tab(.memory, "14-memory-health-empty")
        try await scenario("idle"); Nav.shared.go(.home); try await pause()
        for shape in AvatarChoice.shapes {
            await ProfileStore.shared.save(AvatarChoice(shape: shape, palette: "mist"))
            try check(ProfileStore.shared.avatar.shape == shape && ProfileStore.shared.error.isEmpty, "PUT confirms selected shape")
            try await capture("15-doudou-" + shape, wait: 200)
        }
        let reloaded = ProfileStore(); await reloaded.load(); try check(reloaded.avatar.shape == "cat", "new client synchronizes saved profile")
        Nav.shared.push(.diaries); try await capture("16-diary-note-grid")
        try await tab(.settings, "17-settings-membership")
        Nav.shared.push(.connectors(tab: 0)); try await capture("18-connectors-system-app-icons")
        Nav.shared.stacks[.settings] = [.connectors(tab: 1)]; try await capture("19-connectors-cloud-official-icons", wait: 1200)
        try check(ConnectorStore.shared.connected.count == 1 && ConnectorStore.shared.catalog.count == 8, "cloud contains separate service connectors only")
        scroll(w.contentView!, toEnd: true); try await capture("20-connectors-cloud-more", wait: 300)
        Nav.shared.push(.connector("qq-mail")); try await capture("21-connector-multiple-account-states")
        Nav.shared.push(.connectorForm(name: "qq-mail", accountID: "qq-a")); try await capture("22-connector-edit-masked-secret")
        Nav.shared.stacks[.settings] = [.connectors(tab: 1), .connector("imap"), .connectorForm(name: "imap", accountID: nil)]
        try await capture("23-connector-dynamic-form")
        Nav.shared.stacks[.settings] = [.devices]; try await capture("24-devices-offline-remove")
        Nav.shared.go(.chat); try await scenario("queue"); try await capture("25-queued-message", wait: 200)
        guard let queued = chat.items.first(where: { $0.queued && !$0.serverID.isEmpty }) else { throw VerificationError(description: "queue identity") }
        try check(chat.updateQueue(queued, text: "修改后的排队消息：先列三件最要紧的事。"), "loopback edit"); try await pause(300)
        try check(chat.items.contains { $0.serverID == queued.serverID && $0.text.hasPrefix("修改后的") && $0.queued }, "queue edit acknowledged")
        try await capture("26-queued-message-edited", wait: 100)
        guard let edited = chat.items.first(where: { $0.serverID == queued.serverID }) else { throw VerificationError(description: "edited queue bubble") }
        _ = chat.updateQueue(edited); try await pause(300)
        try check(!chat.items.contains { $0.serverID == queued.serverID }, "recall waits for server removal")
        let stats = try await Api.json("/verify/stats"); try check(stats["historyUsers"] as? Int == 0, "recalled queue never enters history")
        try await capture("27-queued-message-recalled", wait: 100)
        try await scenario("queue-late")
        guard let late = chat.items.first(where: { $0.queued }) else { throw VerificationError(description: "too_late fixture") }
        _ = chat.updateQueue(late); try await pause(200)
        try check(chat.queueNotice == "豆豆已经在看这条了" && chat.items.contains { $0.serverID == late.serverID && !$0.queued }, "too_late server authority")
        try await capture("28-queue-too-late", wait: 100)
        w.contentView = NSHostingView(rootView: OnboardingView().background(Theme.canvas).preferredColorScheme(.light))
        try await capture("29-onboarding-enable-all", wait: 300)
        print("PASS: v0.4 loopback production pages, cards, WK thumbnails/cache/fallback, task controls, health, avatar PUT/GET, diaries, member card, connectors and queue protocol")
    }
}
