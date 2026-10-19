import AppKit

@main struct ProviderTests {
    static var count = 0
    static func check(_ value: Bool, _ label: String) { if !value { print("FAIL: " + label); exit(1) }; count += 1 }
    static func body(_ request: URLRequest) throws -> [String: Any] { try JSONSerialization.jsonObject(with: MockTransport.body(request)) as! [String: Any] }
    static let builtin: [String: Any] = ["id":"zenmux", "name":"ZenMux", "builtin":true, "protocol":"anthropic", "models":[["id":"claude-demo", "name":"Claude 演示", "note":"日常使用"]]]
    static let custom: [String: Any] = ["id":"example", "name":"示例服务", "builtin":false, "protocol":"anthropic", "baseUrl":"https://example.test", "keyHint":"••••abcd", "models":[["id":"claude-demo", "name":"自定义 Claude"]]]
    static func settings(_ selection: [String: Any] = ["provider":"zenmux", "id":"claude-demo"], providers: [[String: Any]] = [builtin,custom]) -> [String: Any] {
        ["model":selection, "providers":providers, "kernel":"openclaw"]
    }
    static func parses(_ row: [String: Any]) -> Bool { (try? AgentSettingsSnapshot.parse(row)) != nil }
    static func validDraft() -> ProviderDraft {
        var d = ProviderDraft(); d.name = "我的服务"; d.baseURL = "https://example.test/"; d.apiKey = "sk-test-0000abcd"
        d.models = [ProviderModelDraft(modelID:"claude-custom",name:"我的 Claude")]; return d
    }
    static func accepts(_ draft: ProviderDraft, editing: Bool = false) -> Bool { (try? draft.payload(editing: editing)) != nil }

