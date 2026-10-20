import SwiftUI
struct ConsoleView:View {
    @Environment(\.dismiss) private var dismiss
    var body:some View {
        VStack(spacing:18) {
            HStack { Spacer(); CircleIconButton(icon:"xmark",help:"关闭控制台") { dismiss() } }.padding(.horizontal,24).padding(.top,20)
            VStack(spacing:7) { AgentAvatar(size:84); Text(ProfileStore.shared.agentName).font(Theme.font(size:20,weight:.semibold))
                if ChatClient.shared.avatarState == .working { Text(ChatClient.shared.avatarText.isEmpty ? "努力工作中" : ChatClient.shared.avatarText).font(Theme.font(size:12)).foregroundStyle(Theme.sub) }
            }
            PillTabs(titles:["活动","设备","定时","记忆"],selection:Binding(get:{Nav.shared.consoleTab},set:{Nav.shared.consoleTab=$0})).padding(6).background(Theme.card,in:Capsule())
            Group {
                switch Nav.shared.consoleTab { case 0: ActivityListView(); case 1: ComputerPanel(); case 2: SchedulesPanel(); default: MemoryPanel() }
            }.frame(maxWidth:.infinity,maxHeight:.infinity)
            HStack { if !ChatClient.shared.connected { Text("连接中…").font(Theme.font(size:12)).foregroundStyle(Theme.sub) }; Spacer()
                Button { if Nav.shared.tab == .chat,let side=Nav.shared.sideChat {Task {await side.stop()}} else {ChatClient.shared.interrupt()} } label:{ Label("停止当前回复",systemImage:"stop.fill") }.buttonStyle(PrimaryButtonStyle(height:34)).disabled(!(Nav.shared.tab == .chat && Nav.shared.sideChat != nil ? Nav.shared.sideChat?.status == "running" : ChatClient.shared.busy)).opacity((Nav.shared.tab == .chat && Nav.shared.sideChat != nil ? Nav.shared.sideChat?.status == "running" : ChatClient.shared.busy) ? 1 : 0.35)
            }.padding(.horizontal,26).padding(.bottom,20)
        }.frame(width:740,height:710).background(Theme.background).foregroundStyle(Theme.ink).preferredColorScheme(Theme.scheme).tint(Theme.ink)
    }
}
struct ActivityListView:View {
    private var store:ActivityListStore {.shared}
    @Environment(\.interactiveWindow) private var active
    private var days:[String] {
        var seen=Set<String>();return store.recent.map {day($0.time)}.filter {seen.insert($0).inserted}
    }
    private func day(_ date:Date?)->String {
        guard let date else {return "更早"}
        let calendar=Calendar.current
        if calendar.isDateInToday(date) {return "今天"}
        if calendar.isDateInYesterday(date) {return "昨天"}
        let f=DateFormatter();f.locale=Locale(identifier:"zh_CN");f.dateFormat=calendar.component(.year,from:date) == calendar.component(.year,from:Date()) ? "M月d日" : "yyyy年M月d日"
        return f.string(from:date)
    }
    var body:some View {
        ScrollView {LazyVStack(alignment:.leading,spacing:6) {
            if !store.running.isEmpty {heading("进行中");ForEach(store.running) {ActivityRow(item:$0)}}
            ForEach(days,id:\.self) {day in
                heading(day)
                ForEach(store.recent.filter {self.day($0.time) == day}) {ActivityRow(item:$0)}
            }
            if store.running.isEmpty && store.recent.isEmpty {Note(text:store.loading ? "加载中…" : store.error.isEmpty ? "今天还没有活动" : store.error)}
            if store.next != nil {Button("更早的活动") {Task {await store.load(reset:false)}}.buttonStyle(SoftButtonStyle()).disabled(store.loading)}
            if !store.error.isEmpty && !store.recent.isEmpty {Note(text:store.error)}
        }.padding(.horizontal,28).padding(.top,8)}
        .task(id:"\(ChatClient.shared.jobsVersion)-\(active)") {await store.load()}
    }
    private func heading(_ title:String)->some View {Text(title).font(Theme.font(size:12,weight:.medium)).foregroundStyle(Theme.sub).padding(.top,8).padding(.bottom,6)}
}
struct ActivityRow:View {
    let item:ActivitySummary
    @State private var hovering=false
    var body:some View {
        Button {Nav.shared.console=false;Nav.shared.push(.activity(id:item.id,title:item.title))} label:{
            HStack(alignment:.top,spacing:13) {
                Image(systemName:item.status == "running" ? "circle.dotted" : item.chatType == "side" ? "bubble.left.and.bubble.right" : "circle.hexagongrid.fill")
                    .font(.system(size:15,weight:.medium)).foregroundStyle(Theme.sub)
                    .frame(width:32,height:32).background(Theme.field,in:Circle()).padding(.top,3)
                VStack(alignment:.leading,spacing:4) {
                    Text(item.title).font(Theme.font(size:14,weight:.semibold)).foregroundStyle(Theme.ink).lineLimit(1).verificationAction("activity-title-"+item.id)
                    Text(item.summary.isEmpty ? " " : item.summary).font(Theme.font(size:12)).foregroundStyle(Theme.sub).lineLimit(1).truncationMode(.tail).verificationAction("activity-summary-"+item.id)
                    HStack(spacing:6) {
                        if let time=item.time {Text(Fmt.hm.string(from:time))}
                        if item.status != "done" {Text(item.label)}
                    }.font(Theme.font(size:11)).foregroundStyle(Theme.faint)
                }.frame(maxWidth:.infinity,alignment:.leading)
            }.padding(.horizontal,8).padding(.vertical,10).contentShape(Rectangle())
                .background(hovering ? Theme.field : .clear,in:RoundedRectangle(cornerRadius:12))
        }.buttonStyle(.plain).onHover {hovering=$0}.verificationAction("activity-row-"+item.id)
    }
}
struct ComputerPanel:View {
    var body:some View {
        ScrollView { VStack(alignment:.leading,spacing:20) {
            Text("在线设备").font(Theme.titleFont(18))
            ForEach(ConnectorStore.shared.devices.filter(\.online)) { d in
                ListRow(icon:d.icon,title:d.name,subtitle:d.caps.filter(\.enabled).map(\.title).joined(separator:"、"),action:{ Nav.shared.console=false; Nav.shared.push(.devices) })
            }
            if ConnectorStore.shared.devices.filter(\.online).isEmpty { Note(text:"还没有在线设备") }
        }.padding(28) }.task { await ConnectorStore.shared.load() }
    }
}
struct SchedulesPanel:View {
    @State private var rows:[[String:Any]]=[]
    @State private var error=""
    @State private var working=Set<String>()
    var body:some View {
        ScrollView { VStack(alignment:.leading,spacing:12) {
            ForEach(Array(rows.enumerated()),id:\.offset) { _,r in
                let id=r["id"] as? String ?? ""
                HStack(spacing:12) {
                    VStack(alignment:.leading,spacing:6) {
                        Text(r["name"] as? String ?? id).font(Theme.font(size:14,weight:.medium))
                        Text(scheduleText(r)).font(Theme.font(size:12)).foregroundStyle(Theme.sub)
                        if let d=ProductTime.date(r["nextRun"]) { Text("下次 · "+Fmt.when(d)).font(Theme.font(size:11)).foregroundStyle(Theme.sub) }
                    }; Spacer()
                    Button(r["running"] as? Bool == true ? "进行中" : "立即运行") { update(id,run:true) }.buttonStyle(SoftButtonStyle()).disabled(working.contains(id) || r["running"] as? Bool == true)
                    Toggle("启用",isOn:Binding(get:{r["enabled"] as? Bool ?? false},set:{update(id,enabled:$0)})).labelsHidden().toggleStyle(.switch).disabled(working.contains(id))
                }.card(radius:16,padding:18)
            }
            if !error.isEmpty { Note(text:error) }
        }.padding(.horizontal,28).padding(.top,8) }.task(id:ChatClient.shared.jobsVersion) { await load() }
    }
    private func scheduleText(_ r:[String:Any])->String {
        if r["id"] as? String == "feed" { return "每 \(r["interval"] as? Int ?? 30) 分钟 · \(r["start"] as? String ?? "07:00")–\(r["end"] as? String ?? "23:00")" }
        return r["cron"] as? String ?? "按约定跟进"
    }
    private func load() async { do { rows=try await Api.json("/api/schedules")["items"] as? [[String:Any]] ?? []; error="" } catch { self.error=error.localizedDescription } }
    private func update(_ id:String,enabled:Bool?=nil,run:Bool=false) {
        working.insert(id); Task { defer {working.remove(id)}; do { _ = try await Api.json("/api/schedules/"+Api.query(id)+(run ? "/run" : ""),method:run ? "POST" : "PUT",body:enabled.map {["enabled":$0]}); await load() } catch { self.error=error.localizedDescription } }
    }
}
struct MemoryPanel:View {
    @State private var data:[String:Any]=[:]
    @State private var error=""
    var body:some View {
        ScrollView { VStack(alignment:.leading,spacing:20) {
            VStack(alignment:.leading,spacing:12) {
                Text("OpenClaw 记忆").font(Theme.titleFont(20))
                memoryLink("豆豆的人格",path:"SOUL.md",icon:"person.crop.circle")
                ForEach(Array((data["items"] as? [[String:Any]] ?? []).enumerated()),id:\.offset) { _,i in
                    memoryLink(i["name"] as? String ?? "记忆",path:i["path"] as? String ?? "",icon:"doc.text")
                }
                memoryLink("健康 · 只读",path:"data/health/days.json",icon:"heart")
            }.card(radius:20,padding:22)
            if !error.isEmpty { Note(text:error) }
        }.padding(28) }.task(id:ChatClient.shared.filesVersion) { do { data=try await Api.json("/api/memory") } catch { self.error=error.localizedDescription } }
    }
    private func memoryLink(_ title:String,path:String,icon:String)->some View {
        ListRow(icon:icon,title:title,action:{Nav.shared.console=false; Nav.shared.push(.memoryItem(title:title,path:path))})
    }
}
struct MemoryEditor:View {
    let title:String
    let path:String
    @State private var text=""
    @State private var readOnly=true
    @State private var editing=false
    @State private var loaded=false
    @State private var saving=false
    @State private var error=""
    var body:some View {
        SubPage(title:title,trailing:{
            if loaded && !readOnly { Button(editing ? "保存" : "编辑") {
                if editing { save() } else { editing=true }
            }.buttonStyle(SoftButtonStyle()).disabled(saving) }
        },content:{
            if editing { TextEditor(text:$text).font(Theme.font(size:14)).frame(minHeight:450).scrollContentBackground(.hidden).padding(15).background(Theme.card,in:RoundedRectangle(cornerRadius:18)) }
            else if loaded { MarkdownView(text:text,size:14).textSelection(.enabled).card(padding:24) }
            if !error.isEmpty { Note(text:error) }
        }).task(id:path) {
            do { let r=try await Api.json("/api/memory/item?path="+Api.query(path)); text=r["text"] as? String ?? ""; readOnly=r["readOnly"] as? Bool ?? true; loaded=true } catch { self.error=error.localizedDescription }
        }
    }
    private func save() { guard !readOnly else {return}; saving=true; Task { defer {saving=false}; do { _ = try await Api.json("/api/memory/item?path="+Api.query(path),method:"PUT",body:["text":text]); editing=false; ChatClient.shared.filesVersion += 1 } catch {self.error=error.localizedDescription} } }
}

