import AppKit
import SwiftUI

@main struct V161Review {
    @MainActor static func main() {
        NSApplication.shared.setActivationPolicy(.regular)
        Task { @MainActor in
            do {try await run();print("PASS: native full image aspect ratio, feed, Wind status and provider wallet");exit(0)}
            catch {print("FAIL: \(error)");exit(1)}
        }
        NSApplication.shared.run()
    }
    @MainActor static func run() async throws {
        precondition(LocalVerification.explicitLoopback && Prefs.isolatedRoot != nil)
        let output=URL(fileURLWithPath:ProcessInfo.processInfo.environment["DOUDOU_REVIEW_OUTPUT"]!)
        try FileManager.default.createDirectory(at:output,withIntermediateDirectories:true)
        AppearanceStore.shared.select(.light)
        let window=NSWindow(contentRect:NSRect(x:0,y:0,width:860,height:850),styleMask:[.titled,.closable],backing:.buffered,defer:false)
        window.isReleasedWhenClosed=false;window.title="豆豆 · 图片与额度验收"
        func show<V:View>(_ view:V) async throws {
            window.contentView=NSHostingView(rootView:view.frame(width:860,height:850,alignment:.top).background(Theme.background).foregroundStyle(Theme.ink).preferredColorScheme(.light))
            window.center();window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)
            try await Task.sleep(nanoseconds:1_200_000_000)
        }
        func shot(_ name:String) throws {
            let view=window.contentView!;view.layoutSubtreeIfNeeded();let bitmap=view.bitmapImageRepForCachingDisplay(in:view.bounds)!
            view.cacheDisplay(in:view.bounds,to:bitmap);try bitmap.representation(using:.png,properties:[:])!.write(to:output.appendingPathComponent(name+".png"))
        }
        try await show(VStack(alignment:.leading,spacing:12) {
            RemoteImage(path:"data/library/portrait.png",maxSide:320,fullWidth:true).verificationAction("full-image")
            Text("Caption follows the whole image").verificationAction("image-caption")
        }.frame(width:320))
        guard let anchor=VerificationActionAnchor.views.object(forKey:"full-image") else {throw CocoaError(.coderValueNotFound)}
        let size=anchor.bounds.size
        guard abs(size.height/size.width-1.5)<0.02,size.height>400 else {throw ApiError(code:0,message:"图片没有保留原始比例：\(size)")}
        try shot("mac-portrait-layout")
        let result:[String:Any]=["imageWidth":size.width,"imageHeight":size.height,"aspectRatioPreserved":true,"fixture":"loopback synthetic only"]
        try JSONSerialization.data(withJSONObject:result,options:.prettyPrinted).write(to:output.appendingPathComponent("mac-layout.json"))
        guard let normal=UsageSnapshot(["status":"ok","message":"do not show internal explanation","items":[]]),normal.headline=="额度正常",normal.visible,
              let missing=UsageSnapshot(["status":"unsupported","message":"do not show internal explanation","items":[]]), !missing.visible else {throw CocoaError(.validationMissingMandatoryProperty)}
        try await show(FeedPage())
        guard let feedImage=VerificationActionAnchor.views.object(forKey:"feed-image-data/feed/2026-10-20/1200-layout.md"),abs(feedImage.bounds.height/feedImage.bounds.width-1.5)<0.02 else {throw ApiError(code:0,message:"原生动态图片未完整加载")}
        try shot("mac-feed-image")
        try await show(ConnectorDetailPage(name:"wind"));try shot("mac-wind-status")
        try await show(ConnectorsPage(initialTab:1,focus:nil));try shot("mac-connectors")
        try await show(ModelSettingsPage());try shot("mac-wallet")
        window.close()
    }
}
