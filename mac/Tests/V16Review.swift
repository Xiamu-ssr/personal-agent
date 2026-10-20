import AppKit
import SwiftUI

@main struct V16Review {
    static var window: NSWindow!
    @MainActor static func main() {
        NSApplication.shared.setActivationPolicy(.regular)
        Task { @MainActor in
            do { try await run(); window.close(); print("PASS: native wallet, model selection and multi-account allowance UI"); exit(0) }
            catch { print("FAIL: \(error)"); exit(1) }
        }
        NSApplication.shared.run()
    }
    @MainActor static func run() async throws {
        precondition(LocalVerification.explicitLoopback && Prefs.isolatedRoot != nil)
        let env=ProcessInfo.processInfo.environment
        let root=URL(fileURLWithPath:env["DOUDOU_REVIEW_ROOT"]!)
        let out=URL(fileURLWithPath:env["DOUDOU_REVIEW_OUTPUT"]!)
        try FileManager.default.createDirectory(at:out,withIntermediateDirectories:true)
        let data=try Data(contentsOf:root.appendingPathComponent("verification/v1.6.0/fixture.json"))
        let fixture=try JSONSerialization.jsonObject(with:data) as! [String:Any]
        var settings=fixture["settings"] as! [String:Any]
        AppearanceStore.shared.select(.light)
        let config=URLSessionConfiguration.ephemeral;config.protocolClasses=[MockTransport.self];Api.session=URLSession(configuration:config)
        MockTransport.respond={req in
            if req.url!.path=="/api/settings" {
                if req.httpMethod=="PUT" { let body=try JSONSerialization.jsonObject(with:MockTransport.body(req)) as! [String:Any];settings["model"]=body["model"] }
                return (200,settings)
            }
            if req.url!.path=="/api/connectors" { return (200,fixture["connectors"] as! [String:Any]) }
            return (200,["items":[]])
        }
        window=NSWindow(contentRect:NSRect(x:0,y:0,width:860,height:850),styleMask:[.titled,.closable],backing:.buffered,defer:false)
        window.isReleasedWhenClosed=false;window.title="豆豆 · 模型与额度验收"
        func show<V:View>(_ view:V) async throws {
            window.contentView=NSHostingView(rootView:view.frame(width:860,height:850).background(Theme.background).foregroundStyle(Theme.ink).preferredColorScheme(Theme.scheme))
            window.center();window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)
            try await Task.sleep(nanoseconds:900_000_000)
        }
        func shot(_ name:String) throws {
            let view=window.contentView!;view.layoutSubtreeIfNeeded();let bitmap=view.bitmapImageRepForCachingDisplay(in:view.bounds)!
            view.cacheDisplay(in:view.bounds,to:bitmap);try bitmap.representation(using:.png,properties:[:])!.write(to:out.appendingPathComponent(name+".png"))
        }
        try await show(ModelSettingsPage());try shot("mac-model-wallet")
        func click(_ id:String) async throws {
            guard let view=VerificationActionAnchor.views.object(forKey:id as NSString),view.window===window else { throw CocoaError(.coderValueNotFound) }
            view.scrollToVisible(view.bounds)
            let point=view.convert(NSPoint(x:view.bounds.midX,y:view.bounds.midY),to:nil)
            for type in [NSEvent.EventType.leftMouseDown,.leftMouseUp] {
                NSApp.postEvent(NSEvent.mouseEvent(with:type,location:point,modifierFlags:[],timestamp:ProcessInfo.processInfo.systemUptime,
                    windowNumber:window.windowNumber,context:nil,eventNumber:1,clickCount:1,pressure:type == .leftMouseDown ? 1:0)!,atStart:false)
            }
            try await Task.sleep(nanoseconds:900_000_000)
        }
        try await click("model-zenmux-sample-glm")
        guard AgentSettingsStore.shared.snapshot?.model.id=="sample-glm" else { throw CocoaError(.validationMissingMandatoryProperty) }
        try await click("provider-card-11111111-1111-4111-8111-111111111111")
        let selection=ModelSelection(provider:"11111111-1111-4111-8111-111111111111",id:"deepseek-flash")
        guard AgentSettingsStore.shared.snapshot?.model==selection else { throw CocoaError(.validationMissingMandatoryProperty) }
        try shot("mac-model-balance")
        try await click("provider-card-add");try shot("mac-model-add-card")
        try await show(ConnectorsPage(initialTab:1,focus:nil));try shot("mac-connectors")
        try await show(ConnectorDetailPage(name:"tavily"));try shot("mac-tavily-accounts")
        guard ConnectorStore.shared.connector("tavily")?.accounts.count==2,
              ConnectorStore.shared.connector("tavily")?.usage?.items.first?.remaining==1950 else { throw CocoaError(.coderValueNotFound) }
    }
}
