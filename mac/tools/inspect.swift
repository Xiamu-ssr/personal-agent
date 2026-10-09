import AppKit
import ApplicationServices
let capture = CGPreflightScreenCaptureAccess()
print("screenCapture=\(capture), accessibility=\(AXIsProcessTrusted())")
for app in NSWorkspace.shared.runningApplications where app.bundleIdentifier == "com.xiamu.agent.mac" {
    print("Doudou pid=\(app.processIdentifier), regular=\(app.activationPolicy == .regular), bundle=\(app.bundleURL?.path ?? "")")
    if capture, let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
        for row in list where row[kCGWindowOwnerPID as String] as? Int32 == app.processIdentifier {
            print("window=\(row[kCGWindowNumber as String] ?? ""), layer=\(row[kCGWindowLayer as String] ?? ""), bounds=\(row[kCGWindowBounds as String] ?? "")")
        }
    }
}
