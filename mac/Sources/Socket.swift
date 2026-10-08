import Foundation

/// One auto-reconnecting WebSocket to the cloud body (role=app or role=device). All callbacks arrive on the main queue.
final class Socket: NSObject, URLSessionWebSocketDelegate {
    let role: String
    var onOpen: (() -> Void)?
    var onMessage: (([String: Any]) -> Void)?
    var onClose: ((String?) -> Void)?

    private var task: URLSessionWebSocketTask?
    private var opened = false
    private var wanted = false
    private var retry = 0
    private var pinger: Timer?
    private lazy var session = URLSession(configuration: .default, delegate: self, delegateQueue: .main)

    init(role: String) {
        self.role = role
        super.init()
        // Notice dead connections (sleep, network switch) within half a minute.
        pinger = Timer.scheduledTimer(withTimeInterval: 25, repeats: true) { [weak self] _ in self?.ping() }
    }

    func start() {
        wanted = true
        if task == nil { open() }
    }

    func stop() {
        wanted = false
        close()
    }

    /// Drop and reconnect now, e.g. after the server/token or the capability list changed.
    func restart() {
        close()
        retry = 0
        if wanted { open() }
    }

    @discardableResult
    func send(_ obj: [String: Any]) -> Bool {
        guard let t = task, opened, let data = try? JSONSerialization.data(withJSONObject: obj),
              let s = String(data: data, encoding: .utf8) else { return false }
        t.send(.string(s)) { _ in }
        return true
    }

    private func close() {
        let t = task
        task = nil
        opened = false
        t?.cancel(with: .normalClosure, reason: nil)
    }

    private func open() {
        guard Prefs.configured, let req = Api.wsRequest(role) else { return }
        let t = session.webSocketTask(with: req)
        t.maximumMessageSize = 16 << 20
        task = t
        opened = false
        t.resume()
        receive(t)
    }

    private func ping() {
        guard let t = task, opened else { return }
        t.sendPing { [weak self] err in
            guard err != nil else { return }
            DispatchQueue.main.async { self?.dropped(t, nil) }
        }
    }

    private func receive(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self, self.task === t else { return }
                switch result {
                case .success(let msg):
                    var data: Data?
                    switch msg {
                    case .string(let s): data = s.data(using: .utf8)
                    case .data(let d): data = d
                    @unknown default: break
                    }
                    if let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { self.onMessage?(obj) }
                    self.receive(t)
                case .failure(let e):
                    self.dropped(t, self.reason(t, e))
                }
            }
        }
    }

    private func reason(_ t: URLSessionTask, _ e: Error?) -> String? {
        if (t.response as? HTTPURLResponse)?.statusCode == 401 { return "口令不对，去设置里改" }
        return e?.localizedDescription
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol proto: String?) {
        guard webSocketTask === task else { return }
        opened = true
        retry = 0
        onOpen?()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        dropped(webSocketTask, nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let ws = task as? URLSessionWebSocketTask { dropped(ws, reason(ws, error)) }
    }

    private func dropped(_ t: URLSessionWebSocketTask, _ why: String?) {
        guard task === t else { return }
        task = nil
        opened = false
        t.cancel()
        onClose?(why)
        guard wanted else { return }
        let delay = min(Double(1 << min(retry, 5)), 30)
        retry += 1
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, self.wanted, self.task == nil else { return }
            self.open()
        }
    }
}
