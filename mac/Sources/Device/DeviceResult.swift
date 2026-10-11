import Foundation

enum DeviceResult {
    static func success(id: String, data: Any) -> [String: Any] {
        ["t": "result", "id": id, "ok": true, "data": data]
    }
}
