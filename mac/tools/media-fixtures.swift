import AppKit
import AVFoundation
import CryptoKit
import Network

@MainActor enum MediaFixtures {
    static func run() async throws {
        let root = "data/files/fixture-\(UUID())/"
        func row(_ name: String, _ kind: String, _ mime: String = "application/octet-stream") -> [String: Any] {
            ["path": root + name, "name": name, "kind": kind, "mime": mime, "size": 64044]
        }
        let rows = [row("图片.png", "image", "image/png"), row("演示.MP4", "video", "video/mp4"),
                    row("会议 录音.wav", "audio", "audio/wav"), row("报告.pdf", "file", "application/pdf")]
        let parsed = MediaItem.parse(rows)
        try check(parsed.count == 4 && parsed.map(\.kind) == [.image, .video, .audio, .file] && parsed[2].mime == "audio/wav" && parsed[2].size == 64044,
                  "reply media preserves order, kinds, MIME and measured byte sizes")
        let historyRow: [String: Any] = ["role": "assistant", "text": "正文链接", "ts": 1000, "media": rows]
        try check(ChatClient.item(historyRow)?.media == parsed, "assistant history media parsing")
        let hello = ChatClient(sender: { _ in true })
        hello.handle(["t": "hello", "history": [historyRow]])
        try check(hello.items.first?.media == parsed, "hello history attaches media")
        hello.stop()
        print("PASS: media assistant history and hello preserve ordered path/name/kind/MIME/size")
        try check(MediaItem.parse(nil).isEmpty && MediaItem.parse(NSNull()).isEmpty && MediaItem.parse("invalid").isEmpty &&
                  ChatClient.item(["role": "assistant", "text": "旧正文"])?.media.isEmpty == true, "missing media preserves old records")
        try check(MediaItem.parse([["path": root + "bad"]]).isEmpty, "incomplete media entries do not break the message")
        let unknown = MediaItem.parse([row("未知.bin", "future")])
        try check(unknown.first?.kind == .file, "unknown kind renders as file")
        print("PASS: media legacy/missing/malformed records and unknown kinds")
        for (name, kind, expected) in [("image.png", "image", MediaPresentation.image), ("video.MP4", "video", .video),
                                      ("audio.mp3", "audio", .audio), ("file.zip", "file", .file), ("video.WEBM", "video", .file),
                                      ("audio.ogg", "audio", .file), ("audio.OPUS", "audio", .file), ("audio.flac", "audio", .audio)] {
            try check(MediaPresentation.forItem(MediaItem(row(name, kind))!) == expected, "media presentation \(name)")
        }
        print("PASS: media kind-to-view mapping, case-insensitive webm/ogg/opus file fallback")
        for (path, expected) in [("data/files/a.HTML", Nav.FilePresentation.web), ("data/files/a.md", .text), ("data/files/a.txt", .text),
                                 ("data/files/a.PDF", .web), ("data/files/a.docx", .external), ("data/files/a.mp4", .external),
                                 ("data/files/a.ogg", .external), ("data/files/a.png", .image), ("data/sites/demo", .web),
                                 ("data/briefs/2026-10-13/简报.html", .brief)] {
            try check(Nav.filePresentation(path) == expected, "file open destination \(path)")
        }
        try check(MediaFileCard.icon("a.webm") == "film" && MediaFileCard.icon("a.opus") == "waveform" && MediaFileCard.icon("a.PDF") == "doc.richtext",
                  "fallback file cards retain media and document type icons")
        print("PASS: media file opening uses authenticated web for HTML/PDF, native text, or downloaded default-app files")
        let path = root + "中文 100%?x#y+z.wav"
        let url = Api.fileURL(path, server: "https://fixture.invalid/agent")!
        try check(url.path == "/agent/files/" + path && url.query == nil && url.fragment == nil &&
                  url.absoluteString.contains("%20") && url.absoluteString.contains("%25") && url.absoluteString.contains("%3F") &&
                  url.absoluteString.contains("%23"), "media file URL encodes each path component exactly once")
        print("PASS: media file URLs preserve spaces/Chinese/percent/query/fragment characters")
        let chat = ChatClient(sender: { _ in true })
        defer { chat.stop() }
        chat.handle(["t": "delta", "text": "流式正文", "media": rows])
        try await Task.sleep(nanoseconds: 300_000_000)
        try check(chat.streaming == "流式正文" && chat.items.isEmpty, "deltas remain Markdown only")
        let identity = chat.streamID
        chat.handle(["t": "turn_end", "text": "完成正文", "media": rows])
        try check(chat.items.last?.id == identity && chat.items.last?.media == parsed && chat.streaming.isEmpty, "turn_end attaches media to completed stream")
        chat.handle(["t": "turn_end", "text": "旧回复"])
        try check(chat.items.last?.media.isEmpty == true, "legacy turn_end remains readable")
        chat.handle(["t": "turn_end", "text": "部分回复", "partial": true, "media": rows])
        try check(chat.items.last?.media.isEmpty == true, "partial turns do not render media")
        chat.handle(["t": "turn_end", "text": "出错回复", "error": "本地错误", "media": rows])
        try check(chat.items.filter { $0.kind == .assistant }.last?.media.isEmpty == true, "error turns do not render media")
        print("PASS: media delta-to-turn_end lifecycle, stable identity, legacy/partial/error turns")
        let task = try TaskHistory.parse(["id": "media-task", "title": "任务", "status": "done", "items": [
            ["kind": "prompt", "from": "agent", "text": "交代"], ["kind": "result", "text": "任务结果", "media": rows]]], id: "media-task")
        try check(task.items[0].message.media.isEmpty && task.items[1].message.media == parsed && task.items[1].message.kind == .assistant,
                  "task results share assistant media rendering while old rows remain valid")
        print("PASS: media task result parsing shares assistant rendering and legacy support")
        let bounds = NSRect(x: 0, y: 0, width: 300, height: 220)
        try check(MediaVisibilityObserver.visible(bounds: bounds, clipped: NSRect(x: 0, y: 200, width: 300, height: 20)) &&
                  !MediaVisibilityObserver.visible(bounds: bounds, clipped: NSRect(x: 0, y: 220, width: 300, height: 20)) &&
                  !MediaVisibilityObserver.visible(bounds: .zero, clipped: bounds), "clipped and empty media rows must stop decoding")
        print("PASS: media clip visibility handles partly visible, offscreen and empty rows")

        let server = try MediaHTTPFixture()
        try await server.start()
        let base = "http://127.0.0.1:\(server.port)/agent", token = "local-media-fixture"
        let session = Api.session
        Api.session = URLSession(configuration: .ephemeral)
        let media = MediaItem(row("会议 录音.wav", "audio", "audio/wav"))!
        let fallback = MediaItem(row("fallback.wav", "audio", "audio/wav"))!
        let invalid = MediaItem(row("unplayable.wav", "audio", "audio/wav"))!
        let missing = MediaItem(row("missing.wav", "audio", "audio/wav"))!
        let first = MediaPlayback(), second = MediaPlayback(), cached = MediaPlayback(), unsupported = MediaPlayback(), unavailable = MediaPlayback(), cancelled = MediaPlayback()
        defer {
            [first, second, cached, unsupported, unavailable, cancelled].forEach { $0.release() }
            Api.session.invalidateAndCancel(); Api.session = session; server.close()
            let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("com.xiamu.agent.mac/media")
            for name in ["会议 录音.wav", "fallback.wav", "unplayable.wav", "missing.wav", "slow.wav", "other/会议 录音.wav"] {
                let key = SHA256.hash(data: Data((base + "/" + root + name).utf8)).map { String(format: "%02x", $0) }.joined()
                try? FileManager.default.removeItem(at: cache.appendingPathComponent(key))
            }
        }
        await first.prepare(media, server: base, token: token)
        try check(first.player != nil && !first.usingCache && first.duration > 3.9 && first.player?.rate == 0,
                  "real AVURLAsset accepts Bearer header and prepares paused WAV playback")
        try check(server.requests.contains { $0.path.contains(".wav") && $0.headers["authorization"] == "Bearer " + token && $0.headers["range"] != nil },
                  "real AVFoundation requests include authentication and Range")
        print("PASS: media real AVURLAsset Bearer/Range requests on loopback; paused preparation and duration")
        first.player?.isMuted = true
        first.seek(2)
        for _ in 0..<100 where abs((first.player?.currentTime().seconds ?? 0) - 2) > 0.1 { try await Task.sleep(nanoseconds: 10_000_000) }
        try check(abs((first.player?.currentTime().seconds ?? 0) - 2) < 0.1, "real media seek reaches selected time")
        print("PASS: media real AVPlayer seek updates playback position")
        await second.prepare(media, server: base, token: token)
        second.player?.isMuted = true
        first.player?.play()
        for _ in 0..<100 where !first.playing { try await Task.sleep(nanoseconds: 5_000_000) }
        second.player?.play()
        for _ in 0..<100 where first.player?.rate != 0 { try await Task.sleep(nanoseconds: 5_000_000) }
        try check(first.player?.rate == 0 && second.player?.rate != 0, "native player controls pause the previous player")
        second.pause()
        var voicePlaying = true
        MediaPlaybackFocus.claim(UUID()) { voicePlaying = false }
        second.player?.play()
        for _ in 0..<100 where voicePlaying { try await Task.sleep(nanoseconds: 5_000_000) }
        try check(!voicePlaying, "reply media also claims the shared voice-note playback focus")
        let released = second.player!
        second.release()
        try check(second.player == nil && released.rate == 0 && released.currentItem == nil && !second.playing && second.duration == 0,
                  "release pauses playback, removes item and clears observable progress")
        print("PASS: media only one native/voice focus plays; release pauses/detaches player and resets progress")
        let downloaded = try await Api.download(media.path, server: base, token: token)
        let other = try await Api.download(root + "other/会议 录音.wav", server: base, token: token)
        let downloadedData = try Data(contentsOf: downloaded)
        try check(downloadedData == MediaHTTPFixture.wav && downloaded != other && downloaded.lastPathComponent == "会议 录音.wav",
                  "authenticated disk downloads retain bytes/name and separate same-name server paths")
        print("PASS: media authenticated disk download preserves bytes and prevents filename collisions")
        await cached.prepare(fallback, server: base, token: token)
        try check(cached.usingCache && cached.player != nil && cached.player?.rate == 0 && (cached.player?.currentItem?.asset as? AVURLAsset)?.url.isFileURL == true,
                  "rejected ranged stream falls back to authenticated disk download and paused local playback")
        print("PASS: media stream failure falls back to authenticated cache and local AVPlayer")
        await unsupported.prepare(invalid, server: base, token: token)
        try check(unsupported.unsupported && unsupported.player == nil && !unsupported.failed, "unplayable asset becomes file card")
        await unavailable.prepare(missing, server: base, token: token)
        try check(unavailable.failed && unavailable.player == nil, "missing remote file becomes unavailable without a player")
        print("PASS: media runtime unplayable assets fall back to files; missing files show unavailable")
        let preparing = Task { @MainActor in await cancelled.prepare(MediaItem(row("slow.wav", "audio", "audio/wav"))!, server: base, token: token) }
        try await Task.sleep(nanoseconds: 10_000_000)
        cancelled.release(); preparing.cancel(); await preparing.value
        try check(cancelled.player == nil && !cancelled.loading && !cancelled.failed, "disappearing during asset load cannot install a late player")
        print("PASS: media release during delayed loading cancels work and prevents late playback")
    }
}