    @MainActor static func main() async throws {
        check(LocalVerification.explicitLoopback, "tests use isolated loopback credentials")
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [MockTransport.self]; Api.session = URLSession(configuration:config)
        let snapshot = try AgentSettingsSnapshot.parse(settings())
        check(snapshot.model == ModelSelection(provider:"zenmux", id:"claude-demo"), "structured model parses")
        check(snapshot.providers.count == 2 && snapshot.providers[1].models[0].note.isEmpty, "providers parse optional model description")
        check(snapshot.providers[1].keyHint == "••••abcd" && snapshot.providers[0].keyHint == nil && snapshot.providers[0].baseURL == nil, "public key hint and builtin metadata")
        check(snapshot.label(.model) == "Claude 演示", "settings labels resolve structured selection")
        let presetRows: [[String: Any]] = [
            ["id":"siliconflow", "name":"硅基流动", "protocol":"openai", "baseUrl":"https://api.siliconflow.cn/v1", "hint":"常用模型", "models":[["id":"deepseek-ai/DeepSeek-V4.1-Flash", "name":"DeepSeek V4.1 Flash", "note":"图片 · 对话 · 工具"]]],
            ["id":"anthropic", "name":"Anthropic", "protocol":"anthropic", "baseUrl":"https://api.anthropic.com", "hint":"官方 API", "models":[["id":"claude-haiku-5-5", "name":"Claude Haiku 5.5"]]],
        ]
        var catalog = settings(); catalog["providerPresets"] = presetRows
        let presets = try AgentSettingsSnapshot.parse(catalog).providerPresets
        check(presets.count == 2 && presets[0].models[0].note.contains("图片"), "shared provider catalog parses")
        let prefilled = ProviderFormModel(presets: presets)
        check(prefilled.draft.name == "硅基流动" && prefilled.draft.protocolName == "openai" && prefilled.draft.models[0].modelID == "deepseek-ai/DeepSeek-V4.1-Flash", "new accounts prefill endpoint protocol and model IDs")
        prefilled.draft.apiKey = "fixture-one-vendor-key"
        prefilled.choosePreset("anthropic")
        check(prefilled.draft.apiKey.isEmpty && prefilled.draft.baseURL == "https://api.anthropic.com" && prefilled.draft.protocolName == "anthropic", "changing vendor clears the other vendor credential")
        prefilled.choosePreset("")
        check(prefilled.draft.name.isEmpty && prefilled.draft.models.count == 1, "custom service remains editable")
        check(parses(settings(["provider":"example", "id":"claude-demo"])), "same model ID may exist in different providers")
        var invalid = settings(); invalid["model"] = "claude-demo"
        check(!parses(invalid), "old flat model format is rejected")
        check(!parses(settings(["provider":"missing", "id":"claude-demo"])), "selected provider must exist")
        check(!parses(settings(["provider":"example", "id":"missing"])), "selected model must belong to provider")
        check(!parses(settings(providers:[builtin,custom,custom])), "duplicate provider IDs are rejected")
        var bad = custom; bad["models"] = [["id":"same", "name":"一"], ["id":"same", "name":"二"]]
        check(ModelProvider(bad) == nil, "duplicate model IDs within provider are rejected")
        bad = custom; bad["protocol"] = "openai"
        check(ModelProvider(bad) != nil, "OpenAI protocol is supported")
        bad = custom; bad["baseUrl"] = "https://example.test/?key=oops"
        check(ModelProvider(bad) == nil, "public provider URL is validated")
        bad = custom; bad["models"] = []
        check(ModelProvider(bad) == nil, "empty model list is rejected")
        bad = custom; bad["keyHint"] = "untrusted-hint-abcd"; bad["apiKey"] = "must-not-enter-public-state"
        let publicValue = ModelProvider(bad)!
        check(publicValue.keyHint == "••••abcd" && !String(reflecting:publicValue).contains("must-not-enter-public-state"), "public metadata only retains the last four key characters")

        let d = validDraft(), payload = try d.payload(editing:false)
        check(payload["baseUrl"] as? String == "https://example.test", "base URL trailing slash is removed")
        check(payload["protocol"] as? String == "anthropic" && payload["apiKey"] as? String == d.apiKey, "create body contains key and uses fixed protocol without an editable field")
        var draft = d; draft.name = "  演示服务  "; draft.baseURL = " https://example.test/// "; draft.models[0].modelID = "  demo  "; draft.models[0].name = " 演示 "
        let trimmed = try draft.payload(editing:false)
        check(trimmed["name"] as? String == "演示服务" && trimmed["baseUrl"] as? String == "https://example.test", "form trims text and URL")
        check((trimmed["models"] as? [[String:Any]])?.first?["id"] as? String == "demo", "model IDs are trimmed before validation")
        draft = d; draft.name = " "
        check(!accepts(draft), "empty service name rejected")
        draft.name = String(repeating:"豆",count:41)
        check(!accepts(draft), "service name length enforced")
        draft.name = String(repeating:"豆",count:40)
        check(accepts(draft), "40-character service name accepted")
        for url in ["example.test", "ftp://example.test", "https://example.test?x=1", "https://example.test#x", "https://key:secret@example.test", "https://"] {
            draft = d; draft.baseURL = url; check(!accepts(draft), "invalid base URL rejected without reflecting its value")
        }
        draft = d; draft.baseURL = "http://127.0.0.1:18799/v1/"
        check(accepts(draft), "HTTP custom endpoints are permitted")
        draft = d; draft.apiKey = " "
        check(!accepts(draft), "new service requires a key")
        check(try draft.payload(editing:true)["apiKey"] == nil, "blank edit key is omitted rather than clearing existing key")
        draft = d; draft.models = []
        check(!accepts(draft), "at least one model is required")
        draft.models = (0..<21).map { ProviderModelDraft(modelID:"m\($0)",name:"模型") }
        check(!accepts(draft), "at most twenty models")
        draft.models.removeLast()
        check(accepts(draft), "twenty distinct models accepted")
        draft = d; draft.models.append(ProviderModelDraft(modelID:" claude-custom ",name:"重复"))
        check(!accepts(draft), "duplicate trimmed IDs rejected")
        draft = d; draft.models[0].modelID = String(repeating:"x",count:201)
        check(!accepts(draft), "model ID length enforced")
        draft.models[0].modelID = String(repeating:"x",count:200)
        check(accepts(draft), "200-character model ID accepted")
        draft.models[0].name = String(repeating:"字",count:41)
        check(!accepts(draft), "model display name length enforced")
        draft.models[0].name = " "
        check(!accepts(draft), "model display name required")
        check(!String(describing:d).contains(d.apiKey) && !String(reflecting:d).contains(d.apiKey), "draft descriptions redact credentials")
        check(ProviderSecret.safeError("401: \(d.apiKey)",key:d.apiKey) == "401: [已隐藏]", "returned key is removed from error")
        check(!ProviderSecret.safeError("apiKey=opaque-secret Authorization: Bearer opaque-token",key:"").contains("opaque-secret"), "credential fields redact unknown keys")
        check(!ProviderSecret.safeError("Bearer opaque-token",key:"").contains("opaque-token"), "authorization headers redact unknown credentials")
        check(ProviderSecret.safeError("401: sk-other-test-credential",key:"") == "401: [已隐藏]", "unsubmitted key-shaped credentials are redacted")
        check(!ProviderSecret.safeError("token=a%2Bb%2Fc",key:"a+b/c").contains("a%2B"), "URL-encoded credential redacted")

        var current = settings(), writes = [[String:Any]]()
        MockTransport.respond = { r in
            if r.httpMethod == "PUT" { let b = try body(r); writes.append(b); if let m = b["model"] { current["model"] = m }; if let mode = b["permissionMode"] { current["permissionMode"] = mode } }
            return (200,current)
        }
        let store = AgentSettingsStore(); await store.load()
        await store.selectModel(ModelSelection(provider:"example",id:"claude-demo"))
        check(writes.count == 1 && (writes[0]["model"] as? [String:Any])?["provider"] as? String == "example", "model selection PUT contains provider and model ID")
        check(store.snapshot?.model.provider == "example", "model save preserves permission mode")
        await store.selectModel(ModelSelection(provider:"example",id:"claude-demo")); await store.selectModel(ModelSelection(provider:"missing",id:"claude-demo"))
        check(writes.count == 1, "unchanged and unavailable model selections do not send")
        MockTransport.respond = { _ in (400,["error":"模型暂时不可用"]) }
        await store.selectModel(ModelSelection(provider:"zenmux",id:"claude-demo"))
        check(store.snapshot?.model.provider == "example" && store.error == "模型暂时不可用", "failed selection leaves previous model selected")

        var calls = [(String,String)](), saved = false
        let form = ProviderFormModel(); form.draft = d
        MockTransport.respond = { r in
            calls.append((r.httpMethod!,r.url!.path))
            if r.url!.path == "/api/providers" { let b = try body(r); check(b["apiKey"] as? String == d.apiKey, "create request carries submitted key only in body"); saved = true; return (201,["provider":custom]) }
            return (200,settings())
        }
        check(await form.save(), "atomic test-and-save create succeeds")
        check(saved && calls.filter{$0.1.hasPrefix("/api/providers")}.count == 1 && calls[0].0 == "POST", "create uses one atomic save endpoint")
        check(form.draft.apiKey.isEmpty && form.error.isEmpty && !form.working, "successful save clears transient key and working state")
        check(!String(describing:form).contains(d.apiKey) && !String(reflecting:form).contains(d.apiKey), "form descriptions cannot expose key")
        let editing = ProviderFormModel(provider:ModelProvider(custom))
        MockTransport.respond = { r in
            if r.httpMethod == "PATCH" { let b = try body(r); check(r.url!.path == "/api/providers/example" && b["apiKey"] == nil, "edit omits blank key"); return (200,["provider":custom]) }
            return (200,settings())
        }
        check(await editing.save(), "edit retains existing key")
        editing.draft.apiKey = d.apiKey
        MockTransport.respond = { r in
            if r.httpMethod == "PATCH" { check(try body(r)["apiKey"] as? String == d.apiKey, "replacement key is explicitly submitted"); return (200,["provider":custom]) }
            return (200,settings())
        }
        check(await editing.save() && editing.draft.apiKey.isEmpty, "replacement key cleared after acknowledgement")

        let failure = ProviderFormModel(); failure.draft = d
        // Capture actual stdout/stderr around a failing HTTP response, not only the redaction helper.
        let capture = Pipe(), originalOut = dup(STDOUT_FILENO), originalErr = dup(STDERR_FILENO)
        fflush(stdout); fflush(stderr); dup2(capture.fileHandleForWriting.fileDescriptor,STDOUT_FILENO); dup2(capture.fileHandleForWriting.fileDescriptor,STDERR_FILENO)
        MockTransport.respond = { _ in (400,["error":"服务返回 401：apiKey=\(d.apiKey)，请检查 Key"]) }
        let failed = await failure.save()
        fflush(stdout); fflush(stderr); dup2(originalOut,STDOUT_FILENO); dup2(originalErr,STDERR_FILENO); close(originalOut); close(originalErr); try capture.fileHandleForWriting.close()
        let logs = String(data:capture.fileHandleForReading.readDataToEndOfFile(),encoding:.utf8) ?? ""
        check(!failed && failure.error.contains("401") && !failure.error.contains(d.apiKey), "failed test displays upstream error without echoing key")
        check(!logs.contains(d.apiKey), "API Key never reaches stdout or stderr during failed save")
        check(failure.draft.apiKey == d.apiKey && !failure.working, "failure preserves editable draft and releases save lock")
        var deletes = 0
        MockTransport.respond = { r in deletes += 1; return (409,["error":"先换到别的模型"]) }
        check(!(await editing.delete()) && editing.error == "先换到别的模型" && !editing.deleting && !editing.working, "active provider delete shows cloud refusal")
        MockTransport.respond = { r in if r.httpMethod == "DELETE" { deletes += 1; return (200,["ok":true]) }; return (200,settings(providers:[builtin])) }
        check(await editing.delete() && deletes == 2, "nonactive provider deletion refreshes settings")
        let builtinForm = ProviderFormModel(provider:ModelProvider(builtin))
        let builtinDelete = await builtinForm.delete(), builtinSave = await builtinForm.save()
        check(!builtinDelete && !builtinSave, "builtin provider cannot be mutated")
        let blank = ProviderFormModel(); var networkRequests = 0
        MockTransport.respond = { _ in networkRequests += 1; return (200,[:]) }
        check(!(await blank.save()) && networkRequests == 0, "invalid form is rejected before network")
        let locked = ProviderFormModel(); locked.draft = d; var saves = 0
        MockTransport.respond = { r in
            if r.httpMethod == "POST" { saves += 1; Thread.sleep(forTimeInterval:0.08); return (201,["provider":custom]) }
            return (200,settings())
        }
        let pending = Task { await locked.save() }
        while !locked.working { await Task.yield() }
        let duplicateSave = await locked.save(), concurrentDelete = await locked.delete()
        check(!duplicateSave && !concurrentDelete, "save lock blocks concurrent form actions")
        check(await pending.value && saves == 1 && !locked.working, "one in-flight save results in one mutation")
        print("PASS: \(count) provider assertions")
    }
}
