import AppKit
import SwiftUI
import WebKit

@MainActor func memoryPressureFixtures() async throws {
    let refs = ["life/居住.md", "work/项目记录.md", "preferences/协作习惯.md"]
    let text = String(repeating: "一条带多个文件指针的稳定记忆。", count: 12)
    let content = NativeMarkdownContent(text: text, refs: refs, size: 14, lineHeight: 26)
    let rendered = MemoryPointerText.rendered(text: text, refs: refs, size: 14, lineHeight: 26)
    try check(rendered === MemoryPointerText.rendered(text: text, refs: refs, size: 14, lineHeight: 26), "same native Markdown reuses its rendered attributed string")
    let other = MemoryPointerText.rendered(text: "另一个正文", refs: refs, size: 14)
    func images(_ value: NSAttributedString) -> [NSImage] {
        var images: [NSImage] = []
        value.enumerateAttribute(.attachment, in: NSRange(location: 0, length: value.length)) { attachment, _, _ in
            if let image = (attachment as? NSTextAttachment)?.image { images.append(image) }
        }
        return images
    }
    let originalImages = images(rendered), otherImages = images(other)
    try check(originalImages.count == 3 && zip(originalImages, otherImages).allSatisfy { $0 === $1 }, "different text reuses pointer bitmap objects")
    let native = MemoryPointerTextView(frame: NSRect(x: 0, y: 0, width: 410, height: 100), textContainer: nil)
    native.textContainer?.widthTracksTextView = false
    native.textContainer?.lineFragmentPadding = 0
    native.textContainerInset = .zero
    let coordinator = MemoryPointerText.Coordinator { _ in }
    try check(coordinator.apply(content, to: native), "first pointer content applies")
    native.layoutSubtreeIfNeeded()
    let displayed = native.textContainer!.containerSize, frame = native.frame
    let height = native.measuredHeight(width: 240)
    let measurements = native.measurementCount
    for _ in 0..<10_000 {
        try check(!coordinator.apply(content, to: native), "unchanged pointer update is a no-op")
        try check(native.measuredHeight(width: 240) == height, "stable proposed width reuses measured height")
    }
    try check(native.measurementCount == measurements && native.textContainer!.containerSize == displayed && native.frame == frame,
              "size queries neither relayout the live container nor alter the native frame")
    for width in stride(from: CGFloat(100), to: 2000, by: 7) { _ = native.measuredHeight(width: width) }
    try check(native.textContainer!.containerSize == displayed, "varying proposals still leave the displayed TextKit container alone")
    try check(coordinator.apply(.init(text: text, refs: refs, size: 17, lineHeight: 30), to: native), "font and line-height changes invalidate native content")
    let font = native.textStorage!.attribute(.font, at: 0, effectiveRange: nil) as? NSFont
    try check(font?.pointSize == 17, "updated font actually appears in the text storage")
    native.isEditable = false
    native.appearance = NSAppearance(named: .aqua)
    native.drawsBackground = true; native.backgroundColor = .white
    native.setFrameSize(NSSize(width: 410, height: native.measuredHeight(width: 410)))
    native.layoutSubtreeIfNeeded()
    if let bitmap = native.bitmapImageRepForCachingDisplay(in: native.bounds) {
        native.cacheDisplay(in: native.bounds, to: bitmap)
        let output = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("verification/v0.5.0/memory-pressure/pointer-native.png")
        try bitmap.representation(using: .png, properties: [:])?.write(to: output)
    }

    var documentHeight: CGFloat = 1, loading = true, failed = ""
    let parent = BriefWebView(html: "", documentHeight: Binding(get: { documentHeight }, set: { documentHeight = $0 }),
        loading: Binding(get: { loading }, set: { loading = $0 }), failed: Binding(get: { failed }, set: { failed = $0 }))
    let webCoordinator = BriefWebView.Coordinator(parent)
    webCoordinator.webView(WKWebView(), didFail: nil, withError: NSError(domain: "fixture", code: 9))
    try check(loading && failed.isEmpty, "WebKit callbacks do not synchronously publish SwiftUI state")
    try await Task.sleep(nanoseconds: 60_000_000)
    try check(!loading && !failed.isEmpty, "deferred WebKit status is published on a later turn")
    loading = true; failed = ""
    webCoordinator.webView(WKWebView(), didFail: nil, withError: NSError(domain: "fixture", code: 9))
    webCoordinator.invalidate()
    try await Task.sleep(nanoseconds: 60_000_000)
    try check(loading && failed.isEmpty && documentHeight == 1, "recycled WebKit coordinator drops pending publications")
    print("PASS: 10,000 unchanged native updates reuse bitmap/text/height caches; measurement does not mutate the displayed view; WebKit publishes later and cancels on recycling")
}
