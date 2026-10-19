import AppKit
import SwiftUI

@main struct V081Tests {
    static var count=0
    static func check(_ pass:Bool,_ label:String) {if !pass {print("FAIL: "+label);exit(1)};count += 1}
    static func body(_ r:URLRequest)throws->[String:Any] {try JSONSerialization.jsonObject(with:MockTransport.body(r)) as! [String:Any]}
    @MainActor static func main() async throws {
        let config=URLSessionConfiguration.ephemeral;config.protocolClasses=[MockTransport.self];Api.session=URLSession(configuration:config)
        check(LocalVerification.explicitLoopback,"isolated loopback verification")
        let post=FeedPost(["path":"data/feed/2026-10-15/0900.md","date":"2026-10-15","title":"产品观察","source":"演示编辑部","icon":"🌱","body":"正文"])!
        let quote=ChatQuote(post)
        let row:[String:Any]=["id":"quoted","role":"user","text":"","quote":["kind":"feed","path":post.path,"title":post.title,"source":post.source,"emoji":"🌱"]]
        let parsed=ChatClient.item(row)!
        check(parsed.quote == quote && parsed.visible,"quote-only user message remains visible")
        check(ChatQuote(["kind":"feed","path":"data/feed/../system/token","title":"bad"]) == nil,"quote rejects traversal")
        check(ChatQuote(["kind":"goal","path":post.path,"title":"bad"]) == nil,"quote kind is strict")
        check(ChatQuote(["kind":"feed","path":"data/library/a.md","title":"bad"]) == nil,"quote only accepts feed paths")
        let c=Composer();var requests:[[String:Any]]=[]
        c.discuss(post)
        check(Nav.shared.tab == .chat && Nav.shared.sideChat == nil && c.quote == quote && c.focusRevision == 1,"discuss navigates to main composer and requests focus")
        check(requests.isEmpty && c.hasContent,"discussion selection sends no request and allows empty text")
        MockTransport.respond={ r in
            check(r.url!.path == "/api/send","quote uses the main send endpoint")
            let b=try body(r);requests.append(b)
            check((b["quote"] as? [String:Any])?["path"] as? String == post.path && b["text"] as? String == "","discuss preserves original path and empty user text")
            check((b["attachments"] as? [Any])?.isEmpty == true,"quoted messages use the unified attachment payload")
            if requests.count == 1 {throw URLError(.timedOut)}
            return (200,["ok":true,"id":"discussion"])
        }
        check(!(await c.sendContents()) && c.quote == quote,"failed discuss retains quote draft")
        check(await c.sendContents(),"retry discuss succeeds")
        check(requests.count == 2 && requests[0]["clientId"] as? String == requests[1]["clientId"] as? String && UUID(uuidString:requests[0]["clientId"] as! String) != nil,"discuss retries reuse one UUID")
        check(c.quote == nil && !c.hasContent,"acknowledged discussion clears quote")
        c.discuss(post);c.quote=nil;c.text="取消引用后普通发送"
        MockTransport.respond={r in check(r.url!.path == "/api/send","cancelled quote sends normally");return (200,["ok":true,"id":"ordinary"])}
        check(await c.sendContents(),"ordinary send after cancelling quote")

        let idea=Idea(["id":"idea-1","icon":"🌱","title":"饭后散步","description":"从十分钟开始","reply":"帮我安排饭后散步"])!
        let ideaQuote=ChatQuote(idea,revision:"revision-1",group:"最近可以试试")
        check(ChatQuote(ideaQuote.json) == ideaQuote,"Idea history preserves its full snapshot")
        let ideaComposer=Composer();ideaComposer.reference(ideaQuote)
        check(ideaComposer.hasContent && ideaComposer.text.isEmpty && ideaComposer.focusRevision == 1,"Idea selection stages a quote without sending")
        var ideaSends=0
        ideaComposer.delivery={message in
            ideaSends += 1;check(message.endpoint == "/api/send","Idea sends to the main conversation")
            let reference=message.body["quote"] as! [String:Any]
            check(reference["id"] as? String == "idea-1" && reference["revision"] as? String == "revision-1" && reference["reply"] == nil,"cloud resolves the selected Idea by identity and revision")
        }
        check(ideaSends == 0,"staging an Idea does not send")
        check(await ideaComposer.sendContents(),"quote-only Idea can be sent")
        ideaComposer.reference(ideaQuote);ideaComposer.text="只走十分钟"
        check(await ideaComposer.sendContents() && ideaSends == 2,"Idea accepts an optional comment")

        var ids:[String]=[];let retry=Composer();retry.text="只发一次"
        MockTransport.respond={r in ids.append(try body(r)["clientId"] as! String);if ids.count == 1 {throw URLError(.networkConnectionLost)};return (200,["ok":true,"id":"one"])}
        check(!(await retry.sendContents()),"uncertain main acknowledgement preserves draft")
        check(await retry.sendContents(),"main retry is acknowledged")
        check(ids.count == 2 && ids[0] == ids[1],"main retry reuses UUID")
        retry.text="只发一次";check(await retry.sendContents(),"intentional repeated text may be sent again")
        check(ids[2] != ids[1],"next intentional message has a new UUID")

        var attempts=0;let edited=Composer();edited.text="第一版"
        edited.delivery={s in ids.append(s.clientID);attempts += 1;throw URLError(.timedOut)}
        _=await edited.sendContents();let before=ids.last;edited.text="第二版";_=await edited.sendContents()
        check(before != ids.last,"edited draft starts a distinct message identity")
        let gate=Composer();gate.text="连点";var delivered=0
        gate.delivery={_ in delivered += 1;try await Task.sleep(nanoseconds:80_000_000)}
        let first=Task {await gate.sendContents()}
        while !gate.sending {await Task.yield()}
        check(!(await gate.sendContents()),"concurrent send is ignored")
        check(await first.value && delivered == 1 && !gate.sending,"sending lock spans acknowledgement")

        // Uploads survive a message retry and keep the same submission identity.
        let files=Composer();files.drafts=[Draft(data:Data("pdf".utf8),name:"演示.pdf",kind:"file")]
        var uploads=0;var sends=0;var attachmentIDs:[String]=[]
        MockTransport.respond={r in
            if r.url!.path == "/api/upload" {uploads += 1;return (200,["path":"data/uploads/演示.pdf","name":"演示.pdf","kind":"file"])}
            let b=try body(r);sends += 1;attachmentIDs.append(b["clientId"] as! String)
            check((b["attachments"] as? [[String:Any]])?.first?["path"] as? String == "data/uploads/演示.pdf","uploaded attachment accompanies message")
            if sends == 1 {throw URLError(.timedOut)};return (200,["ok":true,"id":"attachment"])
        }
        check(!(await files.sendContents()) && files.drafts.first?.uploaded != nil,"upload retained after failed message acknowledgement")
        check(await files.sendContents(),"attachment retry succeeds")
        check(uploads == 1 && attachmentIDs[0] == attachmentIDs[1] && files.drafts.isEmpty,"retry reuses uploaded file and UUID")

        let side=SideChatThread();var creates=0;var sideIDs:[String]=[];side.composer.text="新旁聊"
        MockTransport.respond={r in
            if r.url!.path == "/api/side-chats" {creates += 1;sideIDs.append(try body(r)["clientId"] as! String);if creates == 1 {throw URLError(.timedOut)};return (201,["ok":true,"id":"side-test","chatType":"side"])}
            return (200,["id":"side-test","chatType":"side","items":[],"messages":[],"status":"done"])
        }
        check(!(await side.composer.sendContents()) && side.activityID == nil,"uncertain side create retains draft")
        check(await side.composer.sendContents(),"side create retry succeeds")
        check(sideIDs.count == 2 && sideIDs[0] == sideIDs[1],"side create reuses UUID")
        side.composer.text="续聊";MockTransport.respond={r in
            if r.httpMethod == "POST" {let b=try body(r);check(r.url!.path == "/api/activities/side-test/send" && UUID(uuidString:b["clientId"] as! String) != nil,"side continuation carries UUID");return (200,["ok":true,"id":"side-test"])}
            return (200,["id":"side-test","chatType":"side","items":[],"messages":[]])
        };check(await side.composer.sendContents(),"side continuation acknowledges")

        let transcript=ChatTranscript()
        let a:[String:Any]=["role":"assistant","id":"a","text":"第一条","ts":1,"options":[["id":"0","label":"继续"]],"activityId":"main-round"]
        let b:[String:Any]=["role":"assistant","id":"b","text":"断线时的回复","ts":2,"source":"say"]
        transcript.mergeSnapshot([a]);transcript.useOptions("a");transcript.mergeSnapshot([a,b]);transcript.receive(b)
        check(transcript.items.map(\.serverID) == ["a","b"] && transcript.items[0].optionsUsed,"catch-up merges missing say without re-enabling options or duplicating")
        transcript.receive(["id":"c","role":"assistant","text":"快照之后","ts":3]);transcript.mergeSnapshot([a,b])
        check(transcript.items.map(\.serverID) == ["a","b","c"],"older snapshot preserves newer websocket messages")
        let chat=ChatClient();chat.handle(["t":"say","id":"a","text":"第一条"])
        MockTransport.respond={r in r.url!.path == "/api/state" ? (200,["chatEmpty":false,"busy":false]) : (200,["items":[a,b]])}
        chat.connected=true;chat.busy=true;await chat.catchUp();await chat.catchUp()
        check(chat.items.map(\.serverID) == ["a","b"],"foreground HTTP catch-up is repeatable and deduplicates")
        check(!chat.busy,"foreground snapshot repairs a missed idle status on an apparently connected socket")
        check(chat.items[0].activityID == "main-round","assistant activity identity survives HTTP catch-up")
        transcript.mergeSnapshot([row]);check(transcript.items.first{$0.serverID == "quoted"}?.quote == quote,"history catch-up preserves quote")
        let user:[String:Any]=["role":"user","id":"u1","text":"同文","clientId":"same"]
        transcript.receive(user);transcript.receive(["role":"user","id":"u2","text":"同文","clientId":"other"])
        check(transcript.items.filter{$0.text == "同文"}.count == 2,"intentional identical messages never merge by text")
        check(AppIconStyle.capability("notify").hex != AppIconStyle.capability("calendar_events").hex,"capability colors distinguish actions")
        check(AppIconStyle.connector("gmail").hex != AppIconStyle.connector("qq-mail").hex,"connector brand color blocks differ")

        let removedBody:[String:Any]=["id":"body","role":"assistant","text":"过程里的正文","fallback":true]
        check(ChatClient.item(removedBody) == nil,"removed final-body fallback never becomes a bubble")
        transcript.mergeSnapshot([removedBody]);check(!transcript.items.contains {$0.serverID == "body"},"history refill also excludes final-body fallback")
        chat.handle(["t":"delta","id":"raw","text":"中间正文"])
        check(!chat.items.contains {$0.serverID == "raw"},"raw assistant text never creates a provisional bubble")
        let onlySay=ChatTranscript(activityID:"side-say")
        onlySay.receive(removedBody.merging(["activityId":"side-say","chatType":"side"],uniquingKeysWith:{_,new in new}))
        check(onlySay.items.isEmpty,"side chat follows the same say-only rule")

        let work:[String:Any]=["id":"main-work","kind":"chat","title":"处理中","summary":"","status":"done","ts":3000]
        let background:[String:Any]=["id":"background","title":"阅读清单","summary":"整理了三篇设计文章。","status":"done","chatType":"side","ts":2000]
        let list=ActivityListStore()
        list.apply(["running":[],"recent":[work,background],"next":1000],reset:true)
        check(list.recent.map(\.id) == ["main-work","background"],"server-selected main work remains in the activity list")
        check(list.recent[1].summary == "整理了三篇设计文章。" && list.recent[0].summary.isEmpty,"activity parses summary and accepts metadata still being generated")
        let originalTime=list.recent[0].time
        let patch:[String:Any]=["t":"activity","phase":"updated","id":"main-work","title":"整理设计资料","summary":"阅读资料并整理了产品设计要点。"]
        list.receive(patch)
        check(list.recent.map(\.id) == ["main-work","background"] && list.recent[0].time == originalTime,"updated preserves row identity, order and timestamp")
        check(list.recent[0].title == "整理设计资料" && list.recent[0].summary == "阅读资料并整理了产品设计要点。","updated patches both title and summary in place")
        list.receive(["phase":"updated","id":"main-work","title":"不完整"])
        check(list.recent[0].title == "整理设计资料","incomplete metadata event cannot erase the summary")
        list.receive(["phase":"updated","id":"not-yet-loaded","title":"整理计划","summary":"整理了今天的计划。"])
        check(list.recent.count == 2,"metadata event alone never fabricates an activity or inserts pure chat")
        list.apply(["running":[],"recent":[work,background],"next":1000],reset:true,startedAt:0)
        check(list.recent[0].title == "整理设计资料","metadata arriving during a request wins over its older HTTP snapshot")
        var fresh=work;fresh["title"]="补充设计资料";fresh["summary"]="补充并核对了产品设计资料。"
        list.apply(["running":[],"recent":[fresh,background],"next":1000],reset:true)
        check(list.recent[0].title == "补充设计资料","a later canonical fetch can supersede an already observed event")
        let older:[String:Any]=["id":"older","title":"昨天的工作","summary":"整理了昨天的记录。","ts":500]
        MockTransport.respond={r in
            check(r.url!.path == "/api/activities" && URLComponents(url:r.url!,resolvingAgainstBaseURL:false)!.queryItems!.contains(URLQueryItem(name:"before",value:"1000")),"activity pagination uses the server cursor")
            return (200,["running":[],"recent":[older,background],"next":NSNull()])
        }
        await list.load(reset:false)
        check(list.recent.map(\.id) == ["main-work","background","older"] && list.next == nil,"pagination appends older rows without reordering or duplicate IDs")

        let inflight=ActivityListStore()
        MockTransport.respond={_ in
            Task { @MainActor in inflight.receive(patch) }
            Thread.sleep(forTimeInterval:0.1)
            return (200,["running":[],"recent":[work]])
        }
        await inflight.load()
        check(inflight.item("main-work")?.title == "整理设计资料","real asynchronous load preserves an updated event received while fetching")

        let shared=ActivityListStore.shared
        shared.reset();shared.apply(["recent":[work,background]],reset:true)
        SideChats.shared.apply(["recent":[work,background]],reset:true)
        let jobs=chat.jobsVersion
        chat.handle(patch)
        check(shared.recent[0].summary == "阅读资料并整理了产品设计要点。" && chat.jobsVersion == jobs,"updated event updates shared UI data without triggering a reload")
        check(SideChats.shared.items.map(\.id) == ["background"],"main activity never appears in the side-chat list")
        chat.handle(["t":"activity","phase":"updated","id":"background","title":"补充阅读清单","summary":"增加了两篇设计文章。"])
        check(SideChats.shared.items.first?.title == "补充阅读清单" && SideChats.shared.thread("background").title == "补充阅读清单","metadata event without chatType updates an already known side chat")
        check(shared.item("background")?.summary == "增加了两篇设计文章。","shared console receives the same side activity summary")
        let pending=ActivityListStore();pending.apply(["running":[["id":"running","title":"正在整理","started":1000]]],reset:true)
        pending.receive(["phase":"updated","id":"running","title":"整理资料","summary":"已完成第一部分。"])
        check(pending.running[0].status == "running" && pending.running[0].summary == "已完成第一部分。","metadata update preserves a running activity's status")
        print("PASS: \(count) v0.8.1 assertions (attachments, discussion/quote, UUID reuse, catch-up, say-only, activity metadata/pagination, icons)")
    }
}
