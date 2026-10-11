import Foundation

@MainActor
enum ConnectorFixtures {
    static func run() async throws {
        let fields: [[String: Any]] = [
            ["key": "preset", "label": "邮箱类型", "type": "select", "required": true,
             "options": [["value": "qq", "label": "QQ 邮箱"], ["value": "custom", "label": "其他"]]],
            ["key": "address", "label": "邮箱地址", "type": "text", "required": true],
            ["key": "password", "label": "授权码", "type": "secret", "required": true,
             "help": "邮箱授权说明"],
            ["key": "host", "label": "服务器", "type": "text", "required": true, "showIf": ["preset": "custom"]],
            ["key": "port", "label": "端口", "type": "number", "default": 993, "showIf": ["preset": "custom"]],
            ["key": "scope", "label": "读取范围", "type": "select", "default": "inbox",
             "options": [["value": "inbox", "label": "收件箱"], ["value": "all", "label": "全部"]], "showIf": ["preset": "custom"]],
            ["key": "label", "label": "备注", "type": "text", "help": "可选说明"]
        ]
        let row: [String: Any] = ["name": "imap", "title": "其他邮箱", "icon": "/api/connectors/imap/icon", "fields": fields, "multiAccount": true,
                                 "accounts": [["id": "a/1?", "label": "本地邮箱", "status": "ok", "checkedAt": 1000,
                                               "values": ["preset": "custom", "address": "fixture@example.com", "password": "••••",
                                                          "host": "imap.example.com", "port": 1993, "scope": "all", "label": "工作邮箱"]]]]
        let connector = CloudConnector(row)
        let account = connector.accounts[0]
        let draft = ConnectorDraft(connector: connector)
        try check(draft.initial["port"] == "993" && draft.initial["scope"] == "inbox", "create form applies schema defaults")
        var values = draft.initial.merging(["preset": "qq", "address": " fixture@qq.com ", "password": "local-fixture-only"]) { _, new in new }
        try check(connector.fields!.filter { $0.visible(values) }.map(\.key) == ["preset", "address", "password", "label"], "showIf hides custom-only fields")
        try check(connector.fields![2].help(values) == "邮箱授权说明" && connector.fields!.last!.help(values) == "可选说明", "plain service-specific help")
        let qq = try draft.payload(values)
        try check(qq["address"] as? String == "fixture@qq.com" && qq["host"] == nil && qq["port"] == nil && qq["scope"] == nil, "hidden fields are omitted from save")
        values["preset"] = "custom"; values["host"] = "imap.example.com"
        let custom = try draft.payload(values)
        try check(custom["port"] as? Double == 993 && custom["scope"] as? String == "inbox", "number and select use schema types")
        try check(connector.fields![2].help(values) == "邮箱授权说明", "help remains service-specific")
        values["port"] = "not a number"
        do { _ = try draft.payload(values); throw VerificationError(description: "invalid numeric field accepted") } catch is ApiError {}
        values["port"] = "NaN"
        do { _ = try draft.payload(values); throw VerificationError(description: "nonfinite numeric field accepted") } catch is ApiError {}
        values["password"] = ""
        do { _ = try draft.payload(values); throw VerificationError(description: "required secret accepted empty for create") } catch is ApiError {}
        let edit = ConnectorDraft(connector: connector, account: account)
        try check(edit.initial["password"] == "" && edit.initial["port"] == "1993" && edit.initial["preset"] == "custom" && edit.initial["scope"] == "all", "edit prefills all nonsecret values rather than defaults")
        var edited = edit.initial
        let blankEdit = try edit.payload(edited)
        try check(blankEdit["password"] == nil, "blank edit secret preserves existing value")
        edited["password"] = "••••"
        let maskedEdit = try edit.payload(edited)
        try check(maskedEdit["password"] == nil, "masked edit secret preserves existing value")
        edited["password"] = "new-local-fixture"
        let newEdit = try edit.payload(edited)
        try check(newEdit["password"] as? String == "new-local-fixture", "new edit secret is sent only when entered")
        let safe = edit.safeError(ApiError(code: 400, message: "模拟错误 new-local-fixture"), values: edited)
        try check(!safe.contains("new-local-fixture"), "form error redacts typed secret")
        var plaintext = row
        plaintext["accounts"] = [["id": "bad-server", "values": ["password": "plaintext-fixture"]]]
        try check(CloudConnector(plaintext).accounts[0].values?["password"] == "••••", "decode masks a secret even if server failed to mask")
        try check(!CloudConnector(row.merging(["multiAccount": false]) { _, new in new }).canAdd, "single-account connector suppresses add when configured")
        try check(!CloudConnector(["name": "future"]).canAdd, "missing schema does not invent a form")

        var calls: [(String, String)] = []
        FixtureProtocol.respond = { request in
            if request.url?.path.contains("/api/connectors/") == true || request.url?.path.contains("/api/devices/") == true {
                calls.append((request.httpMethod ?? "", request.url?.absoluteString ?? ""))
            }
            if request.httpMethod == "POST" || request.httpMethod == "PUT", request.url?.path.hasSuffix("/test") != true {
                let bytes: Data
                if let data = request.httpBody { bytes = data }
                else if let stream = request.httpBodyStream {
                    stream.open(); defer { stream.close() }
                    var data = Data(), buffer = [UInt8](repeating: 0, count: 1024)
                    while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(contentsOf: buffer.prefix(n)) }
                    bytes = data
                } else { bytes = Data() }
                let body = try JSONSerialization.jsonObject(with: bytes) as? [String: Any]
                try check((body?["values"] as? [String: Any])?["label"] as? String == "本地备注", "account save wraps values in JSON")
            }
            if request.url?.path.hasSuffix("/api/connectors") == true {
                return (200, [:], try JSONSerialization.data(withJSONObject: ["cloud": ["installed": [row], "catalog": [["name": "qq-mail", "title": "QQ 邮箱", "fields": fields, "multiAccount": true, "icon": "/api/connectors/qq-mail/icon"]]], "devices": []]))
            }
            return (200, [:], Data(#"{"ok":true}"#.utf8))
        }
        try await ConnectorAPI.save(name: "imap", id: nil, values: ["label": "本地备注"])
        try await ConnectorAPI.save(name: "imap", id: "a/1?", values: ["label": "本地备注"])
        try await ConnectorAPI.test(name: "imap", id: "a/1?")
        try await ConnectorAPI.delete(name: "imap", id: "a/1?")
        try await ConnectorAPI.removeDevice("offline/device?")
        try check(calls.map(\.0) == ["POST", "PUT", "POST", "DELETE", "DELETE"], "connector methods use declared endpoints")
        try check(calls[1].1.contains("/accounts/a%2F1%3F") && calls[2].1.hasSuffix("/test") && calls[4].1.contains("/devices/offline%2Fdevice%3F"), "path IDs are encoded as components")
        let store = ConnectorStore()
        await store.load()
        try check(store.loaded && store.connected.count == 1 && store.catalog[0].name == "qq-mail" && store.connector("imap")?.accounts.count == 1,
                  "v0.4 catalog parses independent services and account schemas")
        FixtureProtocol.respond = { _ in (400, [:], Data(#"{"error":"本地验证失败"}"#.utf8)) }
        do { try await ConnectorAPI.save(name: "imap", id: nil, values: [:]); throw VerificationError(description: "failed connector save accepted") }
        catch let error as ApiError { try check(error.message == "本地验证失败", "connector error preserves Chinese server reason") }
        try check(edited["password"] == "new-local-fixture", "failed submit retains in-memory draft")
        Nav.shared.tab = .settings
        Nav.shared.stacks[.settings] = [.connectors(tab: 0)]
        Nav.shared.openConnector("imap", from: 1)
        Nav.shared.pop()
        try check(Nav.shared.stacks[.settings]?.last == .connectors(tab: 1), "returning from detail preserves cloud host tab")
        Nav.shared.tab = .chat; Nav.shared.stacks = [:]
        store.reset()
        print("PASS: dynamic connector forms, edit prefill/PUT, secret masking, conditional fields, API methods and failures")
    }
}
