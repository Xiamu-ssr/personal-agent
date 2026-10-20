import SwiftUI

struct Allowance: Equatable {
    let label: String
    let unit: String
    let remaining: Double
    let fraction: Double?
    let resetAt: String?
    init?(_ row: [String: Any]) {
        guard let value = row["remaining"] as? Double, value.isFinite, value >= 0 else { return nil }
        remaining = value; label = row["label"] as? String ?? ""; unit = row["unit"] as? String ?? ""
        fraction = (row["fraction"] as? Double).flatMap { $0.isFinite && (0...1).contains($0) ? $0 : nil }
        resetAt = row["resetAt"] as? String
    }
    var amount: String {
        let f = NumberFormatter(); f.numberStyle = .decimal; f.maximumFractionDigits = ["USD", "CNY"].contains(unit) ? 2 : 0
        let n = f.string(from: NSNumber(value: remaining)) ?? "—"
        switch unit { case "CNY": return "¥" + n; case "USD": return "$" + n; case "credits": return n + " 积分"; case "flows": return n + " Flows"; default: return n + " " + unit }
    }
}

struct UsageSnapshot: Equatable {
    let status: String
    let message: String
    let items: [Allowance]
    init?(_ row: [String: Any]?) {
        guard let row else { return nil }
        status = row["status"] as? String ?? ""; message = row["message"] as? String ?? ""
        items = (row["items"] as? [[String: Any]] ?? []).compactMap(Allowance.init)
    }
    var visible: Bool { !items.isEmpty || ["ok","exhausted","error","partial"].contains(status) }
    var headline: String {
        if let first=items.first { return first.amount }
        switch status {case "ok":return "额度正常";case "exhausted":return "额度不足";case "error":return "暂不可用";case "partial":return "部分可用";default:return ""}
    }
}

struct UsageMeter: View {
    let usage: UsageSnapshot
    var compact = false
    var ink = Theme.ink
    var body: some View {
        if usage.visible { VStack(alignment: .leading, spacing: 7) {
            if usage.items.isEmpty {
                let color=usage.status == "ok" ? Theme.online : usage.status == "exhausted" ? Theme.danger : Theme.sub
                HStack(spacing:5) { Circle().fill(color).frame(width:5,height:5);Text(usage.headline).font(Theme.font(size:12)).foregroundStyle(color) }
                    .padding(.horizontal,8).padding(.vertical,5).background(color.opacity(0.09),in:RoundedRectangle(cornerRadius:9))
            }
            ForEach(Array((compact ? Array(usage.items.prefix(1)) : usage.items).enumerated()), id: \.offset) { _, item in
                VStack(alignment: .leading, spacing: 5) {
                    HStack {
                        if !compact { Text(item.label).font(Theme.font(size: 11)).foregroundStyle(ink.opacity(0.6)); Spacer() }
                        Text(item.amount).font(Theme.font(size: compact ? 11 : 14, weight: .medium)).foregroundStyle(ink)
                    }
                    if let fraction = item.fraction {
                        GeometryReader { proxy in
                            Capsule().fill(ink.opacity(0.12))
                                .overlay(alignment: .leading) { Capsule().fill(fraction < 0.1 ? Theme.danger : ink.opacity(0.65)).frame(width: proxy.size.width * fraction) }
                        }.frame(height: 4)
                    }
                    if !compact, let reset = item.resetAt, let date = ISO8601DateFormatter().date(from: reset) {
                        Text(date.formatted(.dateTime.month().day().hour().minute()) + " 恢复").font(Theme.font(size: 10)).foregroundStyle(ink.opacity(0.6))
                    }
                }
            }
            if !compact && usage.status == "partial" && !usage.items.isEmpty { Text("部分账号暂不可用").font(Theme.font(size:12)).foregroundStyle(ink.opacity(0.6)) }
        } }
    }
}
