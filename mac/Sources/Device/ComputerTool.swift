import AppKit
import ApplicationServices
import ScreenCaptureKit

actor ComputerTool {
    static let shared = ComputerTool()
    private var geometry: CaptureGeometry?
    private var running = false

    func run(_ args: [String: Any]) async throws -> Any {
        guard !running else { throw CapError("电脑操作正在进行，请等上一次调用完成") }
        running = true
        defer { running = false }
        let op = args["op"] as? String ?? "screenshot"
        if op == "screenshot" { return try await screenshot(args) }
        guard AXIsProcessTrusted() else { throw CapError("请在系统设置里允许豆豆的辅助功能权限") }
        switch op {
        case "click":
            let point = try mapped(args)
            let buttonName = args["button"] as? String ?? "left"
            let button: CGMouseButton
            let down: CGEventType, up: CGEventType
            switch buttonName {
            case "left": button = .left; down = .leftMouseDown; up = .leftMouseUp
            case "right": button = .right; down = .rightMouseDown; up = .rightMouseUp
            case "middle": button = .center; down = .otherMouseDown; up = .otherMouseUp
            default: throw CapError("button 只能是 left/right/middle")
            }
            let landing = try await move(to: point)
            for count in 1...((args["double"] as? Bool == true) ? 2 : 1) {
                try postMouse(down, at: landing, button: button, count: count)
                do { try await pause(0.04...0.09) }
                catch { try? postMouse(up, at: landing, button: button, count: count); throw error }
                try postMouse(up, at: landing, button: button, count: count)
                if count == 1 && args["double"] as? Bool == true { try await pause(0.06...0.12) }
            }
        case "type":
            guard let text = args["text"] as? String else { throw CapError("type 需要 text") }
            for character in text {
                let units = Array(String(character).utf16)
                for isDown in [true, false] {
                    guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: isDown) else { throw CapError("无法创建键盘事件") }
                    units.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: $0.baseAddress) }
                    event.post(tap: .cghidEventTap)
                }
                try await pause(0.035...0.11)
            }
        case "key":
            try await key(args["keys"])
        case "scroll":
            let landing = try await move(to: mapped(args))
            let dx = try number(args, "dx", default: 0), dy = try number(args, "dy", default: 0)
            guard abs(dx) <= 100_000, abs(dy) <= 100_000,
                  let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
                                      wheel1: -Int32(dy), wheel2: -Int32(dx), wheel3: 0) else { throw CapError("滚动量过大或无法创建事件") }
            event.location = landing
            event.post(tap: .cghidEventTap)
        case "drag":
            guard let from = args["from"] as? [String: Any], let to = args["to"] as? [String: Any] else { throw CapError("drag 需要 from/to 的 x,y") }
            let start = try await move(to: mapped(from))
            let end = try mapped(to)
            try postMouse(.leftMouseDown, at: start)
            do {
                let landing = try await move(from: start, to: end, type: .leftMouseDragged)
                try postMouse(.leftMouseUp, at: landing)
            } catch {
                try? postMouse(.leftMouseUp, at: CGEvent(source: nil)?.location ?? start)
                throw error
            }
        default: throw CapError("computer_use 的 op 不正确")
        }
        return ["ok": true]
    }

    private func screenshot(_ args: [String: Any]) async throws -> [String: Any] {
        guard CGPreflightScreenCaptureAccess() else { throw CapError("请在系统设置里允许豆豆的屏幕录制权限，若系统要求请重启豆豆") }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let id = (args["display"] as? NSNumber)?.uint32Value ?? CGMainDisplayID()
        guard let display = content.displays.first(where: { $0.displayID == id }) else { throw CapError("找不到这个显示器") }
        let bounds = CGDisplayBounds(id)
        let size = CaptureGeometry.scaledSize(CGSize(width: CGDisplayPixelsWide(id), height: CGDisplayPixelsHigh(id)))
        let config = SCStreamConfiguration()
        config.width = Int(size.width)
        config.height = Int(size.height)
        config.showsCursor = true
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        var result = try DeviceImage.jpeg(image)
        let width = result["width"] as! Int, height = result["height"] as! Int
        geometry = CaptureGeometry(display: id, screen: bounds, image: CGSize(width: width, height: height))
        result["display"] = Int(id)
        return result
    }

    private func number(_ args: [String: Any], _ key: String, default value: Double? = nil) throws -> Double {
        guard let number = (args[key] as? NSNumber)?.doubleValue ?? value, number.isFinite else { throw CapError("\(key) 必须是有限数值") }
        return number
    }

    private func mapped(_ args: [String: Any]) throws -> CGPoint {
        guard let geometry else { throw CapError("请先调用 screenshot，再用截图的像素坐标操作") }
        guard CGDisplayIsActive(geometry.display) != 0, CGDisplayBounds(geometry.display) == geometry.screen else {
            throw CapError("显示器布局变了，请重新截图")
        }
        return try geometry.screenPoint(CGPoint(x: number(args, "x"), y: number(args, "y")))
    }

    private func move(from origin: CGPoint? = nil, to target: CGPoint, type: CGEventType = .mouseMoved) async throws -> CGPoint {
        let start = origin ?? CGEvent(source: nil)?.location ?? target
        let radius = geometry.map { min(2 * $0.screen.width / $0.image.width, 2 * $0.screen.height / $0.image.height) } ?? 2
        let path = PointerMotion.path(from: start, to: target, seed: .random(in: .min ... .max), jitterRadius: radius)
        var last = target
        for (index, sample) in path.dropFirst().enumerated() {
            try await Task.sleep(nanoseconds: UInt64(sample.delay * 1_000_000_000))
            var point = sample.point
            // Only clamp the landing. The approach can start on a different display.
            if index == path.count - 2, let bounds = geometry?.screen {
                point.x = min(max(point.x, bounds.minX), bounds.maxX - 0.01)
                point.y = min(max(point.y, bounds.minY), bounds.maxY - 0.01)
            }
            try postMouse(type, at: point)
            last = point
        }
        return last
    }

    private func postMouse(_ type: CGEventType, at point: CGPoint, button: CGMouseButton = .left, count: Int = 1) throws {
        guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { throw CapError("无法创建鼠标事件") }
        event.setIntegerValueField(.mouseEventClickState, value: Int64(count))
        event.post(tap: .cghidEventTap)
    }

    private func pause(_ range: ClosedRange<Double>) async throws {
        try await Task.sleep(nanoseconds: UInt64(Double.random(in: range) * 1_000_000_000))
    }

    private func key(_ value: Any?) async throws {
        let keys: [String]
        if let array = value as? [String] { keys = array }
        else if let string = value as? String { keys = string.split(separator: "+").map(String.init) }
        else { throw CapError("keys 需要按键名数组或 Cmd+L 形式的组合") }
        guard !keys.isEmpty else { throw CapError("keys 不能为空") }
        var flags: CGEventFlags = []
        var modifiers: [CGKeyCode] = [], regular: [CGKeyCode] = []
        for key in keys {
            switch key.trimmingCharacters(in: .whitespaces).uppercased() {
            case "CMD", "COMMAND", "META": flags.insert(.maskCommand); modifiers.append(55)
            case "CTRL", "CONTROL": flags.insert(.maskControl); modifiers.append(59)
            case "ALT", "OPTION": flags.insert(.maskAlternate); modifiers.append(58)
            case "SHIFT": flags.insert(.maskShift); modifiers.append(56)
            default:
                guard let code = NativeKey.code(key) else { throw CapError("不支持的按键：\(key)") }
                regular.append(code)
            }
        }
        let all = modifiers + regular
        for code in all {
            guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true) else { continue }
            event.flags = flags
            event.post(tap: .cghidEventTap)
        }
        do { try await pause(0.04...0.1) }
        catch { releaseKeys(all, flags: flags); throw error }
        releaseKeys(all, flags: flags)
    }

    private func releaseKeys(_ keys: [CGKeyCode], flags: CGEventFlags) {
        var remainingFlags = flags
        for code in keys.reversed() {
            switch code {
            case 55: remainingFlags.remove(.maskCommand)
            case 59: remainingFlags.remove(.maskControl)
            case 58: remainingFlags.remove(.maskAlternate)
            case 56: remainingFlags.remove(.maskShift)
            default: break
            }
            let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
            event?.flags = remainingFlags
            event?.post(tap: .cghidEventTap)
        }
    }
}

