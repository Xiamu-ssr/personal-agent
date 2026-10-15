import Foundation
import Observation

struct FeedPost:Identifiable,Equatable {
    let path:String
    let date:String
    let title:String
    let source:String
    let url:String
    let published:String
    let icon:String
    let image:String?
    let body:String
    var id:String { path }
    init?(_ r:[String:Any]) {
        guard let p=r["path"] as? String, DataPath.valid(p), let date=r["date"] as? String,
              let title=r["title"] as? String, let body=r["body"] as? String else { return nil }
        path=p; self.date=date; self.title=title; self.body=body; source=r["source"] as? String ?? ""
        url=r["url"] as? String ?? ""; published=r["published"] as? String ?? ""; icon=r["icon"] as? String ?? "📰"
        image=(r["image"] as? String).flatMap { DataPath.valid($0) ? $0 : nil }
    }
    var sourceLink:URL? {DataPath.http(url)}
    var hasSourceLink:Bool {
        guard let sourceLink,let markdown=try? AttributedString(markdown:body) else {return false}
        func normalized(_ url:URL)->String {
            var parts=URLComponents(url:url,resolvingAgainstBaseURL:false);parts?.fragment=nil
            return parts?.url?.absoluteString ?? url.absoluteString
        }
        return markdown.runs.contains {run in run.link.map {normalized($0) == normalized(sourceLink)} ?? false}
    }
    var time:Date? {
        let f=DateFormatter(); f.locale=Locale(identifier:"zh_CN"); f.dateFormat="yyyy-MM-dd HH:mm"; return f.date(from:published)
    }
}
struct FeedPageData {
    let items:[FeedPost]
    let days:[String]
    let next:String?
    static func parse(_ r:[String:Any]) throws -> Self {
        guard let rows=r["items"] as? [[String:Any]], let days=r["days"] as? [String] else { throw ApiError(code:0,message:"动态数据不完整") }
        let items=rows.compactMap(FeedPost.init)
        guard items.count == rows.count, Set(days).count == days.count, items.allSatisfy({days.contains($0.date)}) else { throw ApiError(code:0,message:"动态日期或帖子不完整") }
        let next=r["next"] as? String
        if let next, next != days.last { throw ApiError(code:0,message:"动态分页游标不正确") }
        return Self(items:items,days:days,next:next)
    }
}
@Observable final class FeedStore {
    static let shared=FeedStore()
    var items:[FeedPost]=[]
    var days:[String]=[]
    var next:String?
    var loaded=false
    var loading=false
    var error=""
    private var reloadRequested=false
    func apply(_ page:FeedPageData,reset:Bool) {
        if reset { items=[]; days=[] }
        var byID=Dictionary(items.map { ($0.path,$0) },uniquingKeysWith: { _,new in new })
        for p in page.items { byID[p.path]=p }
        items=byID.values.sorted { $0.path > $1.path }
        days=Array(Set(days+page.days)).sorted(by:>)
        next=page.next; loaded=true
    }
    @MainActor func load(reset:Bool=false) async {
        guard !loading else { if reset { reloadRequested=true }; return }; if !reset && loaded && next == nil { return }
        loading=true
        defer { loading=false; if reloadRequested { reloadRequested=false; Task { await self.load(reset:true) } } }
        let cursor=reset ? nil : next
        do {
            let r=try await Api.json("/api/feed?days=7"+(cursor.map { "&before="+Api.query($0) } ?? ""))
            try Task.checkCancellation()
            let page=try FeedPageData.parse(r)
            if let cursor, let next=page.next, next >= cursor { throw ApiError(code:0,message:"动态分页没有前进") }
            apply(page,reset:reset); error=""
        } catch is CancellationError {} catch { self.error=error.localizedDescription }
    }
}
struct Goal:Identifiable,Equatable {
    static let domains=["健康","人际","金融","事业","兴趣","效率","其他"]
    let name:String
    let path:String
    let title:String
    let domain:String
    let cadence:String
    let due:String?
    let status:String
    let progress:Double
    let body:String
    let nextCheckin:Date?
    var id:String { name }
    init?(_ r:[String:Any]) {
        guard let name=r["name"] as? String, !name.isEmpty, !name.contains("/"),
              let path=r["path"] as? String, DataPath.valid(path), let title=r["title"] as? String,
              let domain=r["domain"] as? String, Self.domains.contains(domain),
              let status=r["status"] as? String, ["追踪中","暂停","完成","放弃"].contains(status),
              let progress=(r["progress"] as? NSNumber)?.doubleValue, progress.isFinite, (0...100).contains(progress),
              let cadence=r["cadence"] as? String, let body=r["body"] as? String else { return nil }
        self.name=name; self.path=path; self.title=title; self.domain=domain; self.status=status; self.progress=progress
        self.cadence=cadence; self.body=body; due=r["due"] as? String
        nextCheckin=status == "追踪中" ? ProductTime.date(r["nextCheckin"]) : nil
    }
}
struct Idea:Identifiable {
    let id:String
    let icon:String
    let title:String
    let description:String
    let reply:String
    init?(_ r:[String:Any]) {
        guard let id=r["id"] as? String, !id.isEmpty, let title=r["title"] as? String, let reply=r["reply"] as? String, !reply.isEmpty else { return nil }
        self.id=id; self.title=title; self.reply=reply; icon=r["icon"] as? String ?? "💡"; description=r["description"] as? String ?? ""
    }
}
struct IdeaGroup:Identifiable { let name:String; let items:[Idea]; var id:String { name } }
struct Artifact:Identifiable {
    let name:String
    let path:String
    let kind:String
    let thumbnail:String?
    let files:[MediaItem]
    var id:String { path }
    init?(_ r:[String:Any]) {
        guard let path=r["path"] as? String, DataPath.valid(path) else { return nil }
        self.path=path; name=r["name"] as? String ?? "构件"; kind=r["kind"] as? String ?? "document"
        thumbnail=r["thumbnail"] as? String; files=MediaItem.parse(r["files"])
    }
}
