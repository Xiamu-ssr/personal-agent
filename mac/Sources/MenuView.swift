import SwiftUI

/// The menu-bar bubble: a quick chat that stays around when the main window is closed.
struct MenuView: View {
    @Environment(\.openWindow) private var openWindow
    @State private var input = ""
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
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(chat.items.suffix(60)) { MessageRow(item: $0, compact: true) }
                    if !chat.streaming.isEmpty { AssistantBubble(text: chat.streaming, compact: true) }
                    if chat.busy && chat.streaming.isEmpty { Thinking(hint: chat.toolHint) }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(12)
            }
            .onAppear { proxy.scrollTo("end", anchor: .bottom) }
            .onChange(of: chat.items.count) { proxy.scrollTo("end", anchor: .bottom) }
            .onChange(of: chat.streaming) { proxy.scrollTo("end", anchor: .bottom) }
        }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("跟豆豆说…（⌥↩ 换行）", text: $input, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.system(size: 13))
                .lineLimit(1...5)
                .onSubmit(send)
                .padding(.vertical, 8)
            if chat.busy {
                Button { chat.interrupt() } label: { Image(systemName: "stop.fill").frame(width: 30, height: 30) }
                    .buttonStyle(.plain).help("让豆豆停下")
            } else {
                Button(action: send) {
                    ZStack {
                        GoldBase()
                        Image(systemName: "arrow.up").font(.system(size: 13, weight: .bold)).foregroundStyle(Theme.goldText)
                    }
                    .frame(width: 30, height: 30)
                }
                .buttonStyle(.plain)
                .disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 4)
        .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(.white.opacity(0.85)))
        .padding(10)
    }

    private func send() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !chat.busy else { return }
        if chat.send(text) { input = "" }
    }
}
