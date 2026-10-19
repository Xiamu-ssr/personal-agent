import SwiftUI
import Observation
struct ActivitySummary:Identifiable,Equatable {
    let id:String
    var title:String
    var summary:String
    let status:String
    let chatType:String?
    let time:Date?
    init?(_ r:[String:Any],running:Bool=false) {
        guard let id=r["id"] as? String, !id.isEmpty else { return nil }
        self.id=id; title=r["title"] as? String ?? r["label"] as? String ?? "活动"
        summary=r["summary"] as? String ?? ""
        chatType=r["chatType"] as? String
        status=running ? "running" : r["status"] as? String ?? "done"; time=ProductTime.date(r[running ? "started" : "ts"])
    }
    var label:String { switch status { case "running":"进行中"; case "error":"出错"; case "stopped":"已停止"; default:"完成" } }
}

/// The cloud decides which rounds are activities. Metadata events only patch an existing ID.
@Observable final class ActivityListStore {
    static let shared=ActivityListStore()
    var running:[ActivitySummary]=[]
    var recent:[ActivitySummary]=[]
    var next:Double?
    var loading=false
    var error=""
    @ObservationIgnored private var revision=0
    @ObservationIgnored private var generation=0
    @ObservationIgnored private var reloadRequested=false
    private struct Metadata {let revision:Int;let title:String;let summary:String}
    @ObservationIgnored private var metadata:[String:Metadata]=[:]
    func item(_ id:String)->ActivitySummary? {(running+recent).first {$0.id == id}}
    func receive(_ row:[String:Any]) {
        guard row["phase"] as? String == "updated",let id=row["id"] as? String,!id.isEmpty,
              let title=row["title"] as? String,let summary=row["summary"] as? String else {return}
        revision += 1;metadata[id]=Metadata(revision:revision,title:title,summary:summary)
        for i in running.indices where running[i].id == id {running[i].title=title;running[i].summary=summary}
        for i in recent.indices where recent[i].id == id {recent[i].title=title;recent[i].summary=summary}
    }
    func apply(_ response:[String:Any],reset:Bool,startedAt:Int?=nil) {
        let startedAt=startedAt ?? revision
        func patched(_ item:ActivitySummary)->ActivitySummary {
            var item=item
            if let patch=metadata[item.id],patch.revision>startedAt {item.title=patch.title;item.summary=patch.summary}
            return item
        }
        let active=(response["running"] as? [[String:Any]] ?? []).compactMap {ActivitySummary($0,running:true)}.map(patched)
        let finished=(response["recent"] as? [[String:Any]] ?? []).compactMap {ActivitySummary($0)}.map(patched)
        var seen=Set<String>()
        running=active.filter {seen.insert($0.id).inserted}
        if reset {recent=finished.filter {seen.insert($0.id).inserted}}
        else {
            let incoming=Dictionary(finished.map {($0.id,$0)},uniquingKeysWith:{_,new in new})
            recent=(recent.map {incoming[$0.id] ?? $0}+finished).filter {seen.insert($0.id).inserted}
        }
        // Rows keep their stable IDs, order and timestamps when their title/summary changes.
        let fetched=Set((active+finished).map(\.id))
        metadata=metadata.filter {!(fetched.contains($0.key) && $0.value.revision<=startedAt)}
        next=(response["next"] as? NSNumber)?.doubleValue
    }
    @MainActor func load(reset:Bool=true) async {
        guard !loading else {if reset {reloadRequested=true};return}
        guard reset || next != nil else {return}
        loading=true
        defer {loading=false;if reloadRequested {reloadRequested=false;Task {await self.load()}}}
        let startedAt=revision,version=generation,cursor=reset ? nil : next
        do {
            let response=try await Api.json("/api/activities?limit=30"+(cursor.map {"&before=\(Int($0))"} ?? ""))
            try Task.checkCancellation()
            guard version == generation else {return}
            if let cursor,let next=(response["next"] as? NSNumber)?.doubleValue,next>=cursor {throw ApiError(code:0,message:"活动列表没有继续加载")}
            apply(response,reset:reset,startedAt:startedAt);error=""
        } catch is CancellationError {} catch {self.error=error.localizedDescription}
    }
    func reset() {running=[];recent=[];next=nil;metadata=[:];revision += 1;generation += 1;reloadRequested=false;error=""}
}
struct ActivityStep:Identifiable {
    let id:Int
    let kind:String
    let text:String
    let from:String
    let time:Date?
    let attachments:[Attachment]
}
@Observable final class ActivityStore {
    let id:String
    let composer:Composer
    var title=""
    var summary=""
    var status=""
    var items:[ActivityStep]=[]
    var loading=false
    var error=""
    init(id:String) { self.id=id; composer=Composer(taskID:id) }
    static func endpoint(_ id:String,action:String) throws -> String {
        guard !id.isEmpty, ["history","send","stop"].contains(action) else { throw ApiError(code:0,message:"活动编号不对") }
        return "/api/activities/"+Api.query(id)+"/"+action
    }
    @MainActor func load() async {
        guard !loading else { return }; loading=true; defer { loading=false }
        do {
            let r=try await Api.json(Self.endpoint(id,action:"history")); try Task.checkCancellation()
            guard r["id"] as? String == id, let rows=r["items"] as? [[String:Any]] else { throw ApiError(code:0,message:"活动记录不完整") }
            title=r["title"] as? String ?? "活动"; summary=r["summary"] as? String ?? "";status=r["status"] as? String ?? ""
            items=rows.enumerated().map { i,r in ActivityStep(id:i,kind:r["kind"] as? String ?? "",text:r["text"] as? String ?? "",from:r["from"] as? String ?? "",time:ProductTime.date(r["time"]),attachments:(r["attachments"] as? [[String:Any]] ?? []).map(Attachment.init)) }
            error=""
        } catch is CancellationError {} catch { self.error=error.localizedDescription }
    }
}
struct ActivityPage:View {
    let id:String
    let title:String
    @State private var store:ActivityStore
    @Environment(\.interactiveWindow) private var active
    init(id:String,title:String) { self.id=id; self.title=title; _store=State(initialValue:ActivityStore(id:id)) }
    private var headline:String {ActivityListStore.shared.item(id)?.title ?? (store.title.isEmpty ? title : store.title)}
    private var summary:String {ActivityListStore.shared.item(id)?.summary ?? store.summary}
    var body:some View {
        SubPage(title:headline,scrolls:false,trailing:{
            if store.status == "running" { Button("停止活动") { Task { do { _ = try await Api.json(ActivityStore.endpoint(id,action:"stop"),method:"POST"); await store.load() } catch { store.error=error.localizedDescription } } }.buttonStyle(SoftButtonStyle()) }
        },content:{
            VStack(spacing:12) {
                if !summary.isEmpty {Text(summary).font(Theme.font(size:12)).foregroundStyle(Theme.sub).lineLimit(1).frame(maxWidth:.infinity,alignment:.leading).padding(.horizontal,32)}
                ScrollView { LazyVStack(alignment:.leading,spacing:16) {
                    ActivityStepsView(items:store.items)
                    if !store.error.isEmpty { Note(text:store.error) }
                }.frame(maxWidth:720).padding(.horizontal,32).frame(maxWidth:.infinity) }
                ComposerBar(placeholder:"接着聊这个活动…",c:store.composer).frame(maxWidth:740).padding(.horizontal,30).padding(.bottom,20)
            }
        }).task(id:"\(active)-\(ChatClient.shared.jobsVersion)") {
            guard active else { return }; await store.load()
            while !Task.isCancelled && store.status == "running" { do { try await Task.sleep(nanoseconds:3_000_000_000) } catch { return }; await store.load() }
        }.onChange(of:store.composer.sentRevision) { Task { await store.load() } }
    }
}


