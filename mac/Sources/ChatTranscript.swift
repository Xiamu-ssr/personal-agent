import Foundation
import Observation

/// One conversation's bubbles and option consumption. Main chat and each side chat own an instance.
@Observable final class ChatTranscript {
    private(set) var activityID:String?
    var items:[ChatItem]=[]
    private(set) var revision=0
    var sentRevision=0
    var choosing=Set<String>()
    var error=""
    var hasEarlier=false
    var loadingEarlier=false
    @ObservationIgnored var onLoadEarlier:(()->Void)?
    @ObservationIgnored private var consumed=Set<String>()
    // Presentation measurements belong to this transcript; this cache owns
    // no native views, media players or background page tasks.
    @ObservationIgnored let scrollState=ChatScrollState()
    @ObservationIgnored let layoutCache=ChatLayoutCache()
    init(activityID:String?=nil) { self.activityID=activityID }
    func bind(_ id:String) { precondition(activityID == nil || activityID == id); activityID=id }
    func reset() { items=[]; consumed=[]; choosing=[]; error="";hasEarlier=false;loadingEarlier=false;scrollState.returnToBottom();layoutCache.reset();revision += 1 }
    private func belongs(_ row:[String:Any])->Bool {
        if let activityID { return row["activityId"] as? String == activityID && row["chatType"] as? String == "side" }
        return row["chatType"] as? String != "side"
    }
    func receive(_ row:[String:Any]) {
        guard belongs(row),let item=ChatClient.item(row) else {return}
        upsert(item)
    }
    private func upsert(_ incoming:ChatItem) {
        var item=incoming
        if item.optionsUsed {consumed.insert(item.serverID)}
        item.optionsUsed = item.optionsUsed || consumed.contains(item.serverID)
        if let i=items.firstIndex(where:{$0.serverID == item.serverID}) {
            item.optionsUsed = item.optionsUsed || items[i].optionsUsed;guard item != items[i] else{return};items[i]=item
        } else if !item.clientID.isEmpty,let i=items.firstIndex(where:{$0.kind == item.kind && $0.clientID == item.clientID}) {
            items[i]=item
        } else {items.append(item)}
        revision += 1
    }
    func mergeSnapshot(_ rows:[[String:Any]]) {
        var merged=items,indices=Dictionary(items.enumerated().map{($0.element.serverID,$0.offset)},uniquingKeysWith:{_,new in new})
        for row in rows {
            guard belongs(row),var item=ChatClient.item(row) else{continue}
            if item.optionsUsed {consumed.insert(item.serverID)}
            item.optionsUsed = item.optionsUsed || consumed.contains(item.serverID)
            if let i=indices[item.serverID] {item.optionsUsed = item.optionsUsed || merged[i].optionsUsed;merged[i]=item}
            else {indices[item.serverID]=merged.count;merged.append(item)}
        }
        // A reconnect sends a recent suffix. It must never move that suffix ahead
        // of the older messages already loaded, or publish one change per bubble.
        let ordered=merged.enumerated().sorted {a,b in
            if let x=a.element.ts,let y=b.element.ts,x != y {return x<y}
            return a.offset<b.offset
        }.map(\.element)
        if ordered != items {items=ordered;revision += 1}
    }
    func absorb(_ other:ChatTranscript) {
        consumed.formUnion(other.consumed)
        for item in other.items {upsert(item)}
        for id in consumed {useOptions(id)}
    }
    func useOptions(_ id:String) {
        consumed.insert(id)
        if let i=items.firstIndex(where:{$0.serverID == id}),!items[i].optionsUsed {items[i].optionsUsed=true;revision += 1}
    }
    @MainActor func choose(messageID:String,optionID:String) async {
        guard !consumed.contains(messageID),!choosing.contains(messageID),
              let item=items.first(where:{$0.serverID == messageID}),!item.optionsUsed,
              item.options.contains(where:{$0.id == optionID}) else {return}
        choosing.insert(messageID);defer {choosing.remove(messageID)}
        var body=["messageId":messageID,"optionId":optionID]
        if let activityID {body["activityId"]=activityID}
        do {_ = try await Api.json("/api/options/choose",method:"POST",body:body);useOptions(messageID);error=""}
        catch let e as ApiError where e.code == 409 {useOptions(messageID);error="这组选项已经用过了"}
        catch {self.error=error.localizedDescription}
    }
}
