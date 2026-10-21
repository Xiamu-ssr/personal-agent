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
    @ObservationIgnored private var consumed=Set<String>()
    init(activityID:String?=nil) { self.activityID=activityID }
    func bind(_ id:String) { precondition(activityID == nil || activityID == id); activityID=id }
    func reset() { items=[]; consumed=[]; choosing=[]; error="";revision += 1 }
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
        for row in rows {receive(row)}
        let order=Dictionary(rows.enumerated().compactMap { i,row in (row["id"] as? String).map {($0,i)} },uniquingKeysWith:{_,new in new})
        // The server owns write order. Events newer than this snapshot stay after its rows.
        items=items.enumerated().sorted { a,b in
            let x=order[a.element.serverID],y=order[b.element.serverID]
            if let x,let y {return x<y}; if x != nil {return true};if y != nil {return false};return a.offset<b.offset
        }.map(\.element)
        revision += 1
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
