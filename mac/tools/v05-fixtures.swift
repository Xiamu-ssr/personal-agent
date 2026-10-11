import Foundation

@MainActor
enum V05Fixtures {
    static func run() async throws {
        let path = "data/briefs/2026-10-11/晨报.html"
        let html = "<!doctype html><html><head><style>body{margin:0}</style></head><body><section class=card>今天</section></body></html>"
        let raw: [String: Any] = ["date": "2026-10-11", "name": "晨报", "time": "2026-10-11T07:36:00.100+08:00", "path": path, "cards": [["html": html], ["html": html]]]
        let brief = BriefItem.parse(raw)
        try check(brief?.cards.count == 2 && brief?.cards.first?.html == html, "complete HTML card documents are preserved unchanged")
        var invalid = raw; invalid["path"] = "data/briefs/2026-10-11/晨报.json"
        try check(BriefItem.parse(invalid) == nil, "old JSON brief paths are rejected")
        invalid = raw; invalid["cards"] = [["title": "旧卡片"]]
        try check(BriefItem.parse(invalid) == nil, "old native card fields are rejected")
        invalid = raw; invalid["cards"] = Array(repeating: ["html": html], count: 6)
        try check(BriefItem.parse(invalid)?.cards.count == 6, "six HTML cards are accepted")
        invalid["cards"] = Array(repeating: ["html": html], count: 7)
        try check(BriefItem.parse(invalid) == nil, "over-limit HTML cards are rejected")
        try check(!BriefItem.validPath("data/briefs/../outside.html"), "brief paths cannot escape date folder")
        let metrics = MemorySummary.health(["metrics": [["key": "steps", "label": "步数", "value": 6840, "unit": "步"], ["key": "sleep", "label": "睡眠"]]])
        try check(metrics[0].value == "6840" && metrics[1].value == "--", "health accepts numeric values and missing metric placeholders")
        try check(MemorySummary.health([:]).isEmpty, "absent health data remains empty")
        let preview = MemorySummary.preview("# 总档\n更新：今天\n\n第一行 → life/日常.md\n第二行\n第三行\n第四行\n第五行")
        try check(preview.contains("→ life/日常.md") && !preview.contains("第五行") && !preview.contains("更新："), "profile preview limits lines without losing pointer tags")
        let first = Date(timeIntervalSince1970: 1_800_000_000)
        try check(ProfileStore.companionDays(first.timeIntervalSince1970 * 1000, now: first) == 1 && ProfileStore.companionDays(nil) == nil, "membership starts at day one and never invents firstChat")
        let profile = ProfileStore()
        profile.applyState(["firstChat": 1000, "userCall": "夏木", "agentName": "豆豆"])
        try check(profile.userCall == "夏木" && profile.agentName == "豆豆" && profile.firstChat == 1000, "state names drive product copy")
        profile.applyState(["firstChat": NSNull()])
        try check(profile.firstChat == nil, "null firstChat clears prior metadata")
        try check(AvatarChoice(shape: "cat", palette: "sakura").json["palette"] as? String == "sakura", "profile enum matches cloud v0.4 contract")
        for shape in AvatarChoice.shapes { try check(!DreamAvatar.silhouette(shape).isEmpty, "each silhouette has a normalized vector path") }

        var routes: [String] = []
        FixtureProtocol.respond = { request in
            let path = request.url?.path ?? ""
            routes.append((request.httpMethod ?? "GET") + " " + path)
            if path.hasSuffix("/api/briefs") {
                let days = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "days" }?.value
                let older = raw.merging(["date": "2026-09-20", "time": "2026-09-20T07:36:00+08:00", "path": "data/briefs/2026-09-20/晨报.html"]) { _, new in new }
                return (200, [:], try JSONSerialization.data(withJSONObject: ["items": days == "365" ? [raw, older] : [raw]]))
            }
            if path.hasSuffix("/api/state") { return (200, [:], Data(#"{"userCall":"夏木","agentName":"豆豆","firstChat":1000}"#.utf8)) }
            return (200, [:], Data(#"{"avatar":{"shape":"cat","palette":"mist"}}"#.utf8))
        }
        let fetched = try await BriefItem.fetch()
        try check(fetched.count == 1, "briefs render from one aggregated endpoint")
        let linked = try await BriefItem.fetch(path: "data/briefs/2026-09-20/晨报.html")
        try check(linked?.date == "2026-09-20" && linked?.cards.first?.html == html, "older task links load complete HTML cards from the aggregated endpoint")
        await profile.load()
        try check(profile.avatar.shape == "cat" && profile.userCall == "夏木", "profile GET restores appearance alongside state metadata")
        await profile.save(AvatarChoice(shape: "boy", palette: "dusk"))
        try check(profile.avatar == AvatarChoice(shape: "boy", palette: "dusk") && routes.contains(where: { $0.hasPrefix("PUT ") && $0.hasSuffix("/api/profile") }), "appearance save uses cloud profile PUT")
        FixtureProtocol.respond = { _ in (400, [:], Data(#"{"error":"本地头像保存失败"}"#.utf8)) }
        await profile.save(AvatarChoice(shape: "girl", palette: "mint"))
        try check(profile.avatar.shape == "boy" && !profile.error.isEmpty, "failed save preserves confirmed appearance")
        Nav.shared.open("data/briefs/2026-10-11/晨报.html")
        try check(Nav.shared.tab == .today && Nav.shared.briefFocus == "data/briefs/2026-10-11/晨报.html", "brief outputs navigate to 今日 with path focus")
        Nav.shared.briefFocus = nil; Nav.shared.tab = .chat; Nav.shared.stacks = [:]
        print("PASS: v0.5 HTML briefs, health/profile previews, avatar sync, membership and brief navigation")
    }
}

@MainActor
enum SettingsTaskFixtures {
    static func body(_ request: URLRequest) throws -> [String: Any] {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var bytes = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let n = stream.read(&bytes, maxLength: bytes.count)
                if n <= 0 { break }
                data.append(contentsOf: bytes.prefix(n))
            }
        }
        return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    }

    static func run() async throws {
        let prompt = "帮我排一下：A&B + 今天？"
        var components = URLComponents(); components.scheme = "doudou"; components.host = "prompt"; components.queryItems = [URLQueryItem(name: "text", value: prompt)]
        try check(BriefNavigation.prompt(components.url!) == prompt, "brief prompt decodes Unicode and query punctuation exactly once")
        for url in ["https://example.invalid", "doudou://other?text=x", "doudou://prompt/path?text=x", "doudou://prompt?text=", "doudou://prompt?text=a&text=b", "file:///tmp/x"] {
            try check(BriefNavigation.prompt(URL(string: url)!) == nil, "non-prompt or malformed card links do not send")
        }
        _ = try await BriefSandbox.ruleList()
        print("PASS: compiled WebKit offline rules and strict prompt URL decoding")

        var settings: [String: Any] = ["model": "a", "permissionMode": "auto", "models": [["id": "a", "label": "A", "note": "消耗约 1×"], ["id": "b", "label": "B", "note": "消耗约 2×"]],
            "permissionModes": [["id": "auto", "label": "自动", "note": "拦下危险操作"], ["id": "bypassPermissions", "label": "完全放行", "note": "什么都不拦"]]]
        var writes: [[String: Any]] = []
        FixtureProtocol.respond = { request in
            try check(request.url?.path.hasSuffix("/api/settings") == true, "settings use their own endpoint")
            if request.httpMethod == "PUT" {
                let body = try body(request)
                writes.append(body)
                settings.merge(body) { _, value in value }
            }
            return (200, [:], try JSONSerialization.data(withJSONObject: settings))
        }
        let store = AgentSettingsStore(); await store.load()
        try check(store.snapshot?.model == "a" && store.snapshot?.models.first?.note == "消耗约 1×", "settings GET restores model, modes and one-line notes")
        await store.select(.model, id: "b")
        await store.select(.permissionMode, id: "bypassPermissions")
        try check(writes.count == 2 && writes[0].count == 1 && writes[0]["model"] as? String == "b" && writes[1].count == 1 && writes[1]["permissionMode"] as? String == "bypassPermissions", "settings PUT sends only the selected field")
        let second = AgentSettingsStore(); await second.load()
        try check(second.snapshot?.model == "b" && second.snapshot?.permissionMode == "bypassPermissions", "a fresh settings store restores server-confirmed choices")
        FixtureProtocol.respond = { _ in (502, [:], Data(#"{"error":"本地模拟：设置保存失败"}"#.utf8)) }
        await store.select(.model, id: "a")
        try check(store.snapshot?.model == "b" && !store.error.isEmpty && !store.saving, "failed settings save preserves selection and unlocks retry")
        print("PASS: settings GET/partial PUT, server-confirmed selection, restore and failed-save preservation")

        let id = "task/中文 &?"
        var history: [String: Any] = ["id": id, "title": "研究摘要", "status": "done", "items": [
            ["kind": "prompt", "text": "整理研究摘要", "time": "2026-10-11T07:00:00+08:00"],
            ["kind": "tool", "tool": "Read", "text": "读取 data/memory/profile/总档.md", "time": 1000],
            ["kind": "result", "text": "## 结果\n\n**已经完成**。简报：data/briefs/2026-10-11/晨报.html", "time": 2000]]]
        let parsed = try TaskHistory.parse(history, id: id)
        let summary = TaskSummary.parse(["id": id, "title": "研究摘要", "status": "stopped", "ts": 1000, "path": "data/briefs/2026-10-11/晨报.html"])
        try check(summary?.id == id && summary?.status == .stopped && summary?.outputs.count == 1, "completed task summaries parse without chat role and retain stopped status and path")
        try check(parsed.status == .done && parsed.turns.count == 1 && parsed.turns[0].steps.count == 1 && parsed.turns[0].results.first?.text.contains("**已经完成**") == true, "task history separates prompt, folded steps and Markdown results")
        let endpoint = try TaskHistoryStore.endpoint(id, action: "send")
        try check(!endpoint.contains("task/中文") && endpoint.contains("%2F") && endpoint.contains("%26") && endpoint.contains("%3F"), "task ids are encoded as one path component")
        try check(TaskHistoryStore.briefPath(in: parsed.items.last!.text) == "data/briefs/2026-10-11/晨报.html", "task results expose HTML brief links")
        var sends = 0
        FixtureProtocol.respond = { request in
            if request.httpMethod == "POST" {
                try check(request.url?.absoluteString.contains("%2F") == true && request.url?.path.hasSuffix("/send") == true, "continuation posts to original encoded task id")
                let body = try body(request)
                try check(body.count == 1 && body["text"] as? String == "补一份清单", "continuation sends only trimmed text")
                sends += 1
                var items = history["items"] as! [[String: Any]]
                items.append(["kind": "prompt", "text": "补一份清单", "time": 3000])
                history["items"] = items; history["status"] = "running"
                return (200, [:], try JSONSerialization.data(withJSONObject: ["ok": true, "id": id]))
            }
            return (200, [:], try JSONSerialization.data(withJSONObject: history))
        }
        let detail = TaskHistoryStore(id: id); await detail.load(); detail.draft = "  补一份清单 \n"
        let sent = await detail.send()
        try check(sent && sends == 1 && detail.draft.isEmpty && detail.history?.status == .running && detail.history?.turns.count == 2 && detail.history?.items.first?.text == "整理研究摘要", "continuation retains task context and clears draft only after acknowledgement")
        detail.draft = "失败时保留这段话"
        FixtureProtocol.respond = { _ in (502, [:], Data(#"{"error":"本地模拟：续聊失败"}"#.utf8)) }
        let failed = await detail.send()
        try check(!failed && detail.draft == "失败时保留这段话" && !detail.sending && !detail.error.isEmpty, "failed continuation preserves draft and retry")
        FixtureProtocol.respond = { _ in (200, [:], Data(#"{"ok":true,"id":"wrong-task"}"#.utf8)) }
        let wrong = await detail.send()
        try check(!wrong && !detail.draft.isEmpty, "mismatched continuation acknowledgement does not clear draft")
        print("PASS: task history grouping/timestamps, encoded id, continuation context, acknowledgements and failed-send draft preservation")

        var polls = 0
        FixtureProtocol.respond = { _ in
            polls += 1
            history["status"] = polls == 1 ? "running" : "done"
            return (200, [:], try JSONSerialization.data(withJSONObject: history))
        }
        let watching = TaskHistoryStore(id: id)
        let watcher = Task { await watching.watch() }
        try await Task.sleep(nanoseconds: 3_250_000_000)
        try check(polls == 2 && watching.history?.status == .done, "opened running task refreshes after three seconds")
        try await Task.sleep(nanoseconds: 3_050_000_000)
        try check(polls == 2, "completed task stops history requests")
        watcher.cancel(); await watcher.value
        print("PASS: three-second running-task refresh and no polling requests after completion")
    }
}
