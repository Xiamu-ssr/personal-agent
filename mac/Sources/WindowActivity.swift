import AppKit
import Observation
import SwiftUI

private struct InteractiveWindowKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
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
    func updateNSView(_ nsView: ActivityView, context: Context) { nsView.applySkin() }
}

final class ActivityView: NSView {
    private let activity: WindowActivity
    private var observers: [NSObjectProtocol] = []
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
        applySkin()
        refresh()
    }

    func applySkin() {
        window?.appearance = Theme.appearance
        window?.backgroundColor = NSColor(Theme.background)
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

/// Coalesce incoming scroll requests without a layout preference or an animated scroll transaction.
@Observable
final class BottomFollower {
    var revision = 0
    @ObservationIgnored private var pending: DispatchWorkItem?
    func request() {
        guard pending == nil else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.pending = nil
            self.revision += 1
        }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: work)
    }
    func cancel() { pending?.cancel(); pending = nil }
    deinit { pending?.cancel() }
}
