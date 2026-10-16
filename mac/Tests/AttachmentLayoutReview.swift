import AppKit
import SwiftUI
import CoreGraphics

/// Runs the real composer through AppKit layout. --baseline records the released layout before the fix.
@main struct AttachmentLayoutReview {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        Task { @MainActor in
            do { try await run(); exit(0) } catch { print("FAIL: \(error)"); exit(1) }
        }
        app.run()
    }
    @MainActor static func run() async throws {
        let baseline = CommandLine.arguments.contains("--baseline")
        AppearanceStore.shared.select(.light)
        let c = Composer()
        let window = NSWindow(contentRect: NSRect(x:0,y:0,width:780,height:600), styleMask:[.titled], backing:.buffered, defer:false)
        window.title = "豆豆 · 附件布局验证"
        window.contentView = NSHostingView(rootView: VStack {
            Text("聊天").font(.title).padding(30)
            ChatMessages()
            ComposerBar(placeholder:"说点什么…",c:c).verificationAction("layout-composer").padding(24)
        }.frame(maxWidth:.infinity,maxHeight:.infinity).background(Theme.background).preferredColorScheme(.light))
        window.center(); window.makeKeyAndOrderFront(nil)
        try await Task.sleep(nanoseconds:300_000_000)
        func height() -> CGFloat { VerificationActionAnchor.views.object(forKey:"layout-composer")!.bounds.height }
        let empty = height()
        c.add(image:NSImage(contentsOfFile:"mac/Resources/Mascot/idle/still.png")!,name:"演示图片")
        try await Task.sleep(nanoseconds:400_000_000)
        let attached = height()
        let single=attached
        for _ in 0..<2 {c.add(image:NSImage(contentsOfFile:"mac/Resources/Mascot/idle/still.png")!,name:"附件名称很长的产品观察截图")}
        c.drafts.append(Draft(data:Data("PDF fixture".utf8),name:"产品观察.pdf",kind:"file"))
        c.text=String(repeating:"这是一段带附件的长消息，输入框应该只在五行以内增长。",count:18)
        try await Task.sleep(nanoseconds:400_000_000)
        let mixed=height()
        let result:[String:Any] = ["empty":empty,"oneImage":attached,"growth":attached-empty,"baseline":baseline,"mixedLongText":mixed,"singleImage":single]
        let out=URL(fileURLWithPath:"/tmp/v081-mac-shots")
        try FileManager.default.createDirectory(at:out,withIntermediateDirectories:true)
        try JSONSerialization.data(withJSONObject:result,options:.prettyPrinted).write(to:out.appendingPathComponent(baseline ? "baseline-layout.json":"fixed-layout.json"))
        print(result)
        if baseline {
            let target=out.appendingPathComponent("00-baseline-attachment.png")
            if CGPreflightScreenCaptureAccess() {
                let p=Process();p.executableURL=URL(fileURLWithPath:"/usr/sbin/screencapture");p.arguments=["-x","-l",String(window.windowNumber),target.path];try p.run();p.waitUntilExit()
            } else if let view=window.contentView,let bitmap=view.bitmapImageRepForCachingDisplay(in:view.bounds) {
                view.cacheDisplay(in:view.bounds,to:bitmap);try bitmap.representation(using:.png,properties:[:])!.write(to:target)
            }
        } else if attached-empty > 70 || attached-empty < 45 {
            throw ApiError(code:0,message:"附件条应只增加一行高度")
        }
        print("PASS: native attachment layout")
    }
}