private final class MediaHTTPFixture {
    struct Request { let path: String; let headers: [String: String] }
    private let listener: NWListener
    private let queue = DispatchQueue(label: "doudou.media.fixture")
    private let lock = NSLock()
    private var recorded: [Request] = []
    private var connections: [NWConnection] = []
    private var startupComplete = false
    var requests: [Request] { lock.lock(); defer { lock.unlock() }; return recorded }
    var port: UInt16 { listener.port!.rawValue }
    init() throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
    }
    func start() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            listener.stateUpdateHandler = { [weak self] state in
                guard let self, !self.startupComplete else { return }
                if case .ready = state { self.startupComplete = true; continuation.resume() }
                if case .failed(let error) = state { self.startupComplete = true; continuation.resume(throwing: error) }
            }
            listener.newConnectionHandler = { [weak self] connection in
                guard let self else { return }
                self.connections.append(connection); connection.start(queue: self.queue); self.receive(connection, data: Data())
            }
            listener.start(queue: queue)
        }
    }
    private func receive(_ connection: NWConnection, data: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] next, _, complete, error in
            guard let self, error == nil else { connection.cancel(); return }
            let data = data + (next ?? Data())
            guard let request = String(data: data, encoding: .utf8), request.contains("\r\n\r\n") else {
                if !complete { self.receive(connection, data: data) } else { connection.cancel() }; return
            }
            let lines = request.components(separatedBy: "\r\n"), first = lines[0].split(separator: " ")
            guard first.count >= 2 else { connection.cancel(); return }
            let path = String(first[1]), method = String(first[0])
            let headers = Dictionary(lines.dropFirst().compactMap { line -> (String, String)? in
                guard let colon = line.firstIndex(of: ":") else { return nil }
                return (line[..<colon].lowercased(), line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces))
            }, uniquingKeysWith: { _, new in new })
            self.lock.lock(); self.recorded.append(Request(path: path, headers: headers)); self.lock.unlock()
            var body = path.contains("unplayable") ? Data("not playable".utf8) : Self.wav
            var status = "200 OK", extra = ""
            if headers["authorization"] != "Bearer local-media-fixture" { status = "401 Unauthorized"; body = Data() }
            else if path.contains("missing") { status = "404 Not Found"; body = Data() }
            else if path.contains("fallback"), headers["range"] != nil { status = "403 Forbidden"; body = Data() }
            else if let range = headers["range"], range.hasPrefix("bytes=") {
                let parts = range.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
                let start = Int(parts.first ?? "") ?? 0, end = min(Int(parts.last ?? "") ?? (body.count - 1), body.count - 1)
                if start <= end && start >= 0 {
                    status = "206 Partial Content"; extra = "Content-Range: bytes \(start)-\(end)/\(body.count)\r\n"
                    body = body.subdata(in: start..<(end + 1))
                } else { status = "416 Range Not Satisfiable"; body = Data() }
            }
            let header = "HTTP/1.1 \(status)\r\nContent-Type: audio/wav\r\nContent-Length: \(body.count)\r\nAccept-Ranges: bytes\r\n\(extra)Connection: close\r\n\r\n"
            let content = Data(header.utf8) + (method == "HEAD" ? Data() : body)
            let send: @Sendable () -> Void = { connection.send(content: content, completion: .contentProcessed { _ in connection.cancel() }) }
            if path.contains("slow") { self.queue.asyncAfter(deadline: .now() + 0.08, execute: send) } else { send() }
        }
    }
    func close() { queue.sync { listener.cancel(); connections.forEach { $0.cancel() }; connections = [] } }
    static let wav: Data = {
        var data = Data()
        func text(_ value: String) { data.append(Data(value.utf8)) }
        func u16(_ value: UInt16) { var value = value.littleEndian; withUnsafeBytes(of: &value) { data.append(contentsOf: $0) } }
        func u32(_ value: UInt32) { var value = value.littleEndian; withUnsafeBytes(of: &value) { data.append(contentsOf: $0) } }
        text("RIFF"); u32(64036); text("WAVEfmt "); u32(16); u16(1); u16(1); u32(8000); u32(16000); u16(2); u16(16)
        text("data"); u32(64000); data.append(Data(count: 64000)); return data
    }()
}
