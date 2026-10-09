import Foundation

enum Prefs {
    static let defaultServer = "https://127.0.0.1/agent"
    private static let d = UserDefaults.standard

    static var server: String {
        get { trim(d.string(forKey: "server") ?? defaultServer) }
        set { d.set(trim(newValue), forKey: "server") }
    }

    private static func trim(_ s: String) -> String {
        var s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }

    static var supportDir: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Doudou")
    }

    private static var tokenFile: URL { supportDir.appendingPathComponent("token") }

    /// Kept in a 0600 file rather than the keychain: ad-hoc signed builds would re-prompt for keychain access on every update.
    static var token: String {
        get { ((try? String(contentsOf: tokenFile, encoding: .utf8)) ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
        set {
            try? FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true)
            FileManager.default.createFile(atPath: tokenFile.path, contents: Data(newValue.utf8), attributes: [.posixPermissions: 0o600])
        }
    }

    static var configured: Bool { !server.isEmpty && !token.isEmpty }

    /// The capability walkthrough after the first login. Installs that were already paired before v0.2 skip it.
    static var onboarded: Bool {
        get { d.bool(forKey: "onboarded") }
        set { d.set(newValue, forKey: "onboarded") }
    }

    /// Run once at launch, before anything reads [onboarded].
    static func migrate() {
        if d.object(forKey: "onboarded") == nil { onboarded = configured }
    }

    /// 接收消息通知: pop a system notification for replies and finished jobs while the app is in the background.
    static var notifyMessages: Bool {
        get { d.object(forKey: "notifyMessages") as? Bool ?? true }
        set { d.set(newValue, forKey: "notifyMessages") }
    }

    /// When the first chat happened (ms since 1970); never changes once known, so it is fetched only once.
    static var firstChatAt: Double {
        get { d.double(forKey: "firstChatAt") }
        set { d.set(newValue, forKey: "firstChatAt") }
    }

    static func signOut() {
        token = ""
        d.removeObject(forKey: "firstChatAt")
    }

    static var deviceId: String {
        if let id = d.string(forKey: "deviceId") { return id }
        let id = "mac-" + UUID().uuidString.prefix(8).lowercased()
        d.set(id, forKey: "deviceId")
        return id
    }

    static var deviceName: String {
        get { d.string(forKey: "deviceName") ?? (Host.current().localizedName ?? "Mac") }
        set { d.set(newValue.trimmingCharacters(in: .whitespaces), forKey: "deviceName") }
    }

    static func granted(_ cap: String) -> Bool { d.bool(forKey: "cap.\(cap)") }
    static func setGranted(_ cap: String, _ on: Bool) { d.set(on, forKey: "cap.\(cap)") }

    /// The one folder the agent may list/read/write through the `folder` capability.
    static var folder: String? {
        get { d.string(forKey: "folder") }
        set { d.set(newValue, forKey: "folder") }
    }
}
