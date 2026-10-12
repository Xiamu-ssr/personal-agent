import AppKit
import SwiftUI

struct TodaySwipeReceiver: NSViewRepresentable {
    @Binding var selection: Int
    func makeNSView(context: Context) -> TodaySwipeView { TodaySwipeView(selection: $selection) }
    func updateNSView(_ view: TodaySwipeView, context: Context) { view.selection = $selection }
    static func dismantleNSView(_ view: TodaySwipeView, coordinator: ()) { view.detach() }
}
final class TodaySwipeView: NSView {
    var selection: Binding<Int>
    private var monitor: Any?
    private var accumulated: CGFloat = 0
    private var switched = false
    init(selection: Binding<Int>) { self.selection = selection; super.init(frame: .zero) }
    required init?(coder: NSCoder) { fatalError() }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow(); detach()
        guard window != nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            guard let self else { return event }; return self.handle(event)
        }
    }
    func handle(_ event: NSEvent) -> NSEvent? {
        guard event.window === window, bounds.contains(convert(event.locationInWindow, from: nil)),
              event.hasPreciseScrollingDeltas else { return event }
        if event.phase.contains(.began) || event.phase.contains(.mayBegin) { accumulated = 0; switched = false }
        guard abs(event.scrollingDeltaX) > abs(event.scrollingDeltaY) else { return event }
        let content = window?.contentView
        let hitPoint = content?.superview?.convert(event.locationInWindow, from: nil) ?? event.locationInWindow
        var hit = content?.hitTest(hitPoint)
        while let view = hit {
            if view is NSTextView { return event }
            if let scroll = view as? NSScrollView, scroll.hasHorizontalScroller,
               (scroll.documentView?.bounds.width ?? 0) > scroll.contentView.bounds.width + 1 { return event }
            hit = view.superview
        }
        accumulated += event.scrollingDeltaX
        if !switched && abs(accumulated) > 45 {
            let next = min(1, max(0, selection.wrappedValue + (accumulated < 0 ? 1 : -1)))
            if selection.wrappedValue != next { selection.wrappedValue = next }
            switched = true
        }
        return nil
    }
    func detach() { if let monitor { NSEvent.removeMonitor(monitor); self.monitor = nil } }
    deinit { detach() }
}
