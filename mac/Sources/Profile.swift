import Observation
import SwiftUI

struct AvatarChoice: Equatable {
    static let shapes = ["bean", "girl", "boy", "cat"]
    static let palettes = ["mist", "dusk", "mint", "sakura"]
    static let shapeTitles = ["豆子", "女生", "男生", "猫"]
    static let paletteTitles = ["晨雾蓝", "暮光金", "薄荷", "樱粉"]
    var shape = "bean"
    var palette = "mist"

    init(shape: String = "bean", palette: String = "mist") {
        self.shape = Self.shapes.contains(shape) ? shape : "bean"
        self.palette = Self.palettes.contains(palette) ? palette : "mist"
    }
    init(_ json: [String: Any]) {
        self.init(shape: json["shape"] as? String ?? "bean", palette: json["palette"] as? String ?? "mist")
    }
    var json: [String: Any] { ["shape": shape, "palette": palette] }
}

@Observable
final class ProfileStore {
    static let shared = ProfileStore()
    var avatar = AvatarChoice()
    var userCall = "你"
    var agentName = "豆豆"
    var firstChat: Double?
    var saving = false
    var error = ""
    private var generation = 0

    func applyState(_ state: [String: Any]) {
        userCall = (state["userCall"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "你"
        agentName = (state["agentName"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "豆豆"
        firstChat = (state["firstChat"] as? NSNumber)?.doubleValue
    }

    func load() async {
        guard !saving else { return }
        generation += 1
        let version = generation
        async let state = try? Api.json("/api/state")
        async let profile = try? Api.json("/api/profile")
        let (s, p) = await (state, profile)
        guard version == generation, !Task.isCancelled else { return }
        if let s { applyState(s) }
        if !saving, let a = p?["avatar"] as? [String: Any] { avatar = AvatarChoice(a) }
    }

    func save(_ choice: AvatarChoice) async {
        guard !saving else { return }
        saving = true; error = ""
        generation += 1
        let version = generation
        defer { saving = false }
        do {
            _ = try await Api.json("/api/profile", method: "PUT", body: ["avatar": choice.json])
            guard version == generation else { return }
            avatar = choice
        } catch { self.error = "头像没保存：\(error.localizedDescription)" }
    }

    func reset() {
        generation += 1
        avatar = AvatarChoice(); userCall = "你"; agentName = "豆豆"; firstChat = nil; error = ""
    }

    static func companionDays(_ firstChat: Double?, now: Date = Date()) -> Int? {
        guard let firstChat, firstChat.isFinite, firstChat > 0 else { return nil }
        let cal = Calendar.current
        return max(1, (cal.dateComponents([.day], from: cal.startOfDay(for: Date(timeIntervalSince1970: firstChat / 1000)),
                                          to: cal.startOfDay(for: now)).day ?? 0) + 1)
    }
}
