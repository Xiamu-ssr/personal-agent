import SwiftUI

/// The menu-bar bubble: a quick chat that stays around when the main window is closed.
struct MenuView: View {
    @State private var dropping = false
    @State private var windowActivity = WindowActivity()
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
                    AgentAvatar(size: 56)
                    Text("还没登录").font(Theme.font(size: 15, weight: .semibold)).foregroundStyle(Theme.ink)
                    Button("打开豆豆登录", action: openMain).buttonStyle(PrimaryButtonStyle(height: 34))
                    Spacer()
                }
                .frame(maxWidth: .infinity)
            }
        }
        .frame(width: 380, height: 540)
        .background(Theme.canvas)
        .preferredColorScheme(Theme.scheme)
        .background(WindowActivityReader(activity: windowActivity).frame(width: 0, height: 0))
        .environment(\.interactiveWindow, windowActivity.active)
        .environment(\.pageVisible, windowActivity.visible)
        .task(id:windowActivity.visible) {
            guard windowActivity.visible,session.configured else{return}
            await ProfileStore.shared.load();await chat.catchUp()
        }
    }

    private func openMain() {
        AppDelegate.openMain?()
        MenuController.shared.close()
        NSApp.activate(ignoringOtherApps: true)
    }

    private var header: some View {
        HStack(spacing: 10) {
            AgentAvatar(size: 28)
            Text(ProfileStore.shared.agentName).font(Theme.font(size: 14, weight: .semibold)).foregroundStyle(Theme.ink)
            Spacer()
            MenuActionButton(symbol: "macwindow", label: "打开主窗口", action: openMain).frame(width: 20, height: 24)
            MenuActionButton(symbol: "power", label: "退出豆豆") { NSApp.terminate(nil) }.frame(width: 20, height: 24)
        }
        .foregroundStyle(Theme.ink.opacity(0.75))
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var messages: some View { ChatMessages(compact: true) }

    private var composer: some View {
        ComposerBar(placeholder:"跟豆豆说…",compact:true).padding(10)
            .onDrop(of:[.fileURL,.image],isTargeted:$dropping) { Composer.shared.drop($0) }
            .overlay { if dropping { RoundedRectangle(cornerRadius:20).strokeBorder(Theme.ink,style:StrokeStyle(lineWidth:1,dash:[4])).padding(8).allowsHitTesting(false) } }
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
    func updateNSView(_ button: NSButton, context: Context) {
        context.coordinator.action = action
        button.contentTintColor = NSColor(Theme.ink).withAlphaComponent(0.75)
    }
    final class Coordinator: NSObject {
        var action: () -> Void
        init(action: @escaping () -> Void) { self.action = action }
        @objc func press(_ sender: NSButton) { action() }
    }
}
