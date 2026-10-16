import SwiftUI
import Observation

@Observable final class SideChatThread:Identifiable {
    let id=UUID()
    private(set) var activityID:String?
    let transcript:ChatTranscript
    let composer:Composer
    var title="新旁聊"
    var status=""
    var loading=false
    var error=""
    init(activityID:String?=nil) {
        self.activityID=activityID;transcript=ChatTranscript(activityID:activityID);composer=Composer()
        composer.delivery={ [weak self] submission in
            guard let self else {throw CancellationError()};try await self.send(submission)
        }
    }
    func bind(_ activityID:String) {self.activityID=activityID;transcript.bind(activityID)}
    @MainActor func send(_ submission:MessageSubmission) async throws {
        let text=submission.text,attachments=submission.attachments
        guard !text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty || !attachments.isEmpty else {
            throw ApiError(code:400,message:"先写点什么，或添加一个附件")
        }
        let body=submission.body
        if let activityID {
            let response=try await Api.json(ActivityStore.endpoint(activityID,action:"send"),method:"POST",body:body)
            guard response["ok"] as? Bool == true,response["id"] as? String == activityID else {throw ApiError(code:0,message:"旁聊消息没有发出去，请重试")}
        } else {
            let response=try await Api.json("/api/side-chats",method:"POST",body:body)
            guard response["ok"] as? Bool == true,response["chatType"] as? String == "side",let id=response["id"] as? String,!id.isEmpty else {
                throw ApiError(code:0,message:"旁聊没有创建成功，请重试")
            }
            SideChats.shared.adopt(self,activityID:id)
        }
        status="running";transcript.sentRevision += 1;error=""
        await load();ChatClient.shared.jobsVersion += 1
    }
    @MainActor func load() async {
        guard let activityID,!loading else {return};loading=true;defer {loading=false}
        do {
            let response=try await Api.json(ActivityStore.endpoint(activityID,action:"history"));try Task.checkCancellation()
            guard response["id"] as? String == activityID,response["chatType"] as? String == "side",let rows=response["messages"] as? [[String:Any]] else {
                throw ApiError(code:0,message:"旁聊记录不完整")
            }
            title=response["title"] as? String ?? "旁聊";status=response["status"] as? String ?? ""
            transcript.mergeSnapshot(rows);error=""
        } catch is CancellationError {} catch {self.error=error.localizedDescription}
    }
    @MainActor func stop() async {
        guard let activityID else {return}
        do {_ = try await Api.json(ActivityStore.endpoint(activityID,action:"stop"),method:"POST");await load();ChatClient.shared.jobsVersion += 1}
        catch {self.error=error.localizedDescription}
    }
}

/// The sidebar is a server-backed filtered activity list; ordinary activity continuations stay out.
@Observable final class SideChats {
    static let shared=SideChats()
    var items:[ActivitySummary]=[]
    var next:Double?
    var loading=false
    var error=""
    @ObservationIgnored private var threads:[String:SideChatThread]=[:]
    @ObservationIgnored private var reloadRequested=false
    func thread(_ activityID:String)->SideChatThread {
        if let thread=threads[activityID] {return thread}
        let thread=SideChatThread(activityID:activityID);threads[activityID]=thread;return thread
    }
    func adopt(_ thread:SideChatThread,activityID:String) {
        thread.bind(activityID)
        if let early=threads[activityID],early !== thread {thread.transcript.absorb(early.transcript);thread.title=early.title}
        threads[activityID]=thread
    }
    func receive(_ row:[String:Any]) {
        guard row["chatType"] as? String == "side",let id=row["activityId"] as? String,!id.isEmpty else {return}
        thread(id).transcript.receive(row)
    }
    func activity(_ row:[String:Any]) {
        guard let id=row["id"] as? String,!id.isEmpty,
              row["chatType"] as? String == "side" || (row["phase"] as? String == "updated" && (threads[id] != nil || items.contains {$0.id == id})) else {return}
        let t=thread(id)
        if let title=row["title"] as? String {t.title=title}
        if let i=items.firstIndex(where:{$0.id == id}) {
            if let title=row["title"] as? String {items[i].title=title}
            if let summary=row["summary"] as? String {items[i].summary=summary}
        }
        if let status=row["status"] as? String {t.status=status}
        else if row["phase"] as? String == "started" {t.status="running"}
    }
    func apply(_ response:[String:Any],reset:Bool) {
        let running=(response["running"] as? [[String:Any]] ?? []).compactMap {ActivitySummary($0,running:true)}
        let recent=(response["recent"] as? [[String:Any]] ?? []).compactMap {ActivitySummary($0)}
        var byID=Dictionary((reset ? [] : items).map {($0.id,$0)},uniquingKeysWith:{_,new in new})
        for item in recent+running where item.chatType == "side" {byID[item.id]=item}
        items=byID.values.sorted {a,b in (a.time ?? .distantPast) == (b.time ?? .distantPast) ? a.id<b.id : (a.time ?? .distantPast)>(b.time ?? .distantPast)}
        next=(response["next"] as? NSNumber)?.doubleValue
    }
    @MainActor func load(reset:Bool=true) async {
        guard !loading else {if reset {reloadRequested=true};return}
        if !reset && next == nil {return}
        loading=true;defer {loading=false;if reloadRequested {reloadRequested=false;Task {await self.load()}}}
        do {
            let cursor=reset ? nil : next
            let response=try await Api.json("/api/activities?limit=30"+(cursor.map {"&before=\(Int($0))"} ?? ""));try Task.checkCancellation()
            if let cursor,let next=(response["next"] as? NSNumber)?.doubleValue,next>=cursor {throw ApiError(code:0,message:"旁聊列表没有继续加载")}
            apply(response,reset:reset);error=""
        } catch is CancellationError {} catch {self.error=error.localizedDescription}
    }
    func reset() {for t in threads.values {t.composer.reset()};threads=[:];items=[];next=nil;error=""}
}
