import AppKit

enum DeviceImage {
    static func jpeg(_ image: CGImage) throws -> [String: Any] {
        let size = CaptureGeometry.scaledSize(CGSize(width: image.width, height: image.height))
        guard let context = CGContext(data: nil, width: Int(size.width), height: Int(size.height),
                                      bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw CapError("无法创建截图") }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(origin: .zero, size: size))
        guard let scaled = context.makeImage(),
              let data = NSBitmapImageRep(cgImage: scaled).representation(using: .jpeg, properties: [.compressionFactor: 0.78]) else {
            throw CapError("无法编码截图")
        }
        return ["image": data.base64EncodedString(), "mime": "image/jpeg", "width": scaled.width, "height": scaled.height]
    }
}
