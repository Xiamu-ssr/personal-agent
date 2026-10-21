import AppKit
import Observation
import SwiftUI

private struct InteractiveWindowKey: EnvironmentKey { static let defaultValue = false }
private struct PageVisibleKey: EnvironmentKey { static let defaultValue = true }
extension EnvironmentValues {
    var pageVisible: Bool {
        get { self[PageVisibleKey.self] }
        set { self[PageVisibleKey.self] = newValue }
    }
    var interactiveWindow: Bool {
        get { self[InteractiveWindowKey.self] }
        set { self[InteractiveWindowKey.self] = newValue }
    }
}

@Observable
final class WindowActivity {
    var active = false
}

struct WindowActivityReader: NSViewRepresentable {
    let activity: WindowActivity
    func makeNSView(context: Context) -> ActivityView { ActivityView(activity: activity) }
    func updateNSView(_ nsView: ActivityView, context: Context) { nsView.applyAppearance() }
}

final class ActivityView: NSView {
    private let activity: WindowActivity
    private var observers: [NSObjectProtocol] = []
    private var appearancePending=false
    private var desiredAppearance:NSAppearance?
    private var desiredBackground:NSColor?
    init(activity: WindowActivity) { self.activity = activity; super.init(frame: .zero) }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    deinit { observers.forEach(NotificationCenter.default.removeObserver) }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        let center = NotificationCenter.default
        for name in [NSApplication.didBecomeActiveNotification, NSApplication.didResignActiveNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.refresh() })
        }
        if let window {
            for name in [NSWindow.didChangeOcclusionStateNotification, NSWindow.didMiniaturizeNotification,
                         NSWindow.didDeminiaturizeNotification, NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification,
                         NSWindow.willCloseNotification] {
                observers.append(center.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in self?.refresh() })
            }
        }
        applyAppearance()
        refresh()
    }

    func applyAppearance() {
        // Observe the selected theme here, then mutate AppKit after SwiftUI's
        // current graph update. Setting NSWindow.appearance synchronously from
        // updateNSView re-enters SwiftUI while its color-scheme graph is updating.
        desiredAppearance=Theme.appearance;desiredBackground=NSColor(Theme.background)
        guard !appearancePending else{return};appearancePending=true
        DispatchQueue.main.async { [weak self] in
            guard let self else{return};self.appearancePending=false
            guard let window=self.window else{return}
            if window.appearance?.name != self.desiredAppearance?.name {window.appearance=self.desiredAppearance}
            if let color=self.desiredBackground,window.backgroundColor != color {window.backgroundColor=color}
        }
    }

    private func refresh() {
        // Visibility changes only. No geometry measurements are written back into SwiftUI.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let active = NSApp.isActive && self.window?.isVisible == true &&
                         self.window?.occlusionState.contains(.visible) == true && self.window?.isMiniaturized == false
            if self.activity.active != active {
                self.activity.active = active
                #if MAC_PERF
                PerfProbe.shared.record(active ? "window_active" : "window_paused")
                #endif
            }
        }
    }
}

struct ActiveProgress: View {
    @Environment(\.interactiveWindow) private var active
    var body: some View {
        Group {
            if active { ProgressView() }
            else { Image(systemName: "ellipsis").foregroundStyle(Theme.faint) }
        }
    }
}
