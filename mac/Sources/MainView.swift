import SwiftUI

struct MainView: View {
    @Environment(\.openWindow) private var openWindow
    private var session: Session { .shared }
    private var nav: Nav { .shared }
    @State private var dropping = false

    var body: some View {
        ZStack {
            Theme.canvas.ignoresSafeArea()
            // A soft light from the top-right, like the brushed-metal reference.
            RadialGradient(colors: [.white.opacity(0.55), .clear], center: UnitPoint(x: 0.85, y: 0.0), startRadius: 0, endRadius: 520)
                .ignoresSafeArea()
            if !session.configured {
                LoginView()
            } else if !session.onboarded {
                OnboardingView()
            } else {
                HStack(spacing: 0) {
                    Sidebar()
                    content
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .onDrop(of: [.fileURL, .image], isTargeted: $dropping) {
                            guard nav.tab.prompt != nil, nav.stacks[nav.tab]?.isEmpty ?? true else { return false }
                            return Composer.shared.drop($0)
                        }
                        .overlay { if dropping { dropHint } }
                }
            }
            if let p = nav.preview { ImagePreview(path: p) }
            if !nav.toast.isEmpty {
                VStack {
                    Spacer()
                    Text(nav.toast).font(.system(size: 13)).foregroundStyle(.white)
                        .padding(.horizontal, 18).padding(.vertical, 10)
                        .background(Capsule().fill(Theme.ink.opacity(0.88)))
                        .padding(.bottom, 100)
                }
                .transition(.opacity)
                .allowsHitTesting(false)
            }
        }
        .ignoresSafeArea(.container, edges: .top)
        .frame(minWidth: 920, minHeight: 640)
        .preferredColorScheme(.light)
        .onAppear { AppDelegate.openMain = { openWindow(id: "main") } }
        .animation(.easeOut(duration: 0.2), value: nav.toast)
    }

    @ViewBuilder
    private var content: some View {
        let stack = nav.stacks[nav.tab] ?? []
        Group {
            if let top = stack.last {
                RouteView(route: top).id(top)
            } else {
                switch nav.tab {
                case .chat: ChatPage()
                case .today: TodayPage()
                case .tasks: TasksPage()
                case .memory: MemoryPage()
                case .home: HomePage()
                case .settings: SettingsPage()
                }
            }
        }
        .padding(.top, 26)
    }

    private var dropHint: some View {
        RoundedRectangle(cornerRadius: 26, style: .continuous)
            .strokeBorder(style: StrokeStyle(lineWidth: 2, dash: [8, 6]))
            .foregroundStyle(Color(hex: 0xC9A869))
            .background(RoundedRectangle(cornerRadius: 26, style: .continuous).fill(.white.opacity(0.55)))
            .overlay {
                VStack(spacing: 10) {
                    Image(systemName: "tray.and.arrow.down").font(.system(size: 30, weight: .light))
                    Text("松开，把文件加到消息里").font(.system(size: 15, weight: .medium))
                }
                .foregroundStyle(Theme.goldText)
            }
            .padding(20)
            .allowsHitTesting(false)
    }
}

struct Sidebar: View {
    private var nav: Nav { .shared }
    private var chat: ChatClient { .shared }
    private var device: DeviceClient { .shared }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 10) {
                Orb(size: 34)
                VStack(alignment: .leading, spacing: 2) {
                    Text("豆豆").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink)
                    HStack(spacing: 5) {
                        Dot(on: chat.connected)
                        Text(chat.connected ? (chat.busy ? (chat.toolHint.isEmpty ? "在想…" : chat.toolHint) : "在线") : "连接中…")
                            .font(.system(size: 11)).foregroundStyle(Theme.sub).lineLimit(1)
                    }
                }
            }
            .padding(.horizontal, 10)
            .padding(.top, 52)
            .padding(.bottom, 22)

            ForEach([Tab.chat, .today, .tasks, .memory, .home], id: \.self) { item($0) }
            Spacer()
            item(.settings)
                .padding(.bottom, 16)
        }
        .padding(.horizontal, 12)
        .frame(width: 208)
        .frame(maxHeight: .infinity)
        .background(.white.opacity(0.38))
        .overlay(alignment: .trailing) { Rectangle().fill(.white.opacity(0.8)).frame(width: 1) }
    }

    private func item(_ t: Tab) -> some View {
        SidebarItem(tab: t, selected: nav.tab == t, badge: t == .tasks ? chat.live.count : 0) { nav.go(t) }
    }
}

struct SidebarItem: View {
    let tab: Tab
    let selected: Bool
    var badge = 0
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 11) {
                ZStack {
                    if selected { GoldBase(radius: 10) }
                    Image(systemName: tab.icon)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(selected ? Theme.goldText : tab.tint)
                }
                .frame(width: 32, height: 28)
                Text(tab.title)
                    .font(.system(size: 14, weight: selected ? .semibold : .regular))
                    .foregroundStyle(selected ? Theme.goldText : Theme.ink.opacity(0.82))
                Spacer()
                if badge > 0 {
                    Text("\(badge)").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.goldText)
                        .padding(.horizontal, 7).frame(height: 18).background(Capsule().fill(Color(hex: 0xF3DFB0)))
                }
            }
            .padding(.horizontal, 8)
            .frame(height: 42)
            .background {
                if selected {
                    RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.goldWash)
                        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(.white.opacity(0.9), lineWidth: 1))
                        .shadow(color: Color(hex: 0x9C7440, alpha: 0.12), radius: 6, y: 3)
                } else if hover {
                    RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.white.opacity(0.55))
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}

/// Full-window image viewer for picture attachments.
struct ImagePreview: View {
    let path: String

    var body: some View {
        ZStack {
            Color.black.opacity(0.55).ignoresSafeArea()
                .onTapGesture { Nav.shared.preview = nil }
            RemoteImage(path: path, maxSide: 900)
                .shadow(color: .black.opacity(0.3), radius: 30, y: 10)
                .padding(40)
            VStack {
                HStack {
                    Spacer()
                    Button { Nav.shared.preview = nil } label: {
                        Image(systemName: "xmark").font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
                            .frame(width: 32, height: 32).background(Circle().fill(.white.opacity(0.18)))
                    }
                    .buttonStyle(.plain)
                    .keyboardShortcut(.cancelAction)
                }
                Spacer()
            }
            .padding(.top, 40)
            .padding(.trailing, 24)
        }
    }
}
