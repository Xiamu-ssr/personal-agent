import AppKit
import SwiftUI

final class MockTransport:URLProtocol {
    static func body(_ r: URLRequest) -> Data {
        if let d = r.httpBody { return d }
        guard let stream = r.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var result = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; result.append(buffer, count: n) }
        return result
    }
    static var respond:((URLRequest)throws->(Int,[String:Any]))?
    override class func canInit(with request:URLRequest)->Bool { true }
    override class func canonicalRequest(for request:URLRequest)->URLRequest { request }
    override func startLoading() {
        do { let (code,body)=try Self.respond!(request)
            client?.urlProtocol(self,didReceive:HTTPURLResponse(url:request.url!,statusCode:code,httpVersion:nil,headerFields:["Content-Type":"application/json"])!,cacheStoragePolicy:.notAllowed)
            client?.urlProtocol(self,didLoad:try JSONSerialization.data(withJSONObject:body)); client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self,didFailWithError:error) }
    }
    override func stopLoading() {}
}
@main struct V08Tests {
    static var count=0
    static func check(_ pass:Bool,_ label:String) { if !pass { print("FAIL: "+label); exit(1) }; count += 1 }
    @MainActor static func main() async {
        let config=URLSessionConfiguration.ephemeral; config.protocolClasses=[MockTransport.self]; Api.session=URLSession(configuration:config)
        Prefs.server="http://127.0.0.1:18808"
        check(Prefs.isolatedRoot != nil,"test data root is isolated")
        for card in [["type":"connector","id":"github"],["type":"goal","name":"每周运动"],["type":"link","url":"https://example.test/a"],["type":"browser"],["type":"device","capability":"shell"]] {
            check(SayCard(card) != nil,"parse card \(card["type"]!)")
        }
        for kind in ["image","video","audio","file"] { check(SayCard(["type":kind,"path":"data/library/media/演示."+kind]) != nil,"parse media \(kind)") }
        for path in ["/etc/passwd","data/../system/token","data//image.png","data/./image.png","data/a\\b","https://example.test/a.png"] {
            check(SayCard(["type":"image","path":path]) == nil,"reject invalid data path")
        }
        for url in ["javascript:alert(1)","file:///tmp/test","https://user:pass@example.test"] { check(SayCard(["type":"link","url":url]) == nil,"reject invalid link") }
        check(SayCard(["type":"goal","name":"../角色"]) == nil,"reject goal traversal")
        var wire:[[String:Any]]=[]
        let chat=ChatClient(sender:{ wire.append($0); return true })
        let bubble:[String:Any]=["t":"say","role":"assistant","id":"a","text":"取个名字？","options":[["id":"0","label":"豆豆"],["id":"1","label":"芽芽"]],"cards":[["type":"image","path":"data/a.png"]],"media":[["path":"data/a.png","kind":"image"],["path":"data/b.png","kind":"image"]],"ts":1000]
        chat.handle(bubble); chat.handle(bubble)
        check(chat.items.count == 1,"duplicate say merges by server ID")
        check(!ChatItem(kind:.assistant,text:" \n").visible,"whitespace fallback never creates empty visual bubble")
        check(chat.items[0].visibleMedia.map(\.path) == ["data/b.png"],"card and Markdown media deduplicate")
        var calls=0
        MockTransport.respond={ r in calls += 1; check(r.url!.path == "/api/options/choose","choose uses v08 endpoint"); let b=try JSONSerialization.jsonObject(with:MockTransport.body(r)) as! [String:String]; check(b["messageId"] == "a" && b["optionId"] == "0","choose sends server identities"); return (200,["ok":true]) }
        await chat.choose(messageID:"a",optionID:"0"); await chat.choose(messageID:"a",optionID:"1")
        check(calls == 1 && chat.items[0].optionsUsed,"whole option group consumed once")
        chat.handle(bubble); check(chat.items[0].optionsUsed,"stale history cannot reenable options")
        let second:[String:Any]=["t":"say","role":"assistant","id":"b","text":"再选一次","options":[["id":"0","label":"继续"]]]
        chat.handle(second); MockTransport.respond={ _ in (409,["error":"already used"]) }
        await chat.choose(messageID:"b",optionID:"0"); check(chat.items[1].optionsUsed,"cross device 409 disables group")
        chat.handle(["t":"options_used","messageId":"future"])
        chat.handle(["t":"say","role":"assistant","id":"future","text":"","options":[["id":"0","label":"继续"]]])
        check(chat.items[2].optionsUsed,"out of order consumption survives say")
        let n=chat.items.count; chat.handle(["t":"turn_end","text":"summary that must not duplicate"]); check(chat.items.count == n,"turn end does not add bubble")
        chat.handle(["t":"status","busy":true]); check(chat.send("忙时插话"),"busy input remains enabled")
        check(wire.last?["t"] as? String == "send","busy interjection transmits immediately")
        chat.handle(["t":"user","role":"user","id":"u","text":"忙时插话"]); check(chat.items.filter{$0.kind == .user}.count == 1,"echo reconciles optimistic input")
        chat.handle(["t":"delta","id":"stream","text":"part"]); chat.handle(["t":"say","role":"assistant","id":"stream","text":"complete"]); chat.handle(["t":"delta","id":"stream","text":"late"])
        check(chat.items.last?.text == "complete","say completes fallback stream and rejects late delta")
        chat.handle(["t":"background_activities","phase":"snapshot","items":[["id":"job","description":"工作","startedAt":1],["id":"job","description":"更新","startedAt":1]]]); check(chat.backgroundActivities.count == 1,"background snapshot deduplicates IDs")
        chat.handle(["t":"background_activities","phase":"snapshot","items":[]]); check(chat.backgroundActivities.isEmpty,"empty snapshot clears background set")
        chat.handle(["t":"avatar","state":"working","text":"在看邮件"]); chat.handle(["t":"status","busy":false]); check(chat.avatarState == .working,"main idle cannot override background working avatar")
        let feed=FeedStore()
        func post(_ day:String,_ name:String)->[String:Any] { ["path":"data/feed/\(day)/\(name).md","date":day,"title":name,"body":"正文"] }
        let first=try! FeedPageData.parse(["days":["2026-10-15","2026-10-14"],"items":[post("2026-10-15","0900"),post("2026-10-15","0800"),post("2026-10-14","1200")],"next":"2026-10-14"])
        feed.apply(first,reset:true)
        check(feed.items.count == 3 && feed.days.count == 2,"feed pagination retains entire days")
        feed.apply(try! FeedPageData.parse(["days":["2026-10-14","2026-10-13"],"items":[post("2026-10-14","1200"),post("2026-10-13","0800")],"next":NSNull()]),reset:false)
        check(feed.items.count == 4 && feed.next == nil,"feed overlap deduplicates and final cursor stops")
        do { _ = try FeedPageData.parse(["days":["2026-10-15"],"items":[post("2026-10-14","1200")]]); check(false,"invalid page should fail") } catch { check(true,"feed rejects cross date corruption") }
        let paged=FeedStore(); paged.apply(first,reset:true)
        MockTransport.respond={ r in check(URLComponents(url:r.url!,resolvingAgainstBaseURL:false)!.queryItems!.contains(URLQueryItem(name:"before",value:"2026-10-14")),"feed uses exclusive date cursor"); return (200,["days":["2026-10-13"],"items":[post("2026-10-13","0800")],"next":NSNull()]) }
        await paged.load(); check(paged.items.count == 4 && paged.error.isEmpty,"feed network next page merges")
        let coalesced=FeedStore();var refreshes=0
        MockTransport.respond={ _ in refreshes += 1; if refreshes == 1 { Thread.sleep(forTimeInterval:0.1) }; return (200,["days":["2026-10-15"],"items":[post("2026-10-15","0900")],"next":NSNull()]) }
        let firstLoad=Task { await coalesced.load(reset:true) }
        while !coalesced.loading { await Task.yield() }
        await coalesced.load(reset:true);await firstLoad.value
        for _ in 0..<100 {if refreshes>=2 && !coalesced.loading {break};try? await Task.sleep(nanoseconds:10_000_000)}
        check(refreshes == 2 && coalesced.items.count == 1,"new feed notification during a load schedules a fresh snapshot")
        let badge=FeedBadge(); badge.leave(); badge.receive(); check(badge.unread,"feed new sets badge"); badge.enter(); check(!badge.unread,"enter feed clears badge"); badge.receive(); check(!badge.unread,"visible feed stays read")
        var g:[String:Any]=["name":"每周运动","path":"data/goals/每周运动.md","title":"每周运动","domain":"健康","cadence":"0 8 * * 1","status":"追踪中","progress":25,"body":"## 计划\n每周三次","nextCheckin":"2026-10-19T00:00:00.000Z"]
        check(Goal(g)?.nextCheckin != nil,"parse goal next check in ISO milliseconds")
        g["progress"]=25.5; check(Goal(g)?.progress == 25.5,"fractional goal progress is preserved"); g["progress"]=101; check(Goal(g) == nil,"reject goal progress outside range"); g["progress"]=25
        g["domain"]="invalid"; check(Goal(g) == nil,"reject unknown goal domain"); g["domain"]="健康"
        g["status"]="暂停"; check(Goal(g)?.nextCheckin == nil,"paused goal has no next check in")
        g["status"]="完成"; check(Goal(g)?.nextCheckin == nil,"completed goal has no next check in")
        check((try! ActivityStore.endpoint("goal:每周运动",action:"send")).contains("%3A"),"activity IDs percent encode punctuation")
        check(Api.wsRequest("browser")?.url?.path == "/ws/browser","browser uses separate socket path")
        check(Api.wsRequest("browser")?.url?.query == nil,"browser token never appears in URL")
        await sideChats(); feedSourceLinks()
        print("PASS: \(count) v0.8 assertions (cards, options, say/stream, busy input, avatar, snapshots, feed paging/badge, goals, browser routing)")
    }
    @MainActor static func sideChats() async {
        SideChats.shared.reset()
        let main=ChatClient(sender:{_ in true})
        let common:[String:Any]=["id":"shared-bubble","role":"assistant","text":"主聊选项","options":[["id":"0","label":"继续"]]]
        var mainEvent=common;mainEvent["t"]="say";main.handle(mainEvent)
        var requests:[String]=[]
        let draft=SideChatThread();Nav.shared.openSide(draft)
        check(draft.activityID == nil && draft.transcript.items.isEmpty,"opening a draft creates no server side chat")
        let sideMessage:[String:Any]=["role":"assistant","id":"shared-bubble","text":"只属于旁聊 A","activityId":"side-a","chatType":"side","options":[["id":"0","label":"调研"],["id":"1","label":"计划"]],"ts":2]
        let user:[String:Any]=["role":"user","id":"side-user","text":"旁聊 A 首条消息","activityId":"side-a","chatType":"side","ts":1]
        var early=sideMessage;early["t"]="activity_message";main.handle(early)
        check(main.items.count == 1 && main.items[0].text == "主聊选项","side message event never enters main transcript")
        MockTransport.respond={r in
            requests.append(r.url!.path)
            if r.url!.path == "/api/side-chats" {
                let b=try JSONSerialization.jsonObject(with:MockTransport.body(r)) as! [String:Any]
                check(b["text"] as? String == "旁聊 A 首条消息" && b["attachments"] as? [[String:Any]] != nil,"first side send creates with text and attachment array")
                return (201,["ok":true,"id":"side-a","chatType":"side"])
            }
            check(r.url!.path == "/api/activities/side-a/history","created chat reads its own history")
            return (200,["id":"side-a","chatType":"side","title":"旁聊 A","status":"done","items":[["kind":"tool","text":"must never become a bubble"]],"messages":[user,sideMessage]])
        }
        draft.composer.text="旁聊 A 首条消息"
        let created=await draft.composer.sendContents()
        check(created && requests.filter{$0 == "/api/side-chats"}.count == 1 && draft.activityID == "side-a","first message creates exactly once")
        check(Nav.shared.sideChat === draft && draft.composer.text.isEmpty,"shared composer stays in side chat after sending")
        check(draft.transcript.items.map(\.serverID) == ["side-user","shared-bubble"],"pre-create event merges with ordered history without tool steps or duplicate bubbles")
        let other=SideChats.shared.thread("side-b")
        var otherMessage=sideMessage;otherMessage["activityId"]="side-b";other.transcript.receive(otherMessage)
        MockTransport.respond={r in
            let b=try JSONSerialization.jsonObject(with:MockTransport.body(r)) as! [String:String]
            check(r.url!.path == "/api/options/choose" && b["activityId"] == "side-a" && b["messageId"] == "shared-bubble","side option sends its activity identity")
            return (200,["ok":true])
        }
        await draft.transcript.choose(messageID:"shared-bubble",optionID:"0")
        check(draft.transcript.items.last!.optionsUsed && !other.transcript.items[0].optionsUsed && !main.items[0].optionsUsed,"same bubble ID options stay independent across main and two side chats")
        draft.transcript.mergeSnapshot([user,sideMessage]);check(draft.transcript.items.last!.optionsUsed,"late side snapshot cannot reenable consumed options")
        main.handle(["t":"options_used","activityId":"side-b","chatType":"side","messageId":"future"])
        var future=otherMessage;future["id"]="future";future["t"]="activity_message";main.handle(future)
        check(other.transcript.items.last!.optionsUsed && !main.items[0].optionsUsed,"side option event arriving before its bubble stays scoped")
        main.handle(["t":"options_used","activityId":"side-b","chatType":"side","messageId":"shared-bubble"])
        check(other.transcript.items[0].optionsUsed && !main.items[0].optionsUsed,"side option event cannot consume main group with same ID")
        main.busy=true
        MockTransport.respond={r in
            if r.url!.path.hasSuffix("/send") {
                requests.append(r.url!.path)
                let b=try JSONSerialization.jsonObject(with:MockTransport.body(r)) as! [String:Any]
                check(r.url!.path == "/api/activities/side-a/send" && b["text"] as? String == "旁聊 A 补充","side continuation keeps original activity ID")
                return (200,["ok":true,"id":"side-a"])
            }
            return (200,["id":"side-a","chatType":"side","title":"旁聊 A","status":"running","items":[],"messages":[user,sideMessage]])
        }
        draft.status="running";draft.composer.text="旁聊 A 补充"
        let continued=await draft.composer.sendContents()
        check(continued && main.busy && main.items.count == 1 && requests.filter{$0 == "/api/side-chats"}.count == 1,"busy side send creates no second activity and changes no main state")
        let failing=SideChatThread();MockTransport.respond={_ in (400,["error":"本地拒绝空旁聊"])}
        failing.composer.text="保留失败草稿";let failed=await failing.composer.sendContents()
        check(!failed && failing.activityID == nil && failing.composer.text == "保留失败草稿","rejected create preserves draft and leaves no local server ID")
        let list=SideChats()
        list.apply(["running":[["id":"side-a","title":"A","chatType":"side","started":2000]],"recent":[["id":"main","title":"主聊天","ts":3000],["id":"job","title":"动态","ts":2500],["id":"side-a","title":"A","chatType":"side","ts":1000]],"next":900],reset:true)
        check(list.items.map(\.id) == ["side-a"] && list.items[0].status == "running","sidebar filters both activity arrays strictly to side and deduplicates")
        MockTransport.respond={r in
            check(URLComponents(url:r.url!,resolvingAgainstBaseURL:false)!.queryItems!.contains(URLQueryItem(name:"before",value:"900")),"side list retains activity pagination cursor")
            return (200,["recent":[["id":"side-old","title":"较早旁聊","chatType":"side","ts":800],["id":"other","title":"其他活动","ts":700]],"next":NSNull()])
        }
        await list.load(reset:false);check(Set(list.items.map(\.id)) == ["side-a","side-old"] && list.next == nil,"side pagination keeps older chats and excludes ordinary activity")
        MockTransport.respond={_ in (200,["id":"side-a","items":[],"messages":[common]])}
        await draft.load();check(!draft.error.isEmpty && draft.transcript.items.count == 2,"non-side history cannot replace a side conversation")
        Nav.shared.go(.chat);check(Nav.shared.sideChat == nil,"main chat button leaves side conversation")
        SideChats.shared.reset()
    }
    static func feedSourceLinks() {
        func post(_ body:String)->FeedPost {FeedPost(["path":"data/feed/2026-10-15/a.md","date":"2026-10-15","title":"动态","body":body,"url":"https://example.test/news?a=1"])!}
        check(post("正文 [阅读原文](https://example.test/news?a=1)").hasSourceLink,"inline source link hides extra original action")
        check(post("[报道][source]\n\n[source]: https://example.test/news?a=1").hasSourceLink,"reference source link also hides extra original action")
        check(post("<https://example.test/news?a=1#section>").hasSourceLink,"autolink source ignores fragment when deduplicating")
        check(!post("[另一篇](https://example.test/other)").hasSourceLink,"other article link does not hide source action")
        check(!post("`https://example.test/news?a=1`").hasSourceLink,"literal code URL is not a rendered source link")
    }

}
