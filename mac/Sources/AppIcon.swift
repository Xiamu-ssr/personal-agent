import SwiftUI

/// Local symbols and color blocks keep services recognizable in both appearances, without remote logos.
struct AppIconStyle: Equatable {
    let symbol: String
    let hex: UInt32
    var color: Color { Color(red:Double((hex >> 16) & 255)/255,green:Double((hex >> 8) & 255)/255,blue:Double(hex & 255)/255) }
    static func capability(_ name: String) -> Self {
        switch name {
        case "shell": return Self(symbol:"terminal",hex:0x535663)
        case "computer_use", "screenshot": return Self(symbol:"viewfinder",hex:0x627FAD)
        case "browser": return Self(symbol:"globe",hex:0x3586DA)
        case "notify", "notifications": return Self(symbol:"bell.fill",hex:0xE65353)
        case "calendar_events", "calendar": return Self(symbol:"calendar",hex:0xED8B32)
        case "reminders": return Self(symbol:"checklist",hex:0xED8B32)
        case "clipboard": return Self(symbol:"doc.on.clipboard.fill",hex:0x229DAD)
        case "battery": return Self(symbol:"battery.100percent",hex:0x3BA565)
        case "location": return Self(symbol:"location.fill",hex:0x3586DA)
        case "sms": return Self(symbol:"message.fill",hex:0x3BA565)
        case "health": return Self(symbol:"heart.fill",hex:0xDB608C)
        case "camera": return Self(symbol:"camera.fill",hex:0x627FAD)
        case "microphone", "voice": return Self(symbol:"mic.fill",hex:0x9272CB)
        case "folder_desktop", "folder_documents", "folder_downloads", "files", "file": return Self(symbol:"folder.fill",hex:0xDCA92B)
        default: return Self(symbol:"laptopcomputer",hex:0x627FAD)
        }
    }
    static func connector(_ name: String) -> Self {
        switch name {
        case "gmail": return Self(symbol:"envelope.fill",hex:0xD94B43)
        case "qq-mail": return Self(symbol:"envelope.fill",hex:0x298AD1)
        case "netease-163", "netease-126", "exmail": return Self(symbol:"envelope.fill",hex:0xD94B43)
        case "weread": return Self(symbol:"book.fill",hex:0x348ADE)
        case "wind": return Self(symbol:"chart.line.uptrend.xyaxis",hex:0xCE3A40)
        case "tencent-quotes": return Self(symbol:"chart.line.uptrend.xyaxis",hex:0x287BE0)
        case "amap": return Self(symbol:"map.fill",hex:0x287BE0)
        case "github": return Self(symbol:"chevron.left.forwardslash.chevron.right",hex:0x24292F)
        case "tavily": return Self(symbol:"sparkle.magnifyingglass",hex:0x6478D4)
        case "aliyun-mail": return Self(symbol:"envelope.fill",hex:0xED8B32)
        default: return Self(symbol:"app.connected.to.app.below.fill",hex:0x6D79A4)
        }
    }
}

struct AppIcon: View {
    let style: AppIconStyle
    var size: CGFloat = 36
    var body: some View {
        Image(systemName:style.symbol).font(.system(size:size*0.45,weight:.semibold))
            .foregroundStyle(.white).frame(width:size,height:size)
            .background(style.color,in:RoundedRectangle(cornerRadius:size*0.25,style:.continuous))
            .overlay(RoundedRectangle(cornerRadius:size*0.25).strokeBorder(.white.opacity(0.15),lineWidth:0.5))
    }
}
