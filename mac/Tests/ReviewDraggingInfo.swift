import AppKit

/// A local Finder-shaped pasteboard delivered to the owned NSTextView's real drop methods.
final class ReviewDraggingInfo: NSObject, NSDraggingInfo {
    let draggingPasteboard: NSPasteboard
    let draggingDestinationWindow: NSWindow?
    init(pasteboard:NSPasteboard,window:NSWindow) {draggingPasteboard=pasteboard;draggingDestinationWindow=window}
    var draggingSourceOperationMask: NSDragOperation {.copy}
    var draggingLocation: NSPoint {NSPoint(x:250,y:80)}
    var draggedImageLocation: NSPoint {.zero}
    var draggedImage: NSImage? {nil}
    var draggingSource: Any? {nil}
    var draggingSequenceNumber: Int {1}
    var draggingFormation: NSDraggingFormation = .none
    var animatesToDestination=false
    var numberOfValidItemsForDrop=2
    var springLoadingHighlight: NSSpringLoadingHighlight {.none}
    func resetSpringLoading() {}
    func slideDraggedImage(to screenPoint:NSPoint) {}
    override func namesOfPromisedFilesDropped(atDestination dropDestination:URL) -> [String]? {nil}
    func enumerateDraggingItems(options enumOpts:NSDraggingItemEnumerationOptions = [], for view:NSView?, classes classArray:[AnyClass], searchOptions:[NSPasteboard.ReadingOptionKey:Any] = [:], using block:(NSDraggingItem,Int,UnsafeMutablePointer<ObjCBool>)->Void) {}
}