struct ActivityStepsView: View {
    let items: [ActivityStep]
    var body: some View {
        LazyVStack(alignment:.leading,spacing:16) {
            ForEach(items) { step in
                VStack(alignment:.leading,spacing:8) {
                    HStack {
                        Text(step.kind == "tool" ? "调用工具" : step.kind == "tool_result" ? "执行结果" : step.kind == "prompt" ? (step.from == "user" ? "你的交代" : "豆豆的交代") : "豆豆")
                            .font(Theme.font(size:11,weight:.medium)).foregroundStyle(Theme.sub)
                        Spacer()
                        if let time=step.time {Text(Fmt.when(time)).font(Theme.font(size:10)).foregroundStyle(Theme.sub)}
                    }
                    if step.kind == "tool" || step.kind == "tool_result" {
                        DisclosureGroup("查看摘要") {Text(step.text).font(Theme.font(size:12)).foregroundStyle(Theme.sub).frame(maxWidth:.infinity,alignment:.leading)}.verificationAction("activity-step-\(step.id)")
                    } else {MarkdownView(text:step.text,size:14).textSelection(.enabled)}
                    ForEach(Array(step.attachments.enumerated()),id:\.offset) {AttachmentView(att:$0.element)}
                }.card(radius:16,padding:17)
            }
        }
    }
}
