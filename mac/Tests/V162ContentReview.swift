import AppKit
import SwiftUI
import WebKit
import CryptoKit

@main struct V162ContentReview {
    @MainActor static func main() {
        NSApplication.shared.setActivationPolicy(.regular)
        Task {@MainActor in
            do {try await run();print("PASS: actual library previews, HTML viewer and authenticated save");exit(0)}
            catch {print("FAIL: \(error)");exit(1)}
        }
        NSApplication.shared.run()
    }
    @MainActor static func run() async throws {
        precondition(LocalVerification.explicitLoopback && Prefs.isolatedRoot != nil)
        AppearanceStore.shared.select(.dark)
        let output=URL(fileURLWithPath:ProcessInfo.processInfo.environment["DOUDOU_REVIEW_OUTPUT"]!)
        try FileManager.default.createDirectory(at:output,withIntermediateDirectories:true)
        let window=NSWindow(contentRect:NSRect(x:0,y:0,width:860,height:900),styleMask:[.titled,.closable],backing:.buffered,defer:false)
        window.isReleasedWhenClosed=false;window.title="豆豆 · 内容交付验收"
        func show<V:View>(_ view:V) {
            window.contentView=NSHostingView(rootView:view.frame(width:860,height:900,alignment:.top).background(Theme.background).foregroundStyle(Theme.ink).preferredColorScheme(.dark));window.center();window.makeKeyAndOrderFront(nil)
        }
        func until(_ test:()->Bool) async throws {
            for _ in 0..<160 {if test(){return};try await Task.sleep(nanoseconds:100_000_000)}
            throw ApiError(code:0,message:"Native view did not finish loading")
        }
        func web(_ view:NSView)->WKWebView? {if let v=view as? WKWebView{return v};return view.subviews.compactMap{web($0)}.first}
        func shot(_ name:String) async throws {
            let view=window.contentView!;view.layoutSubtreeIfNeeded();let bitmap=view.bitmapImageRepForCachingDisplay(in:view.bounds)!
            view.cacheDisplay(in:view.bounds,to:bitmap)
            if let browser=web(view) {
                let snapshot=try await browser.takeSnapshot(configuration:nil),rect=browser.convert(browser.bounds,to:view)
                if let context=NSGraphicsContext(bitmapImageRep:bitmap){
                    NSGraphicsContext.saveGraphicsState();NSGraphicsContext.current=context
                    let draw=view.isFlipped ? NSRect(x:rect.minX,y:view.bounds.height-rect.maxY,width:rect.width,height:rect.height):rect
                    NSBezierPath(rect:draw).addClip();snapshot.draw(in:draw);NSGraphicsContext.restoreGraphicsState()
                }
            }
            try bitmap.representation(using:.png,properties:[:])!.write(to:output.appendingPathComponent(name+".png"))
        }
        let library=try await Api.json("/api/library"),artifacts=(library["artifacts"] as? [[String:Any]] ?? []).compactMap(Artifact.init),pages=artifacts.filter{$0.kind=="page"}
        guard pages.count==6,artifacts.count==7 else {throw ApiError(code:0,message:"Library omitted standalone files or included support assets")}
        show(LibraryPage())
        try await until {pages.filter {VerificationActionAnchor.views.object(forKey:("library-image-"+($0.thumbnail ?? "")) as NSString) != nil}.count>=5}
        try await shot("mac-library")
        let page="data/library/artifacts/独立海报.html"
        show(WebRoute(title:"独立海报",path:page))
        var loaded=false
        for _ in 0..<160 {
            if let browser=web(window.contentView!),let text=try? await browser.evaluateJavaScript("document.body.textContent") as? String,text.contains("页面完整打开"){loaded=true;break}
            try await Task.sleep(nanoseconds:100_000_000)
        }
        guard loaded else {
            if let b=web(window.contentView!){print("WEB DIAGNOSTIC",b.url?.lastPathComponent ?? "no URL",b.isLoading,(try? await b.evaluateJavaScript("document.body.innerText")) ?? "no body")}
            else {print("WEB DIAGNOSTIC no native WebView")}
            try await shot("mac-html-failed")
            throw ApiError(code:0,message:"HTML viewer did not render the page")
        }
        try await shot("mac-html")
        let original=try await Api.data(Api.filePath(page)),download=try await Api.download(page),saved=try Data(contentsOf:download)
        guard saved==original else {throw ApiError(code:0,message:"Downloaded HTML differs from original")}
        let record:[String:Any]=["fixture":"real product HTTP with synthetic files","pages":pages.count,"previewImagesVisible":true,"htmlLoaded":true,"downloadBytes":saved.count,"downloadMatches":true]
        try JSONSerialization.data(withJSONObject:record,options:.prettyPrinted).write(to:output.appendingPathComponent("mac-content.json"))
        window.close()
    }
}
