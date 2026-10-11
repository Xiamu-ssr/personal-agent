import Foundation
import CoreGraphics

struct CaptureGeometry: Equatable {
    let display: CGDirectDisplayID
    /// CG display bounds: logical points, top-left origin, including multi-monitor offsets.
    let screen: CGRect
    let image: CGSize

    func screenPoint(_ pixel: CGPoint) throws -> CGPoint {
        guard image.width > 0, image.height > 0, screen.width > 0, screen.height > 0,
              pixel.x.isFinite, pixel.y.isFinite,
              pixel.x >= 0, pixel.y >= 0, pixel.x < image.width, pixel.y < image.height else {
            throw CapError("坐标超出最近一次截图，请使用图片中的像素坐标")
        }
        return CGPoint(x: screen.minX + pixel.x * screen.width / image.width,
                       y: screen.minY + pixel.y * screen.height / image.height)
    }

    static func scaledSize(_ size: CGSize, longEdge: CGFloat = 1440) -> CGSize {
        guard size.width > 0, size.height > 0 else { return .zero }
        let scale = min(1, longEdge / max(size.width, size.height))
        return CGSize(width: max(1, floor(size.width * scale)), height: max(1, floor(size.height * scale)))
    }
}

struct MotionSample: Equatable {
    let point: CGPoint
    let delay: Double
}

enum PointerMotion {
    private struct Random {
        var state: UInt64
        mutating func unit() -> Double {
            state = state &* 6364136223846793005 &+ 1442695040888963407
            return Double(state >> 11) / Double(UInt64(1) << 53)
        }
        mutating func signed() -> Double { unit() * 2 - 1 }
    }

    /// Seeded, pure cubic Bézier motion. Ease-in/out, small lateral jitter and a bounded landing error.
    static func path(from start: CGPoint, to target: CGPoint, seed: UInt64, jitterRadius: CGFloat = 2) -> [MotionSample] {
        var random = Random(state: seed)
        let end = CGPoint(x: target.x + CGFloat(random.signed()) * jitterRadius,
                          y: target.y + CGFloat(random.signed()) * jitterRadius)
        let dx = end.x - start.x, dy = end.y - start.y
        let distance = hypot(dx, dy)
        let normal = distance > 0 ? CGPoint(x: -dy / distance, y: dx / distance) : .zero
        let bend = min(90, distance * 0.22)
        let bend1 = CGFloat(random.signed()) * bend, bend2 = CGFloat(random.signed()) * bend
        let c1 = CGPoint(x: start.x + dx * 0.28 + normal.x * bend1, y: start.y + dy * 0.28 + normal.y * bend1)
        let c2 = CGPoint(x: start.x + dx * 0.72 + normal.x * bend2, y: start.y + dy * 0.72 + normal.y * bend2)
        let count = max(24, min(100, Int(distance / 12) + 24))
        let duration = min(0.95, 0.22 + Double(distance) / 1800)
        var points: [CGPoint] = [start], weights: [Double] = [0]
        for index in 1...count {
            let t = CGFloat(index) / CGFloat(count)
            let u = t * t * (3 - 2 * t), v = 1 - u
            let jitter = sin(t * .pi) * 0.6
            points.append(CGPoint(x: v*v*v*start.x + 3*v*v*u*c1.x + 3*v*u*u*c2.x + u*u*u*end.x + CGFloat(random.signed()) * jitter,
                                  y: v*v*v*start.y + 3*v*v*u*c1.y + 3*v*u*u*c2.y + u*u*u*end.y + CGFloat(random.signed()) * jitter))
            weights.append(0.65 + random.unit() * 0.7)
        }
        points[count] = end
        let total = weights.reduce(0, +)
        return zip(points, weights).map { MotionSample(point: $0, delay: $1 / total * duration) }
    }
}
