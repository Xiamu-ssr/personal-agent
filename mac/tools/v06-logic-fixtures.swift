import AppKit
import SwiftUI

@MainActor enum V06LogicFixtures {
    static func run() async throws {
        let suite = "Doudou.local.v06.skin." + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        try check(SkinStore(defaults: defaults).skin == .silver, "skin defaults to silver")
        let skins = SkinStore(defaults: defaults)
        for skin in Skin.allCases { skins.select(skin); try check(SkinStore(defaults: defaults).skin == skin, "each local skin survives store recreation") }
        defaults.set("unknown", forKey: "skin")
        try check(SkinStore(defaults: defaults).skin == .silver, "invalid persisted skin uses silver")
        let original = Theme.skin
        defer { SkinStore.shared.select(original) }
        SkinStore.shared.select(.silver)
        let silver = MemoryPointerText.rendered(text: "正文 `code`", refs: ["life/日常.md"], size: 15)
        SkinStore.shared.select(.night)
        let night = MemoryPointerText.rendered(text: "正文 `code`", refs: ["life/日常.md"], size: 15)
        try check(silver !== night && (night.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? NSColor) == NSColor(Theme.ink), "theme invalidates native text colors and pointer cache once")
        SkinStore.shared.select(.silver)
        try check(silver === MemoryPointerText.rendered(text: "正文 `code`", refs: ["life/日常.md"], size: 15), "skin cycle reuses bounded native text cache")
        try check(Skin.paper.palette[0] == 0xF5F0E6 && Skin.night.palette[6] == 0x1E3330, "palettes follow the v0.6 contract")
        try check(BriefCardView.height(document: 950, window: 700) == 950 && BriefCardView.height(document: 2000, window: 700) == 1400, "brief height uses full document with only the two-window safety cap")
        print("PASS: local skin persistence, invalid selection, native theme/cache invalidation and reuse; full brief height and safety cap")

        let state = ChatScrollState(), first = UUID(), second = UUID(), stream = UUID()
        state.messages([first])
        state.report(distance: 1000, viewport: 600, positionChanged: false)
        try check(state.atBottom, "content growth retains bottom follow intent")
        state.report(distance: 1000, viewport: 600, positionChanged: true)
        try check(!state.atBottom && state.showReturn, "scrolling up over a screen shows return button")
        state.messages([first,second]); state.stream(stream); state.stream(stream)
        state.messages([first,second,stream])
        try check(state.unread == 2, "new messages and streaming turns count once away from bottom")
        state.report(distance: 950, viewport: 580, positionChanged: false)
        try check(!state.atBottom && state.unread == 2, "focus or viewport resize preserves history reading")
        state.returnToBottom()
        try check(state.atBottom && !state.showReturn && state.unread == 0, "send and return-to-bottom reset unread and resume following")
        state.report(distance: 130, viewport: 600, positionChanged: true)
        try check(!state.atBottom && !state.showReturn, "near-bottom gap pauses following without showing the distant-history button")
        state.report(distance: 20, viewport: 600, positionChanged: true)
        try check(state.atBottom, "returning to bottom resumes following")
        let replay = ChatScrollState(), baseDate=Date(timeIntervalSince1970:1000)
        let old=ChatItem(kind:.assistant,text:"以前的消息",ts:baseDate)
        replay.messages([old]); replay.report(distance:900,viewport:600,positionChanged:true)
        let reloaded=ChatItem(kind:.assistant,text:old.text,ts:baseDate)
        replay.messages([reloaded])
        try check(replay.unread==0,"reconnect with fresh view IDs does not count old history as new messages")
        let fresh=ChatItem(kind:.assistant,text:"新消息",ts:baseDate.addingTimeInterval(10))
        replay.messages([reloaded,fresh]); try check(replay.unread==1,"a new arrival after history restoration counts once")
        replay.messages([ChatItem(kind:.assistant,text:reloaded.text,ts:baseDate),ChatItem(kind:.assistant,text:fresh.text,ts:fresh.ts)])
        try check(replay.unread==1,"history replay does not count an already seen new message again")
        let liveID=UUID(); replay.stream(liveID,text:"这一段正在输出")
        replay.messages([ChatItem(kind:.assistant,text:reloaded.text,ts:baseDate),ChatItem(kind:.assistant,text:fresh.text,ts:fresh.ts),ChatItem(kind:.assistant,text:"这一段正在输出，已经完成。",ts:baseDate.addingTimeInterval(20))])
        try check(replay.unread==2,"stream finished in a reconnect snapshot does not double the pending unread turn")
        print("PASS: bottom following, history/focus preservation, send reset, streaming counts and reconnect/history replay de-duplication")

        var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(secondsFromGMT: 8*3600)!
        let now = cal.date(from: DateComponents(year: 2026, month: 10, day: 12, hour: 20))!
        func ago(_ days: Int) -> Date { cal.date(byAdding: .day, value: -days, to: cal.startOfDay(for: now))! }
        try check(TaskListStore.group(ago(0),now:now,calendar:cal)=="今天" && TaskListStore.group(ago(7),now:now,calendar:cal)=="近 7 天" && TaskListStore.group(ago(8),now:now,calendar:cal)=="更早" && TaskListStore.group(nil,now:now,calendar:cal)=="更早", "task groups use local calendar day boundaries")
        var requested: [URLRequest] = []
        func task(_ id: String, _ ts: Double) -> [String: Any] { ["id":id,"title":id,"label":id,"status":"done","ok":true,"ts":ts,"outputs":[]] }
        FixtureProtocol.respond = { req in
            requested.append(req)
            let query = URLComponents(url:req.url!,resolvingAgainstBaseURL:false)?.queryItems ?? []
            try check(query.first { $0.name=="limit" }?.value == "30", "jobs requests use limit=30")
            if query.contains(where: { $0.name == "before" }) {
                try check(query.first { $0.name=="before" }?.value=="2000", "jobs pagination sends the server cursor in milliseconds")
                return (200,[:],try JSONSerialization.data(withJSONObject:["running":[],"recent":[task("b",2000),task("c",1000)],"next":NSNull()]))
            }
            return (200,[:],try JSONSerialization.data(withJSONObject:["running":[],"recent":[task("a",3000),task("b",2000)],"next":2000]))
        }
        let list = TaskListStore(); await list.refresh(); await list.loadNext(); await list.loadNext()
        try check(list.recent.map(\.id)==["a","b","c"] && list.next==nil && requested.count==2, "pagination appends, de-duplicates and ends on null without more requests")
        var pageRequests = 0
        FixtureProtocol.respond = { req in
            pageRequests += 1
            let cursor = URLComponents(url:req.url!,resolvingAgainstBaseURL:false)?.queryItems?.first { $0.name == "before" }?.value.flatMap(Double.init) ?? 100000
            let all = (0..<75).map { task("history-\($0)", Double(99999-$0)) }.filter { ($0["ts"] as! Double) < cursor }
            let page = Array(all.prefix(30))
            return (200,[:],try JSONSerialization.data(withJSONObject:["running":[],"recent":page,"next": all.count > 30 ? page.last!["ts"]! : NSNull()]))
        }
        let longList=TaskListStore(); await longList.refresh()
        while longList.next != nil { await longList.loadNext() }
        try check(longList.recent.count==75 && pageRequests==3,"task history continues beyond fifty records through all cursor pages")
        print("PASS: local-day task grouping, millisecond cursor, page append/de-duplication, 75 records and pagination termination")

        let id = "fixture-task", path = "data/uploads/2026-10-12/参考.jpg"
        let raw: [String:Any] = ["id":id,"title":"任务","status":"done","items":[
            ["kind":"prompt","from":"agent","text":"交代的任务","time":1000],
            ["kind":"tool","tool":"Read","text":"读取资料","time":2000],
            ["kind":"text","text":"## 进度\n正在整理","time":3000],
            ["kind":"prompt","from":"user","text":"","time":4000,"attachments":[["path":path,"name":"参考.jpg","kind":"image"]]],
            ["kind":"result","text":"**已完成**","time":5000]]]
        let history=try TaskHistory.parse(raw,id:id), again=try TaskHistory.parse(raw,id:id)
        try check(history==again && history.items[0].message.kind == .assistant && history.items[3].message.kind == .user && history.items[3].message.attachments.first?.path==path, "task mapping preserves agent/user roles, attachments and stable message identities")
        var invalid=raw; invalid["items"]=[["kind":"prompt","text":"缺少 from"]]
        do { _=try TaskHistory.parse(invalid,id:id); throw VerificationError(description:"missing task sender must fail") } catch is ApiError {}
        let composer=Composer(taskID:id)
        composer.drafts=[Draft(data:Data("file fixture".utf8),name:"参考.txt",kind:"file")]
        var uploads=0,sends=0
        FixtureProtocol.respond = { req in
            if req.url!.path.hasSuffix("/api/upload") { uploads+=1; return (200,[:],Data(#"{"path":"data/uploads/fixture/参考.txt","name":"参考.txt","size":12}"#.utf8)) }
            sends+=1
            let body=try SettingsTaskFixtures.body(req)
            try check(body["text"] as? String=="" && (body["attachments"] as? [[String:Any]])?.first?["kind"] as? String=="file", "attachment-only task continuation uses the shared upload contract")
            return (200,[:],try JSONSerialization.data(withJSONObject:["ok":true,"id":id]))
        }
        let sent=await composer.sendContents()
        try check(sent && composer.drafts.isEmpty && uploads==1 && sends==1 && composer.sentRevision==1, "shared task composer uploads and clears only on matching acknowledgement")
        composer.drafts=[Draft(data:Data("retry".utf8),name:"重试.txt",kind:"file")]
        FixtureProtocol.respond = { req in
            if req.url!.path.hasSuffix("/api/upload") { uploads+=1; return (200,[:],Data(#"{"path":"data/uploads/fixture/重试.txt","name":"重试.txt","size":5}"#.utf8)) }
            return (502,[:],Data(#"{"error":"本地续聊失败"}"#.utf8))
        }
        let failed=await composer.sendContents()
        try check(!failed && composer.drafts.count==1 && composer.drafts[0].uploaded != nil, "failed task send preserves uploaded attachment for retry")
        FixtureProtocol.respond = { _ in (200,[:],try JSONSerialization.data(withJSONObject:["ok":true,"id":id])) }
        let retried=await composer.sendContents()
        try check(retried && uploads==2, "retry sends cached upload without uploading twice")
        let voice=Composer(taskID:id); voice.text="还没发的草稿"; voice.retryAudio=Data("local-audio".utf8)
        FixtureProtocol.respond = { req in
            if req.url!.path.hasSuffix("/api/transcribe") { return (200,[:],Data(#"{"text":"语音转写的消息"}"#.utf8)) }
            return (200,[:],try JSONSerialization.data(withJSONObject:["ok":true,"id":id]))
        }
        voice.retryTranscribe(); try await Task.sleep(nanoseconds:250_000_000)
        try check(voice.text=="还没发的草稿" && voice.sentRevision==1 && voice.retryAudio==nil,"successful voice delivery preserves the pre-existing typed draft without duplicating the transcript")
        voice.retryAudio=Data("local-audio".utf8)
        FixtureProtocol.respond = { req in
            if req.url!.path.hasSuffix("/api/transcribe") { return (200,[:],Data(#"{"text":"发送失败的转写"}"#.utf8)) }
            return (502,[:],Data(#"{"error":"本地发送失败"}"#.utf8))
        }
        voice.retryTranscribe(); try await Task.sleep(nanoseconds:250_000_000)
        try check(voice.text=="还没发的草稿\n发送失败的转写" && !voice.voiceMode && !voice.transcribing,"failed voice delivery retains the transcript next to the typed draft")
        print("PASS: task sender/Markdown/tool mapping, stable identities, shared attachments-only composer, failed-send retry and voice draft preservation")

        let json: [String:Any] = ["syncedAt":"2026-10-12T12:00:00+08:00","device":"测试手机","note":NSNull(),"days":[
            ["date":"2026-10-12","sleepMinutes":432,"restingHr":62,"hrv":NSNull(),"steps":0],
            ["date":"2026-10-11","sleepMinutes":NSNull(),"restingHr":NSNull(),"hrv":42,"steps":6840]],
            "weekly":[["name":"健康周报","path":"data/briefs/2026-09-20/健康周报.html","date":"2026-09-20","range":"9月14日–9月20日","summary":"节奏稳定"]],
            "records":[["path":"data/memory/health/基线.md","title":"基线","updated":NSNull(),"preview":"两行预览"],["path":"data/memory/health/../secret.md","title":"非法","preview":""]]]
        let mapped=try HealthSnapshot.parse(json), today=mapped.today(now:now)!
        try check(mapped.days.map(\.date)==["2026-10-11","2026-10-12"] && today.steps==0 && today.hrv==nil && mapped.records.count==1 && mapped.syncedAt != nil && mapped.weekly[0].date=="2026-09-20", "health preserves null/zero, orders days, routes old weekly briefs and validates record paths")
        try check(HealthKind.sleep.formatted(today.sleepMinutes)=="7.2" && HealthKind.hrv.formatted(nil)=="--", "health formats minutes as hours and missing values as --")
        var endpoints: [String]=[]
        FixtureProtocol.respond = { req in endpoints.append((req.httpMethod ?? "GET")+" "+req.url!.path); return (200,[:],try JSONSerialization.data(withJSONObject:json)) }
        let health=HealthStore(); await health.load(); await health.load(sync:true)
        try check(endpoints.count==2 && endpoints[0].hasSuffix("/api/health") && endpoints[1].hasPrefix("POST ") && endpoints[1].hasSuffix("/api/health/sync") && health.snapshot==mapped, "health load and immediate sync use dedicated endpoints")
        FixtureProtocol.respond = { _ in (404,[:],Data(#"{"error":"没有这份简报"}"#.utf8)) }
        do { _=try await BriefItem.fetch(path:"data/briefs/2026-09-20/健康周报.html"); throw VerificationError(description:"missing brief") } catch let error as ApiError { try check(error.code==404,"missing health brief retains 404") }
        print("PASS: health null/zero/date/value mapping, weekly/record routes, immediate sync and brief-item 404")
    }
}
