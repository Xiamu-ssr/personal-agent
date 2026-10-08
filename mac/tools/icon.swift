// Renders AppIcon.iconset (same bean as the Android launcher icon). Usage: icon <out.iconset>
import AppKit

func bean(in ctx: CGContext, size: CGFloat) {
    // Squircle-ish background with the usual macOS margin.
    let inset = size * 0.1
    let rect = CGRect(x: inset, y: inset, width: size - 2 * inset, height: size - 2 * inset)
    ctx.addPath(CGPath(roundedRect: rect, cornerWidth: rect.width * 0.225, cornerHeight: rect.width * 0.225, transform: nil))
    ctx.setFillColor(CGColor(red: 0x6B / 255, green: 0x5B / 255, blue: 0xD6 / 255, alpha: 1))
    ctx.fillPath()

    // The Android vector lives in a 108 viewport, y down; the bean spans x 30–76, y 30–84.
    let s = rect.width * 0.62 / 54
    ctx.saveGState()
    ctx.translateBy(x: size / 2, y: size / 2)
    ctx.scaleBy(x: s, y: -s)
    ctx.translateBy(x: -53, y: -57)
    var p = CGPoint(x: 54, y: 30)
    let path = CGMutablePath()
    path.move(to: p)
    for c in [[13, 0, 22, 9, 22, 21], [0, 8, -4, 12, -9, 15], [-5, 3, -6, 7, -7, 10], [-2, 6, -8, 9, -14, 8],
              [-9, -1, -16, -9, -16, -20], [0, -6, 2, -11, 6, -15], [3, -3, 3, -6, 3, -9], [0, -6, 6, -10, 15, -10]] {
        let v = c.map(CGFloat.init)
        path.addCurve(to: CGPoint(x: p.x + v[4], y: p.y + v[5]),
                      control1: CGPoint(x: p.x + v[0], y: p.y + v[1]),
                      control2: CGPoint(x: p.x + v[2], y: p.y + v[3]))
        p = CGPoint(x: p.x + v[4], y: p.y + v[5])
    }
    path.closeSubpath()
    ctx.addPath(path)
    ctx.setFillColor(.white)
    ctx.fillPath()
    ctx.setFillColor(CGColor(red: 0x6B / 255, green: 0x5B / 255, blue: 0xD6 / 255, alpha: 1))
    ctx.fillEllipse(in: CGRect(x: 44, y: 49, width: 6, height: 6))
    ctx.fillEllipse(in: CGRect(x: 58, y: 49, width: 6, height: 6))
    ctx.restoreGState()
}

let out = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let px = base * scale
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                                   hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        let ctx = NSGraphicsContext(bitmapImageRep: rep)!.cgContext
        bean(in: ctx, size: CGFloat(px))
        let name = scale == 1 ? "icon_\(base)x\(base).png" : "icon_\(base)x\(base)@2x.png"
        try rep.representation(using: .png, properties: [:])!.write(to: out.appendingPathComponent(name))
    }
}
