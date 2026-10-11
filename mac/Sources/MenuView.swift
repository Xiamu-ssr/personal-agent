import SwiftUI

/// The menu-bar bubble: a quick chat that stays around when the main window is closed.
struct MenuView: View {
    @State private var input = ""
    @State private var focused = false
    @State private var windowActivity = WindowActivity()
    @State private var follower = BottomFollower()
    private var chat: ChatClient { .shared }
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
        .task { if session.configured { await ProfileStore.shared.load() } }
    }

    private func openMain() {
        AppDelegate.openMain?()
        MenuController.shared.close()
        NSApp.activate(ignoringOtherApps: true)
    }

    private var header: some View {
        HStack(spacing: 10) {
            AgentAvatar(size: 28)
            Text(ProfileStore.shared.agentName).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.ink)
            AgentStatusDot()
            Spacer()
            MenuActionButton(symbol: "macwindow", label: "打开主窗口", action: openMain).frame(width: 20, height: 24)
            MenuActionButton(symbol: "power", label: "退出豆豆") { NSApp.terminate(nil) }.frame(width: 20, height: 24)
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

/// Native popover actions expose the same press target to mouse, accessibility and local acceptance.
private struct MenuActionButton: NSViewRepresentable {
    let symbol: String
    let label: String
    let action: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(action: action) }
    func makeNSView(context: Context) -> NSButton {
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: label) ?? NSImage()
        image.isTemplate = true
        let button = NSButton(image: image, target: context.coordinator, action: #selector(Coordinator.press(_:)))
        button.isBordered = false; button.imagePosition = .imageOnly
        button.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 14, weight: .regular)
        button.contentTintColor = NSColor(Theme.ink).withAlphaComponent(0.75)
        button.toolTip = label; button.setAccessibilityLabel(label)
        return button
    }
    func updateNSView(_ button: NSButton, context: Context) { context.coordinator.action = action }
    final class Coordinator: NSObject {
        var action: () -> Void
        init(action: @escaping () -> Void) { self.action = action }
        @objc func press(_ sender: NSButton) { action() }
    }
}
