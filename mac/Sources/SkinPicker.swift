import SwiftUI

struct SkinPicker: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionTitle(text: "皮肤")
            HStack(spacing: 12) {
                ForEach(Skin.allCases) { skin in
                    Button { SkinStore.shared.select(skin) } label: {
                        HStack(spacing: 10) {
                            HStack(spacing: 0) {
                                ForEach([0, 1, 5, 7], id: \.self) { index in Color(hex: skin.palette[index]).frame(width: 12, height: 28) }
                            }.clipShape(RoundedRectangle(cornerRadius: 6))
                            Text(skin.title).font(skin == .paper ? .custom("Songti SC", size: 15) : Theme.font(size: 15))
                            Spacer(minLength: 4)
                            Image(systemName: SkinStore.shared.skin == skin ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(SkinStore.shared.skin == skin ? Theme.accent : Theme.line)
                        }
                        .foregroundStyle(Theme.ink).padding(14)
                        .background(SkinStore.shared.skin == skin ? Theme.userBubble : Theme.card, in: RoundedRectangle(cornerRadius: 14))
                        .contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityLabel(skin.title).verificationAction(skin.title)
                }
            }
        }
    }
}
