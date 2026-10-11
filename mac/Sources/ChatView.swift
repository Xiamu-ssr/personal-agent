import AVFoundation
import SwiftUI

struct ChatPage: View {
    private var chat: ChatClient { .shared }
    private var device: DeviceClient { .shared }
    private var nav: Nav { .shared }
    @Environment(\.interactiveWindow) private var active
    @State private var follower = BottomFollower()
    @State private var searching = false
    @State private var query = ""
    @State private var highlight: UUID? = nil
    @State private var jump: UUID? = nil
    @FocusState private var searchFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            header
            if !chat.live.isEmpty { LiveStrip().padding(.horizontal, 28).padding(.bottom, 6) }
            ZStack(alignment: .top) {
                messages
                if searching && !query.isEmpty { results.padding(.horizontal, 28) }
            }
            ComposerBar(placeholder: Tab.chat.prompt ?? "")
                .frame(maxWidth: 820)
                .padding(.horizontal, 28)
                .padding(.bottom, 18)
                .padding(.top, 4)
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            HStack(spacing: 10) {
                AgentAvatar(size: 30)
                Text(ProfileStore.shared.agentName).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.ink)
                AgentStatusDot()
            }
            .padding(.leading, 6)
            .padding(.trailing, 16)
            .frame(height: 46)
            .background(Capsule().fill(Theme.card))
            .overlay(Capsule().strokeBorder(.white, lineWidth: 1))
            .shadow(color: Color(hex: 0x253751, alpha: 0.06), radius: 10, y: 4)
            Spacer()
            if searching {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass").font(.system(size: 12)).foregroundStyle(Theme.faint)
                    TextField("搜索聊天记录", text: $query).textFieldStyle(.plain).font(.system(size: 13)).focused($searchFocused)
                        .onExitCommand { closeSearch() }
                    Button { closeSearch() } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.faint) }
                        .buttonStyle(.plain)
                }
                .padding(.horizontal, 12)
                .frame(width: 260, height: 36)
                .background(Capsule().fill(Theme.card))
                .overlay(Capsule().strokeBorder(.white, lineWidth: 1))
            } else {
                CircleIconButton(icon: "magnifyingglass", help: "搜索聊天记录") {
                    searching = true
                    searchFocused = true
                }
            }
            CircleIconButton(icon: "gearshape", help: "设置") { nav.go(.settings) }
        }
        .padding(.horizontal, 28)
        .padding(.top, 14)
        .padding(.bottom, 10)
    }

    private func closeSearch() {
        searching = false
        query = ""
    }

    private var hits: [ChatItem] {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return [] }
        return chat.items.filter { $0.kind != .note && ($0.text.localizedCaseInsensitiveContains(q) || $0.attachments.contains { $0.name.localizedCaseInsensitiveContains(q) || ($0.transcript ?? "").localizedCaseInsensitiveContains(q) }) }.reversed()
    }

    private var results: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(hits.isEmpty ? "已加载的聊天记录里没有「\(query)」" : "找到 \(hits.count) 条")
                .font(.system(size: 11.5)).foregroundStyle(Theme.faint).padding(.horizontal, 10).padding(.vertical, 8)
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(hits.prefix(30)) { item in
                        Button {
                            jump = item.id
                            highlight = item.id
                            closeSearch()
                            DispatchQueue.main.asyncAfter(deadline: .now() + 2.2) { if highlight == item.id { highlight = nil } }
                        } label: {
                            HStack(alignment: .top, spacing: 10) {
                                Text(item.kind == .user ? "我" : "豆豆").font(.system(size: 11, weight: .semibold))
                                    .foregroundStyle(item.kind == .user ? Theme.accent : Theme.goldText).frame(width: 28, alignment: .leading)
                                Text(snippet(item.text.isEmpty ? (item.attachments.first?.transcript ?? item.attachments.first?.name ?? "") : item.text))
                                    .font(.system(size: 12.5)).foregroundStyle(Theme.ink).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                                if let ts = item.ts { Text(Fmt.when(ts)).font(.system(size: 11)).foregroundStyle(Theme.faint) }
                            }
                            .padding(.horizontal, 10).padding(.vertical, 8).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .frame(maxHeight: 300)
        }
        .frame(maxWidth: 560)
        .card(radius: 16, padding: 6)
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private func snippet(_ s: String) -> String {
        let flat = s.replacingOccurrences(of: "\n", with: " ")
        guard let r = flat.range(of: query, options: .caseInsensitive) else { return flat }
        let start = flat.index(r.lowerBound, offsetBy: -24, limitedBy: flat.startIndex) ?? flat.startIndex
        return (start == flat.startIndex ? "" : "…") + flat[start...]
    }

    private var messages: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        if chat.items.isEmpty && chat.streaming.isEmpty {
                            Note(text: chat.connected ? "跟豆豆说点什么吧" : (chat.error.isEmpty ? "连接中…" : chat.error), icon: "bubble.left.and.bubble.right")
                                .padding(.top, 80)
                        }
                        ForEach(chat.items) { item in
                            MessageRow(item: item).equatable()
                                .id(item.id)
                                .background(RoundedRectangle(cornerRadius: 18).fill(Color(hex: 0xF3DFB0, alpha: highlight == item.id ? 0.45 : 0)).padding(-6))
                                .animation(.easeOut(duration: 0.3), value: highlight)
                        }
                    }
                    if !chat.streaming.isEmpty { AssistantBubble(text: chat.streaming, messageID: chat.streamID).id("streaming") }
                    if chat.busy && chat.streaming.isEmpty { Thinking(hint: chat.replyStatus) }
                    Color.clear.frame(height: 1).id("end")
                }
                .frame(maxWidth: 820)
                .padding(.horizontal, 28)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity)
            }
            .scrollContentBackground(.hidden)
            .onAppear { follower.request() }
            .onChange(of: chat.items.count) { if active { follower.request() } }
            .onChange(of: chat.streaming) { if active { follower.request() } }
            .onChange(of: active) { _, value in
                if value { follower.request() } else { follower.cancel() }
            }
            .onChange(of: follower.revision) {
                guard active else { return }
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) { proxy.scrollTo("end", anchor: .bottom) }
                #if MAC_PERF
                PerfProbe.shared.record("scroll_to_bottom")
                #endif
            }
            .onDisappear { follower.cancel() }
            .onChange(of: jump) { _, id in
                guard let id else { return }
                withAnimation { proxy.scrollTo(id, anchor: .center) }
                jump = nil
            }
        }
    }
}

