import AppKit

private struct ProviderLocalFailure: Error, CustomStringConvertible { let description: String }
@main struct ProvidersLocalTests {
    static var count = 0
    static let output = URL(fileURLWithPath:"/tmp/v081-mac-shots")
    static func check(_ ok:Bool, _ text:String) throws { if !ok { throw ProviderLocalFailure(description:text) }; count += 1; print("PASS: " + text); fflush(stdout) }
    @MainActor static func main() {
        let app = NSApplication.shared; app.setActivationPolicy(.prohibited)
        Task { @MainActor in
            do { try await run(); ChatClient.shared.stop(); print("PASS: \(count) real local cloud provider checks"); fflush(stdout); exit(0) }
            catch { print("FAIL: \(error)"); fflush(stdout); exit(1) }
        }; app.run()
    }
    @MainActor static func until(_ text:String, _ condition:()->Bool) async throws {
        for _ in 0..<800 { if condition() { return }; try await Task.sleep(nanoseconds:50_000_000) }
        throw ProviderLocalFailure(description:"timed out: " + text + "; " + ChatClient.shared.error)
    }
    @MainActor static func run() async throws {
        try check(LocalVerification.explicitLoopback && Prefs.isolatedRoot != nil,"temporary user data and loopback only")
        Prefs.notifyMessages = false
        let metadata = try JSONSerialization.jsonObject(with:Data(contentsOf:output.appendingPathComponent("providers-local-cloud.json"))) as! [String:Any]
        let upstream = metadata["upstream"] as! String
        let chat = ChatClient.shared; chat.start()
        try await until("real cloud WS hello") {chat.connected && !chat.items.isEmpty}
        let store = AgentSettingsStore.shared; await store.load()
        try check(store.error.isEmpty && store.snapshot?.providers.count == 1 && store.snapshot?.providers[0].models.count == 4,"real cloud returns structured model and builtin group")
        let initial = store.snapshot!.model, version = chat.settingsVersion
        let new = ProviderFormModel(); new.draft.name = "本地模型服务"; new.draft.baseURL = upstream + "/"; new.draft.apiKey = "sk-test-0000abcd"
        new.draft.models = [ProviderModelDraft(modelID:"claude-provider-local",name:"本地 Claude"),ProviderModelDraft(modelID:"claude-provider-fast",name:"本地轻快")]
        try check(await new.save(),"real atomic provider create tests first model and saves")
        try await until("create settings event") { chat.settingsVersion > version }
        guard let provider = store.snapshot?.providers.first(where:{!$0.builtin}) else { throw ProviderLocalFailure(description:"created public provider") }
        try check(provider.baseURL == upstream && provider.keyHint == "••••abcd" && provider.models.count == 2,"real public provider masks key and normalizes URL")
        try check(new.draft.apiKey.isEmpty,"transient key cleared after real save")
        await store.selectModel(ModelSelection(provider:provider.id,id:provider.models[0].id))
        try check(store.error.isEmpty && store.snapshot?.model.provider == provider.id,"Mac settings store selects real custom provider")
        try await chat.send("验证当前模型服务",clientID:UUID().uuidString)
        try await until("custom SDK reply") {chat.items.contains{$0.text == "自定义假模型已收到你的消息。"} && !chat.busy}
        try check(true,"real SDK next turn uses the selected custom service and returns say")
        let edit = ProviderFormModel(provider:provider); edit.draft.name = "本地模型服务 · 编辑后"
        try check(await edit.save(),"real edit with blank key retests successfully using saved key")
        try check(store.snapshot?.providers.first(where:{$0.id == provider.id})?.keyHint == "••••abcd","blank edit keeps saved key hint")
        try check(!(await edit.delete()) && edit.error == "先换到别的模型","real cloud rejects deletion of selected provider")
        let failure = ProviderFormModel(); failure.draft.name = "测试失败"; failure.draft.baseURL = upstream; failure.draft.apiKey = "sk-test-0000abcd"
        failure.draft.models = [ProviderModelDraft(modelID:"rejected-model",name:"错误模型")]
        try check(!(await failure.save()) && failure.error.contains("400") && !failure.error.contains("sk-test-0000abcd"),"real provider probe exposes useful upstream error without key")
        await store.load()
        try check(store.snapshot?.providers.count == 2,"failed real probe does not save provider")
        await store.selectModel(initial)
        try check(store.snapshot?.model == initial && store.error.isEmpty,"switch back to builtin model")
        try check(await edit.delete(),"real nonselected provider deletion succeeds")
        try check(store.snapshot?.providers.count == 1,"real deletion refreshes Mac settings snapshot")
        let (data,_) = try await URLSession.shared.data(from:URL(string:metadata["control"] as! String)!)
        let evidence = try JSONSerialization.jsonObject(with:data) as! [String:Any]
        let custom = evidence["customRequests"] as! [[String:Any]]
        try check(custom.contains{$0["stream"] as? Bool == true && $0["model"] as? String == "claude-provider-local"},"custom upstream observed selected model on real streaming request")
        try check((evidence["settingsEvents"] as? [Any] ?? []).count >= 5,"real create/edit/select/delete publish settings events")
        let result:[String:Any] = ["checks":count,"cloud":"real local HTTP/WS + Harness + Agent SDK","model":"scripted localhost only","customStreamingRequest":true,"isolatedUserData":true,"keyLogged":false]
        try JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys]).write(to:output.appendingPathComponent("providers-local-acceptance.json"))
    }
}
