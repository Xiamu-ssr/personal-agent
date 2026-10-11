import Foundation

@MainActor
enum V04Fixtures {
    static func run() async throws {
        let path = "data/briefs/2026-10-11/晨报.json"
        let raw: [String: Any] = ["v": 1, "name": "晨报", "time": "2026-10-11T07:36:00+08:00", "cards": [
            ["chip": "今天", "title": "把今天的事收好", "summary": "先完成最需要专注的事。", "blocks": [
                ["type": "unknown", "text": "跳过"], ["type": "timeline", "items": [["when": "15:00"]]],
                ["type": "list", "items": [["text": "取快递", "meta": "顺路"]]], ["type": "note", "text": "日历暂不可读"]],
             "action": ["label": "排一下", "prompt": "帮我排今天的顺序"]], [:]]]
        let brief = BriefItem.parse(["path": path, "date": "2026-10-11", "brief": raw])
        try check(brief?.cards.count == 1 && brief?.cards.first?.blocks.map(\.type) == ["list", "note"], "brief skips unknown blocks, incomplete items and missing card title")
        try check(brief?.cards.first?.actionPrompt == "帮我排今天的顺序" && brief?.name == "晨报", "structured action and brief metadata")
        try check(BriefItem.parse(["path": "data/briefs/2026-10-11/旧简报.html", "brief": raw]) == nil, "brief endpoint accepts JSON paths only")
        try check(BriefItem.parse(["path": path, "brief": ["v": 2, "cards": [["title": "future"]]]]) == nil, "unsupported brief version is skipped")
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
            if path.hasSuffix("/api/briefs") { return (200, [:], try JSONSerialization.data(withJSONObject: ["items": [["date": "2026-10-11", "path": "data/briefs/2026-10-11/晨报.json", "brief": raw]]])) }
            if path.contains("/files/data/briefs/") { return (200, [:], try JSONSerialization.data(withJSONObject: raw)) }
            if path.hasSuffix("/api/state") { return (200, [:], Data(#"{"userCall":"夏木","agentName":"豆豆","firstChat":1000}"#.utf8)) }
            return (200, [:], Data(#"{"avatar":{"shape":"cat","palette":"mist"}}"#.utf8))
        }
        let fetched = try await BriefItem.fetch()
        try check(fetched.count == 1, "briefs render from one aggregated endpoint")
        let linked = try await BriefItem.fetch(path: "data/briefs/2026-09-20/晨报.json")
        try check(linked?.date == "2026-09-20" && linked?.cards.first?.title == "把今天的事收好", "completed task loads native JSON brief outside default list")
        await profile.load()
        try check(profile.avatar.shape == "cat" && profile.userCall == "夏木", "profile GET restores appearance alongside state metadata")
        await profile.save(AvatarChoice(shape: "boy", palette: "dusk"))
        try check(profile.avatar == AvatarChoice(shape: "boy", palette: "dusk") && routes.contains(where: { $0.hasPrefix("PUT ") && $0.hasSuffix("/api/profile") }), "appearance save uses cloud profile PUT")
        FixtureProtocol.respond = { _ in (400, [:], Data(#"{"error":"本地头像保存失败"}"#.utf8)) }
        await profile.save(AvatarChoice(shape: "girl", palette: "mint"))
        try check(profile.avatar.shape == "boy" && !profile.error.isEmpty, "failed save preserves confirmed appearance")
        Nav.shared.open("data/briefs/2026-10-11/晨报.json")
        try check(Nav.shared.tab == .today && Nav.shared.briefFocus == "data/briefs/2026-10-11/晨报.json", "brief outputs navigate to 今日 with path focus")
        Nav.shared.briefFocus = nil; Nav.shared.tab = .chat; Nav.shared.stacks = [:]
        print("PASS: v0.4 JSON briefs/tolerant blocks, health/profile previews, avatar sync, membership and brief navigation")
    }
}