/// Background jobs and sub-agent tasks: a thin bar under the header that expands into a list.
struct LiveStrip: View {
    @Environment(\.interactiveWindow) private var active
    private var chat: ChatClient { .shared }
    @State private var open = false

    var body: some View {
        TimelineView(.animation(minimumInterval: 30, paused: !active)) { ctx in
            VStack(alignment: .leading, spacing: 8) {
                Button { withAnimation(.easeOut(duration: 0.2)) { open.toggle() } } label: {
                    HStack(spacing: 8) {
                        ActiveProgress().controlSize(.mini)
                        Text(summary(ctx.date)).font(.system(size: 12)).foregroundStyle(Theme.ink.opacity(0.85)).lineLimit(1)
                        Spacer()
                        Image(systemName: open ? "chevron.up" : "chevron.down").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.faint)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if open {
                    ForEach(chat.live) { t in
                        HStack {
                            Text(t.label).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(1)
                            Text(t.detail).font(.system(size: 11.5)).foregroundStyle(Theme.sub).lineLimit(1)
                            Spacer()
                            Text("已运行 " + Fmt.duration(ctx.date.timeIntervalSince(t.started))).font(.system(size: 11)).foregroundStyle(Theme.faint)
                        }
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 14).fill(.white.opacity(0.6)))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(.white, lineWidth: 1))
            .frame(maxWidth: 820)
            .frame(maxWidth: .infinity)
        }
    }

    private func summary(_ now: Date) -> String {
        guard let first = chat.live.first else { return "" }
        let one = "\(first.label) · 已运行 \(Fmt.duration(now.timeIntervalSince(first.started)))"
        return chat.live.count == 1 ? "后台在跑：\(one)" : "后台 \(chat.live.count) 个任务在跑：\(one) 等"
    }
}

struct Thinking: View {
    let hint: String
    @Environment(\.interactiveWindow) private var active

    var body: some View {
        TimelineView(.animation(minimumInterval: 0.1, paused: !active)) { context in
            let phase = active ? context.date.timeIntervalSinceReferenceDate * .pi * 2 / 1.2 : 0
            HStack(spacing: 8) {
                HStack(spacing: 4) {
                    ForEach(0..<3) { i in
                        Circle().fill(Theme.faint).frame(width: 5, height: 5)
                            .opacity(0.35 + 0.65 * max(0, sin(phase + Double(i) * 0.9)))
                    }
                }
                Text(hint.isEmpty ? "豆豆在想…" : hint).font(.system(size: 12.5)).foregroundStyle(Theme.sub)
            }
            .padding(.horizontal, 14)
            .frame(height: 34)
            .background(Capsule().fill(.white.opacity(0.7)))
        }
    }
}

struct MessageRow: View, Equatable {
    let item: ChatItem
    var compact = false

