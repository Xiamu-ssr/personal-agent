import Foundation
import Observation
import CryptoKit

struct Attachment: Hashable {
    var path: String
    var name: String
    var kind: String
    var size: Int? = nil
    var transcript: String? = nil
    var json: [String: Any] { ["path":path,"name":name,"kind":kind] }
    init(path: String, name: String, kind: String, size: Int? = nil, transcript: String? = nil) {
        self.path=path; self.name=name; self.kind=kind; self.size=size; self.transcript=transcript
    }
    init(_ row: [String: Any]) {
        path=row["path"] as? String ?? ""; name=row["name"] as? String ?? (path as NSString).lastPathComponent
        kind=row["kind"] as? String ?? "file"; size=row["size"] as? Int; transcript=row["transcript"] as? String
    }
}
struct MediaItem: Hashable, Identifiable {
    enum Kind: String { case image, video, audio, file }
    let path: String
    let name: String
    let kind: Kind
    let mime: String
    let size: Int
    var id: String { path }
    init?(_ row: [String: Any]) {
        guard let path=row["path"] as? String, DataPath.valid(path) else { return nil }
        self.path=path; name=row["name"] as? String ?? (path as NSString).lastPathComponent
        kind=Kind(rawValue: row["kind"] as? String ?? "") ?? .file
        mime=row["mime"] as? String ?? "application/octet-stream"; size=max(0,row["size"] as? Int ?? 0)
    }
    static func parse(_ value: Any?) -> [MediaItem] { (value as? [[String:Any]] ?? []).compactMap(MediaItem.init) }
}
enum DataPath {
    static func valid(_ path: String) -> Bool {
        path.hasPrefix("data/") && !path.contains("\\") && !path.contains("\0") && !path.split(separator:"/", omittingEmptySubsequences:false).contains(where: { $0 == ".." || $0 == "." || $0.isEmpty })
    }
    static func http(_ text: String) -> URL? {
        guard let u=URL(string:text), ["http","https"].contains(u.scheme?.lowercased() ?? ""), u.host != nil, u.user == nil, u.password == nil else { return nil }; return u
    }
}
struct SayOption: Equatable, Identifiable {
    let id: String
    let label: String
    let reply: String
    init?(_ row: [String:Any]) {
        guard let id=row["id"] as? String, let label=row["label"] as? String, !id.isEmpty, !label.isEmpty else { return nil }
        self.id=id; self.label=label; reply=row["reply"] as? String ?? label
    }
}
enum SayCard: Equatable {
    case connector(String), goal(String), link(url:String,title:String,description:String,image:String?)
    case media(type: MediaItem.Kind,path:String,name:String), browser, device(String?)
    init?(_ r: [String:Any]) {
        switch r["type"] as? String {
        case "connector": guard let s=r["id"] as? String, !s.isEmpty else { return nil }; self = .connector(s)
        case "goal": guard let s=r["name"] as? String, !s.isEmpty, !s.contains("/"), !s.contains("\\") else { return nil }; self = .goal(s)
        case "link": guard let s=r["url"] as? String, DataPath.http(s) != nil else { return nil }
            let image=(r["image"] as? String).flatMap { DataPath.http($0) == nil ? nil : $0 }
            self = .link(url:s,title:r["title"] as? String ?? s,description:r["description"] as? String ?? "",image:image)
        case "image","video","audio","file":
            guard let s=r["path"] as? String, DataPath.valid(s), let k=MediaItem.Kind(rawValue:r["type"] as? String ?? "") else { return nil }
            self = .media(type:k,path:s,name:r["name"] as? String ?? (s as NSString).lastPathComponent)
        case "browser": self = .browser
        case "device": self = .device(r["capability"] as? String)
        default: return nil
        }
    }
    var mediaPath: String? { if case .media(_,let p,_) = self { return p }; return nil }
}
struct ChatItem: Identifiable, Equatable {
    enum Kind: Equatable { case user, assistant }
    var id = UUID()
    let kind: Kind
    var text: String
    var attachments: [Attachment] = []
    var media: [MediaItem] = []
    var ts: Date? = nil
    var pending = false
    var source = ""
    var serverID = ""
    var options: [SayOption] = []
    var optionsUsed = false
    var cards: [SayCard] = []
    var activityID = ""
    var visible: Bool { source != "onboarding" && (!text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty || !attachments.isEmpty || !cards.isEmpty || !media.isEmpty || !options.isEmpty) }
    var visibleMedia: [MediaItem] {
        var seen=Set(cards.compactMap(\.mediaPath)); return media.filter { seen.insert($0.path).inserted }
    }
}
enum AvatarState: String, CaseIterable { case idle, working, waiting, happy, error }
struct BackgroundActivity: Identifiable, Equatable {
    let id: String
    var description: String
    var startedAt: Date
}
@Observable final class FeedBadge {
    static let shared=FeedBadge()
    var unread = Prefs.uiDefaults.bool(forKey:"feedUnread")
    var viewing = false
    func receive() { unread = !viewing; Prefs.uiDefaults.set(unread,forKey:"feedUnread") }
    func enter() { viewing=true; unread=false; Prefs.uiDefaults.set(false,forKey:"feedUnread") }
    func leave() { viewing=false }
}
@Observable final class ChatClient {
    static let shared=ChatClient()
    let transcript=ChatTranscript()
    var items:[ChatItem] { get {transcript.items} set {transcript.items=newValue} }
    var busy=false
    var connected=false
    var configured = LocalVerification.explicitLoopback || Prefs.configured
    var error=""
    var sentRevision:Int {transcript.sentRevision}
    var filesVersion=0
    var jobsVersion=0
    var devicesVersion=0
    var settingsVersion=0
    var feedVersion=0
    var avatarState: AvatarState = .idle
    var avatarText=""
    var backgroundActivities: [BackgroundActivity]=[]
    var choosing:Set<String> { get {transcript.choosing} set {transcript.choosing=newValue} }
    @ObservationIgnored private let socket=Socket(role:"app")
    @ObservationIgnored private var sender: (([String:Any])->Bool)?
    @ObservationIgnored private var revision=0
    @ObservationIgnored private var avatarRevision=0
    @ObservationIgnored private var booting=false
    @ObservationIgnored private var refresh: Task<Void,Never>?
    init(sender: (([String:Any])->Bool)?=nil) {
        self.sender=sender
        socket.onOpen = { [weak self] in self?.connected=true; self?.error="" }
        socket.onClose = { [weak self] why in self?.connected=false; self?.error=why ?? "连接已断开，正在重连" }
        socket.onMessage = { [weak self] in self?.handle($0) }
    }
    func start() { configured=LocalVerification.explicitLoopback || Prefs.configured; socket.start() }
    func reconnect() { revision += 1; refresh?.cancel(); socket.stop(); connected=false; start() }
    func stop() {
        revision += 1; refresh?.cancel(); socket.stop(); connected=false; configured=false
        transcript.reset(); SideChats.shared.reset(); Nav.shared.sideChat=nil; busy=false; backgroundActivities=[]; error=""; avatarState = .idle
    }
    private func transmit(_ row: [String:Any]) -> Bool { sender?(row) ?? socket.send(row) }
    @discardableResult func send(_ text: String, attachments: [Attachment]=[]) -> Bool {
        guard !text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty || !attachments.isEmpty else { return false }
        guard transmit(["t":"send","text":text,"attachments":attachments.map(\.json)]) else { error="还没连上，稍等再发"; return false }
        transcript.appendUser(text,attachments:attachments)
        error=""; return true
    }
    func interrupt() { if !transmit(["t":"interrupt"]) { error="还没连上，无法停止" } }
    @MainActor func choose(messageID:String,optionID:String) async {
        await transcript.choose(messageID:messageID,optionID:optionID)
        if !transcript.error.isEmpty {error=transcript.error}
    }
    func useOptions(_ id:String) {transcript.useOptions(id)}
    static func item(_ r: [String:Any]) -> ChatItem? {
        guard let role=r["role"] as? String, ["user","assistant"].contains(role), let id=r["id"] as? String, !id.isEmpty else { return nil }
        // Stable IDs prevent history refills from jumping or duplicating the UI.
        let hash=Array(SHA256.hash(data:Data(id.utf8)).prefix(16))
        let uuid=hash.withUnsafeBytes { UUID(uuid:$0.loadUnaligned(as:uuid_t.self)) }
        return ChatItem(id:uuid,kind:role == "user" ? .user : .assistant,text:r["text"] as? String ?? "",
                        attachments:(r["attachments"] as? [[String:Any]] ?? []).map(Attachment.init),media:MediaItem.parse(r["media"]),
                        ts:ProductTime.date(r["ts"]),source:r["source"] as? String ?? "",serverID:id,
                        options:(r["options"] as? [[String:Any]] ?? []).compactMap(SayOption.init),optionsUsed:r["optionsUsed"] as? Bool ?? false,
                        cards:(r["cards"] as? [[String:Any]] ?? []).compactMap(SayCard.init),activityID:r["activityId"] as? String ?? "")
    }
    private func upsert(_ row:[String:Any],final:Bool=true) {transcript.receive(row,final:final)}
    @MainActor func bootstrap() async {
        guard !booting else { return }; booting=true; defer { booting=false }
        let version=revision, avatarVersion=avatarRevision
        do {
            async let state=Api.json("/api/state")
            async let history=Api.json("/api/history?n=200")
            let (s,h)=try await (state,history)
            guard version == revision, !Task.isCancelled else { return }
            ProfileStore.shared.applyState(s)
            if avatarVersion == avatarRevision, let a=s["avatar"] as? [String:Any] { applyAvatar(a) }
            // Do not overwrite a newer websocket busy/avatar state with an older HTTP snapshot.
            if !connected { busy=s["busy"] as? Bool ?? false }
            for r in h["items"] as? [[String:Any]] ?? [] { upsert(r) }
            items.sort { ($0.ts ?? .distantPast) < ($1.ts ?? .distantPast) }
            if s["chatEmpty"] as? Bool == true, items.isEmpty {
                _ = try await Api.json("/api/first-chat",method:"POST",body:["device":"mac"])
            }
            error=""
        } catch is CancellationError {} catch { self.error=error.localizedDescription }
    }
    private func applyAvatar(_ r: [String:Any]) {
        avatarRevision += 1
        avatarState=AvatarState(rawValue:r["state"] as? String ?? "") ?? .idle
        avatarText=r["text"] as? String ?? ""
    }
    func handle(_ r: [String:Any]) {
        switch r["t"] as? String {
        case "hello":
            revision += 1; connected=true; busy=r["busy"] as? Bool ?? false
            for h in r["history"] as? [[String:Any]] ?? [] { upsert(h) }
            if let a=r["avatar"] as? [String:Any] { applyAvatar(a) }
            devicesVersion += 1; jobsVersion += 1
            refresh?.cancel(); refresh=Task { @MainActor [weak self] in await self?.bootstrap() }
        case "user","say":
            var row=r; row["role"] = r["t"] as? String == "user" ? "user" : "assistant"; upsert(row)
        case "delta":
            if let id=r["id"] as? String,let text=r["text"] as? String {transcript.delta(id:id,text:text)}
        case "activity_message": SideChats.shared.receive(r); jobsVersion += 1
        case "options_used":
            if r["chatType"] as? String == "side",let id=r["activityId"] as? String {SideChats.shared.thread(id).transcript.useOptions(r["messageId"] as? String ?? "")}
            else {useOptions(r["messageId"] as? String ?? "")}
        case "status": busy=r["busy"] as? Bool ?? false
        case "avatar": applyAvatar(r)
        case "turn_end": if let e=r["error"] as? String { error=e } // Signal only: never another bubble.
        case "activity","activity_step","activity_stop": SideChats.shared.activity(r); jobsVersion += 1
        case "background_activities":
            if r["phase"] as? String == "snapshot" {
                var byID: [String:BackgroundActivity]=[:]
                for a in r["items"] as? [[String:Any]] ?? [] {
                    if let id=a["id"] as? String { byID[id]=BackgroundActivity(id:id,description:a["description"] as? String ?? "后台活动",startedAt:ProductTime.date(a["startedAt"]) ?? Date()) }
                }
                backgroundActivities=byID.values.sorted { $0.startedAt < $1.startedAt }
            } else if let id=r["id"] as? String {
                let patch=r["patch"] as? [String:Any] ?? [:]
                let status=patch["status"] as? String ?? r["status"] as? String ?? ""
                if r["phase"] as? String == "notification" || ["done","completed","failed","stopped","error"].contains(status) { backgroundActivities.removeAll { $0.id == id } }
                else if let i=backgroundActivities.firstIndex(where: { $0.id == id }) { backgroundActivities[i].description=patch["description"] as? String ?? r["description"] as? String ?? backgroundActivities[i].description }
                else if r["phase"] as? String == "started" { backgroundActivities.append(BackgroundActivity(id:id,description:r["description"] as? String ?? "后台活动",startedAt:ProductTime.date(r["startedAt"]) ?? Date())) }
            }; jobsVersion += 1
        case "feed_new": FeedBadge.shared.receive(); feedVersion += 1
        case "feed_settings": feedVersion += 1
        case "files_changed","memory_updated":
            filesVersion += 1
            if (r["path"] as? String ?? "").hasPrefix("data/soul/") || r["t"] as? String == "memory_updated" {
                Task { @MainActor in await ProfileStore.shared.load() }
            }
        case "devices","connectors_changed": devicesVersion += 1
        case "settings": settingsVersion += 1
        case "error": error=r["error"] as? String ?? "操作失败"; choosing=[]
        default: break
        }
    }
}
