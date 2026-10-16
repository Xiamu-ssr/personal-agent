import AppKit
import Observation
import SwiftUI

enum Tab: String, CaseIterable {
    case chat, feed, ideas, goals, library, settings
    var title: String { switch self { case .chat:"聊天"; case .feed:"动态"; case .ideas:"点子"; case .goals:"目标"; case .library:"资源库"; case .settings:"设置" } }
    var icon: String { switch self { case .chat:"bubble.left"; case .feed:"newspaper"; case .ideas:"lightbulb"; case .goals:"checkmark.square"; case .library:"square.grid.2x2"; case .settings:"gearshape" } }
    var prompt: String? { self == .chat ? "消息" : nil }
}
enum Route: Hashable {
    case web(title:String,path:String), doc(title:String,path:String)
    case connectors(tab:Int,focus:String?=nil), connector(String), connectorForm(name:String,accountID:String?)
    case modelProvider(String?)
    case devices, skills, agentSetting(AgentSetting), activity(id:String,title:String), goal(String), memoryItem(title:String,path:String), feedPost(String)
}
@Observable final class Nav {
    static let shared=Nav()
    var tab: Tab = .chat
    var sideChat:SideChatThread?
    var stacks: [Tab:[Route]]=[:]
    var preview: String?
    var toast=""
    var console=false
    var consoleTab=0
    var feedTarget: String?
    var directSending=false
    @ObservationIgnored private var directIdentity=SubmissionIdentity()
    func go(_ t: Tab) { if t == tab { stacks[t]=[] }; tab=t; if t == .chat {sideChat=nil} }
    func openSide(_ thread:SideChatThread) {stacks[.chat]=[]; tab = .chat; sideChat=thread; console=false}
    func push(_ r: Route, in tab: Tab?=nil) { let t=tab ?? self.tab; self.tab=t; stacks[t,default:[]].append(r) }
    func pop() { if !(stacks[tab]?.isEmpty ?? true) { stacks[tab]?.removeLast() } }
    func openConnector(_ name:String,from:Int,focus:String?=nil) { push(.connector(name)) }
    func show(_ s:String) { toast=s; DispatchQueue.main.asyncAfter(deadline:.now()+3) { [weak self] in if self?.toast == s { self?.toast="" } } }
    enum FilePresentation { case image,text,web,external }
    static func filePresentation(_ p:String) -> FilePresentation {
        let ext=(p as NSString).pathExtension.lowercased()
        if ["png","jpg","jpeg","gif","webp","heic","bmp","tiff"].contains(ext) { return .image }
        if ["md","txt","csv","json","log"].contains(ext) { return .text }
        if ["","html","htm","svg","pdf"].contains(ext) { return .web }; return .external
    }
    func open(_ p:String,title:String?=nil,onFailure:(()->Void)?=nil) {
        guard DataPath.valid(p.trimmingCharacters(in:CharacterSet(charactersIn:"/"))) else { show("文件地址不对"); return }
        let title=title ?? ((p as NSString).lastPathComponent as NSString).deletingPathExtension
        switch Self.filePresentation(p) {
        case .image: preview=p
        case .text: push(.doc(title:title,path:p))
        case .web: push(.web(title:title,path:p))
        case .external: Task { @MainActor in do { try await Api.openExternally(p) } catch { if let onFailure { onFailure() } else { show(error.localizedDescription) } } }
        }
    }
    @MainActor func openQuote(_ quote:ChatQuote) {
        stacks[.feed]=[];tab = .feed;console=false
        if FeedStore.shared.items.contains(where:{$0.path == quote.path}) {feedTarget=quote.path}
        else {push(.feedPost(quote.path),in:.feed)}
        AppDelegate.openMain?();MenuController.shared.close()
    }
    func ask(_ s:String) {
        guard !directSending else {return};directSending=true
        let id=directIdentity.id(for:.init(text:s,draftIDs:[],quote:nil))
        Task { @MainActor in
            defer {directSending=false}
            do {try await ChatClient.shared.send(s,clientID:id);directIdentity.clear();stacks[.chat]=[];tab = .chat;sideChat=nil;console=false}
            catch {show(error.localizedDescription)}
        }
    }
}
