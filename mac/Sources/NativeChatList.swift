import AppKit
import SwiftUI
import Observation

@Observable final class ChatPresentationActivity {
    private(set) var active=false
    @ObservationIgnored private var target=false
    @ObservationIgnored private var pending=false
    func set(_ value:Bool) {
        target=value
        guard !pending,active != value else{return};pending=true
        // NSViewRepresentable.updateNSView is inside the parent graph update.
        // Relay lifecycle changes after that transaction, to the hosted graph.
        DispatchQueue.main.async { [self] in pending=false;active=target }
    }
}
private struct ChatHostedContent:View {
    let content:AnyView
    let activity:ChatPresentationActivity
    var body:some View {content.environment(\.interactiveWindow,activity.active)}
}

final class ChatLayoutCache {
    var width:CGFloat=0
    var revision = -1
    var heights:[UUID:CGFloat]=[:]
    var items:[UUID:ChatItem]=[:]
    var readingAnchor:(id:UUID,offset:CGFloat)?
    func reset(){width=0;revision = -1;heights=[:];items=[:];readingAnchor=nil}
}

/// AppKit owns scrolling and row reuse. SwiftUI lays out only the visible bubbles,
/// never a value-type ForEach over the entire long-lived conversation.
struct NativeChatList: NSViewRepresentable {
    let transcript: ChatTranscript
    let state: ChatScrollState
    var compact=false
    var topInset: CGFloat=0
    var active=false
    var visible=true
    var returnRevision=0
    func makeCoordinator()->Coordinator {Coordinator()}
    func makeNSView(context:Context)->NSScrollView {context.coordinator.make()}
    func updateNSView(_ view:NSScrollView,context:Context) {
        let coordinator=context.coordinator,revision=transcript.revision
        coordinator.enqueue { [weak coordinator] in
            coordinator?.update(transcript:transcript,revision:revision,state:state,compact:compact,topInset:topInset,active:active,visible:visible,returnRevision:returnRevision)
        }
    }
    static func dismantleNSView(_ view:NSScrollView,coordinator:Coordinator) {coordinator.close()}

