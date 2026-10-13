import Foundation

private struct CheckFailure: Error { let message: String }

private func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw CheckFailure(message: message) }
}

/// Compiled with the production Sources, without launching the app or reading its credential file.
@main
struct ServerAddressTests {
    static func main() async {
        // The test executable has its own defaults domain, separate from the installed app.
        let defaults = UserDefaults.standard
        let previous = defaults.object(forKey: "server")
        defer {
            if let previous { defaults.set(previous, forKey: "server") }
            else { defaults.removeObject(forKey: "server") }
        }
        do {
            defaults.removeObject(forKey: "server")
            try check(Prefs.server.isEmpty, "unsaved address must be empty")
            try check(!Prefs.configured, "unsaved address must show login without reading a credential")
            try check(Api.fileURL("data/sites/example/index.html") == nil, "empty file URL")
            try check(Api.wsRequest("app") == nil && Api.wsRequest("device") == nil, "empty websocket URL")
            print("PASS: fresh preferences require login; empty file and websocket URLs are skipped")

            for address in ["", " ", "\n\t "] {
                do {
                    _ = try Api.request("/api/state", server: address, token: "fixture-token")
                    throw CheckFailure(message: "empty HTTP request was accepted")
                } catch let error as ApiError {
                    try check(error.message == "请填写云端地址", "empty HTTP address message")
                }
                for password in ["123456", "fixture-token"] {
                    do {
                        _ = try await Api.authenticate(server: address, password: password)
                        throw CheckFailure(message: "empty login was accepted")
                    } catch let error as ApiError {
                        try check(error.message == "请填写云端地址", "empty login message")
                    }
                }
            }
            print("PASS: blank token and pairing logins fail before transport")

            for address in ["/agent", "https://", "https://user:secret@example.invalid/agent", "https://example.invalid/agent?other=1"] {
                Prefs.server = address
                try check(Api.serverURL() == nil, "invalid base URL")
                try check(Api.fileURL("data/sites/example/index.html") == nil, "invalid preview URL")
                try check(Api.wsRequest("app") == nil, "invalid websocket URL")
            }
            print("PASS: invalid base addresses cannot produce preview or websocket requests")

            Prefs.server = " https://example.invalid/agent/// "
            try check(Prefs.server == "https://example.invalid/agent", "saved address is preserved")
            let request = try Api.request("/api/state", server: Prefs.server, token: "fixture-token")
            try check(request.url?.absoluteString == "https://example.invalid/agent/api/state", "saved HTTP base")
            try check(Api.fileURL("data/sites/example/index.html")?.absoluteString == "https://example.invalid/agent/files/data/sites/example/index.html", "saved file base")
            print("PASS: saved user addresses still build the expected endpoints")
        } catch {
            print("FAIL: \(error)")
            exit(1)
        }
    }
}
