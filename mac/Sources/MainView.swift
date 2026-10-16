import SwiftUI

struct MainView:View {
    private var nav:Nav { .shared }
    @Environment(\.openWindow) private var openWindow
    @Environment(\.colorScheme) private var systemScheme
    @State private var activity=WindowActivity()
    @State private var dropping=false
    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            if Session.shared.configured {
                HStack(spacing:0) {
                    Sidebar()
                    Rectangle().fill(Theme.line).frame(width:1)
                    content.frame(maxWidth:.infinity,maxHeight:.infinity)
                        .overlay(alignment:.top) {
                            if nav.stacks[nav.tab]?.isEmpty != false {AvatarHeader(sideChat:nav.tab == .chat && nav.sideChat != nil).padding(.top,14)}
                        }
                        .onDrop(of:[.fileURL,.image],isTargeted:$dropping) { (nav.tab == .chat ? nav.sideChat?.composer ?? .shared : .shared).drop($0) }
                        .overlay { if dropping { RoundedRectangle(cornerRadius:20).strokeBorder(Theme.ink,style:StrokeStyle(lineWidth:2,dash:[6])).padding(18).allowsHitTesting(false) } }
                }
            } else { LoginView() }
            if let p=nav.preview { ImagePreview(path:p) }
            if !nav.toast.isEmpty {
                VStack { Spacer(); Text(nav.toast).font(Theme.font(size:13)).padding(14).background(Theme.card,in:Capsule()).padding(.bottom,80) }.allowsHitTesting(false)
            }
        }
        .frame(minWidth:920,minHeight:650).foregroundStyle(Theme.ink).font(Theme.font(size:15))
        .preferredColorScheme(Theme.scheme).tint(Theme.ink)
        .background(WindowActivityReader(activity:activity).frame(width:0,height:0))
        .environment(\.interactiveWindow,activity.active)
        .sheet(isPresented:Binding(get:{nav.console},set:{nav.console=$0})) { ConsoleView() }
        .onChange(of:activity.active) { if activity.active {Task {await ChatClient.shared.catchUp()}} }
        .onAppear {
            AppDelegate.openMain={openWindow(id:"main")}
            AppearanceStore.shared.systemDark=systemScheme == .dark
        }
        .onChange(of:systemScheme) { _,v in if AppearanceStore.shared.selection == .system { AppearanceStore.shared.systemDark=v == .dark } }
    }
    @ViewBuilder private var content:some View {
        if let route=nav.stacks[nav.tab]?.last { RouteView(route:route).id(route) }
        else {
            switch nav.tab {
            case .chat: ChatPage(thread:nav.sideChat).id(nav.sideChat?.id)
            case .feed: FeedPage()
            case .ideas: IdeasPage()
            case .goals: GoalsPage()
            case .library: LibraryPage()
            case .settings: SettingsPage()
            }
        }
    }
}
struct Sidebar:View {
    private var nav:Nav { .shared }
    private var side:SideChats { .shared }
    var body:some View {
        VStack(alignment:.leading,spacing:7) {
            Button { nav.console=true } label: {
                HStack(spacing:11) { AgentAvatar(size:42); VStack(alignment:.leading,spacing:4) {
                    Text(ProfileStore.shared.agentName).font(Theme.font(size:15,weight:.semibold))
                    Text(ChatClient.shared.connected ? "你的个人助手" : "连接中…").font(Theme.font(size:11)).foregroundStyle(Theme.sub)
                }; Spacer() }
            }.buttonStyle(.plain).padding(.vertical,24).padding(.horizontal,10)
            ForEach([Tab.chat,.feed,.ideas,.goals,.library],id:\.self) { t in
                Button { nav.go(t) } label: {
                    HStack(spacing:13) { Image(systemName:t.icon).font(.system(size:18)).frame(width:23)
                        Text(t.title).font(Theme.font(size:14,weight:nav.tab == t && (t != .chat || nav.sideChat == nil) ? .semibold : .regular)); Spacer()
                        if t == .feed && FeedBadge.shared.unread { Circle().fill(.red).frame(width:6,height:6).accessibilityLabel("有新动态") }
                    }.padding(.horizontal,13).frame(height:43).background(nav.tab == t && (t != .chat || nav.sideChat == nil) ? Theme.card : .clear,in:RoundedRectangle(cornerRadius:12)).contentShape(Rectangle())
                }.buttonStyle(.plain).verificationAction("tab-"+t.rawValue)
            }
            HStack { Text("旁聊").font(Theme.font(size:11,weight:.medium)).foregroundStyle(Theme.sub); Spacer()
                Button { nav.openSide(SideChatThread()) } label:{ Image(systemName:"square.and.pencil") }.buttonStyle(.plain).help("新建旁聊").verificationAction("new-side-chat")
            }.padding(.top,28).padding(.horizontal,14).padding(.bottom,5)
            ScrollView {
                VStack(alignment:.leading,spacing:6) {
                    if side.items.isEmpty { Text("单独聊的话题会出现在这里").font(Theme.font(size:11)).foregroundStyle(Theme.sub).padding(.horizontal,14).padding(.top,6) }
                    ForEach(side.items) { s in Button { nav.openSide(side.thread(s.id)) } label: {
                        Text(s.title).font(Theme.font(size:12)).lineLimit(1).frame(maxWidth:.infinity,alignment:.leading).padding(12).background(nav.sideChat?.activityID == s.id && nav.tab == .chat ? Theme.card : .clear,in:RoundedRectangle(cornerRadius:12)).contentShape(Rectangle())
                    }.buttonStyle(.plain).verificationAction("side-chat-"+s.id) }
                    if side.next != nil {Button("更早的旁聊"){Task {await side.load(reset:false)}}.buttonStyle(.plain).font(Theme.font(size:11)).padding(12).disabled(side.loading).task(id:side.next){await side.load(reset:false)}}
                    if !side.error.isEmpty {Button("旁聊加载失败，重试"){Task {await side.load()}}.buttonStyle(.plain).font(Theme.font(size:11)).padding(12)}
                }
            }
            Spacer(minLength:8)
            Button { nav.go(.settings) } label:{ Label("设置",systemImage:"gearshape").font(Theme.font(size:13)).frame(maxWidth:.infinity,alignment:.leading).padding(14) }.buttonStyle(.plain)
        }.padding(.horizontal,12).padding(.top,12).padding(.bottom,12).frame(width:214).background(Theme.sidebar)
        .task(id:ChatClient.shared.jobsVersion) { await side.load() }
    }
}
struct ImagePreview:View {
    let path:String
    var body:some View {
        ZStack { Color.black.opacity(0.8).ignoresSafeArea().onTapGesture { Nav.shared.preview=nil }
            RemoteImage(path:path,maxSide:850).padding(40)
            VStack { HStack { Spacer(); CircleIconButton(icon:"xmark",help:"关闭") { Nav.shared.preview=nil } }; Spacer() }.padding(24)
        }
    }
}
