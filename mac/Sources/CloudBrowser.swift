import AppKit
import SwiftUI
import Observation
@Observable final class CloudBrowserClient {
    static let shared=CloudBrowserClient()
    var state="closed"
    var control="agent"
    var title="云端浏览器"
    var url=""
    var reason=""
    var image:NSImage?
    var frameID=0
    var error=""
    var changing=false
    var dialog:[String:Any]?
    @ObservationIgnored private let socket=Socket(role:"browser")
    @ObservationIgnored private var viewers=Set<UUID>()
    @ObservationIgnored private var inputWork:Task<Void,Never>?
    init() {
        socket.onOpen = { [weak self] in self?.watch() }
        socket.onMessage = { [weak self] in self?.handle($0) }
        socket.onClose = { [weak self] _ in self?.image=nil; self?.frameID=0; self?.error="实时画面已断开，正在重连" }
    }
    func observe(_ id:UUID,visible:Bool) {
        if visible { viewers.insert(id); socket.start() } else { viewers.remove(id) }
        watch()
        if viewers.isEmpty { socket.stop(); image=nil; frameID=0 }
    }
    private func watch() { _ = socket.send(["t":"browser_watch","watch":!viewers.isEmpty]) }
    func handle(_ r:[String:Any]) {
        if r["t"] as? String == "browser_state" { apply(r) }
        if r["t"] as? String == "browser_frame", let id=r["frameId"] as? Int, id >= frameID,
           let s=r["data"] as? String, s.utf8.count < 12<<20, let data=Data(base64Encoded:s), let im=NSImage(data:data) {
            image=im; frameID=id; error=""
        }
    }
    private func apply(_ r:[String:Any]) {
        state=r["state"] as? String ?? "closed"; control=r["control"] as? String ?? "agent"
        title=r["title"] as? String ?? "云端浏览器"; url=r["url"] as? String ?? ""; reason=r["reason"] as? String ?? ""
        dialog=r["dialog"] as? [String:Any]
        if state == "closed" { image=nil; frameID=0 }; error=""
    }
    @MainActor func action(_ name:String) async {
        guard !changing else { return }; changing=true; defer {changing=false}
        do { let r=try await Api.json("/api/browser/"+name,method:"POST",body:[:]); apply(r) } catch { self.error=error.localizedDescription }
    }
    func input(_ r:[String:Any]) {
        guard control == "user", state != "closed" else { return }
        let previous=inputWork
        inputWork=Task { @MainActor [weak self] in
            await previous?.value; guard let self, !Task.isCancelled else { return }
            do { _ = try await Api.json("/api/browser/input",method:"POST",body:r) } catch { self.error=error.localizedDescription }
        }
    }
    func stop() { socket.stop(); viewers=[]; inputWork?.cancel(); inputWork=nil; image=nil; frameID=0; state="closed"; control="agent"; title="云端浏览器"; reason=""; url=""; error=""; dialog=nil }
}
@MainActor final class CloudBrowserWindow:NSObject,NSWindowDelegate {
    static let shared=CloudBrowserWindow()
    private var window:NSWindow?
    func show() {
        if let window { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps:true); return }
        let window=NSWindow(contentRect:NSRect(x:0,y:0,width:1030,height:760),styleMask:[.titled,.closable,.resizable,.miniaturizable],backing:.buffered,defer:false)
        window.title="豆豆 · 云端浏览器"; window.isReleasedWhenClosed=false; window.delegate=self
        window.contentView=NSHostingView(rootView:CloudBrowserView()); window.minSize=NSSize(width:680,height:500); window.center()
        self.window=window; window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps:true)
    }
    func windowWillClose(_ notification:Notification) { window?.contentView=nil; window=nil }
}
struct BrowserCard:View {
    var compact=false
    @State private var viewer=UUID()
    @State private var visible=true
    private var browser:CloudBrowserClient { .shared }
    var body:some View {
        Button { CloudBrowserWindow.shared.show() } label:{
            VStack(alignment:.leading,spacing:10) {
                ZStack { Theme.field
                    if let image=browser.image { Image(nsImage:image).resizable().scaledToFit() }
                    else { VStack(spacing:10) { Image(systemName:"globe").font(.system(size:26,weight:.light)); Text(browser.state == "closed" ? "打开云端浏览器" : "正在接收画面…").font(Theme.font(size:12)) }.foregroundStyle(Theme.sub) }
                }.frame(height:compact ? 135 : 220).clipShape(RoundedRectangle(cornerRadius:14))
                HStack { Text("云端浏览器").font(Theme.font(size:13,weight:.medium)); Spacer(); Image(systemName:"arrow.up.right.and.arrow.down.left").font(.system(size:11)) }
            }.padding(12).background(Theme.card,in:RoundedRectangle(cornerRadius:20)).contentShape(Rectangle())
        }.buttonStyle(.plain).background(MediaVisibility { visible=$0; browser.observe(viewer,visible:$0) })
        .onAppear { browser.observe(viewer,visible:visible) }.onDisappear { browser.observe(viewer,visible:false) }
    }
}
struct CloudBrowserView:View {
    private var browser:CloudBrowserClient { .shared }
    @State private var activity=WindowActivity()
    @State private var viewer=UUID()
    @State private var prompt=""
    var body:some View {
        VStack(spacing:0) {
            HStack(spacing:14) {
                Image(systemName:"globe"); VStack(alignment:.leading,spacing:4) {
                    Text(browser.title.isEmpty ? "云端浏览器" : browser.title).font(Theme.font(size:14,weight:.semibold)).lineLimit(1)
                    Text(browser.control == "user" ? "你正在接管" : browser.state == "agent" ? "豆豆正在操作" : browser.state == "closed" ? "已关闭" : "豆豆的浏览器").font(Theme.font(size:11)).foregroundStyle(Theme.sub)
                }; Spacer()
                if browser.state == "closed" { Button("打开") { Task { await browser.action("open") } }.buttonStyle(SoftButtonStyle()) }
                Button(browser.control == "user" ? "交还豆豆" : "我来接管") { Task { await browser.action(browser.control == "user" ? "return" : "takeover") } }.buttonStyle(PrimaryButtonStyle(height:34)).disabled(browser.changing)
                Button("关闭浏览器") { Task { await browser.action("close") } }.buttonStyle(SoftButtonStyle()).disabled(browser.changing || browser.state == "closed")
            }.padding(18)
            if !browser.reason.isEmpty { Text(browser.reason).font(Theme.font(size:12)).foregroundStyle(Theme.sub).padding(.bottom,12) }
            GeometryReader { g in
                let size=fit(browser.image?.size ?? CGSize(width:1280,height:800),in:g.size)
                ZStack { Theme.background
                    if let image=browser.image {
                        BrowserSurface(image:image,frameID:browser.frameID,enabled:browser.control == "user",send:browser.input).frame(width:size.width,height:size.height)
                    } else { Note(text:browser.error.isEmpty ? (browser.state == "closed" ? "浏览器已关闭" : "正在接收实时画面…") : browser.error,icon:"globe") }
                }.frame(maxWidth:.infinity,maxHeight:.infinity)
            }
            if !browser.error.isEmpty { Text(browser.error).font(Theme.font(size:12)).padding(10) }
            HStack { Text(browser.control == "user" ? "点击画面后可输入文字、拖动和滚动；⌘V 可粘贴。" : "接管后可操作，登录或验证码完成后交还豆豆。").font(Theme.font(size:11)).foregroundStyle(Theme.sub); Spacer() }.padding(15)
        }.background(Theme.background).foregroundStyle(Theme.ink).preferredColorScheme(Theme.scheme).tint(Theme.ink)
        .background(WindowActivityReader(activity:activity).frame(width:0,height:0))
        .task { browser.observe(viewer,visible:true); await browser.action("open") }
        .onChange(of:activity.active) { browser.observe(viewer,visible:activity.active) }
        .onDisappear { browser.observe(viewer,visible:false) }
        .sheet(isPresented:Binding(get:{browser.dialog != nil && browser.control == "user"},set:{_ in})) {
            VStack(alignment:.leading,spacing:18) {
                Text("网页提示").font(Theme.titleFont(21)); Text(browser.dialog?["message"] as? String ?? "")
                if browser.dialog?["type"] as? String == "prompt" { TextField("输入",text:$prompt).textFieldStyle(.roundedBorder) }
                HStack { Button("取消") { browser.input(["type":"dialog","accept":false]) }.buttonStyle(SoftButtonStyle()); Spacer(); Button("确定") { browser.input(["type":"dialog","accept":true,"promptText":prompt]) }.buttonStyle(PrimaryButtonStyle()) }
            }.padding(28).frame(width:420)
        }
    }
    private func fit(_ image:CGSize,in bounds:CGSize)->CGSize { let k=min(bounds.width/max(1,image.width),bounds.height/max(1,image.height)); return CGSize(width:image.width*k,height:image.height*k) }
}
struct BrowserSurface:NSViewRepresentable {
    let image:NSImage
    let frameID:Int
    let enabled:Bool
    let send:([String:Any])->Void
    func makeNSView(context:Context)->InputView { InputView() }
    func updateNSView(_ v:InputView,context:Context) { v.frameImage=image; v.frameID=frameID; v.canSend=enabled; v.send=send; v.needsDisplay=true }
    /// A fixed-size image canvas implements native text input without NSTextView's content sizing.
    final class InputView:NSView,NSTextInputClient {
        var frameImage:NSImage?
        var frameID=0
        var canSend=false
        var send:(([String:Any])->Void)?
        private var points:[CGPoint]=[]
        private var gestureFrame=0
        private var marked=NSAttributedString(string:"")
        private var selection=NSRange(location:0,length:0)
        private var insertionPoint=NSPoint(x:30,y:30)
        private lazy var imeContext=NSTextInputContext(client:self)
        override var inputContext:NSTextInputContext? { canSend ? imeContext : nil }
        override var isFlipped:Bool { true }
        override var acceptsFirstResponder:Bool { canSend }
        override func draw(_ dirtyRect:NSRect) {
            frameImage?.draw(in:bounds,from:.zero,operation:.copy,fraction:1,respectFlipped:true,hints:nil)
            if hasMarkedText() {
                let rect=NSRect(x:insertionPoint.x,y:insertionPoint.y+12,width:240,height:26)
                NSColor.textBackgroundColor.setFill();NSBezierPath(roundedRect:rect,xRadius:4,yRadius:4).fill()
                (marked.string as NSString).draw(at:NSPoint(x:rect.minX+6,y:rect.minY+4),withAttributes:[.font:NSFont.systemFont(ofSize:14),.foregroundColor:NSColor.textColor,.underlineStyle:NSUnderlineStyle.single.rawValue])
            }
        }
        override func mouseDown(with event:NSEvent) {
            guard canSend else { return }; window?.makeFirstResponder(self); insertionPoint=convert(event.locationInWindow,from:nil); points=[insertionPoint]; gestureFrame=frameID
        }
        override func mouseDragged(with event:NSEvent) {
            guard canSend else { return }; let p=convert(event.locationInWindow,from:nil)
            if points.count < 63 { points.append(p) } else { points[points.count-1]=p }
        }
        override func mouseUp(with event:NSEvent) {
            guard canSend,let first=points.first else { return }; let p=convert(event.locationInWindow,from:nil)
            var row:[String:Any]=["frameId":gestureFrame,"width":bounds.width,"height":bounds.height]
            if points.count > 1 && hypot(p.x-first.x,p.y-first.y)>3 {
                points.append(p); row["type"]="drag"; row["points"]=points.map {["x":max(0,min(bounds.width,$0.x)),"y":max(0,min(bounds.height,$0.y))]}
            } else { row["type"]="click"; row["x"]=p.x; row["y"]=p.y; row["button"]=event.buttonNumber == 1 ? "right" : "left"; row["clickCount"]=event.clickCount }
            send?(row); points=[]
        }
        override func scrollWheel(with event:NSEvent) {
            guard canSend else { return }; let p=convert(event.locationInWindow,from:nil)
            send?(["type":"scroll","frameId":frameID,"x":p.x,"y":p.y,"width":bounds.width,"height":bounds.height,"deltaX":-event.scrollingDeltaX,"deltaY":-event.scrollingDeltaY])
        }
        override func keyDown(with event:NSEvent) {
            guard canSend else { return }
            let keys:[UInt16:String]=[36:"Enter",48:"Tab",51:"Backspace",117:"Delete",53:"Escape",123:"ArrowLeft",124:"ArrowRight",125:"ArrowDown",126:"ArrowUp",115:"Home",119:"End",116:"PageUp",121:"PageDown"]
            if hasMarkedText() { interpretKeyEvents([event]); return }
            if let key=keys[event.keyCode] { sendKey(key,event:event); return }
            if event.modifierFlags.contains(.command) || event.modifierFlags.contains(.control) {
                if event.modifierFlags.contains(.command), event.charactersIgnoringModifiers?.lowercased() == "v" { paste(nil); return }
                if let key=event.charactersIgnoringModifiers { sendKey(key,event:event) }; return
            }
            interpretKeyEvents([event])
        }
        private func sendKey(_ key:String,event:NSEvent) {
            let f=event.modifierFlags
            send?(["type":"key","key":key,"modifiers":(f.contains(.option) ? 1:0)+(f.contains(.control) ? 2:0)+(f.contains(.command) ? 4:0)+(f.contains(.shift) ? 8:0)])
        }
        func insertText(_ insertString:Any,replacementRange:NSRange) {
            guard canSend else {return}; let text=(insertString as? NSAttributedString)?.string ?? insertString as? String ?? ""
            if !text.isEmpty { send?(["type":"text","text":text]) }; unmarkText()
        }
        func setMarkedText(_ value:Any,selectedRange:NSRange,replacementRange:NSRange) {
            marked=(value as? NSAttributedString) ?? NSAttributedString(string:value as? String ?? "")
            selection=selectedRange; needsDisplay=true
        }
        func unmarkText() { marked=NSAttributedString(string:""); selection=NSRange(location:0,length:0); needsDisplay=true }
        func hasMarkedText()->Bool { marked.length>0 }
        func markedRange()->NSRange { hasMarkedText() ? NSRange(location:0,length:marked.length) : NSRange(location:NSNotFound,length:0) }
        func selectedRange()->NSRange { selection }
        func validAttributesForMarkedText()->[NSAttributedString.Key] { [] }
        func attributedSubstring(forProposedRange range:NSRange,actualRange:NSRangePointer?)->NSAttributedString? {
            let r=NSIntersectionRange(range,NSRange(location:0,length:marked.length)); guard r.length>0 else{return nil};actualRange?.pointee=r;return marked.attributedSubstring(from:r)
        }
        func firstRect(forCharacterRange range:NSRange,actualRange:NSRangePointer?)->NSRect {
            actualRange?.pointee=range; let r=convert(NSRect(x:insertionPoint.x,y:insertionPoint.y+12,width:1,height:24),to:nil)
            return window?.convertToScreen(r) ?? r
        }
        func characterIndex(for point:NSPoint)->Int { 0 }
        override func doCommand(by selector:Selector) {
            let keys=["insertNewline:":"Enter","insertTab:":"Tab","deleteBackward:":"Backspace","cancelOperation:":"Escape"]
            if let key=keys[NSStringFromSelector(selector)] { send?(["type":"key","key":key]) }
        }
        @objc func paste(_ sender:Any?) { if canSend,let text=NSPasteboard.general.string(forType:.string) { send?(["type":"text","text":text]) } }
    }
}
