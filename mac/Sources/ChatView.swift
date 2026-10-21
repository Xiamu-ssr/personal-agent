import AVFoundation
import SwiftUI

/// An attachment inside a user bubble: picture thumbnail, file row, or voice note player with its transcript.
struct AttachmentView: View {
    let att: Attachment

    var body: some View {
        switch att.kind=="voice" ? "voice":MediaItem.inferredKind(path:att.path,declared:MediaItem.Kind(rawValue:att.kind) ?? .file).rawValue {
        case "image": RemoteImage(path: att.path, maxSide: 220).onTapGesture { Nav.shared.preview = att.path }
        case "voice": VoiceNote(att: att)
        case "video","audio":if let media=MediaItem(["path":att.path,"name":att.name,"kind":"file","size":att.size ?? 0]){ReplyMediaView(item:media)}
        default:
            Button { Nav.shared.open(att.path, title: att.name) } label: {
                HStack(spacing: 10) {
                    IconTile(icon: icon, size: 32)
                    Text(att.name + (att.size.map { " · " + Fmt.size($0) } ?? ""))
                        .font(Theme.font(size: 13, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(1)
                    Image(systemName: "arrow.up.right").font(Theme.font(size: 10, weight: .semibold)).foregroundStyle(Theme.faint)
                }
                .padding(.horizontal, 10).padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 14).fill(Theme.card))
                .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.line, lineWidth: 1))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    private var icon: String {
        switch (att.name as NSString).pathExtension.lowercased() {
        case "pdf": "doc.richtext"
        case "xls", "xlsx", "csv", "numbers": "tablecells"
        case "zip", "gz", "tar", "rar", "7z": "doc.zipper"
        case "mp3", "m4a", "wav", "aac": "waveform"
        case "mp4", "mov": "film"
        default: "doc.text"
        }
    }
}

/// A data/ image fetched with the token.
struct RemoteImage: View {
    let path: String
    var maxSide: CGFloat = 220
    var maxHeight: CGFloat? = nil
    var failureText: String? = nil
    var fullWidth = false
    @State private var image: NSImage? = nil
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                let s = image.size
                let k = min(1, maxSide / max(s.width, s.height, 1), (maxHeight ?? .greatestFiniteMagnitude) / max(1,s.height))
                if fullWidth {
                    Image(nsImage:image).resizable().aspectRatio(contentMode:.fit).frame(maxWidth:maxSide)
                } else { Image(nsImage: image).resizable().aspectRatio(contentMode: .fit)
                    .frame(width: max(40, s.width * k), height: max(40, s.height * k))
                }
            } else {
                RoundedRectangle(cornerRadius: 14).fill(Theme.field)
                    .frame(width: maxSide * 0.7, height: maxSide * 0.5)
                    .overlay {
                        if failed {
                            VStack(spacing: 6) {
                                Image(systemName: "photo")
                                if let failureText { Text(failureText).font(Theme.font(size: 12)) }
                            }.foregroundStyle(Theme.faint)
                        } else { ActiveProgress().controlSize(.small) }
                    }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.line, lineWidth: 0.5))
        .contentShape(Rectangle())
        .task(id: path+"-"+String(ChatClient.shared.libraryVersion)) {
            do {
                let data = try await Api.cached(path)
                try Task.checkCancellation()
                let decoded=await ImageDecode.thumbnail(data,maxPixels:fullWidth ? 2400:1200)
                try Task.checkCancellation();image=decoded;failed=image==nil
            } catch is CancellationError {} catch { failed = true }
        }
    }
}

