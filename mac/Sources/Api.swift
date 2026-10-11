import AppKit

struct ApiError: LocalizedError {
    let code: Int
    let message: String
    var errorDescription: String? { message }
}

/// One entry of GET /api/tree (newest first).
struct TreeEntry: Identifiable, Hashable {
    let name: String
    let dir: Bool
    let size: Int
    let mtime: Date
    var id: String { name }
}

enum Api {
    /// Explicit loopback verification never reads or forwards a saved credential.
    static var authToken: String { LocalVerification.explicitLoopback ? "local-fixture" : Prefs.token }
    /// Shared transport; validation can replace it with an in-memory URLProtocol.
    static var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        return URLSession(configuration: config)
    }()
    static func request(_ path: String, method: String = "GET", body: [String: Any]? = nil,
                        server: String = Prefs.server, token: String = Api.authToken) throws -> URLRequest {
        guard let u = URL(string: server + path) else { throw ApiError(code: 0, message: "云端地址不对") }
        var r = URLRequest(url: u, timeoutInterval: 20)
        r.httpMethod = method
        if !token.isEmpty { r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            r.httpBody = try JSONSerialization.data(withJSONObject: body)
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return r
    }

    static func data(_ path: String, method: String = "GET", body: [String: Any]? = nil,
                     server: String = Prefs.server, token: String = Api.authToken) async throws -> Data {
        try await send(request(path, method: method, body: body, server: server, token: token))
    }

    private static func send(_ req: URLRequest) async throws -> Data {
        let (d, resp) = try await session.data(for: req)
        try validate(d, resp)
        return d
    }

    private static func validate(_ d: Data, _ resp: URLResponse) throws {
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            let msg = (try? JSONSerialization.jsonObject(with: d) as? [String: Any])?["error"] as? String
            throw ApiError(code: code, message: msg ?? "HTTP \(code)")
        }
    }

    static func json(_ path: String, method: String = "GET", body: [String: Any]? = nil,
                     server: String = Prefs.server, token: String = Api.authToken) async throws -> [String: Any] {
        let d = try await data(path, method: method, body: body, server: server, token: token)
        guard let object = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else {
            throw ApiError(code: 0, message: "云端返回的数据不是 JSON")
        }
        return object
    }

    /// Validate credentials without changing the saved account on failure.
    static func authenticate(server: String, password: String) async throws -> String {
        guard let u = URL(string: server), ["https", "http"].contains(u.scheme?.lowercased() ?? ""),
              u.host != nil, u.user == nil, u.password == nil, u.query == nil, u.fragment == nil else {
            throw ApiError(code: 0, message: "云端地址不对")
        }
        var token = password
        if password.count == 6 && password.allSatisfy({ $0.isASCII && $0.isNumber }) {
            let r = try await json("/api/pair", method: "POST", body: ["code": password], server: server, token: "")
            guard let t = r["token"] as? String, !t.isEmpty else { throw ApiError(code: 0, message: "云端没给口令") }
            token = t
        }
        let state = try await json("/api/state", server: server, token: token)
        guard state["busy"] is Bool else { throw ApiError(code: 0, message: "这个地址没有返回豆豆的登录状态") }
        return token
    }

    /// Ask the server to issue its WebView cookie. Never synthesize a cookie in the app.
    static func webCookies(server: String = Prefs.server, token: String = Api.authToken) async throws -> [HTTPCookie] {
        let req = try request("/api/login", method: "POST", body: ["token": token], server: server, token: token)
        let (d, resp) = try await session.data(for: req)
        try validate(d, resp)
        guard let http = resp as? HTTPURLResponse, let url = http.url else { return [] }
        let headers = Dictionary(uniqueKeysWithValues: http.allHeaderFields.map { (String(describing: $0.key), String(describing: $0.value)) })
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: headers, for: url)
        guard cookies.contains(where: { $0.name == "pa_token" }) else {
            throw ApiError(code: 0, message: "云端没有返回网页登录 cookie")
        }
        return cookies
    }

    /// POST raw bytes (uploads, audio) and decode the JSON reply.
    static func post(_ path: String, raw: Data, timeout: TimeInterval = 120) async throws -> [String: Any] {
        var r = try request(path, method: "POST")
        r.timeoutInterval = timeout
        r.httpBody = raw
        r.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        let d = try await send(r)
        guard let object = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else {
            throw ApiError(code: 0, message: "云端返回的数据不是 JSON")
        }
        return object
    }

    private static let queryAllowed = CharacterSet.urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+?#"))

    /// Store a file under data/uploads/<date>/ and return the attachment the chat message should carry.
    static func upload(_ data: Data, name: String, kind: String) async throws -> Attachment {
        guard data.count <= 20 << 20 else { throw ApiError(code: 413, message: "文件太大（上限 20MB）") }
        let q = name.addingPercentEncoding(withAllowedCharacters: queryAllowed) ?? "file"
        let r = try await post("/api/upload?name=\(q)", raw: data)
        guard let path = r["path"] as? String else { throw ApiError(code: 0, message: "上传失败") }
        return Attachment(path: path, name: r["name"] as? String ?? name, kind: kind)
    }

    /// Hold-to-talk: audio in, text out. Nothing is stored on the server.
    static func transcribe(_ audio: Data, format: String) async throws -> String {
        guard audio.count <= 10 << 20 else { throw ApiError(code: 413, message: "录音太大（转写上限 10MB）") }
        let r = try await post("/api/transcribe?format=\(format)", raw: audio, timeout: 100)
        return (r["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func tree(_ dir: String) async throws -> [TreeEntry] {
        let q = dir.addingPercentEncoding(withAllowedCharacters: queryAllowed) ?? dir
        let r = try await json("/api/tree?dir=\(q)")
        return (r["entries"] as? [[String: Any]] ?? []).map {
            TreeEntry(name: $0["name"] as? String ?? "", dir: $0["dir"] as? Bool ?? false, size: $0["size"] as? Int ?? 0,
                      mtime: Date(timeIntervalSince1970: ($0["mtime"] as? Double ?? 0) / 1000))
        }
    }

    /// A text file under data/ (Markdown memory, diary).
    static func text(_ dataPath: String) async throws -> String {
        String(decoding: try await data(filePath(dataPath)), as: UTF8.self)
    }

    private static let cache: NSCache<NSString, NSData> = {
        let c = NSCache<NSString, NSData>()
        c.totalCostLimit = 64 << 20
        return c
    }()

    /// Bytes of a data/ file, kept in memory (thumbnails, voice notes).
    static func clearCache() { cache.removeAllObjects() }

    static func cached(_ dataPath: String) async throws -> Data {
        if let d = cache.object(forKey: dataPath as NSString) { return d as Data }
        let d = try await data(filePath(dataPath))
        cache.setObject(d as NSData, forKey: dataPath as NSString, cost: d.count)
        return d
    }

    static func wsRequest(_ role: String) -> URLRequest? {
        var base = Prefs.server
        if base.hasPrefix("https://") { base = "wss://" + base.dropFirst(8) } else if base.hasPrefix("http://") { base = "ws://" + base.dropFirst(7) }
        guard let u = URL(string: "\(base)/ws?role=\(role)") else { return nil }
        var r = URLRequest(url: u)
        r.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        return r
    }

    static func filePath(_ dataPath: String) -> String {
        let allowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/%?#"))
        return "/files/" + dataPath.split(separator: "/").map { $0.addingPercentEncoding(withAllowedCharacters: allowed) ?? String($0) }.joined(separator: "/") + (dataPath.hasSuffix("/") ? "/" : "")
    }

    static func fileURL(_ dataPath: String) -> URL? { URL(string: Prefs.server + filePath(dataPath)) }

    /// Download a data/ file and open it with the default app (PDFs, documents the window can't show).
    static func openExternally(_ dataPath: String) async throws {
        let d = try await data(filePath(dataPath))
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("doudou", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let f = dir.appendingPathComponent((dataPath as NSString).lastPathComponent)
        try d.write(to: f)
        _ = await MainActor.run { NSWorkspace.shared.open(f) }
    }
}
