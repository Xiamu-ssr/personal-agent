import SwiftUI

/// The menu-bar bubble: a quick chat that stays around when the main window is closed.
struct MenuView: View {
    @Environment(\.openWindow) private var openWindow
    @State private var input = ""
    @State private var focused = false
    @State private var windowActivity = WindowActivity()
    @State private var follower = BottomFollower()
    private var chat: ChatClient { .shared }
    private var device: DeviceClient { .shared }
    private var session: Session { .shared }

    var body: some View {
        VStack(spacing: 0) {
            header
            Rectangle().fill(Theme.line).frame(height: 1)
            if session.configured {
                messages
                composer
            } else {
                VStack(spacing: 14) {
                    Spacer()
                    Orb(size: 56)
                    Text("还没登录").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink)
                    Button("打开豆豆登录", action: openMain).buttonStyle(GoldButtonStyle(height: 34))
                    Spacer()
                }
                .frame(maxWidth: .infinity)
            }
        }
        .frame(width: 380, height: 540)
        .background(Theme.canvas)
        .preferredColorScheme(.light)
        .background(WindowActivityReader(activity: windowActivity).frame(width: 0, height: 0))
        .environment(\.interactiveWindow, windowActivity.active)
        .onAppear { AppDelegate.openMain = { openWindow(id: "main") } }
    }

    private func openMain() {
        openWindow(id: "main")
        NSApp.activate(ignoringOtherApps: true)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Orb(size: 28)
            VStack(alignment: .leading, spacing: 1) {
                Text("豆豆").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.ink)
                HStack(spacing: 5) {
                    Dot(on: chat.connected)
                    Text(statusLine(chat, device)).font(.system(size: 11)).foregroundStyle(Theme.sub).lineLimit(1)
                }
            }
            Spacer()
            Button(action: openMain) { Image(systemName: "macwindow") }
                .buttonStyle(.borderless).help("打开主窗口")
            Button { NSApp.terminate(nil) } label: { Image(systemName: "power") }
                .buttonStyle(.borderless).help("退出豆豆")
        }
        .foregroundStyle(Theme.ink.opacity(0.75))
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var messages: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(chat.items.suffix(60)) { MessageRow(item: $0, compact: true).equatable() }
                    }
                    if !chat.streaming.isEmpty { AssistantBubble(text: chat.streaming, compact: true, messageID: chat.streamID).id("streaming") }
                    if chat.busy && chat.streaming.isEmpty { Thinking(hint: chat.replyStatus) }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(12)
            }
            .onAppear { follower.request() }
            .onChange(of: chat.items.count) { if windowActivity.active { follower.request() } }
            .onChange(of: chat.streaming) { if windowActivity.active { follower.request() } }
            .onChange(of: windowActivity.active) { _, active in
                if active { follower.request() } else { follower.cancel() }
            }
            .onChange(of: follower.revision) {
                guard windowActivity.active else { return }
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) { proxy.scrollTo("end", anchor: .bottom) }
                #if MAC_PERF
                PerfProbe.shared.record("scroll_to_bottom")
                #endif
            }
            .onDisappear { follower.cancel() }
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            TaskControls(compact: true)
            HStack(alignment: .bottom, spacing: 8) {
                GrowingInput(text: $input, focused: $focused, placeholder: "跟豆豆说…（⌥↩ 换行）",
                             enabled: !Composer.shared.sending, fontSize: 13, verticalPadding: 8,
                             onSubmit: send, onAttachmentPaste: { pasteAttachment($0) })
                    .frame(maxWidth: .infinity)
                Button(action: send) {
                    ZStack {
                        GoldBase()
                        Image(systemName: "arrow.up").font(.system(size: 13, weight: .bold)).foregroundStyle(Theme.goldText)
                    }
                    .frame(width: 30, height: 30)
                }
                .buttonStyle(.plain)
                .help("发送（↩︎）· ⌥↩︎ 换行")
                .disabled(Composer.shared.sending || input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(.horizontal, 10).padding(.vertical, 4)
            .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(.white.opacity(0.85)))
        }
        .padding(10)
    }

    private func pasteAttachment(_ pasteboard: NSPasteboard) -> Bool {
        guard !Composer.shared.sending, Composer.shared.paste(pasteboard) else { return false }
        if !input.isEmpty { Composer.shared.text = input; input = "" }
        Nav.shared.go(.chat)
        openMain()
        return true
    }

    private func send() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !Composer.shared.sending else { return }
        if chat.send(text) { input = "" }
    }
}