    @MainActor final class Coordinator:NSObject,NSTableViewDataSource,NSTableViewDelegate {
        let scroll=ChatListScroll(),table=ChatTableView()
        var transcript:ChatTranscript?
        var state:ChatScrollState?
        var items:[ChatItem]=[]
        var revision = -1, sentRevision = -1, returnRevision = -1
        var compact=false, active=false, topInset:CGFloat=0, width:CGFloat=0
        var metrics=ChatLayoutCache()
        let activity=ChatPresentationActivity()
        var observers:[NSObjectProtocol]=[]
        var wheel:Any?
        var following=false, pendingBottom=false, closed=false
        private var latestUpdate:(()->Void)?
        private var updateQueued=false,resizeQueued=false
        // Hosting a row enters a separate SwiftUI graph. Apply native changes
        // after the enclosing representable transaction; coalesce streamed updates.
        func enqueue(_ update:@escaping()->Void) {
            guard !closed else{return};latestUpdate=update
            guard !updateQueued else{return};updateQueued=true
            DispatchQueue.main.async{[weak self] in
                guard let self,!self.closed else{return};self.updateQueued=false
                let update=self.latestUpdate;self.latestUpdate=nil;update?()
            }
        }
        func scheduleResize(){
            guard !closed,!resizeQueued else{return};resizeQueued=true
            DispatchQueue.main.async{[weak self] in
                guard let self,!self.closed else{return};self.resizeQueued=false;self.resize()
            }
        }
        var userScrollUntil:TimeInterval=0
        var readingAnchor:(id:UUID,offset:CGFloat)? {get{metrics.readingAnchor}set{metrics.readingAnchor=newValue}}
        func make()->NSScrollView {
            scroll.drawsBackground=false;scroll.hasVerticalScroller=true;scroll.autohidesScrollers=true
            OverlayScrollbars.style(scroll)
            table.headerView=nil;table.backgroundColor = .clear;table.intercellSpacing=NSSize(width:0,height:12)
            table.selectionHighlightStyle = .none;table.allowsEmptySelection=true;table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
            let column=NSTableColumn(identifier:NSUserInterfaceItemIdentifier("message"));column.resizingMask = .autoresizingMask;table.addTableColumn(column)
            table.dataSource=self;table.delegate=self;scroll.documentView=table
            scroll.onResize={[weak self] in self?.scheduleResize()}
            scroll.contentView.postsBoundsChangedNotifications=true
            observers=[NotificationCenter.default.addObserver(forName:NSView.boundsDidChangeNotification,object:scroll.contentView,queue:.main){[weak self] _ in MainActor.assumeIsolated{self?.report()}}]
            wheel=NSEvent.addLocalMonitorForEvents(matching:.scrollWheel){[weak self] event in
                if let self,event.window === self.scroll.window,self.scroll.visibleRect.contains(self.scroll.convert(event.locationInWindow,from:nil)){self.readingAnchor=nil;self.userScrollUntil=ProcessInfo.processInfo.systemUptime+0.5}
                return event
            }
            return scroll
        }
        func update(transcript:ChatTranscript,revision:Int,state:ChatScrollState,compact:Bool,topInset:CGFloat,active:Bool,visible:Bool,returnRevision:Int) {
            self.state=state;self.active=active
            activity.set(active && visible)
            guard visible else{return}
            let rebound=self.transcript !== transcript || self.compact != compact
            let changed=rebound || self.revision != revision
            if rebound {metrics=compact ? ChatLayoutCache():transcript.layoutCache;sentRevision=transcript.sentRevision;width=0}
            self.transcript=transcript;self.compact=compact;self.topInset=topInset
            if changed {
                let next=(compact ? Array(transcript.items.suffix(60)):transcript.items).filter(\.visible)
                let old=Dictionary(items.map{($0.id,$0)},uniquingKeysWith:{_,new in new})
                if metrics.revision != revision {
                    let snapshots=Dictionary(next.map{($0.id,$0)},uniquingKeysWith:{_,new in new})
                    for item in next where metrics.items[item.id] != item {metrics.heights.removeValue(forKey:item.id)}
                    metrics.heights=metrics.heights.filter{snapshots[$0.key] != nil};metrics.items=snapshots;metrics.revision=revision
                }
                let sameOrder=items.map(\.id)==next.map(\.id)
                items=next;self.revision=revision;state.messages(items)
                if sameOrder {
                    let changedRows=IndexSet(items.indices.filter{old[items[$0].id] != items[$0]})
                    if !changedRows.isEmpty {table.reloadData(forRowIndexes:changedRows,columnIndexes:IndexSet(integer:0));table.noteHeightOfRows(withIndexesChanged:changedRows)}
                } else {table.reloadData()}
                if state.atBottom {bottom()}
            }
            if sentRevision != transcript.sentRevision {sentRevision=transcript.sentRevision;state.returnToBottom();bottom()}
            if self.returnRevision != returnRevision {self.returnRevision=returnRevision;if state.atBottom {bottom()}}
            resize()
        }
        func resize() {
            let next=scroll.contentSize.width
            guard next>40,abs(next-width)>0.5 else{return}
            if state?.atBottom != true && width>0 {
                let row=table.row(at:NSPoint(x:1,y:scroll.contentView.bounds.minY+1))
                if items.indices.contains(row){readingAnchor=(items[row].id,scroll.contentView.bounds.minY-table.rect(ofRow:row).minY)}
            }
            width=next
            if abs(metrics.width-next)>0.5 {metrics.heights.removeAll(keepingCapacity:true);metrics.width=next}
            table.tableColumns.first?.width=next
            table.noteHeightOfRows(withIndexesChanged:IndexSet(items.indices));table.reloadData()
            if state?.atBottom == true {bottom()}else{restoreAnchor()}
        }
        func numberOfRows(in tableView:NSTableView)->Int {items.count}
        func tableView(_ tableView:NSTableView,shouldSelectRow row:Int)->Bool {false}
        func tableView(_ tableView:NSTableView,rowViewForRow row:Int)->NSTableRowView? {
            let view=NSTableRowView();view.setAccessibilityElement(true);view.setAccessibilityRole(.row);return view
        }
        func tableView(_ tableView:NSTableView,heightOfRow row:Int)->CGFloat {
            guard items.indices.contains(row) else{return 1}
            return (metrics.heights[items[row].id] ?? 140)+(row==0 ? topInset:0)
        }
        func tableView(_ tableView:NSTableView,viewFor tableColumn:NSTableColumn?,row:Int)->NSView? {
            guard items.indices.contains(row),let transcript else{return nil}
            let id=NSUserInterfaceItemIdentifier("bubble"),cell=(tableView.makeView(withIdentifier:id,owner:self) as? ChatBubbleHost) ?? ChatBubbleHost()
            cell.identifier=id
            let item=items[row],padding:CGFloat=compact ? 14:28
            let contentWidth=max(180,min(width-2*padding,compact ? width-2*padding:680))
            let bubble=MessageRow(item:item,compact:compact,transcript:transcript).id(item.id).frame(width:contentWidth,alignment:.leading).fixedSize(horizontal:false,vertical:true).padding(.horizontal,padding).padding(.top,row==0 ? topInset:0).padding(.bottom,2)
            let root=ChatHostedContent(content:AnyView(bubble),activity:activity)
            cell.configure(AnyView(root),width:width)
            cell.onHeight={[weak self,weak cell] height in
                guard let self,let cell,!self.closed,let index=self.items.firstIndex(where:{$0.id==item.id}),self.table.row(for:cell)==index else{return}
                let value=ceil(height)-(index==0 ? self.topInset:0)
                guard value.isFinite,value>0,abs((self.metrics.heights[item.id] ?? 140)-value)>0.5 else{return}
                self.metrics.heights[item.id]=value;let follow=self.state?.atBottom == true
                self.table.noteHeightOfRows(withIndexesChanged:IndexSet(integer:index))
                if follow {self.bottom()}else{self.restoreAnchor()}
            }
            return cell
        }
        func bottom() {
            readingAnchor=nil
            guard !pendingBottom,!closed else{return};pendingBottom=true
            DispatchQueue.main.async{[weak self] in
                guard let self,!self.closed else{return};self.pendingBottom=false
                guard self.state?.atBottom == true,!self.items.isEmpty else{return}
                self.following=true;self.table.scrollRowToVisible(self.items.count-1)
                self.scroll.contentView.scroll(to:NSPoint(x:0,y:max(0,self.table.bounds.height-self.scroll.contentSize.height)));self.scroll.reflectScrolledClipView(self.scroll.contentView)
                self.following=false
            }
        }
        func restoreAnchor() {
            guard !closed,let anchor=readingAnchor,let row=items.firstIndex(where:{$0.id==anchor.id}) else{return}
            let rect=table.rect(ofRow:row),offset=max(0,min(anchor.offset,max(0,rect.height-1)))
            following=true
            scroll.contentView.scroll(to:NSPoint(x:0,y:rect.minY+offset));scroll.reflectScrolledClipView(scroll.contentView)
            following=false
        }
        func report() {
            guard !following else{return}
            let clip=scroll.contentView.bounds,distance=max(0,table.bounds.height-clip.maxY)
            state?.report(distance:distance,viewport:clip.height,positionChanged:ProcessInfo.processInfo.systemUptime<userScrollUntil)
        }
        func close(){
            activity.set(false)
            if state?.atBottom != true {
                let row=table.row(at:NSPoint(x:1,y:scroll.contentView.bounds.minY+1))
                if items.indices.contains(row){readingAnchor=(items[row].id,scroll.contentView.bounds.minY-table.rect(ofRow:row).minY)}
            }
            closed=true;latestUpdate=nil;observers.forEach(NotificationCenter.default.removeObserver);observers=[];if let wheel{NSEvent.removeMonitor(wheel)};wheel=nil;scroll.onResize=nil;items=[];transcript=nil;table.dataSource=nil;table.reloadData();table.delegate=nil;scroll.documentView=nil
        }
    }
}

