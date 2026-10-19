import SwiftUI

struct ChatQuote: Equatable, Hashable {
    let kind: String
    let path: String
    let title: String
    let emoji: String
    let source: String
    let ideaID: String
    let revision: String
    let description: String
    let reply: String
    init?(_ row: [String:Any]) {
        guard let kind=row["kind"] as? String,let title=row["title"] as? String,!title.isEmpty else { return nil }
        let path=row["path"] as? String ?? "",ideaID=row["id"] as? String ?? "",revision=row["revision"] as? String ?? "",reply=row["reply"] as? String ?? ""
        if kind == "feed" {guard DataPath.valid(path),path.hasPrefix("data/feed/") else {return nil}}
        else if kind == "idea" {guard !ideaID.isEmpty,!revision.isEmpty,!reply.isEmpty else {return nil}}
        else {return nil}
        self.kind=kind;self.path=path;self.title=title;emoji=row["emoji"] as? String ?? "";source=row["source"] as? String ?? ""
        self.ideaID=ideaID;self.revision=revision;self.reply=reply;description=row["description"] as? String ?? ""
    }
    init(_ post: FeedPost) {kind="feed";path=post.path;title=post.title;emoji=post.icon;source=post.source;ideaID="";revision="";description="";reply=""}
    init(_ idea:Idea,revision:String,group:String) {kind="idea";path="";title=idea.title;emoji=idea.icon;source=group;ideaID=idea.id;self.revision=revision;description=idea.description;reply=idea.reply}
    var reference:[String:Any] {kind == "feed" ? ["kind":kind,"path":path] : ["kind":kind,"id":ideaID,"revision":revision]}
    var json:[String:Any] {var r=reference;r.merge(["title":title,"emoji":emoji,"source":source]){_,v in v};if kind == "idea" {r["description"]=description;r["reply"]=reply};return r}
}

struct QuoteCard: View {
    let quote: ChatQuote
    var remove: (() -> Void)? = nil
    var body: some View {
        HStack(spacing:11) {
            RoundedRectangle(cornerRadius:2).fill(Theme.sub.opacity(0.4)).frame(width:3)
            Text(quote.emoji.isEmpty ? (quote.kind == "idea" ? "💡" : "📰") : quote.emoji).font(.system(size:23))
            VStack(alignment:.leading,spacing:4) {
                Text(quote.title).font(Theme.font(size:12,weight:.medium)).lineLimit(2)
                if !quote.source.isEmpty {Text(quote.source).font(Theme.font(size:10)).foregroundStyle(Theme.sub).lineLimit(1)}
            }.frame(maxWidth:.infinity,alignment:.leading)
            if let remove {
                Button(action:remove) {Image(systemName:"xmark.circle.fill").foregroundStyle(Theme.sub)}
                    .buttonStyle(.plain).help("取消引用").verificationAction("quote-remove")
            }
        }.padding(11).fixedSize(horizontal:false,vertical:true)
            .background(Theme.field,in:RoundedRectangle(cornerRadius:13)).foregroundStyle(Theme.ink)
    }
}

/// A failed submission keeps its UUID until its content changes or it is acknowledged.
struct SubmissionIdentity {
    struct Content: Equatable {
        let text: String
        let draftIDs: [UUID]
        let quote: ChatQuote?
    }
    private var content: Content?
    private(set) var clientID: String?
    mutating func id(for content: Content) -> String {
        if self.content != content || clientID == nil { self.content=content;clientID=UUID().uuidString }
        return clientID!
    }
    mutating func clear() {content=nil;clientID=nil}
}

struct MessageSubmission {
    let text: String
    let attachments: [Attachment]
    let clientID: String
    let quote: ChatQuote?
    var endpoint: String {"/api/send"}
    var body: [String:Any] {
        var value:[String:Any] = ["text":text,"attachments":attachments.map(\.json),"clientId":clientID]
        if let quote {value["quote"]=quote.reference};return value
    }
}

struct IdeaQuotePage:View {
    let quote:ChatQuote
    var body:some View {SubPage(title:"引用的点子") {
        PageTitle(title:quote.title,subtitle:quote.source)
        if !quote.description.isEmpty {MarkdownView(text:quote.description)}
        SectionTitle(text:"可以这样开始");MarkdownView(text:quote.reply)
    }}
}
