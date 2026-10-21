import AppKit
import SwiftUI

/// A thin native overlay scroller, without a permanent gutter beside content.
struct OverlayScrollbars: NSViewRepresentable {
    func makeNSView(context: Context) -> Reader { Reader() }
    func updateNSView(_ view: Reader, context: Context) { view.apply() }
    static func style(_ scroll: NSScrollView) {
        scroll.scrollerStyle = .overlay; scroll.autohidesScrollers = true
        scroll.verticalScroller?.controlSize = .mini; scroll.horizontalScroller?.controlSize = .mini
    }
    final class Reader: NSView {
        private weak var styled: NSScrollView?
        override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); apply() }
        override func layout() { super.layout(); apply() }
        func apply() {
            guard let scroll = enclosingScrollView, styled !== scroll else { return }
            styled = scroll
            // SwiftUI owns the enclosing ScrollView's current layout transaction.
            // Change its AppKit chrome after that transaction has completed.
            DispatchQueue.main.async { [weak scroll] in if let scroll {OverlayScrollbars.style(scroll)} }
        }
    }
}

struct ChoiceControl<Value: Hashable>: View {
    let title: String
    @Binding var selection: Value
    let choices: [(Value, String)]
    @State private var opened = false
    var body: some View {
        Button { opened.toggle() } label: {
            HStack(spacing: 14) {
                Text(choices.first { $0.0 == selection }?.1 ?? "请选择").lineLimit(1)
                Spacer(minLength: 4)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 10, weight: .medium)).foregroundStyle(Theme.sub)
            }.font(Theme.font(size: 13)).foregroundStyle(Theme.ink)
                .padding(.horizontal, 12).padding(.vertical, 9)
                .background(Theme.field, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.line, lineWidth: 0.5))
                .contentShape(RoundedRectangle(cornerRadius: 10))
        }.buttonStyle(.plain).accessibilityLabel(title)
            .accessibilityValue(choices.first { $0.0 == selection }?.1 ?? "请选择")
            .verificationAction("choice-" + title)
            .popover(isPresented:$opened,arrowEdge:.top) {
                ScrollView {
                    VStack(spacing:3) {
                        ForEach(Array(choices.enumerated()),id:\.offset) { _,choice in
                            MenuActionRow(title:choice.1,icon:selection==choice.0 ? "checkmark":nil) {
                                selection=choice.0;opened=false
                            }.verificationAction("choice-option-"+choice.1)
                        }
                    }.padding(7).background(OverlayScrollbars())
                }.frame(width:220,height:min(300,CGFloat(choices.count)*37+14)).background(Theme.card)
            }
    }
}

struct MenuActionRow: View {
    let title: String
    var icon: String?
    let action: () -> Void
    @State private var hovering = false
    var body: some View {
        Button(action: action) {
            HStack(spacing: 11) {
                Image(systemName: icon ?? "checkmark").font(.system(size: 13, weight: .medium))
                    .opacity(icon == nil ? 0 : 1).frame(width: 18)
                Text(title).font(Theme.font(size: 13)); Spacer(minLength: 8)
            }.foregroundStyle(Theme.ink).padding(.horizontal, 10).frame(height: 34)
                .background(hovering ? Theme.field : .clear, in: RoundedRectangle(cornerRadius: 8))
                .contentShape(RoundedRectangle(cornerRadius: 8))
        }.buttonStyle(.plain).onHover { hovering = $0 }
    }
}