    var body: some View {
        switch item.kind {
        case .user: UserBubble(item: item, compact: compact)
        case .schedule:
            Label(item.scheduleTitle, systemImage: "alarm")
                .font(.system(size: 11.5)).foregroundStyle(Theme.faint).frame(maxWidth: .infinity)
                .padding(.vertical, 3)
        case .assistant: AssistantBubble(text: item.text, compact: compact, messageID: item.id)
        case .note:
            Text(item.text).font(.system(size: 11.5)).foregroundStyle(Theme.faint).frame(maxWidth: .infinity)
        case .card: CardMessage(item: item)
        }
    }
}

struct UserBubble: View {
    let item: ChatItem
    var compact = false
    @State private var editing = false
    @State private var draft = ""

    var body: some View {
        HStack {
            Spacer(minLength: compact ? 40 : 120)
            VStack(alignment: .trailing, spacing: 8) {
                ForEach(item.attachments, id: \.path) { AttachmentView(att: $0) }
                if !item.text.isEmpty {
                    Text(Markdown.inline(item.text))
                        .font(.system(size: compact ? 13 : 14))
                        .foregroundStyle(Theme.ink)
                        .lineSpacing(3)
                        .textSelection(.enabled)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Theme.userBubble))
                        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(.white.opacity(0.7), lineWidth: 1))
                }
                if item.queued {
                    Text("排队中").font(.system(size: 10.5)).foregroundStyle(Theme.sub).padding(.trailing, 10)
                }
            }
            .opacity(item.queued ? 0.55 : item.pending ? 0.7 : 1)
            .contextMenu {
                if item.queued && !item.serverID.isEmpty {
                    Button("撤回") { ChatClient.shared.updateQueue(item) }
                    Button("修改") { draft = item.text; editing = true }
                }
            }
            .disabled(ChatClient.shared.queueOperations.contains(item.serverID))
            .sheet(isPresented: $editing) {
                VStack(alignment: .leading, spacing: 18) {
                    Text("修改排队消息").font(.system(size: 20, weight: .semibold)).foregroundStyle(Theme.ink)
                    TextEditor(text: $draft).font(.system(size: 14)).frame(height: 130)
                        .padding(10).background(.white, in: RoundedRectangle(cornerRadius: 12))
                    HStack {
                        Spacer()
                        Button("取消") { editing = false }.buttonStyle(SoftButtonStyle())
                        Button("保存修改") {
                            if ChatClient.shared.updateQueue(item, text: draft) { editing = false }
                            else if !item.queued { editing = false; Nav.shared.show("豆豆已经在看这条了") }
                        }.buttonStyle(GoldButtonStyle(height: 34)).disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }.padding(24).frame(width: 430).background(Theme.canvas).preferredColorScheme(.light)
            }
        }
    }
}

struct AssistantBubble: View, Equatable {
    let text: String
    var compact = false
    var messageID: UUID? = nil

    var body: some View {
        HStack {
            MarkdownView(text: text, size: compact ? 13 : 14, cacheID: messageID)
                .textSelection(.enabled)
                .card(radius: compact ? 14 : 20, padding: compact ? 11 : 16)
            Spacer(minLength: compact ? 30 : 80)
        }
    }
}

/// JSON brief preview; clicking navigates to its native cards on 今日.
struct CardMessage: View {
    let item: ChatItem
    @State private var hover = false
    @State private var brief: BriefCard?

    var body: some View {
        HStack {
            Button {
                if let p = item.outputs.first { Nav.shared.open(p, title: item.label.isEmpty ? nil : item.label) }
            } label: {
                HStack(spacing: 12) {
                    IconTile(icon: "doc.richtext", tint: Color(hex: 0x527AAA), size: 40)
                    VStack(alignment: .leading, spacing: 3) {
                        if let brief, !brief.chip.isEmpty { Text(brief.chip).font(.system(size: 11)).foregroundStyle(Theme.goldText) }
                        Text(brief?.title ?? (item.text.isEmpty ? (item.label.isEmpty ? "简报" : item.label) : item.text))
                            .font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(2).multilineTextAlignment(.leading)
                        if let brief, !brief.summary.isEmpty {
                            Text(brief.summary).font(.system(size: 12)).foregroundStyle(Theme.sub).lineLimit(2).multilineTextAlignment(.leading)
                        } else {
                            Text([item.label, item.ts.map(Fmt.when) ?? ""].filter { !$0.isEmpty }.joined(separator: " · "))
                                .font(.system(size: 11.5)).foregroundStyle(Theme.faint)
                        }
                    }
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.faint)
                }
                .frame(maxWidth: 440)
                .card(radius: 18, padding: 14)
                .scaleEffect(hover ? 1.01 : 1)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { h in withAnimation(.easeOut(duration: 0.12)) { hover = h } }
            .disabled(item.outputs.isEmpty)
            Spacer()
        }
        .task(id: "\(item.outputs.first ?? "")#\(ChatClient.shared.filesVersion)") {
            brief = nil
            if let path = item.outputs.first, path.hasPrefix("data/briefs/"), path.hasSuffix(".json"),
               let data = try? await Api.data(Api.filePath(path)), let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                brief = BriefItem.parse(["path": path, "brief": json])?.cards.first
            }
        }
    }
}

