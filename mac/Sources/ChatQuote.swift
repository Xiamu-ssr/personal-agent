import SwiftUI

struct ChatQuote: Equatable, Hashable {
    let path: String
    let title: String
    let emoji: String
    let source: String
    init?(_ row: [String:Any]) {
        guard row["kind"] as? String == "feed",let path=row["path"] as? String,
              DataPath.valid(path),path.hasPrefix("data/feed/"),let title=row["title"] as? String,!title.isEmpty else { return nil }
        self.path=path;self.title=title;emoji=row["emoji"] as? String ?? "📰";source=row["source"] as? String ?? ""
    }
    init(_ post: FeedPost) {path=post.path;title=post.title;emoji=post.icon;source=post.source}
}

struct QuoteCard: View {
    let quote: ChatQuote
    var remove: (() -> Void)? = nil
    var body: some View {
        HStack(spacing:11) {
            RoundedRectangle(cornerRadius:2).fill(Theme.sub.opacity(0.4)).frame(width:3)
            Text(quote.emoji).font(.system(size:23))
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
    var endpoint: String {quote == nil ? "/api/send" : "/api/feed/feedback"}
    var body: [String:Any] {
        if let quote { return ["path":quote.path,"action":"discuss","text":text,"clientId":clientID] }
        return ["text":text,"attachments":attachments.map(\.json),"clientId":clientID]
    }
}
