import Foundation
import Observation
@Observable final class ProfileStore {
    static let shared=ProfileStore()
    var userCall="你"
    var agentName="豆豆"
    var firstChat: Double?
    func applyState(_ s: [String:Any]) {
        userCall=s["userCall"] as? String ?? "你"; agentName=s["agentName"] as? String ?? "豆豆"
        firstChat=(s["firstChat"] as? NSNumber)?.doubleValue
    }
    @MainActor func load() async { if let s=try? await Api.json("/api/state") { applyState(s) } }
    func reset() { userCall="你"; agentName="豆豆"; firstChat=nil }
}
