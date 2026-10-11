import AppKit
import ApplicationServices

enum FolderPermission {
    static func directory(for name: String) -> URL? {
        let directory: FileManager.SearchPathDirectory
        switch name {
        case "folder_desktop": directory = .desktopDirectory
        case "folder_documents": directory = .documentDirectory
        case "folder_downloads": directory = .downloadsDirectory
        default: return nil
        }
        return FileManager.default.urls(for: directory, in: .userDomainMask).first
    }

    static func request(_ name: String) async -> String? {
        guard let url = directory(for: name) else { return "没有这个文件夹" }
        return await Task.detached {
            do {
                // This actual directory read triggers Files and Folders TCC; access() alone does not.
                _ = try FileManager.default.contentsOfDirectory(atPath: url.path)
                _ = try FileManager.default.contentsOfDirectory(atPath: url.path)
                return nil as String?
            } catch {
                return "无法访问\(url.lastPathComponent)，请在「系统设置 → 隐私与安全性 → 文件与文件夹」允许豆豆：\(error.localizedDescription)"
            }
        }.value
    }
}

enum DevicePermissions {
    @MainActor
    static func computerUse() async -> String? {
        let screen = await requestScreenRecording()
        let accessibility = await requestAccessibility()
        let errors = [screen, accessibility].compactMap { $0 }
        return errors.isEmpty ? nil : errors.joined(separator: "；")
    }

    @MainActor
    static func requestScreenRecording() async -> String? {
        await request(panel: "Privacy_ScreenCapture", title: "屏幕录制", granted: { CGPreflightScreenCaptureAccess() }, prompt: {
            // Register the signed app with TCC, even on a fresh install. The UI keeps polling independently.
            Task.detached { _ = CGRequestScreenCaptureAccess() }
        })
    }

    @MainActor
    static func requestAccessibility() async -> String? {
        await request(panel: "Privacy_Accessibility", title: "辅助功能", granted: { AXIsProcessTrusted() }, prompt: {
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
        })
    }

    @MainActor
    private static func request(panel: String, title: String, granted: () -> Bool, prompt: () -> Void) async -> String? {
        if granted() { return nil }
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(panel)"),
              NSWorkspace.shared.open(url) else { return "无法打开\(title)设置，请手动在隐私与安全性中允许豆豆" }
        prompt()
        let deadline = ProcessInfo.processInfo.systemUptime + 120
        while ProcessInfo.processInfo.systemUptime < deadline {
            if granted() { return nil }
            do { try await Task.sleep(nanoseconds: 500_000_000) }
            catch { return "\(title)授权等待已取消" }
        }
        return "等待\(title)授权超过 2 分钟，请在系统设置里开启；若系统提示，退出并重新打开豆豆"
    }
}
