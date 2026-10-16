import AppKit
import SwiftUI

/// One native editor for both chat composers. SwiftUI receives a size, never a height-state feedback update.
struct GrowingInput: NSViewRepresentable {
    @Binding var text: String
    @Binding var focused: Bool
    let placeholder: String
    var enabled = true
    var fontSize: CGFloat = Theme.bodySize
    var verticalPadding: CGFloat = 10
    let onSubmit: () -> Void
    var onAttachmentPaste: (NSPasteboard) -> Bool = { _ in false }

    func makeCoordinator() -> Coordinator { Coordinator(owner: self) }

    func makeNSView(context: Context) -> GrowingInputContainer {
        let view = GrowingInputContainer(fontSize: fontSize, verticalPadding: verticalPadding)
        view.editor.delegate = context.coordinator
        view.editor.onSubmit = { [weak coordinator = context.coordinator] in coordinator?.submit() }
        view.editor.onAttachmentPaste = { [weak coordinator = context.coordinator] in
            coordinator?.owner.onAttachmentPaste($0) ?? false
        }
        return view
    }

    func updateNSView(_ view: GrowingInputContainer, context: Context) {
        let color = NSColor(Theme.ink)
        if view.editor.textColor != color {
            view.editor.textColor = color; view.editor.insertionPointColor = color; view.editor.needsDisplay = true
        }
        let font = NSFont.systemFont(ofSize: fontSize, weight: .regular)
        if view.editor.font != font { view.editor.font = font; view.textChanged(force: true) }
        let coordinator = context.coordinator
        coordinator.owner = self
        if view.editor.placeholder != placeholder {
            view.editor.placeholder = placeholder
            view.editor.setAccessibilityLabel(placeholder)
        }
        if view.editor.isEditable != enabled { view.editor.isEditable = enabled }
        if !view.editor.hasMarkedText(), view.editor.string != text {
            coordinator.updating = true
            view.editor.string = text
            view.textChanged()
            if text.isEmpty { view.contentView.scroll(to: .zero) }
            coordinator.updating = false
        }
        if focused && !coordinator.focusRequested {
            view.requestFocus = enabled
            DispatchQueue.main.async { [weak view] in view?.applyFocusRequest() }
        }
        coordinator.focusRequested = focused
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: GrowingInputContainer, context: Context) -> CGSize? {
        let width = proposal.width ?? nsView.bounds.width
        guard width.isFinite else { return CGSize(width: max(1, nsView.bounds.width), height: nsView.minimumHeight) }
        return CGSize(width: width, height: nsView.measuredHeight(width: max(1, width)))
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var owner: GrowingInput
        var updating = false
        var focusRequested = false
        init(owner: GrowingInput) { self.owner = owner }

        func textDidChange(_ notification: Notification) {
            guard let editor = notification.object as? ComposerTextView else { return }
            (editor.enclosingScrollView as? GrowingInputContainer)?.textChanged()
            if !updating, owner.text != editor.string { owner.text = editor.string }
        }

        func textDidBeginEditing(_ notification: Notification) { if !owner.focused { owner.focused = true } }
        func textDidEndEditing(_ notification: Notification) { if owner.focused { owner.focused = false } }
        func submit() { if owner.enabled { owner.onSubmit() } }
    }
}

final class GrowingInputContainer: NSScrollView {
    let editor = ComposerTextView(frame: .zero)
    private let verticalPadding: CGFloat
    private let lineHeight: CGFloat
    private let maximumLines: Int?
    private let measureStorage = NSTextStorage()
    private let measureLayout = NSLayoutManager()
    private let measureContainer = NSTextContainer(size: .zero)
    private var measuredText = ""
    private var displayWidth: CGFloat = -1
    private var arranging = false
    private struct Measurement { let height: CGFloat; let document: CGFloat }
    private var sizes: [CGFloat: Measurement] = [:]
    private(set) var measurementCount = 0
    var requestFocus = false
    var minimumHeight: CGFloat { lineHeight + verticalPadding * 2 }

