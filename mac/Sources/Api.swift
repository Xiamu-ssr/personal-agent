import AppKit

struct ApiError: LocalizedError {
    let code: Int
    let message: String
    var errorDescription: String? { message }
}

enum Api {
    static func request(_ path: String, method: String = "GET", body: [String: Any]? = nil) throws -> URLRequest {
        guard let u = URL(string: Prefs.server + path) else { throw ApiError(code: 0, message: "云端地址不对") }
        var r = URLRequest(url: u, timeoutInterval: 20)
        r.httpMethod = method
        if !Prefs.token.isEmpty { r.setValue("Bearer \(Prefs.token)", forHTTPHeaderField: "Authorization") }
        if let body {
            r.httpBody = try JSONSerialization.data(withJSONObject: body)
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return r
    }

    static func data(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> Data {
        let (d, resp) = try await URLSession.shared.data(for: request(path, method: method, body: body))
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            let msg = (try? JSONSerialization.jsonObject(with: d) as? [String: Any])?["error"] as? String
            throw ApiError(code: code, message: code == 401 ? "口令不对" : (msg ?? "HTTP \(code)"))
        }
        return d
    }

    static func json(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> [String: Any] {
        let d = try await data(path, method: method, body: body)
        return (try? JSONSerialization.jsonObject(with: d) as? [String: Any]) ?? [:]
    }

    static func wsRequest(_ role: String) -> URLRequest? {
        var base = Prefs.server
        if base.hasPrefix("https://") { base = "wss://" + base.dropFirst(8) } else if base.hasPrefix("http://") { base = "ws://" + base.dropFirst(7) }
        guard let u = URL(string: "\(base)/ws?role=\(role)") else { return nil }
        var r = URLRequest(url: u)
        r.setValue("Bearer \(Prefs.token)", forHTTPHeaderField: "Authorization")
        return r
    }

    static func filePath(_ dataPath: String) -> String {
        let allowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#"))
        return "/files/" + dataPath.split(separator: "/").map { $0.addingPercentEncoding(withAllowedCharacters: allowed) ?? String($0) }.joined(separator: "/")
    }

    /// Download a data/ file (briefs, sites) and open it with the default app.
    static func openFile(_ dataPath: String) async throws {
        let d = try await data(filePath(dataPath))
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("doudou", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let f = dir.appendingPathComponent(dataPath.replacingOccurrences(of: "/", with: "_"))
        try d.write(to: f)
        _ = await MainActor.run { NSWorkspace.shared.open(f) }
    }
}
