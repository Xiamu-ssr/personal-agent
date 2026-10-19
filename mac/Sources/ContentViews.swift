import SwiftUI

struct FeedPage:View {
    private var store:FeedStore { .shared }
    @State private var input=""
    @State private var settings=false
    @State private var refreshing=false
    @State private var feedback:[String:String]=[:]
    @State private var sending=Set<String>()
    var body:some View {
        ScrollViewReader { proxy in
        PageScaffold(title:"动态") {
            HStack { TextField("想看什么？",text:$input).textFieldStyle(.plain).onSubmit(ask)
                Button(action:ask) { Image(systemName:"arrow.up") }.buttonStyle(.plain).disabled(input.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
                CircleIconButton(icon:"slider.horizontal.3",help:"调节动态") { settings=true }.verificationAction("feed-settings")
                Button(refreshing ? "刷新中…" : "刷新") { refresh() }.buttonStyle(SoftButtonStyle()).disabled(refreshing)
            }.padding(12).background(Theme.card,in:Capsule())
            if store.items.isEmpty { Note(text:store.loading ? "加载中…" : "还没有动态，告诉豆豆你关心什么") }
            ForEach(store.days,id:\.self) { day in
                VStack(alignment:.leading,spacing:25) {
                    Text(day).font(Theme.font(size:11,weight:.medium)).foregroundStyle(Theme.sub)
                    ForEach(store.items.filter { $0.date == day }) { p in post(p).id(p.path) }
                }
            }
            if let cursor=store.next {
                Button(store.loading ? "加载中…" : "更早的动态") { Task { await store.load() } }.buttonStyle(SoftButtonStyle())
                    .disabled(store.loading).frame(maxWidth:.infinity).task(id:cursor) { if store.error.isEmpty { await store.load() } }
            }
            if !store.error.isEmpty { Note(text:store.error); Button("重试") { Task { await store.load(reset:!store.loaded) } }.buttonStyle(SoftButtonStyle()) }
        }
        .task(id:ChatClient.shared.feedVersion) { await store.load(reset:true) }
        .onAppear { FeedBadge.shared.enter() }.onDisappear { FeedBadge.shared.leave() }
        .sheet(isPresented:$settings) { FeedSettingsView() }
        .onChange(of:Nav.shared.feedTarget,initial:true) {
            if let path=Nav.shared.feedTarget { proxy.scrollTo(path,anchor:.center);Nav.shared.feedTarget=nil }
        }
        }
    }

    private func ask() { let s=input.trimmingCharacters(in:.whitespacesAndNewlines); guard !s.isEmpty else { return }; Nav.shared.ask(s); input="" }
    private func refresh() {
        refreshing=true; Task { defer { refreshing=false }; do { let r=try await Api.json("/api/feed/refresh",method:"POST"); Nav.shared.show(r["mode"] as? String == "skipped" ? "豆豆已经在更新动态了" : "豆豆开始找新动态了") } catch { Nav.shared.show(error.localizedDescription) } }
    }
    private func act(_ p:FeedPost,_ action:String) async -> Bool {
        guard !sending.contains(p.path) else { return false }; sending.insert(p.path); defer { sending.remove(p.path) }
        do { _ = try await Api.json("/api/feed/feedback",method:"POST",body:["path":p.path,"action":action]); feedback[p.path]=action; return true }
        catch { Nav.shared.show(error.localizedDescription); return false }
    }
    private func post(_ p:FeedPost)->some View {
        HStack(alignment:.top,spacing:15) {
            Text(p.icon).font(.system(size:28)).frame(width:32)
            VStack(alignment:.leading,spacing:11) {
                Text(p.source).font(Theme.font(size:10)).foregroundStyle(Theme.sub.opacity(0.75)).lineLimit(1)
                Text(p.title).font(Theme.font(size:17,weight:.semibold)).fixedSize(horizontal:false,vertical:true)
                MarkdownView(text:p.body,size:14)
                if !p.hasSourceLink,let u=p.sourceLink {Link("阅读原文 ↗",destination:u).font(Theme.font(size:12)).foregroundStyle(Theme.link)}
                if let image=p.image { RemoteImage(path:image,maxSide:570,maxHeight:320).frame(maxWidth:.infinity,alignment:.leading) }
                HStack(spacing:23) {
                    Button { Task { _ = await act(p,"like") } } label:{ Image(systemName:feedback[p.path] == "like" ? "hand.thumbsup.fill" : "hand.thumbsup") }.verificationAction("feed-like-"+p.path).disabled(sending.contains(p.path))
                    Button { Task { _ = await act(p,"dislike") } } label:{ Image(systemName:feedback[p.path] == "dislike" ? "hand.thumbsdown.fill" : "hand.thumbsdown") }.verificationAction("feed-dislike-"+p.path).disabled(sending.contains(p.path))
                    Button { Composer.shared.discuss(p) } label:{ Label("讨论",systemImage:"bubble") }.verificationAction("feed-discuss-"+p.path)
                    Spacer(); if let d=p.time {Text(Fmt.ago(d)).font(Theme.font(size:11)).foregroundStyle(Theme.sub)}
                }.font(Theme.font(size:12)).buttonStyle(.plain).foregroundStyle(Theme.sub).padding(.vertical,5)
                Rectangle().fill(Theme.line).frame(height:1).padding(.top,5)
            }
        }
    }
}
struct FeedSettingsView:View {
    @Environment(\.dismiss) private var dismiss
    @State private var enabled=true
    @State private var interval=30
    @State private var start="07:00"
    @State private var end="23:00"
    @State private var instructions=""
    @State private var loading=true
    @State private var saving=false
    @State private var error=""
    var body:some View {
        VStack(alignment:.leading,spacing:20) {
            HStack { Text("调节动态").font(Theme.titleFont(23)); Spacer(); CircleIconButton(icon:"xmark",help:"关闭") { dismiss() }.verificationAction("feed-close") }
            Text("动态说明").font(Theme.font(size:14,weight:.semibold))
            Text("告诉豆豆你关心的方向、来源和希望看到的细节。保存后从下一次更新起生效。").font(Theme.font(size:12)).foregroundStyle(Theme.sub)
            TextEditor(text:$instructions).font(Theme.font(size:14)).scrollContentBackground(.hidden).padding(12).background(Theme.card,in:RoundedRectangle(cornerRadius:16)).frame(height:210)
            Toggle("自动更新",isOn:$enabled).toggleStyle(.switch)
            HStack { Text("每隔"); Picker("间隔",selection:$interval) { ForEach([15,30,60],id:\.self) { Text("\($0) 分钟").tag($0) } }.labelsHidden().frame(width:130); Spacer() }
            HStack { Text("时段"); TextField("07:00",text:$start).frame(width:75); Text("至"); TextField("23:00",text:$end).frame(width:75) }.textFieldStyle(.roundedBorder)
            if !error.isEmpty { Text(error).font(Theme.font(size:12)) }
            HStack { Spacer(); Button(saving ? "保存中…" : "保存") { save() }.buttonStyle(PrimaryButtonStyle()).verificationAction("feed-save").disabled(loading || saving) }
        }.padding(30).frame(width:520).background(Theme.background).foregroundStyle(Theme.ink).preferredColorScheme(Theme.scheme)
        .task { do { let r=try await Api.json("/api/feed/settings"); enabled=r["enabled"] as? Bool ?? true; interval=r["interval"] as? Int ?? 30; start=r["start"] as? String ?? "07:00"; end=r["end"] as? String ?? "23:00"; instructions=r["instructions"] as? String ?? ""; loading=false } catch { self.error=error.localizedDescription } }
    }
    private func save() {
        saving=true; Task { defer { saving=false }; do { _ = try await Api.json("/api/feed/settings",method:"PUT",body:["enabled":enabled,"interval":interval,"start":start,"end":end,"instructions":instructions]); dismiss() } catch { self.error=error.localizedDescription } }
    }
}
struct IdeasPage:View {
    @State private var groups:[IdeaGroup]=[]
    @State private var revision=""
    @State private var error=""
    @State private var working=false
    var body:some View {
        PageScaffold(title:"点子") {
            HStack { Text("从你在意的事开始").font(Theme.font(size:13)).foregroundStyle(Theme.sub); Spacer(); Button("换一批") { refresh() }.buttonStyle(SoftButtonStyle()).disabled(working) }
            ForEach(groups) { group in
                VStack(alignment:.leading,spacing:8) {
                    Text(group.name).font(Theme.font(size:12,weight:.medium)).foregroundStyle(Theme.sub).padding(.bottom,6)
                    ForEach(group.items) { idea in Button { choose(idea) } label: {
                        HStack(alignment:.top,spacing:15) { Text(idea.icon).font(.system(size:28)); VStack(alignment:.leading,spacing:8) {
                            Text(idea.title).font(Theme.font(size:16,weight:.medium))
                            Text(idea.description).font(Theme.font(size:13)).foregroundStyle(Theme.sub).fixedSize(horizontal:false,vertical:true)
                        }; Spacer(); Image(systemName:"arrow.up.left").font(.system(size:11)).foregroundStyle(Theme.sub) }.padding(.vertical,20).contentShape(Rectangle())
                    }.buttonStyle(.plain).verificationAction("idea-"+idea.id).disabled(working); Rectangle().fill(Theme.line).frame(height:1) }
                }
            }
            if groups.isEmpty { Note(text:error.isEmpty ? "豆豆还在想点子，可以先换一批" : error) }
            if !error.isEmpty && !groups.isEmpty { Note(text:error) }
        }.task(id:ChatClient.shared.filesVersion) { await load() }
    }
    private func load() async {
        do { let r=try await Api.json("/api/ideas"); revision=r["revision"] as? String ?? ""; groups=(r["groups"] as? [[String:Any]] ?? []).map { IdeaGroup(name:$0["name"] as? String ?? "",items:($0["items"] as? [[String:Any]] ?? []).compactMap(Idea.init)) }; error="" }
        catch { self.error=error.localizedDescription }
    }
    private func choose(_ idea:Idea) {
        Composer.shared.reference(ChatQuote(idea,revision:revision,group:groups.first{$0.items.contains{$0.id == idea.id}}?.name ?? "点子"))
    }
    private func refresh() { working=true; Task { defer { working=false }; do { _ = try await Api.json("/api/ideas/refresh",method:"POST"); Nav.shared.show("豆豆开始想新点子了") } catch { self.error=error.localizedDescription } } }
}
struct GoalsPage:View {
    @State private var goals:[Goal]=[]
    @State private var error=""
    @State private var domain:String?
    var body:some View {
        PageScaffold(title:"目标") {
            SectionTitle(text:"正在跟进")
            if goals.isEmpty { Note(text:"还没有目标，聊聊你想改变的事") }
            ForEach(goals) { goal in Button { Nav.shared.push(.goal(goal.name)) } label: {
                VStack(alignment:.leading,spacing:10) {
                    HStack { Text(goal.title).font(Theme.font(size:16,weight:.medium)); Spacer(); Text("\(goal.progress.formatted(.number.precision(.fractionLength(0...1))))%").font(Theme.font(size:12)) }
                    ProgressView(value:Double(goal.progress),total:100).tint(Theme.accent)
                    Text(goal.status + (goal.nextCheckin.map { " · 下次跟进 "+Fmt.when($0) } ?? "")).font(Theme.font(size:12)).foregroundStyle(Theme.sub)
                }.padding(.vertical,16).contentShape(Rectangle())
            }.buttonStyle(.plain) }
            SectionTitle(text:"创建目标").padding(.top,8)
            Text("先一起把目标聊清楚，再约定计划和跟进频率。").font(Theme.font(size:13)).foregroundStyle(Theme.sub)
            VStack(spacing:0) { ForEach(Array(Goal.domains.enumerated()),id:\.element) { i,d in
                ListRow(icon:["heart","person.2","dollarsign","building.2","paintpalette","laptopcomputer","scope"][i],title:d,action:{domain=d}) { Image(systemName:"plus").foregroundStyle(Theme.sub) }.verificationAction("create-"+d)
                if i < 6 { RowDivider() }
            } }
            if !error.isEmpty { Note(text:error) }
        }.task(id:ChatClient.shared.filesVersion) { do { let r=try await Api.json("/api/goals"); goals=(r["items"] as? [[String:Any]] ?? []).compactMap(Goal.init); let errors=r["errors"] as? [[String:Any]] ?? []; error=errors.map { ($0["name"] as? String ?? "目标")+"："+($0["error"] as? String ?? "解析失败") }.joined(separator:"\n") } catch { self.error=error.localizedDescription } }
        .sheet(isPresented:Binding(get:{domain != nil},set:{if !$0 {domain=nil}})) { VStack(alignment:.leading,spacing:20) {
            Text("创建\(domain ?? "")目标").font(Theme.titleFont(23))
            Text("我们会在聊天中一起完善目标。豆豆会问几个问题，了解你的想法，再制定计划。设置后，进度和下一次跟进会出现在这里。").font(Theme.font(size:14)).lineSpacing(5)
            HStack { Button("取消") { domain=nil }.buttonStyle(SoftButtonStyle()); Spacer(); Button("开始吧") { let d=domain ?? "其他"; domain=nil; Nav.shared.ask("我想立一个\(d)方面的目标，帮我聊清楚计划和跟进频率") }.buttonStyle(PrimaryButtonStyle()).verificationAction("goal-start") }
        }.padding(30).frame(width:450) }
    }
}
struct GoalDetailPage:View {
    let name:String
    @State private var goal:Goal?
    @State private var error=""
    var body:some View {
        SubPage(title:goal?.title ?? name) {
            if let goal { HStack { StatusTag(text:goal.status); Text(goal.domain).foregroundStyle(Theme.sub); Spacer(); Text("\(goal.progress.formatted(.number.precision(.fractionLength(0...1))))%") }
                ProgressView(value:Double(goal.progress),total:100).tint(Theme.ink)
                if let due=goal.due { Text("截止 · "+due).font(Theme.font(size:12)).foregroundStyle(Theme.sub) }
                if let next=goal.nextCheckin { Text("下次跟进 · "+Fmt.when(next)).font(Theme.font(size:12)).foregroundStyle(Theme.sub) }
                MarkdownView(text:goal.body,size:15).card(padding:24)
                Button("和豆豆聊这个目标") { Nav.shared.ask("我们聊聊「\(name)」这个目标，我想调整计划") }.buttonStyle(PrimaryButtonStyle())
            } else { Note(text:error.isEmpty ? "加载中…" : error) }
        }.task(id:"\(name)-\(ChatClient.shared.filesVersion)") {
            do { let r=try await Api.json("/api/goals/item?name="+Api.query(name)); guard let goal=Goal(r) else { throw ApiError(code:0,message:"目标格式不完整") }; self.goal=goal } catch { self.error=error.localizedDescription }
        }
    }
}
struct LibraryPage:View {
    @State private var section=0
    @State private var artifacts:[Artifact]=[]
    @State private var media:[MediaItem]=[]
    @State private var error=""
    var body:some View {
        PageScaffold(title:"资源库") {
            PillTabs(titles:["构件","影音内容"],selection:$section)
            if section == 0 {
                LazyVGrid(columns:[GridItem(.flexible()),GridItem(.flexible())],spacing:20) { ForEach(artifacts) { artifact in
                    Button { Nav.shared.open(artifact.path,title:artifact.name) } label: {
                        VStack(alignment:.leading,spacing:12) {
                            AuthenticatedThumbnail(endpoint:artifact.thumbnail,icon:artifact.kind == "page" ? "macwindow" : "doc.text").frame(height:190).clipped().clipShape(RoundedRectangle(cornerRadius:14))
                            Text(artifact.name).font(Theme.font(size:14,weight:.medium)).lineLimit(1)
                            Text(artifact.kind == "page" ? "页面" : "文档 · \(artifact.files.count) 个文件").font(Theme.font(size:11)).foregroundStyle(Theme.sub)
                        }.padding(12).background(Theme.card,in:RoundedRectangle(cornerRadius:20)).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                } }
                if artifacts.isEmpty { Note(text:"豆豆做的页面和文档会出现在这里") }
            } else {
                LazyVGrid(columns:[GridItem(.flexible()),GridItem(.flexible()),GridItem(.flexible())],spacing:15) {
                    ForEach(media) { item in VStack(alignment:.leading,spacing:9) { ReplyMediaView(item:item); Text(item.name).font(Theme.font(size:11)).foregroundStyle(Theme.sub).lineLimit(1) }.frame(maxWidth:.infinity,alignment:.leading) }
                }
                if media.isEmpty { Note(text:"交付的图片、视频和音频会出现在这里") }
            }
            if !error.isEmpty { Note(text:error) }
        }.task(id:ChatClient.shared.filesVersion) {
            do { let r=try await Api.json("/api/library"); artifacts=(r["artifacts"] as? [[String:Any]] ?? []).compactMap(Artifact.init); media=MediaItem.parse(r["media"]); error="" } catch { self.error=error.localizedDescription }
        }
    }
}
struct AuthenticatedThumbnail:View {
    let endpoint:String?
    var icon="photo"
    @State private var image:NSImage?
    var body:some View {
        ZStack { Theme.field; if let image { Image(nsImage:image).resizable().scaledToFit() } else { Image(systemName:icon).font(.system(size:35,weight:.light)).foregroundStyle(Theme.sub) } }
            .task(id:endpoint) { guard let e=endpoint, e.hasPrefix("/api/library/thumbnail?") else { return }; if let d=try? await Api.data(e) { image=NSImage(data:d) } }
    }
}

struct FeedPostDetailPage: View {
    let path: String
    @State private var post: FeedPost?
    @State private var error=""
    var body: some View {
        SubPage(title:"动态详情") {
            if let post {
                Text(post.icon).font(.system(size:32))
                Text(post.title).font(Theme.titleFont(23))
                Text(post.source).font(Theme.font(size:11)).foregroundStyle(Theme.sub)
                MarkdownView(text:post.body,size:14)
                if let image=post.image {RemoteImage(path:image,maxSide:570,maxHeight:320)}
                if !post.hasSourceLink,let url=post.sourceLink {Link("阅读原文 ↗",destination:url).foregroundStyle(Theme.link)}
                Button("讨论") {Composer.shared.discuss(post)}.buttonStyle(SoftButtonStyle())
            } else {Note(text:error.isEmpty ? "加载中…" : error)}
        }.task(id:path) {
            do {
                let row=try await Api.json("/api/feed/item?path="+Api.query(path))
                guard let p=FeedPost(row) else {throw ApiError(code:0,message:"这条动态不完整")};post=p
            } catch {self.error=error.localizedDescription}
        }
    }
}
