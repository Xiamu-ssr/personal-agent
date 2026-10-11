import SwiftUI

extension View {
    /// A geometry marker for native clicks in the owned verification window. Absent in app builds.
    @ViewBuilder func verificationAction(_ name: String) -> some View {
        #if MAC_VERIFY
        background(VerificationActionAnchor(name: name).allowsHitTesting(false))
        #else
        self
        #endif
    }
}

#if MAC_VERIFY
struct VerificationActionAnchor: NSViewRepresentable {
    static let views = NSMapTable<NSString, NSView>.strongToWeakObjects()
    let name: String
    func makeNSView(context: Context) -> Marker {
        let view = Marker(); view.name = name; Self.views.setObject(view, forKey: name as NSString); return view
    }
    func updateNSView(_ view: Marker, context: Context) {
        guard view.name != name else { return }
        if Self.views.object(forKey: view.name as NSString) === view { Self.views.removeObject(forKey: view.name as NSString) }
        view.name = name; Self.views.setObject(view, forKey: name as NSString)
    }
    static func dismantleNSView(_ view: Marker, coordinator: ()) {
        if views.object(forKey: view.name as NSString) === view { views.removeObject(forKey: view.name as NSString) }
    }
    final class Marker: NSView {
        var name = ""
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
}
#endif
