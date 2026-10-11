import SwiftUI

/// Block-level Markdown good enough for chat replies, memory and diary: headings, lists, quotes, code, tables, rules.
enum MDBlock: Hashable {
    case heading(Int, String)
    case paragraph(String)
    case list([MDItem])
    case quote(String)
    case code(String)
    case table([[String]])
    case rule
}

struct MDItem: Hashable {
    let level: Int
    let marker: String
    var text: String
}

private final class MarkdownBlocks: NSObject {
    let text: String
    let blocks: [MDBlock]
    init(text: String, blocks: [MDBlock]) { self.text = text; self.blocks = blocks }
}

private final class MarkdownInline: NSObject {
    let value: AttributedString
    init(_ value: AttributedString) { self.value = value }
}

enum Markdown {
    private static let expressions: NSCache<NSString, NSRegularExpression> = {
        let cache = NSCache<NSString, NSRegularExpression>()
        cache.countLimit = 16
        return cache
    }()
    private static let blocksCache: NSCache<NSString, MarkdownBlocks> = {
        let cache = NSCache<NSString, MarkdownBlocks>()
        cache.countLimit = 512; cache.totalCostLimit = 4 << 20
        return cache
    }()
    private static let inlineCache: NSCache<NSString, MarkdownInline> = {
        let cache = NSCache<NSString, MarkdownInline>()
        cache.countLimit = 1024; cache.totalCostLimit = 4 << 20
        return cache
    }()

    static func blocks(_ text: String, id: UUID?) -> [MDBlock] {
        let key = (id.map { "message:" + $0.uuidString } ?? ("text:" + text)) as NSString
        if let cached = blocksCache.object(forKey: key), cached.text == text { return cached.blocks }
        let blocks = parse(text)
        blocksCache.setObject(MarkdownBlocks(text: text, blocks: blocks), forKey: key, cost: text.utf8.count * 4)
        return blocks
    }

    static func clearCache() { blocksCache.removeAllObjects(); inlineCache.removeAllObjects() }

