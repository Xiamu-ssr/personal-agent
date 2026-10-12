import SwiftUI

struct MainView: View {
    @Environment(\.openWindow) private var openWindow
    private var session: Session { .shared }
    private var nav: Nav { .shared }
    @State private var dropping = false
    @State private var windowActivity = WindowActivity()

    var body: some View {
        GeometryReader { windowGeometry in
        ZStack {
            Theme.canvas.ignoresSafeArea()
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
                    Text(nav.toast).font(Theme.font(size: 13)).foregroundStyle(Theme.ink)
                        .padding(.horizontal, 18).padding(.vertical, 10)
                        .background(Capsule().fill(Theme.card))
                        .padding(.bottom, 100)
                }
                .transition(.opacity)
                .allowsHitTesting(false)
            }
        }
        .environment(\.briefWindowHeight, windowGeometry.size.height)
        }
        .ignoresSafeArea(.container, edges: .top)
        .frame(minWidth: 920, minHeight: 640)
        .preferredColorScheme(Theme.scheme)
        .tint(Theme.accent)
        .foregroundStyle(Theme.ink)
        .font(Theme.font(size: Theme.bodySize))
        .background(WindowActivityReader(activity: windowActivity).frame(width: 0, height: 0))
        .environment(\.interactiveWindow, windowActivity.active)
        .onAppear { AppDelegate.openMain = { openWindow(id: "main") } }
        .task(id: "\(ChatClient.shared.connected)-\(ChatClient.shared.filesVersion)-\(windowActivity.active)") {
            if session.configured { await ProfileStore.shared.load() }
        }
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
            .foregroundStyle(Theme.accent)
            .background(RoundedRectangle(cornerRadius: 26, style: .continuous).fill(Theme.card))
            .overlay {
                VStack(spacing: 10) {
                    Image(systemName: "tray.and.arrow.down").font(Theme.font(size: 30, weight: .light))
                    Text("松开，把文件加到消息里").font(Theme.font(size: 15, weight: .medium))
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
                AgentAvatar(size: 34)
                Text(ProfileStore.shared.agentName).font(Theme.font(size: 15, weight: .semibold)).foregroundStyle(Theme.ink)
                AgentStatusDot()
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
        .background(Theme.card)
        .overlay(alignment: .trailing) { Rectangle().fill(Theme.card).frame(width: 1) }
    }

    private func item(_ t: Tab) -> some View {
        SidebarItem(tab: t, selected: nav.tab == t, badge: t == .tasks ? Set(chat.live.map(\.id) + chat.backgroundTasks.map(\.id)).count : 0) { nav.go(t) }
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
                        .font(Theme.font(size: 14, weight: .medium))
                        .foregroundStyle(selected ? Theme.goldText : tab.tint)
                }
                .frame(width: 32, height: 28)
                Text(tab.title)
                    .font(Theme.font(size: 14, weight: selected ? .semibold : .regular))
                    .foregroundStyle(selected ? Theme.goldText : Theme.ink.opacity(0.82))
                Spacer()
                if badge > 0 {
                    Text("\(badge)").font(Theme.font(size: 11, weight: .semibold)).foregroundStyle(Theme.goldText)
                        .padding(.horizontal, 7).frame(height: 18).background(Capsule().fill(Theme.userBubble))
                }
            }
            .padding(.horizontal, 8)
            .frame(height: 42)
            .background {
                if selected {
                    RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.goldWash)
                        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.line, lineWidth: 0.5))
                        .shadow(color: Theme.ink.opacity(0.025), radius: 6, y: 3)
                } else if hover {
                    RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.card)
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
                        Image(systemName: "xmark").font(Theme.font(size: 13, weight: .semibold)).foregroundStyle(.white)
                            .frame(width: 32, height: 32).background(Circle().fill(Theme.card))
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
