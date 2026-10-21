import AppKit
import AVFoundation
import SwiftUI

@main struct PerformanceReview {
    @MainActor static func main() {
        NSApplication.shared.setActivationPolicy(.regular)
        Task { @MainActor in
            do { try await run(); print("PASS: content and idle performance review"); exit(0) }
            catch { print("FAIL: \(error)"); exit(1) }
        }
        NSApplication.shared.run()
    }
    @MainActor static func run() async throws {
        precondition(Prefs.isolatedRoot != nil && LocalVerification.explicitLoopback)
        Prefs.token="local-synthetic-review";AppearanceStore.shared.select(.dark)
        MenuController.shared.install()
        let env=ProcessInfo.processInfo.environment,baseline=env["DOUDOU_BASELINE"] == "1"
        let output=URL(fileURLWithPath:env["DOUDOU_REVIEW_OUTPUT"]!)
        try FileManager.default.createDirectory(at:output,withIntermediateDirectories:true)
        let window=NSWindow(contentRect:NSRect(x:0,y:0,width:1100,height:800),styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false)
        window.isReleasedWhenClosed=false;window.title="豆豆 · 内容与耗电验收"
        func show<V:View>(_ view:V) {
            window.contentView=NSHostingView(rootView:view.frame(maxWidth:.infinity,maxHeight:.infinity).background(Theme.background).foregroundStyle(Theme.ink))
            window.center();window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)
        }
        func shot(_ name:String) throws {
            let view=window.contentView!;view.layoutSubtreeIfNeeded()
            let bitmap=view.bitmapImageRepForCachingDisplay(in:view.bounds)!;view.cacheDisplay(in:view.bounds,to:bitmap)
            try bitmap.representation(using:.png,properties:[:])!.write(to:output.appendingPathComponent(name+".png"))
        }
        func videoLayers(_ view:NSView)->[AVPlayerLayer] {
            func layers(_ layer:CALayer)->[AVPlayerLayer] { (layer as? AVPlayerLayer).map{[$0]} ?? [] + (layer.sublayers ?? []).flatMap(layers) }
            return (view.layer.map(layers) ?? []) + view.subviews.flatMap(videoLayers)
        }
        func playingVideos()->Int {
            Dictionary(videoLayers(window.contentView!).map{(ObjectIdentifier($0),$0)},uniquingKeysWith:{_,new in new}).values.filter{$0.player?.rate ?? 0 > 0}.count
        }
        func tableView(_ view:NSView)->NSTableView? {if let table=view as? NSTableView{return table};return view.subviews.compactMap(tableView).first}
        func click(_ id:String) async throws {
            guard let view=VerificationActionAnchor.views.object(forKey:id as NSString),let target=view.window else{throw CocoaError(.coderValueNotFound)}
            let point=view.convert(NSPoint(x:view.bounds.midX,y:view.bounds.midY),to:nil)
            for type in [NSEvent.EventType.leftMouseDown,.leftMouseUp] {
                NSApp.postEvent(NSEvent.mouseEvent(with:type,location:point,modifierFlags:[],timestamp:ProcessInfo.processInfo.systemUptime,windowNumber:target.windowNumber,context:nil,eventNumber:1,clickCount:1,pressure:type == .leftMouseDown ? 1:0)!,atStart:false)
            }
            try await Task.sleep(nanoseconds:400_000_000)
        }
        let table="""
        ## 三种服务的选择

        | 维度 | 服务一：网页搜索与正文 | 服务二：深度检索与提取 |
        | --- | --- | --- |
        | 价格与额度 | **按次计费**，没有结果不计费；每次可以返回多条结果，需要关注独立账号的余额。 | 独立 API Key，不同套餐的额度不同，统一在连接器中管理。 |
        | 鉴权与限流 | 标准 API 使用 Bearer Token，按次计费，限流与模型推理独立。 | 支持多账号，余额不足后使用备用账号，普通限流不换号。 |
        | 中文与国内信源 | 国内新闻、中文政务、社区、技术博客等信息，保留来源与发布时间。 | 海外科技动态、英文文档、公开研究，保留完整来源。 |
        | 正文提取 | 提供 `fetch` 接口，把网页转成完整的 Markdown；这格故意写得比较长，验证换行后不会压住下一行文字。 | 为模型提供页面摘要与正文，同时支持多网址提取。 |

        结论：三列表格完整换行，更多列支持横向滚动，后文不会与表格重叠。
        """
        show(ScrollView {MarkdownView(text:table,size:17).frame(width:660).padding(28)})
        try await Task.sleep(nanoseconds:800_000_000);try shot("mac-table");print("PHASE_TABLE_DONE");fflush(stdout)
        if !baseline {
            var frames:[NSRect]=[]
            for row in 0..<5 {
                let view=VerificationActionAnchor.views.object(forKey:"markdown-table-row-\(row)" as NSString)!
                let rect=view.convert(view.bounds,to:nil);frames.append(rect)
                for column in 0..<3 {
                    let cell=VerificationActionAnchor.views.object(forKey:"markdown-cell-\(row)-\(column)" as NSString)!
                    guard rect.insetBy(dx:-1,dy:-1).contains(cell.convert(cell.bounds,to:nil)) else {throw ApiError(code:0,message:"Table text escaped its row")}
                }
            }
            guard zip(frames,frames.dropFirst()).allSatisfy({!$0.0.intersects($0.1)}) else {throw ApiError(code:0,message:"Wrapped table rows overlap")}
        }
        ChatClient.shared.start();show(MainView())
        for _ in 0..<100 {if ChatClient.shared.transcript.items.count>=500 {break};try await Task.sleep(nanoseconds:100_000_000)}
        if env["DOUDOU_REVIEW_INTERACTIVE"] == "1" {
            window.title="豆豆 · 请激活此验收窗口"
            for _ in 0..<300 {if NSApp.isActive {break};try await Task.sleep(nanoseconds:100_000_000)}
            guard NSApp.isActive else {throw ApiError(code:0,message:"Review window was not activated")}
            window.title="豆豆 · 内容与耗电验收"
        }
        guard ChatClient.shared.transcript.items.count==1000 else {throw ApiError(code:0,message:"Expected 1000 synthetic messages")}
        guard let asset=Bundle.main.resourceURL?.appendingPathComponent("Mascot/idle/dark.mp4"),FileManager.default.fileExists(atPath:asset.path) else {throw ApiError(code:0,message:"Real mascot assets missing")}
        window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)
        try await Task.sleep(nanoseconds:500_000_000);ChatClient.shared.avatarState = .working
        let reactionActive=NSApp.isActive
        var reactionPlayers=0
        for _ in 0..<25 {try await Task.sleep(nanoseconds:100_000_000);reactionPlayers=max(reactionPlayers,playingVideos())}
        ChatClient.shared.avatarState = .idle
        try await Task.sleep(nanoseconds:3_000_000_000)
        print("PROFILE_IDLE_START");fflush(stdout)
        try await Task.sleep(nanoseconds:UInt64(env["DOUDOU_REVIEW_IDLE_SECONDS"].flatMap(Double.init) ?? 30)*1_000_000_000)
        let idlePlayers=playingVideos()
        try shot("mac-chat")
        var changes:[Double]=[]
        print("PHASE_SWITCH");fflush(stdout)
        for _ in 0..<4 { for tab in [Tab.feed,.ideas,.goals,.library,.chat] {
            let start=ProcessInfo.processInfo.systemUptime;Nav.shared.go(tab);await Task.yield();window.contentView?.layoutSubtreeIfNeeded()
            changes.append((ProcessInfo.processInfo.systemUptime-start)*1000)
            try await Task.sleep(nanoseconds:150_000_000)
        }}
        print("PHASE_SETTINGS");fflush(stdout)
        Nav.shared.go(.settings);try await Task.sleep(nanoseconds:600_000_000);try shot("mac-settings")
        if !baseline {
            print("PHASE_CHOICE_OPEN");fflush(stdout);try await click("choice-外观")
            guard let option=VerificationActionAnchor.views.object(forKey:"choice-option-浅色" as NSString),let panel=option.window else {throw ApiError(code:0,message:"Styled choice did not open")}
            let view=panel.contentView!,bitmap=view.bitmapImageRepForCachingDisplay(in:view.bounds)!;view.cacheDisplay(in:view.bounds,to:bitmap)
            try bitmap.representation(using:.png,properties:[:])!.write(to:output.appendingPathComponent("mac-appearance-menu.png"))
            print("PHASE_CHOICE_LIGHT");fflush(stdout);try await click("choice-option-浅色");guard AppearanceStore.shared.selection == .light else {throw ApiError(code:0,message:"Choice did not apply")}
            print("PHASE_CHOICE_DARK");fflush(stdout);AppearanceStore.shared.select(.dark)
        }
        Nav.shared.go(.chat);try await Task.sleep(nanoseconds:500_000_000)
        var readingPositionPreserved=false,settingsPositionPreserved=false
        if let list=tableView(window.contentView!),let coordinator=list.delegate as? NativeChatList.Coordinator,let scroll=list.enclosingScrollView {
            coordinator.state?.report(distance:10000,viewport:scroll.contentSize.height,positionChanged:true)
            list.scrollRowToVisible(100);try await Task.sleep(nanoseconds:400_000_000)
            let before=list.row(at:NSPoint(x:1,y:scroll.contentView.bounds.minY+1))
            guard before>=0 && before<900 else {throw ApiError(code:0,message:"Reader did not leave the newest messages")}
            Nav.shared.go(.ideas);try await Task.sleep(nanoseconds:200_000_000);Nav.shared.go(.chat);try await Task.sleep(nanoseconds:500_000_000)
            if let after=tableView(window.contentView!),let area=after.enclosingScrollView {readingPositionPreserved=after.row(at:NSPoint(x:1,y:area.contentView.bounds.minY+1))==before}
            Nav.shared.go(.settings);try await Task.sleep(nanoseconds:200_000_000);Nav.shared.go(.chat);try await Task.sleep(nanoseconds:500_000_000)
            if let after=tableView(window.contentView!),let area=after.enclosingScrollView {settingsPositionPreserved=after.row(at:NSPoint(x:1,y:area.contentView.bounds.minY+1))==before}
        }
        if !baseline {
            guard readingPositionPreserved && settingsPositionPreserved else {throw ApiError(code:0,message:"Tab navigation lost the reader's message")}
            try await click("composer-attachments")
            guard let panel=VerificationActionAnchor.views.object(forKey:"attachment-menu-file" as NSString)?.window else {throw ApiError(code:0,message:"Attachments popover did not open")}
            guard panel.screen?.visibleFrame.contains(panel.frame)==true else {throw ApiError(code:0,message:"Attachments menu escaped the visible screen")}
            let view=panel.contentView!,bitmap=view.bitmapImageRepForCachingDisplay(in:view.bounds)!;view.cacheDisplay(in:view.bounds,to:bitmap)
            try bitmap.representation(using:.png,properties:[:])!.write(to:output.appendingPathComponent("mac-attachments-menu.png"))
            try await click("composer-attachments")
        }
        let hiddenMenuRows=MenuController.shared.popover.contentViewController.flatMap{tableView($0.view)}?.numberOfRows ?? 0
        guard hiddenMenuRows==0 else{throw ApiError(code:0,message:"Closed menu built an invisible transcript")}
        MenuController.shared.button?.performClick(nil);try await Task.sleep(nanoseconds:800_000_000)
        let openMenuRows=MenuController.shared.popover.contentViewController.flatMap{tableView($0.view)}?.numberOfRows ?? 0
        guard openMenuRows==60 else{throw ApiError(code:0,message:"Menu transcript did not load when opened")}
        MenuController.shared.close()
        window.orderOut(nil);try await Task.sleep(nanoseconds:1_000_000_000)
        let hiddenPlayers=playingVideos()
        guard MenuController.shared.popover.contentViewController==nil else {throw ApiError(code:0,message:"Closed quick-chat retained its controller")}
        let record:[String:Any]=["menuHiddenInitialRows":hiddenMenuRows,"menuOpenRows":openMenuRows,"baseline":baseline,"syntheticData":true,"chatMessages":ChatClient.shared.transcript.items.count,"appActiveDuringReaction":reactionActive,"reactionPlayingVideoLayers":reactionPlayers,"idlePlayingVideoLayers":idlePlayers,"hiddenPlayingVideoLayers":hiddenPlayers,"readingPositionPreservedAcrossTabs":readingPositionPreserved,"readingPositionPreservedAcrossSettings":settingsPositionPreserved,"tabSwitchMilliseconds":changes,"maxTabSwitchMilliseconds":changes.max() ?? 0]
        try JSONSerialization.data(withJSONObject:record,options:[.prettyPrinted,.sortedKeys]).write(to:output.appendingPathComponent("mac-performance-review.json"))
        if !baseline && reactionActive && !ProcessInfo.processInfo.isLowPowerModeEnabled {precondition(reactionPlayers>0,"Expressive avatar never played")}
        if !baseline {precondition(idlePlayers==0 && hiddenPlayers==0,"Decorative video kept decoding while idle/hidden")}
        ChatClient.shared.stop();window.close()
    }
}