    private static func match(_ s: String, _ pattern: String) -> [String]? {
        let key = pattern as NSString
        let re: NSRegularExpression
        if let cached = expressions.object(forKey: key) { re = cached }
        else {
            guard let compiled = try? NSRegularExpression(pattern: pattern) else { return nil }
            expressions.setObject(compiled, forKey: key)
            re = compiled
        }
        guard let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) else { return nil }
        return (0..<m.numberOfRanges).map { i in Range(m.range(at: i), in: s).map { String(s[$0]) } ?? "" }
    }

    private static func cells(_ line: String) -> [String] {
        var s = line.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("|") { s.removeFirst() }
        if s.hasSuffix("|") { s.removeLast() }
        return s.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    static func parse(_ text: String) -> [MDBlock] {
        #if MAC_PERF
        PerfProbe.shared.record("markdown_parse")
        #endif
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var blocks: [MDBlock] = []
        var para: [String] = []
        var list: [MDItem] = []
        var quote: [String] = []

        func flush() {
            if !para.isEmpty { blocks.append(.paragraph(para.joined(separator: "\n"))) }
            if !list.isEmpty { blocks.append(.list(list)) }
            if !quote.isEmpty { blocks.append(.quote(quote.joined(separator: "\n"))) }
            para = []
            list = []
            quote = []
        }

        var i = 0
        while i < lines.count {
            let raw = lines[i]
            let line = raw.trimmingCharacters(in: .whitespaces)
            let indent = raw.prefix { $0 == " " || $0 == "\t" }.count
            i += 1
            if line.hasPrefix("```") {
                flush()
                var code: [String] = []
                while i < lines.count && !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    code.append(lines[i])
                    i += 1
                }
                i += 1
                blocks.append(.code(code.joined(separator: "\n")))
            } else if line.isEmpty {
                flush()
            } else if let m = match(line, #"^(#{1,6})\s+(.*)$"#) {
                flush()
                blocks.append(.heading(m[1].count, m[2]))
            } else if match(line, #"^(-{3,}|\*{3,}|_{3,})$"#) != nil {
                flush()
                blocks.append(.rule)
            } else if line.hasPrefix("|"), i < lines.count, match(lines[i], #"^\s*\|?\s*:?-{2,}"#) != nil {
                flush()
                var rows = [cells(line)]
                i += 1
                while i < lines.count && lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("|") {
                    rows.append(cells(lines[i]))
                    i += 1
                }
                blocks.append(.table(rows))
            } else if line.hasPrefix(">") {
                if !para.isEmpty || !list.isEmpty { flush() }
                quote.append(String(line.dropFirst()).trimmingCharacters(in: .whitespaces))
            } else if let m = match(line, #"^[-*+]\s+(.*)$"#) {
                if !para.isEmpty || !quote.isEmpty { flush() }
                list.append(MDItem(level: indent / 2, marker: "•", text: m[1]))
            } else if let m = match(line, #"^(\d+)[.)]\s+(.*)$"#) {
                if !para.isEmpty || !quote.isEmpty { flush() }
                list.append(MDItem(level: indent / 2, marker: m[1] + ".", text: m[2]))
            } else if !list.isEmpty && indent > 0 {
                list[list.count - 1].text += " " + line
            } else {
                if !list.isEmpty || !quote.isEmpty { flush() }
                para.append(line)
            }
        }
        flush()
        return blocks
    }

    /// Inline Markdown (bold, italics, code, links) with a soft background behind code spans.
    static func inline(_ s: String) -> AttributedString {
        if let cached = inlineCache.object(forKey: s as NSString) { return cached.value }
        #if MAC_PERF
        PerfProbe.shared.record("markdown_inline")
        #endif
        var a = (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
        for run in a.runs where run.inlinePresentationIntent?.contains(.code) == true {
            a[run.range].backgroundColor = Color(hex: 0xE6ECF3)
            a[run.range].foregroundColor = Color(hex: 0x3D5470)
        }
        inlineCache.setObject(MarkdownInline(a), forKey: s as NSString, cost: s.utf8.count * 4)
        return a
    }

    /// Split "… → life/居住.md、work/求职.md" into the text and the memory files it points at.
    static func pointers(_ s: String) -> (String, [String]) {
        guard let r = s.range(of: "→") else { return (s, []) }
        let refs = s[r.upperBound...].components(separatedBy: CharacterSet(charactersIn: "、,，; ；"))
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .compactMap { $0.split(separator: " ").first.map(String.init) }
            .filter { $0.hasSuffix(".md") }
        return refs.isEmpty ? (s, []) : (s[..<r.lowerBound].trimmingCharacters(in: .whitespaces), refs)
    }
}