struct HealthMemoryPage:View {
    @State private var data:[String:Any]=[:]
    @State private var loading=false
    @State private var error=""
    var body:some View {
        SubPage(title:"健康",subtitle:"手机同步的数据，豆豆只读不改",trailing:{
            Button(loading ? "同步中…" : "同步") { Task { await load(sync:true) } }.buttonStyle(SoftButtonStyle()).disabled(loading)
        },content:{
            if let note=data["note"] as? String,!note.isEmpty { Text(note).font(Theme.font(size:13)).foregroundStyle(Theme.sub) }
            ForEach(Array((data["days"] as? [[String:Any]] ?? []).enumerated()),id:\.offset) { _,day in
                VStack(alignment:.leading,spacing:12) {
                    Text(day["date"] as? String ?? "").font(Theme.font(size:15,weight:.medium))
                    HStack(spacing:25) {
                        metric("步数",day["steps"],unit:"步")
                        metric("睡眠",day["sleepMinutes"],unit:"分钟")
                        metric("静息心率",day["restingHr"],unit:"次/分")
                        metric("HRV",day["hrv"],unit:"毫秒")
                    }
                }.card(radius:18,padding:20)
            }
            if !error.isEmpty { Note(text:error) }
        }).task { await load(sync:false) }
    }
    private func metric(_ title:String,_ value:Any?,unit:String)->some View {
        VStack(alignment:.leading,spacing:7) { Text(title).font(Theme.font(size:11)).foregroundStyle(Theme.sub)
            Text((value as? NSNumber).map { $0.stringValue } ?? "--").font(Theme.font(size:21,weight:.medium)).monospacedDigit()
            Text(unit).font(Theme.font(size:10)).foregroundStyle(Theme.sub)
        }.frame(maxWidth:.infinity,alignment:.leading)
    }
    private func load(sync:Bool) async { guard !loading else {return};loading=true;defer{loading=false}; do { data=try await Api.json(sync ? "/api/health/sync" : "/api/health",method:sync ? "POST":"GET");error="" } catch {self.error=error.localizedDescription} }
}