/// Keep accessibility virtualized too. Enumerating every history row can ask
/// AppKit to materialize offscreen hosting views just to inspect their content.
/// The table still reports its full row count; scrolling exposes the next rows.
final class ChatTableView:NSTableView {
    private func visibleRows()->[any NSAccessibilityRow] {
        let range=rows(in:visibleRect)
        guard range.location != NSNotFound,range.length>0 else{return []}
        return (range.location..<min(numberOfRows,NSMaxRange(range))).compactMap {
            rowView(atRow:$0,makeIfNecessary:false) as (any NSAccessibilityRow)?
        }
    }
    override func accessibilityRowCount()->Int {numberOfRows}
    override func accessibilityRows()->[any NSAccessibilityRow]? {visibleRows()}
    override func accessibilityChildren()->[Any]? {visibleRows()}
    override func accessibilityVisibleRows()->[any NSAccessibilityRow]? {visibleRows()}
}

final class ChatListScroll:NSScrollView {
    var onResize:(()->Void)?
    override func layout(){super.layout();onResize?()}
}

final class ChatBubbleHost:NSView {
    private var host=ChatHostingView(rootView:AnyView(EmptyView()))
    var onHeight:((CGFloat)->Void)?
    private var measuring=false
    override init(frame:NSRect){super.init(frame:frame);addSubview(host);host.onInvalidate={[weak self] in self?.measureSoon()}}
    convenience init(){self.init(frame:.zero)}
    required init?(coder:NSCoder){fatalError()}
    func configure(_ root:AnyView,width:CGFloat){onHeight=nil;host.rootView=root;host.frame.size.width=width;measureSoon()}
    override func layout(){super.layout();host.frame=NSRect(x:max(0,(bounds.width-host.frame.width)/2),y:0,width:host.frame.width,height:bounds.height);measureSoon()}
    private func measureSoon(){
        guard !measuring else{return};measuring=true
        DispatchQueue.main.async{[weak self] in
            guard let self else{return};let height=self.host.fittingSize.height;self.measuring=false
            if height.isFinite,height>0 {self.onHeight?(height)}
        }
    }
}
final class ChatHostingView:NSHostingView<AnyView> {
    var onInvalidate:(()->Void)?
    override func invalidateIntrinsicContentSize(){super.invalidateIntrinsicContentSize();onInvalidate?()}
}