enum NativeKey {
    static func code(_ name: String) -> UInt16? { codes[name.uppercased()] }
    private static let codes: [String: UInt16] = [
        "A":0, "S":1, "D":2, "F":3, "H":4, "G":5, "Z":6, "X":7, "C":8, "V":9, "B":11,
        "Q":12, "W":13, "E":14, "R":15, "Y":16, "T":17, "1":18, "2":19, "3":20, "4":21,
        "6":22, "5":23, "=":24, "9":25, "7":26, "-":27, "8":28, "0":29, "]":30, "O":31,
        "U":32, "[":33, "I":34, "P":35, "RETURN":36, "ENTER":36, "L":37, "J":38, "'":39,
        "K":40, ";":41, "\\":42, ",":43, "/":44, "N":45, "M":46, ".":47, "TAB":48,
        "SPACE":49, String(UnicodeScalar(96)):50, "BACKSPACE":51, "ESC":53, "ESCAPE":53, "DELETE":117,
        "LEFT":123, "RIGHT":124, "DOWN":125, "UP":126, "HOME":115, "END":119,
        "PAGEUP":116, "PAGEDOWN":121, "F1":122, "F2":120, "F3":99, "F4":118,
        "F5":96, "F6":97, "F7":98, "F8":100, "F9":101, "F10":109, "F11":103, "F12":111
    ]
}