struct MarkdownView: View {
    let text: String
    var size: CGFloat = 14
    var cacheID: UUID? = nil
    var lineHeight: CGFloat? = nil
    /// When set, trailing "→ path.md" pointers become tags that call this with the path.
    var onPointer: ((String) -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: size * 0.6) {
            ForEach(Array(Markdown.blocks(text, id: cacheID).enumerated()), id: \.offset) { _, b in block(b) }
        }
        .foregroundStyle(Theme.ink)
        .tint(Theme.accent)
    }

    @ViewBuilder
    private func block(_ b: MDBlock) -> some View {
        switch b {
        case .heading(let level, let s):
            Text(Markdown.inline(s))
                .font(.system(size: level == 1 ? size + 6 : level == 2 ? size + 3 : size + 1, weight: level <= 2 ? .bold : .semibold))
                .padding(.top, level <= 2 ? 4 : 2)
        case .paragraph(let s):
            if onPointer == nil && s.utf8.count > 1_000 {
                // TextKit lays out long replies line by line without SwiftUI's large attributed-text drawing path.
                MarkdownParagraph(text: s, size: size, lineHeight: lineHeight)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(s.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                        pointerLine(line)
                    }
                }
            }
        case .list(let items):
            VStack(alignment: .leading, spacing: size * 0.4) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in listItem(item) }
            }
        case .quote(let s):
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 1.5).fill(Color(hex: 0xD9C08A)).frame(width: 3)
                Text(Markdown.inline(s)).font(.system(size: size)).foregroundStyle(Theme.sub).lineSpacing(size * 0.3)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .code(let s):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(s).font(.system(size: size - 1.5, design: .monospaced)).foregroundStyle(Color(hex: 0x33475E)).padding(12)
            }
            .background(RoundedRectangle(cornerRadius: 10).fill(Color(hex: 0xEEF2F7)))
        case .table(let rows):
            table(rows)
        case .rule:
            Rectangle().fill(Theme.line).frame(height: 1).padding(.vertical, 4)
        }
    }

    @ViewBuilder
    private func listItem(_ item: MDItem) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(item.marker)
                .font(.system(size: item.marker == "•" ? size : size - 1, weight: item.marker == "•" ? .bold : .regular))
                .foregroundStyle(Theme.faint)
                .frame(minWidth: 12, alignment: .trailing)
            pointerLine(item.text)
        }
        .padding(.leading, CGFloat(item.level) * 16)
    }

    @ViewBuilder
    private func pointerLine(_ line: String) -> some View {
        let (body, refs) = onPointer == nil ? (line, []) : Markdown.pointers(line)
        if !refs.isEmpty, let onPointer {
            MemoryPointerText(text: body, refs: refs, size: size, lineHeight: lineHeight, onPointer: onPointer)
                .frame(maxWidth: .infinity, alignment: .leading)
                .alignmentGuide(.firstTextBaseline) { _ in
                    let font = NSFont.systemFont(ofSize: size)
                    return (22 - (font.ascender - font.descender)) / 2 + font.ascender
                }
        } else {
            Text(Markdown.inline(body)).font(.system(size: size)).lineSpacing(lineHeight.map { max(0, $0 - size * 1.2) } ?? size * 0.3).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func table(_ rows: [[String]]) -> some View {
        let cols = rows.map(\.count).max() ?? 0
        return ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                ForEach(Array(rows.enumerated()), id: \.offset) { r, row in
                    GridRow {
                        ForEach(0..<cols, id: \.self) { c in
                            Text(Markdown.inline(c < row.count ? row[c] : ""))
                                .font(.system(size: size - 1, weight: r == 0 ? .semibold : .regular))
                                .foregroundStyle(r == 0 ? Theme.ink : Theme.ink.opacity(0.9))
                                .frame(maxWidth: 280, alignment: .leading)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    if r == 0 { Rectangle().fill(Theme.line).frame(height: 1).gridCellColumns(cols) }
                }
            }
            .padding(12)
        }
        .background(RoundedRectangle(cornerRadius: 12).fill(Color(hex: 0xF3F6F9, alpha: 0.9)))
    }
}

/// A selectable native paragraph. Its size query only reads a separate, cached TextKit layout.
struct MarkdownParagraph: NSViewRepresentable {
    let text: String
    let size: CGFloat
    var lineHeight: CGFloat? = nil

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> GrowingInputContainer {
        let view = GrowingInputContainer(fontSize: size, verticalPadding: 0, maximumLines: nil)
        view.editor.isEditable = false
        view.editor.identifier = NSUserInterfaceItemIdentifier("markdown-paragraph")
        view.editor.isSelectable = true
        view.editor.linkTextAttributes = [.foregroundColor: NSColor(Theme.accent)]
        return view
    }

    func updateNSView(_ view: GrowingInputContainer, context: Context) {
        guard context.coordinator.text != text else { return }
        context.coordinator.text = text
        view.editor.textStorage?.setAttributedString(MemoryPointerText.rendered(text: text, refs: [], size: size, lineHeight: lineHeight))
        view.textChanged(force: true)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: GrowingInputContainer, context: Context) -> CGSize? {
        let width = proposal.width ?? max(1, nsView.bounds.width)
        guard width.isFinite else { return nil }
        return CGSize(width: width, height: nsView.measuredHeight(width: max(1, width)))
    }

    final class Coordinator { var text = "" }
}

/// "生活 · 居住" tag for a memory file pointer.
struct PointerTag: View {
    let path: String
    let action: () -> Void

    var body: some View {
        let parts = path.split(separator: "/").map(String.init)
        let file = (parts.last ?? path).replacingOccurrences(of: ".md", with: "")
        let cat = parts.count > 1 ? Theme.category(parts[parts.count - 2]) : nil
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: cat?.icon ?? "doc.text").font(.system(size: 9.5, weight: .semibold))
                Text(cat.map { "\($0.name) · \(file)" } ?? file).font(.system(size: 11.5, weight: .medium))
            }
            .foregroundStyle(cat?.color ?? Theme.accent)
            .padding(.horizontal, 9)
            .frame(height: 22)
            .background(Capsule().fill((cat?.color ?? Theme.accent).opacity(0.09)))
            .overlay(Capsule().strokeBorder((cat?.color ?? Theme.accent).opacity(0.18), lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

/// TextKit keeps each capsule as one inline glyph, so it uses the last text line's remaining width before wrapping.
struct MemoryPointerText: NSViewRepresentable {
    let text: String
    let refs: [String]
    let size: CGFloat
    var lineHeight: CGFloat? = nil
    let onPointer: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onPointer: onPointer) }

    func makeNSView(context: Context) -> NSTextView {
        let view = NSTextView(frame: .zero)
        view.isEditable = false
        view.isSelectable = true
        view.drawsBackground = false
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        view.textContainer?.widthTracksTextView = false
        view.delegate = context.coordinator
        view.linkTextAttributes = [.foregroundColor: NSColor(Theme.accent)]
        return view
    }

    func updateNSView(_ view: NSTextView, context: Context) {
        context.coordinator.onPointer = onPointer
        view.textStorage?.setAttributedString(Self.rendered(text: text, refs: refs, size: size, lineHeight: lineHeight))
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSTextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite, width > 0,
              let container = nsView.textContainer, let layout = nsView.layoutManager else { return nil }
        container.containerSize = CGSize(width: width, height: .greatestFiniteMagnitude)
        layout.ensureLayout(for: container)
        return CGSize(width: width, height: ceil(layout.usedRect(for: container).height))
    }

    @MainActor
    static func rendered(text: String, refs: [String], size: CGFloat, lineHeight: CGFloat? = nil) -> NSAttributedString {
        let result = NSMutableAttributedString()
        let base = NSFont.systemFont(ofSize: size)
        let markdown = Markdown.inline(text)
        for run in markdown.runs {
            var font = base
            let intent = run.inlinePresentationIntent
            var attributes: [NSAttributedString.Key: Any] = [.foregroundColor: NSColor(Theme.ink)]
            if intent?.contains(.code) == true {
                font = .monospacedSystemFont(ofSize: size, weight: .regular)
                attributes[.backgroundColor] = NSColor(Color(hex: 0xE6ECF3))
                attributes[.foregroundColor] = NSColor(Color(hex: 0x3D5470))
            } else {
                if intent?.contains(.stronglyEmphasized) == true { font = NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask) }
                if intent?.contains(.emphasized) == true { font = NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask) }
            }
            attributes[.font] = font
            if intent?.contains(.strikethrough) == true { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            if let link = run.link { attributes[.link] = link }
            result.append(NSAttributedString(string: String(markdown[run.range].characters), attributes: attributes))
        }
        for ref in refs {
            result.append(NSAttributedString(string: " ", attributes: [.font: base]))
            let renderer = ImageRenderer(content: PointerTag(path: ref, action: {}).preferredColorScheme(.light))
            renderer.scale = 2
            guard let image = renderer.nsImage else { continue }
            let attachment = NSTextAttachment()
            attachment.image = image
            attachment.bounds = CGRect(x: 0, y: base.descender - (22 - (base.ascender - base.descender)) / 2,
                                       width: image.size.width, height: 22)
            let tag = NSMutableAttributedString(attachment: attachment)
            var url = URLComponents()
            url.scheme = "doudou-memory"
            url.host = "file"
            url.path = "/" + ref
            if let link = url.url { tag.addAttribute(.link, value: link, range: NSRange(location: 0, length: tag.length)) }
            tag.addAttribute(.toolTip, value: ref, range: NSRange(location: 0, length: tag.length))
            result.append(tag)
        }
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = size * 0.3
        if let lineHeight { paragraph.lineSpacing = 0; paragraph.minimumLineHeight = lineHeight; paragraph.maximumLineHeight = lineHeight }
        paragraph.lineBreakMode = .byWordWrapping
        result.addAttribute(.paragraphStyle, value: paragraph, range: NSRange(location: 0, length: result.length))
        return result
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var onPointer: (String) -> Void
        init(onPointer: @escaping (String) -> Void) { self.onPointer = onPointer }

        func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
            guard let url = link as? URL, url.scheme == "doudou-memory", url.host == "file" else { return false }
            onPointer(String(url.path.dropFirst()))
            return true
        }
    }
}
