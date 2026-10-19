import AppKit
import SwiftUI
import CoreGraphics

private struct ProviderReviewFailure: Error, CustomStringConvertible { let description: String }
@main struct ProvidersReview {
    static let output = URL(fileURLWithPath:"/tmp/v081-mac-shots")
    static var window: NSWindow!
    static var checks = 0
    static var shots = [String]()
    static var captureMethod = ""
    @MainActor static func main() {
        let app = NSApplication.shared; app.setActivationPolicy(.regular)
        Task { @MainActor in
            do { try await run(); ChatClient.shared.stop(); window.close(); print("PASS: \(checks) native provider checks"); fflush(stdout); exit(0) }
            catch { print("FAIL: \(error)"); fflush(stdout); exit(1) }
        }; app.run()
    }
    static func check(_ ok: Bool, _ text: String) throws { if !ok { throw ProviderReviewFailure(description:text) }; checks += 1; print("PASS: " + text); fflush(stdout) }
    static func pause(_ ms: UInt64 = 250) async throws { try await Task.sleep(nanoseconds:ms * 1_000_000) }
    @MainActor static func until(_ text: String, _ condition: () -> Bool) async throws {
        for _ in 0..<200 { if condition() { return }; try await pause(50) }
        throw ProviderReviewFailure(description:"timed out: " + text)
    }
    @MainActor static func collect<T:NSView>(_ view:NSView, type:T.Type) -> [T] { (view as? T).map{[$0]} ?? view.subviews.flatMap{collect($0,type:type)} }
    @MainActor static func marker(_ name:String) throws -> NSView {
        guard let view = VerificationActionAnchor.views.object(forKey:name as NSString), view.window === window else { throw ProviderReviewFailure(description:"missing native marker: " + name) }; return view
    }
    @MainActor static func press(_ name:String) async throws {
        try await until("native action: " + name) { VerificationActionAnchor.views.object(forKey:name as NSString)?.window === window }
        let view = try marker(name); view.scrollToVisible(view.bounds); try await pause(80)
        let point = view.convert(NSPoint(x:view.bounds.midX,y:view.bounds.midY),to:nil)
        for type in [NSEvent.EventType.leftMouseDown,.leftMouseUp] {
            let event = NSEvent.mouseEvent(with:type,location:point,modifierFlags:[],timestamp:ProcessInfo.processInfo.systemUptime,windowNumber:window.windowNumber,context:nil,eventNumber:1,clickCount:1,pressure:type == .leftMouseDown ? 1:0)!
            NSApp.postEvent(event,atStart:false)
        }; try await pause(180)
    }
    @MainActor static func input(_ name:String, _ text:String) async throws {
        try await until("native field: " + name) { VerificationActionAnchor.views.object(forKey:name as NSString)?.window === window }
        let view = try marker(name), rect = view.convert(view.bounds,to:window.contentView!)
        let candidates = collect(window.contentView!,type:NSTextField.self).filter { field in
            let f = field.convert(field.bounds,to:window.contentView!)
            return field.isEditable && f.intersects(rect) && f.midX >= rect.minX && f.midX <= rect.maxX && f.midY >= rect.minY && f.midY <= rect.maxY
        }
        guard let field = candidates.first else { throw ProviderReviewFailure(description:"native text field: " + name) }
        field.scrollToVisible(field.bounds); window.makeFirstResponder(field)
        field.stringValue = text
        if let editor = field.currentEditor() { editor.string = text }
        field.delegate?.controlTextDidChange?(Notification(name:NSControl.textDidChangeNotification,object:field))
        window.makeFirstResponder(window.contentView); try await pause(100)
    }
    @MainActor static func form() throws -> ProviderFormModel {
        guard let form = ProviderFormVerification.current else { throw ProviderReviewFailure(description:"native provider form") }; return form
    }
    @MainActor static func shot(_ name:String) async throws {
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps:true); try await pause(650)
        guard let view = window.contentView else { throw ProviderReviewFailure(description:"snapshot view") }
        view.layoutSubtreeIfNeeded(); let target = output.appendingPathComponent(name + ".png")
        if CGPreflightScreenCaptureAccess() {
            let p = Process(); p.executableURL = URL(fileURLWithPath:"/usr/sbin/screencapture"); p.arguments = ["-x","-l",String(window.windowNumber),target.path]; try p.run(); p.waitUntilExit()
            if p.terminationStatus == 0 { captureMethod = "screencapture owned window"; shots.append(target.path); return }
        }
        guard let bitmap = view.bitmapImageRepForCachingDisplay(in:view.bounds) else { throw ProviderReviewFailure(description:"NSView snapshot") }
        view.cacheDisplay(in:view.bounds,to:bitmap); try bitmap.representation(using:.png,properties:[:])!.write(to:target)
        captureMethod = "NSView snapshot"; shots.append(target.path)
    }
    @MainActor static func run() async throws {
        try check(LocalVerification.explicitLoopback && Prefs.isolatedRoot != nil,"isolated temporary user data and explicit loopback")
        Prefs.notifyMessages = false; AppearanceStore.shared.select(.light)
        Nav.shared.go(.settings); Nav.shared.push(.agentSetting(.model))
        window = NSWindow(contentRect:NSRect(x:0,y:0,width:1120,height:920),styleMask:[.titled,.closable,.resizable,.fullSizeContentView],backing:.buffered,defer:false)
        window.title = "豆豆 · 模型服务验收"; window.titleVisibility = .hidden; window.titlebarAppearsTransparent = true; window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView:MainView()); window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps:true)
        ChatClient.shared.start()
        let store = AgentSettingsStore.shared
        try await until("settings bootstrap") { store.snapshot?.providers.count == 2 && ChatClient.shared.connected && !store.loading }
        try await until("grouped model UI") { VerificationActionAnchor.views.object(forKey:"provider-edit-example")?.window != nil }
        try check(store.snapshot?.providers.first?.builtin == true && store.snapshot?.providers.last?.name == "示例模型服务", "builtin and custom service groups loaded over HTTP")
        try await shot("24-models-light")
        AppearanceStore.shared.select(.dark); try await shot("25-models-dark"); AppearanceStore.shared.select(.light)
        try await press("model-example-claude-custom-demo")
        try await until("radio save") { store.snapshot?.model.provider == "example" && !store.saving }
        try check(store.snapshot?.model.id == "claude-custom-demo", "native radio saves the full provider/model selection")
        try await press("provider-edit-example")
        try await until("edit form") { ProviderFormVerification.current?.provider?.id == "example" }
        let edit = try form()
        try check(edit.draft.apiKey.isEmpty && edit.provider?.keyHint == "••••abcd", "edit only receives a public key hint")
        try await shot("28-provider-edit-masked")
        try await input("provider-name","示例模型服务 · 已编辑")
        try check(edit.draft.name == "示例模型服务 · 已编辑", "native NSTextField updates the edit draft")
        try await press("provider-save")
        try await until("edit complete") { Nav.shared.stacks[.settings]?.last == .agentSetting(.model) && store.snapshot?.providers.last?.name == "示例模型服务 · 已编辑" }
        try await press("provider-edit-example"); try await pause()
        let active = try form(); try await press("provider-delete")
        try await until("active provider refusal") { active.error == "先换到别的模型" }
        try check(Nav.shared.stacks[.settings]?.last == .modelProvider("example"), "deleting selected service displays server refusal and stays on form")
        Nav.shared.pop(); try await pause(250)
        try await press("provider-add")
        try await until("new provider form") { ProviderFormVerification.current?.provider == nil }
        let adding = try form()
        try check(adding.presets.count == 12 && adding.presetID == "siliconflow" && adding.draft.protocolName == "openai", "new service starts with the cloud-supplied SiliconFlow preset")
        try check(adding.draft.models.count == 10 && adding.draft.models[0].modelID == "deepseek-ai/DeepSeek-V4.1-Flash", "preset supplies model IDs without manual entry")
        try await shot("30-provider-presets")
        adding.choosePreset(""); try await pause()
        try await press("provider-details"); try await press("provider-models")
        try await input("provider-name","我的模型服务")
        try await input("provider-url","https://example.test/")
        try await input("provider-key","sk-test-0000abcd")
        let rowID = adding.draft.models[0].id.uuidString
        try await input("provider-model-id-" + rowID,"claude-custom-demo")
        try await input("provider-model-name-" + rowID,"我的 Claude")
        try check(adding.draft.apiKey == "sk-test-0000abcd" && adding.draft.models[0].name == "我的 Claude", "native password and model fields update draft")
        try await press("provider-model-add")
        try check(adding.draft.models.count == 2, "native add-model action creates another row")
        let extra = adding.draft.models[1].id.uuidString
        try await input("provider-model-id-" + extra,"claude-custom-fast")
        try await input("provider-model-name-" + extra,"轻快模型")
        try await shot("26-provider-add")
        try await press("provider-key-eye")
        try check(collect(window.contentView!,type:NSTextField.self).contains { !($0 is NSSecureTextField) && $0.stringValue == "sk-test-0000abcd" }, "reveal toggle displays only the typed fake key")
        try await press("provider-key-eye")
        try await input("provider-name","测试失败的模型服务")
        try await press("provider-save")
        try check(adding.working, "test-and-save shows an in-flight state")
        try await until("test error") { !adding.error.isEmpty && !adding.working }
        try check(adding.error.contains("401") && !adding.error.contains("sk-test-0000abcd") && store.snapshot?.providers.count == 2, "failed test stays inline, hides echoed key and creates no service")
        try await shot("27-provider-test-error")
        try await input("provider-name","我的模型服务")
        try await press("provider-save")
        try await until("create success") { Nav.shared.stacks[.settings]?.last == .agentSetting(.model) && store.snapshot?.providers.count == 3 }
        try check(adding.draft.apiKey.isEmpty, "successful create clears transient key")
        guard let created = store.snapshot?.providers.first(where:{$0.name == "我的模型服务"}) else { throw ProviderReviewFailure(description:"created provider") }
        let version = ChatClient.shared.settingsVersion
        _ = try await Api.json("/__review/select",method:"POST",body:["model":["provider":created.id,"id":"claude-custom-fast"]])
        try await until("WS settings refresh") { ChatClient.shared.settingsVersion > version && store.snapshot?.model.provider == created.id && store.snapshot?.model.id == "claude-custom-fast" }
        try check(true,"settings WebSocket refreshes provider/model selection in the open page")
        try await press("model-zenmux-anthropic/claude-haiku-5.5")
        try await until("switch builtin") { store.snapshot?.model.provider == "zenmux" && !store.saving }
        try await press("provider-edit-" + created.id); try await pause()
        try await press("provider-delete")
        try await until("delete success") { store.snapshot?.providers.count == 2 && Nav.shared.stacks[.settings]?.last == .agentSetting(.model) }
        try check(true,"switching away permits service deletion and list refresh")
        let evidence = try await Api.json("/__review/state"), requests = evidence["requests"] as! [[String:Any]]
        let patches = requests.filter{$0["method"] as? String == "PATCH"}
        try check(patches.count == 1 && patches[0]["keyProvided"] as? Bool == false,"actual edit request omits blank API Key")
        let posts = requests.filter{$0["method"] as? String == "POST" && $0["path"] as? String == "/api/providers"}
        try check(posts.count == 2 && !requests.contains{$0["path"] as? String == "/api/providers/test"},"create failure and retry each use one atomic save request")
        let result:[String:Any] = ["checks":checks,"screenshots":shots.sorted(),"capture":captureMethod,"isolatedUserData":true,"fixture":"scripted contract cloud","keyLogged":false,"requests":requests]
        try JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys]).write(to:output.appendingPathComponent("providers-acceptance.json"))
    }
}