/// Play bar + the cloud's transcript.
@MainActor struct VoiceNote: View {
    let att: Attachment
    @State private var player: AVAudioPlayer? = nil
    @State private var playing = false
    @State private var progress = 0.0
    @State private var loading = false
    @State private var playbackID = UUID()
    @State private var work: Task<Void, Never>?
    @Environment(\.interactiveWindow) private var active

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Button(action: toggle) {
                    ZStack {
                        CapsuleBase()
                        if loading { ActiveProgress().controlSize(.mini) } else {
                            Image(systemName: playing ? "pause.fill" : "play.fill").font(Theme.font(size: 11)).foregroundStyle(Theme.actionText)
                        }
                    }
                    .frame(width: 30, height: 30)
                }
                .buttonStyle(.plain)
                GeometryReader { g in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Theme.field)
                        Capsule().fill(Theme.accent).frame(width: g.size.width * progress)
                    }
                }
                .frame(height: 4)
                Text(duration).font(Theme.font(size: 11).monospacedDigit()).foregroundStyle(Theme.sub)
            }
            .frame(width: 230)
            Text(att.transcript.map { $0.isEmpty ? "（没有听到内容）" : $0 } ?? "语音笔记 · 转写中…")
                .font(Theme.font(size: 13)).foregroundStyle(Theme.ink.opacity(0.85)).lineSpacing(2)
                .frame(maxWidth: 320, alignment: .leading)
                .textSelection(.enabled)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Theme.userBubble))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Theme.line, lineWidth: 0.5))
        .task(id: playing && active) {
            guard playing && active else { return }
            while !Task.isCancelled, let p = player {
                progress = p.duration > 0 ? p.currentTime / p.duration : 0
                if !p.isPlaying { playing = false; progress = 0; break }
                do { try await Task.sleep(nanoseconds: 100_000_000) } catch { break }
            }
        }
        .background(MediaVisibility { if !$0 { stop() } })
        .onChange(of: active) { if !active { stop() } }
        .onDisappear { stop() }
    }

    private var duration: String {
        let s = Int(player?.duration ?? 0)
        return player == nil ? "语音" : String(format: "%d:%02d", s / 60, s % 60)
    }

    private func toggle() {
        if let p = player {
            if p.isPlaying { p.pause(); playing = false; MediaPlaybackFocus.release(playbackID) } else { play(p) }
            return
        }
        loading = true
        work = Task { @MainActor in
            defer { if !Task.isCancelled { loading = false } }
            guard let d = try? await Api.cached(att.path), !Task.isCancelled, let p = try? AVAudioPlayer(data: d) else {
                if Task.isCancelled { return }
                Nav.shared.show("这段语音放不了")
                return
            }
            player = p
            play(p)
        }
    }

    private func play(_ player: AVAudioPlayer) {
        MediaPlaybackFocus.claim(playbackID) { [weak player] in player?.pause(); playing = false }
        player.play(); playing = true
    }

    private func stop() {
        work?.cancel(); work = nil
        player?.stop(); player = nil
        playing = false; loading = false; progress = 0
        MediaPlaybackFocus.release(playbackID)
    }
}