    init(fontSize: CGFloat, verticalPadding: CGFloat, maximumLines: Int? = 5) {
        self.verticalPadding = verticalPadding
        self.maximumLines = maximumLines
        let font = NSFont.systemFont(ofSize: fontSize)
        lineHeight = ceil(NSLayoutManager().defaultLineHeight(for: font))
        super.init(frame: .zero)
        measureStorage.addLayoutManager(measureLayout)
        measureLayout.addTextContainer(measureContainer)
        measureContainer.lineFragmentPadding = 0
        drawsBackground = false
        borderType = .noBorder
        hasHorizontalScroller = false
        hasVerticalScroller = maximumLines != nil
        scrollerStyle = .overlay
        autohidesScrollers = true
        editor.font = font
        editor.textColor = NSColor(Theme.ink)
        editor.insertionPointColor = NSColor(Theme.ink)
        editor.drawsBackground = false
        editor.isRichText = false
        editor.isVerticallyResizable = false
        editor.isHorizontallyResizable = false
        editor.textContainerInset = NSSize(width: 0, height: verticalPadding)
        editor.textContainer?.lineFragmentPadding = 0
        editor.textContainer?.widthTracksTextView = false
        editor.textContainer?.heightTracksTextView = false
        editor.isAutomaticQuoteSubstitutionEnabled = false
        editor.isAutomaticDashSubstitutionEnabled = false
        editor.isAutomaticSpellingCorrectionEnabled = false
        editor.identifier = NSUserInterfaceItemIdentifier("chat-composer")
        editor.registerForDraggedTypes(editor.registeredDraggedTypes + [.fileURL,.png,.tiff])
        documentView = editor
        setContentHuggingPriority(.defaultLow, for: .horizontal)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func textChanged(force: Bool = false) {
        guard force || measuredText != editor.string else { return }
        measuredText = editor.string
        if let storage = editor.textStorage { measureStorage.setAttributedString(storage) }
        sizes.removeAll(keepingCapacity: true)
        needsLayout = true
        arrangeDocument()
        invalidateIntrinsicContentSize()
        editor.needsDisplay = true
    }

    private func measure(width: CGFloat) -> Measurement {
        let width = floor(width * 2) / 2
        if let cached = sizes[width] { return cached }
        // A zero/minimum-width proposal is not a displayed editor and does not need thousands of one-character lines.
        guard width >= 2 else { return Measurement(height: minimumHeight, document: minimumHeight) }
        measurementCount += 1
        #if MAC_PERF
        PerfProbe.shared.record("editor_measure")
        #endif
        // This separate TextKit graph is invisible to SwiftUI and never changes the displayed text container.
        measureContainer.containerSize = NSSize(width: width, height: .greatestFiniteMagnitude)
        measureLayout.ensureLayout(for: measureContainer)
        let document = max(minimumHeight, ceil(measureLayout.usedRect(for: measureContainer).height) + verticalPadding * 2)
        let height = maximumLines.map { min(document, lineHeight * CGFloat($0) + verticalPadding * 2) } ?? document
        let result = Measurement(height: height, document: document)
        if sizes.count >= 32 { sizes.removeAll(keepingCapacity: true) }
        sizes[width] = result
        return result
    }

    func measuredHeight(width: CGFloat) -> CGFloat { measure(width: width).height }

    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: measuredHeight(width: max(1, bounds.width)))
    }

    override func tile() { super.tile(); arrangeDocument() }
    override func layout() { super.layout(); arrangeDocument() }

    private func arrangeDocument() {
        guard !arranging else { return }
        arranging = true
        defer { arranging = false }
        let width = max(1, floor(contentSize.width * 2) / 2)
        let measured = measure(width: width)
        let widthChanged = displayWidth != width
        if widthChanged {
            displayWidth = width
            editor.textContainer?.containerSize = NSSize(width: width, height: .greatestFiniteMagnitude)
        }
        let size = NSSize(width: width, height: max(measured.document, contentSize.height))
        if editor.frame.size != size { editor.setFrameSize(size) }
        if widthChanged { invalidateIntrinsicContentSize() }
    }

    override func scrollWheel(with event: NSEvent) {
        if maximumLines == nil { nextResponder?.scrollWheel(with: event) }
        else { super.scrollWheel(with: event) }
    }

    override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); applyFocusRequest() }

    func applyFocusRequest() {
        guard requestFocus, editor.isEditable, let window else { return }
        requestFocus = false
        if window.firstResponder !== editor { window.makeFirstResponder(editor) }
    }
}

final class ComposerTextView: NSTextView {
    var placeholder = "" { didSet { if placeholder != oldValue { needsDisplay = true } } }
    var onSubmit: (() -> Void)?
    var onAttachmentPaste: ((NSPasteboard) -> Bool)?

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 36 || event.keyCode == 76 {
            guard isEditable else { return }
            // Test before the input system commits marked text; the same Return must never also send.
            if hasMarkedText() { super.keyDown(with: event); return }
            if event.modifierFlags.contains(.option) { super.insertNewline(nil) } else { onSubmit?() }
            return
        }
        super.keyDown(with: event)
    }

    override func paste(_ sender: Any?) {
        guard isEditable else { return }
        if pasteAttachment(from: .general) { return }
        super.paste(sender)
    }

    // NSTextView consumes Finder drops before the surrounding SwiftUI onDrop can see them.
    // Route those through the same attachment reader as paste; never insert file paths into the text.
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        if sender.draggingPasteboard.types?.contains(.fileURL) == true || NSImage.canInit(with:sender.draggingPasteboard) {
            return isEditable ? .copy : []
        }
        return super.draggingEntered(sender)
    }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        draggingEntered(sender)
    }
    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        if sender.draggingPasteboard.types?.contains(.fileURL) == true || NSImage.canInit(with:sender.draggingPasteboard) {return isEditable}
        return super.prepareForDragOperation(sender)
    }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        if pasteAttachment(from:sender.draggingPasteboard) { return true }
        return super.performDragOperation(sender)
    }

    @discardableResult
    func pasteAttachment(from pasteboard: NSPasteboard) -> Bool {
        guard isEditable else { return false }
        return onAttachmentPaste?(pasteboard) ?? false
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        if string.isEmpty && !hasMarkedText() {
            let attributes: [NSAttributedString.Key: Any] = [.font: font ?? NSFont.systemFont(ofSize: 14),
                                                           .foregroundColor: NSColor(Theme.faint)]
            (placeholder as NSString).draw(at: NSPoint(x: textContainerInset.width, y: textContainerInset.height),
                                          withAttributes: attributes)
        }
    }
}