/// An attachment inside a user bubble: picture thumbnail, file row, or voice note player with its transcript.
struct AttachmentView: View {
    let att: Attachment

    var body: some View {
        switch att.kind {
        case "image": RemoteImage(path: att.path, maxSide: 220).onTapGesture { Nav.shared.preview = att.path }
        case "voice": VoiceNote(att: att)
        default:
            Button { Nav.shared.open(att.path, title: att.name) } label: {
                HStack(spacing: 10) {
                    IconTile(icon: icon, size: 32)
                    Text(att.name).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(1)
                    Image(systemName: "arrow.up.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.faint)
                }
                .padding(.horizontal, 10).padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 14).fill(.white.opacity(0.9)))
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
    @State private var image: NSImage? = nil
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                let s = image.size
                let k = min(1, maxSide / max(s.width, s.height, 1))
                Image(nsImage: image).resizable().aspectRatio(contentMode: .fit)
                    .frame(width: max(40, s.width * k), height: max(40, s.height * k))
            } else {
                RoundedRectangle(cornerRadius: 14).fill(Color(hex: 0xE8EDF3))
                    .frame(width: maxSide * 0.7, height: maxSide * 0.5)
                    .overlay(failed ? AnyView(Image(systemName: "photo").foregroundStyle(Theme.faint)) : AnyView(ActiveProgress().controlSize(.small)))
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(.white, lineWidth: 1.5))
        .contentShape(Rectangle())
        .task(id: path) {
            do { image = NSImage(data: try await Api.cached(path)); failed = image == nil } catch { failed = true }
        }
    }
}

/// Play bar + the cloud's transcript.
struct VoiceNote: View {
    let att: Attachment
    @State private var player: AVAudioPlayer? = nil
    @State private var playing = false
    @State private var progress = 0.0
    @State private var loading = false
    @Environment(\.interactiveWindow) private var active

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Button(action: toggle) {
                    ZStack {
                        GoldBase()
                        if loading { ActiveProgress().controlSize(.mini) } else {
                            Image(systemName: playing ? "pause.fill" : "play.fill").font(.system(size: 11)).foregroundStyle(Theme.goldText)
                        }
                    }
                    .frame(width: 30, height: 30)
                }
                .buttonStyle(.plain)
                GeometryReader { g in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color(hex: 0xD5DEE8))
                        Capsule().fill(Color(hex: 0x6F8BAA)).frame(width: g.size.width * progress)
                    }
                }
                .frame(height: 4)
                Text(duration).font(.system(size: 11).monospacedDigit()).foregroundStyle(Theme.sub)
            }
            .frame(width: 230)
            Text(att.transcript.map { $0.isEmpty ? "（没有听到内容）" : $0 } ?? "语音笔记 · 转写中…")
                .font(.system(size: 13)).foregroundStyle(Theme.ink.opacity(0.85)).lineSpacing(2)
                .frame(maxWidth: 320, alignment: .leading)
                .textSelection(.enabled)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Theme.userBubble))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(.white.opacity(0.7), lineWidth: 1))
        .task(id: playing && active) {
            guard playing && active else { return }
            while !Task.isCancelled, let p = player {
                progress = p.duration > 0 ? p.currentTime / p.duration : 0
                if !p.isPlaying { playing = false; progress = 0; break }
                do { try await Task.sleep(nanoseconds: 100_000_000) } catch { break }
            }
        }
        .onDisappear { player?.stop() }
    }

    private var duration: String {
        let s = Int(player?.duration ?? 0)
        return player == nil ? "语音" : String(format: "%d:%02d", s / 60, s % 60)
    }

    private func toggle() {
        if let p = player {
            if p.isPlaying { p.pause(); playing = false } else { p.play(); playing = true }
            return
        }
        loading = true
        Task { @MainActor in
            defer { loading = false }
            guard let d = try? await Api.cached(att.path), let p = try? AVAudioPlayer(data: d) else {
                Nav.shared.show("这段语音放不了")
                return
            }
            player = p
            p.play()
            playing = true
        }
    }
}