struct ChatPage:View {
    var thread:SideChatThread?=nil
    private var chat:ChatClient { .shared }
    private var transcript:ChatTranscript {thread?.transcript ?? chat.transcript}
    @Environment(\.interactiveWindow) private var active
    var body:some View {
        VStack(spacing:0) {
            ChatMessages(transcript:transcript,emptyText:thread == nil ? "豆豆正在准备第一次聊天…" : "在这里聊一个新的话题。",topInset:82)
            if let error=[thread?.error ?? chat.error,transcript.error].first(where:{!$0.isEmpty}) {
                HStack {Text(error).font(Theme.font(size:12)).foregroundStyle(Theme.sub)
                    if !chat.connected {Button("重连"){chat.reconnect()}.buttonStyle(.plain)}
                }.padding(8)
            }
            ComposerBar(placeholder:"消息",c:thread?.composer ?? .shared).frame(maxWidth:720).padding(.horizontal,36).padding(.bottom,22).padding(.top,10)
        }.task(id:"\(active)-\(chat.jobsVersion)-\(chat.connected)") {
            guard let thread,active else {return};await thread.load()
            while !Task.isCancelled && thread.status == "running" {
                do {try await Task.sleep(nanoseconds:3_000_000_000)} catch {return};await thread.load()
            }
        }
    }
}
struct ChatMessages:View {
    var compact=false
    var transcript:ChatTranscript=ChatClient.shared.transcript
    var emptyText="豆豆正在准备第一次聊天…"
    var topInset:CGFloat=0
    @Environment(\.interactiveWindow) private var active
    @State private var scroll=ChatScrollState()
    @State private var returnRevision=0
    var body:some View {
        NativeChatList(transcript:transcript,state:scroll,compact:compact,topInset:topInset,active:active,returnRevision:returnRevision)
            .overlay(alignment:.bottomTrailing) {ReturnToBottom(state:scroll){scroll.returnToBottom();returnRevision += 1}}
            .overlay {if transcript.items.isEmpty {Note(text:ChatClient.shared.connected ? emptyText:"连接中…")}}
    }
}
struct MessageRow:View {
    let item:ChatItem
    var compact=false
    var transcript:ChatTranscript
    var body:some View {
        HStack(alignment:.top) {
            if item.kind == .user { Spacer(minLength:compact ? 30 : 80) }
            VStack(alignment:.leading,spacing:10) {
                if !item.text.isEmpty || item.quote != nil {
                    VStack(alignment:.leading,spacing:10) {
                        if let quote=item.quote {
                            Button {Nav.shared.openQuote(quote)} label: {QuoteCard(quote:quote)}.buttonStyle(.plain).verificationAction("quote-"+item.serverID)
                        }
                        if !item.text.isEmpty {MarkdownView(text:item.text,size:compact ? 13 : 16).textSelection(.enabled)}
                    }.padding(.horizontal,16).padding(.vertical,13)
                        .background(item.kind == .user ? Theme.userBubble : Theme.card,in:RoundedRectangle(cornerRadius:18,style:.continuous))
                }
                if !item.attachments.isEmpty { MessageAttachments(attachments:item.attachments,compact:compact) }
                ForEach(Array(item.cards.enumerated()),id:\.offset) { SayCardView(card:$0.element,compact:compact) }
                ForEach(item.visibleMedia) { ReplyMediaView(item:$0) }
                if !item.options.isEmpty {
                    VStack(spacing:8) {
                        ForEach(item.options) { option in
                            Button { Task { await transcript.choose(messageID:item.serverID,optionID:option.id) } } label: {
                                HStack { Text(option.label).font(Theme.font(size:compact ? 13 : 14,weight:.medium)); Spacer()
                                    Image(systemName:item.optionsUsed ? "checkmark.circle" : "arrow.up.left").font(.system(size:12))
                                }.padding(14).background(Theme.card,in:RoundedRectangle(cornerRadius:14))
                                    .overlay(RoundedRectangle(cornerRadius:14).strokeBorder(Theme.ink.opacity(item.optionsUsed ? 0.04 : 0.2),lineWidth:1)).contentShape(Rectangle())
                            }.buttonStyle(.plain).verificationAction("option-"+item.serverID+"-"+option.id).disabled(item.optionsUsed || transcript.choosing.contains(item.serverID))
                        }
                    }.opacity(item.optionsUsed ? 0.4 : 1).accessibilityLabel(item.optionsUsed ? "这组选项已使用" : "选择回复")
                }
                if item.pending { Text("发送中…").font(.system(size:10)).foregroundStyle(Theme.sub) }
            }.frame(maxWidth:compact ? 300 : 560,alignment:item.kind == .user ? .trailing : .leading)
            if item.kind == .assistant { Spacer(minLength:compact ? 10 : 80) }
        }.foregroundStyle(Theme.ink).verificationAction("message-"+item.serverID)
        .contextMenu {
            Button("复制") {NSPasteboard.general.clearContents();NSPasteboard.general.setString(item.text,forType:.string)}
        }
    }
}
struct MessageAttachments: View {
    let attachments:[Attachment]
    var compact=false
    private var images:[Attachment] {attachments.filter {$0.kind == "image"}}
    var body:some View {
        VStack(alignment:.leading,spacing:8) {
            if !images.isEmpty {
                LazyVGrid(columns:[GridItem(.adaptive(minimum:compact ? 115 : 150),spacing:8)],alignment:.leading,spacing:8) {
                    ForEach(Array(images.enumerated()),id:\.offset) { row in AttachmentView(att:row.element).frame(maxWidth:.infinity,alignment:.leading) }
                }
            }
            ForEach(Array(attachments.filter {$0.kind != "image"}.enumerated()),id:\.offset) {AttachmentView(att:$0.element)}
        }
    }
}
struct SayCardView:View {
    let card:SayCard
    var compact=false
    var body:some View {
        switch card {
        case .connector(let id):
            cardButton(icon:"square.grid.2x2",style:.connector(id),title:ConnectorStore.shared.connector(id)?.title ?? id,subtitle:"连接应用") {
                Nav.shared.push(.connector(id)); MenuController.shared.close(); AppDelegate.openMain?()
            }.task { if !ConnectorStore.shared.loaded { await ConnectorStore.shared.load() } }
        case .goal(let name): cardButton(icon:"checkmark.square",title:name,subtitle:"查看计划与进展") { Nav.shared.push(.goal(name)); AppDelegate.openMain?(); MenuController.shared.close() }
        case .device(let capability):
            cardButton(icon:"laptopcomputer",style:.capability(capability ?? "computer_use"),title:capability.flatMap { c in Capabilities.all.first { $0.name == c }?.title } ?? "本机能力",subtitle:"在这台 Mac 上授权") {
                Nav.shared.push(.connectors(tab:0,focus:capability)); AppDelegate.openMain?(); MenuController.shared.close()
            }
        case .link(let url,let title,let description,let image):
            if let u=DataPath.http(url) {
                Link(destination:u) {
                    VStack(alignment:.leading,spacing:8) {
                        if let image, let u=URL(string:image) { AsyncImage(url:u) { phase in if let im=phase.image { im.resizable().scaledToFill().frame(height:compact ? 100 : 160).clipped() } }.clipShape(RoundedRectangle(cornerRadius:12)) }
                        Text(title).font(Theme.font(size:14,weight:.medium)).foregroundStyle(Theme.link)
                        if !description.isEmpty { Text(description).font(Theme.font(size:12)).foregroundStyle(Theme.sub) }
                        Text(u.host ?? url).font(Theme.font(size:11)).foregroundStyle(Theme.sub)
                    }.frame(maxWidth:.infinity,alignment:.leading).padding(16).background(Theme.card,in:RoundedRectangle(cornerRadius:18))
                }.buttonStyle(.plain)
            }
        case .media(let kind,let path,let name):
            if let m=MediaItem(["kind":kind.rawValue,"path":path,"name":name]) { ReplyMediaView(item:m) }
        }
    }
    private func cardButton(icon:String,style:AppIconStyle?=nil,title:String,subtitle:String,action:@escaping ()->Void)->some View {
        Button(action:action) { HStack(spacing:13) {
            if let style {AppIcon(style:style,size:36)} else {Image(systemName:icon).font(.system(size:23)).frame(width:34)}
            VStack(alignment:.leading,spacing:5) { Text(title).font(Theme.font(size:14,weight:.medium)); Text(subtitle).font(Theme.font(size:12)).foregroundStyle(Theme.sub) }
            Spacer(); Image(systemName:"chevron.right").font(.system(size:11)).foregroundStyle(Theme.sub)
        }.padding(17).background(Theme.card,in:RoundedRectangle(cornerRadius:18)).contentShape(Rectangle()) }.buttonStyle(.plain)
    }
}
