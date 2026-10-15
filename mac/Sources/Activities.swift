import SwiftUI
import Observation
struct ActivitySummary:Identifiable {
    let id:String
    let title:String
    let status:String
    let chatType:String?
    let time:Date?
    init?(_ r:[String:Any],running:Bool=false) {
        guard let id=r["id"] as? String, !id.isEmpty else { return nil }
        self.id=id; title=r["title"] as? String ?? r["label"] as? String ?? "活动"
        chatType=r["chatType"] as? String
        status=running ? "running" : r["status"] as? String ?? "done"; time=ProductTime.date(r[running ? "started" : "ts"])
    }
    var label:String { switch status { case "running":"进行中"; case "error":"出错"; case "stopped":"已停止"; default:"完成" } }
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
            title=r["title"] as? String ?? "活动"; status=r["status"] as? String ?? ""
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
    var body:some View {
        SubPage(title:store.title.isEmpty ? title : store.title,scrolls:false,trailing:{
            if store.status == "running" { Button("停止活动") { Task { do { _ = try await Api.json(ActivityStore.endpoint(id,action:"stop"),method:"POST"); await store.load() } catch { store.error=error.localizedDescription } } }.buttonStyle(SoftButtonStyle()) }
        },content:{
            VStack(spacing:12) {
                ScrollView { LazyVStack(alignment:.leading,spacing:16) {
                    ForEach(store.items) { step in
                        VStack(alignment:.leading,spacing:8) {
                            HStack { Text(step.kind == "tool" ? "工具摘要" : step.kind == "prompt" ? (step.from == "user" ? "你的交代" : "豆豆的交代") : "豆豆").font(Theme.font(size:11,weight:.medium)).foregroundStyle(Theme.sub)
                                Spacer(); if let time=step.time { Text(Fmt.when(time)).font(Theme.font(size:10)).foregroundStyle(Theme.sub) }
                            }
                            if step.kind == "tool" { DisclosureGroup("查看摘要") { Text(step.text).font(Theme.font(size:12)).foregroundStyle(Theme.sub).frame(maxWidth:.infinity,alignment:.leading) } }
                            else { MarkdownView(text:step.text,size:14).textSelection(.enabled) }
                            ForEach(Array(step.attachments.enumerated()),id:\.offset) { AttachmentView(att:$0.element) }
                        }.card(radius:16,padding:17)
                    }
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
