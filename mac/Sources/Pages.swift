import SwiftUI
struct PageScaffold<Content:View>:View {
    let title:String
    var subtitle=""
    var tab:Tab?=nil
    @ViewBuilder let content:()->Content
    var body:some View {
        ScrollView {
            VStack(alignment:.leading,spacing:24) {
                PageTitle(title:title,subtitle:subtitle).verificationAction("page-title-"+title)
                content()
            }.frame(maxWidth:740,alignment:.leading).padding(.horizontal,40).padding(.top,168).padding(.bottom,38).frame(maxWidth:.infinity)
        }.scrollContentBackground(.hidden)
    }
}
struct SubPage<Content:View,Trailing:View>:View {
    let title:String
    var subtitle=""
    var scrolls=true
    @ViewBuilder var trailing:()->Trailing
    @ViewBuilder let content:()->Content
    var body:some View {
        VStack(spacing:0) {
            HStack { Button { Nav.shared.pop() } label:{ Label("返回",systemImage:"chevron.left") }.buttonStyle(SoftButtonStyle())
                Text(title).font(Theme.font(size:17,weight:.semibold)); Spacer(); trailing()
            }.padding(.horizontal,32).padding(.top,24).padding(.bottom,22)
            if scrolls { ScrollView { VStack(alignment:.leading,spacing:22) {
                if !subtitle.isEmpty { Text(subtitle).font(Theme.font(size:13)).foregroundStyle(Theme.sub) }; content()
            }.frame(maxWidth:760,alignment:.leading).padding(.horizontal,36).padding(.bottom,32).frame(maxWidth:.infinity) } }
            else { content() }
        }
    }
}
extension SubPage where Trailing == EmptyView {
    init(title:String,subtitle:String="",scrolls:Bool=true,@ViewBuilder content:@escaping ()->Content) {
        self.init(title:title,subtitle:subtitle,scrolls:scrolls,trailing:{EmptyView()},content:content)
    }
}
struct RouteView:View {
    let route:Route
    var body:some View {
        switch route {
        case .web(let t,let p):WebRoute(title:t,path:p)
        case .doc(let t,let p):DocRoute(title:t,path:p)
        case .connectors(let t,let f):ConnectorsPage(initialTab:t,focus:f)
        case .connector(let n):ConnectorDetailPage(name:n)
        case .connectorForm(let n,let a):ConnectorFormPage(name:n,accountID:a)
        case .devices:DevicesPage()
        case .skills:SkillsPage()
        case .agentSetting(let s):AgentSettingPage(setting:s)
        case .modelProvider(let id):ModelProviderFormPage(providerID:id)
        case .activity(let id,let t):ActivityPage(id:id,title:t)
        case .goal(let n):GoalDetailPage(name:n)
        case .feedPost(let p):FeedPostDetailPage(path:p)
        case .memoryItem(let t,let p):
            if p == "data/health/days.json" { HealthMemoryPage() } else { MemoryEditor(title:t,path:p) }
        }
    }
}
struct WebRoute:View {
    let title:String
    let path:String
    @State private var loading=true
    @State private var failed=""
    var body:some View {
        SubPage(title:title,scrolls:false,trailing:{
            if loading { ActiveProgress().controlSize(.small) }
        },content:{
            ZStack { WebPage(path:path,loading:$loading,failed:$failed)
                if !failed.isEmpty { Note(text:failed,icon:"exclamationmark.triangle").card() }
            }.padding(.horizontal,24).padding(.bottom,24)
        })
    }
}
struct DocRoute:View {
    let title:String
    let path:String
    @State private var text:String?
    @State private var error=""
    var body:some View {
        SubPage(title:title) {
            if let text { MarkdownView(text:text,size:15).textSelection(.enabled).frame(maxWidth:.infinity,alignment:.leading).card(padding:24) }
            else { Note(text:error.isEmpty ? "加载中…" : error) }
        }.task(id:"\(path)-\(ChatClient.shared.filesVersion)") {
            do { text=try await Api.text(path) } catch { self.error=error.localizedDescription }
        }
    }
}
