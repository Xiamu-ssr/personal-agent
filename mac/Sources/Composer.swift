import AppKit
import Observation
import SwiftUI
import UniformTypeIdentifiers

/// A file picked, dropped or pasted, waiting to be uploaded with the next message.
struct Draft: Identifiable {
    let id = UUID()
    let data: Data
    let name: String
    /// image | file | voice
    let kind: String
    var thumb: NSImage? = nil
    var uploaded: Attachment? = nil
}

enum PasteContent {
    case files([URL]), image(NSImage), text

    static func read(_ pb: NSPasteboard) -> PasteContent {
        if let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            return .files(urls)
        }
        let imageFirst = pb.types?.first.flatMap { UTType($0.rawValue) }?.conforms(to: .image) == true
        if let text = pb.string(forType: .string), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !imageFirst {
            return .text
        }
        if let image = NSImage(pasteboard: pb) { return .image(image) }
        return .text
    }
}

/// The one input box shared by 聊天 · 今日 · 任务 · 记忆 (and its draft survives switching pages).
@Observable
final class Composer {
    static let shared = Composer()
    let taskID: String?
    var sentRevision = 0
    init(taskID: String? = nil) { self.taskID = taskID }

    enum Recording { case hold, note }

    var text = ""
    var drafts: [Draft] = []
    var sending = false
    var error = ""
    /// The middle of the bar is the 按住 说话 button instead of the text field.
    var voiceMode = false
    var recording: Recording? = nil
    var holding = false
    var holdCancel = false
    var transcribing = false
    var preparing = false
    /// Keep a failed hold-to-talk recording in memory; retry still uses /api/transcribe and never uploads it.
    var retryAudio: Data? = nil
    let recorder = Recorder()
    @ObservationIgnored private var operation: Task<Void, Never>?
    @ObservationIgnored private var recordRequest: UUID?

    func reset() {
        operation?.cancel()
        cancelRecording()
        text = ""; drafts = []; error = ""
        voiceMode = false; sending = false; transcribing = false; retryAudio = nil
    }

    var hasContent: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !drafts.isEmpty }

    private func fail(_ s: String) {
        error = s
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            if self?.error == s { self?.error = "" }
        }
    }

    private func toChat() {
        guard taskID == nil else { return }
        Nav.shared.go(.chat)
        Nav.shared.stacks[.chat] = []
    }

    // MARK: attachments

    /// Long edge ≤ 1600 px, JPEG — what the spec asks for before sending a picture.
    static func jpeg(_ img: NSImage) -> Data? {
        guard let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
        let scale = min(1, 1600 / Double(max(cg.width, cg.height)))
        let w = max(1, Int(Double(cg.width) * scale)), h = max(1, Int(Double(cg.height) * scale))
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        ctx.setFillColor(.white)
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.interpolationQuality = .high
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        guard let out = ctx.makeImage() else { return nil }
        return NSBitmapImageRep(cgImage: out).representation(using: .jpeg, properties: [.compressionFactor: 0.82])
    }

    func add(image: NSImage, name: String = "图片") {
        guard let d = Self.jpeg(image) else { return fail("这张图片读不了") }
        let base = (name as NSString).deletingPathExtension
        drafts.append(Draft(data: d, name: (base.isEmpty ? "图片" : base) + ".jpg", kind: "image", thumb: image))
    }

    func add(urls: [URL]) {
        for url in urls {
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir), !isDir.boolValue else {
                fail("文件夹发不了，选里面的文件")
                continue
            }
            let type = UTType(filenameExtension: url.pathExtension.lowercased())
            if type?.conforms(to: .image) == true, type != .svg, let img = NSImage(contentsOf: url) {
                add(image: img, name: url.lastPathComponent)
            } else if ((try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) > 20 << 20 {
                fail("「\(url.lastPathComponent)」太大了（上限 20MB）")
            } else if let d = try? Data(contentsOf: url) {
                guard d.count <= 20 << 20 else {
                    fail("「\(url.lastPathComponent)」太大了（上限 20MB）")
                    continue
                }
                drafts.append(Draft(data: d, name: url.lastPathComponent, kind: "file"))
            } else {
                fail("读不了「\(url.lastPathComponent)」")
            }
        }
    }

    func pick(images: Bool) {
        let p = NSOpenPanel()
        p.allowsMultipleSelection = true
        p.canChooseDirectories = false
        if images { p.allowedContentTypes = [.image] }
        p.prompt = "添加"
        guard p.runModal() == .OK else { return }
        add(urls: p.urls)
    }

    /// ⌘V with a picture or copied files on the pasteboard; returns false to let the text field paste text.
    func paste(_ pb: NSPasteboard = .general) -> Bool {
        switch PasteContent.read(pb) {
        case .files(let urls):
            add(urls: urls)
            return true
        case .image(let image):
            add(image: image)
            return true
        case .text: return false
        }
    }

    func drop(_ providers: [NSItemProvider]) -> Bool {
        for p in providers {
            if p.canLoadObject(ofClass: URL.self) {
                _ = p.loadObject(ofClass: URL.self) { url, _ in
                    guard let url, url.isFileURL else { return }
                    DispatchQueue.main.async { self.add(urls: [url]) }
                }
            } else if p.canLoadObject(ofClass: NSImage.self) {
                _ = p.loadObject(ofClass: NSImage.self) { img, _ in
                    guard let img = img as? NSImage else { return }
                    DispatchQueue.main.async { self.add(image: img) }
                }
            }
        }
        return providers.contains { $0.canLoadObject(ofClass: URL.self) || $0.canLoadObject(ofClass: NSImage.self) }
    }

    // MARK: sending

    func send() {
        operation = Task { @MainActor in _ = await sendContents() }
    }

    /// The same upload/retry path serves main chat and task continuations.
    @MainActor @discardableResult func sendContents() async -> Bool {
        guard !sending, !transcribing, recording == nil, !preparing, hasContent else { return false }
        let text = self.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let drafts = self.drafts
        if taskID == nil && !ChatClient.shared.connected { fail("还没连上，稍等再发"); return false }
        sending = true
        defer { sending = false }
        do {
            var atts: [Attachment] = []
            for d in drafts {
                let att: Attachment
                if let uploaded = d.uploaded { att = uploaded } else { att = try await Api.upload(d.data, name: d.name, kind: d.kind) }
                try Task.checkCancellation()
                if let i = self.drafts.firstIndex(where: { $0.id == d.id }) { self.drafts[i].uploaded = att }
                atts.append(att)
            }
            try await deliver(text, attachments: atts)
            if self.text.trimmingCharacters(in: .whitespacesAndNewlines) == text { self.text = "" }
            self.drafts.removeAll { d in drafts.contains { $0.id == d.id } }
            toChat()
            return true
        } catch is CancellationError { return false }
        catch { if !Task.isCancelled { fail("发送失败：\(error.localizedDescription)") }; return false }
    }

    @MainActor private func deliver(_ text: String, attachments: [Attachment] = []) async throws {
        if let taskID {
            var body: [String: Any] = ["text": text]
            if !attachments.isEmpty { body["attachments"] = attachments.map(\.json) }
            let response = try await Api.json(TaskHistoryStore.endpoint(taskID, action: "send"), method: "POST", body: body)
            guard response["ok"] as? Bool == true, response["id"] as? String == taskID else {
                throw ApiError(code: 0, message: "续聊没有发出去，请重试")
            }
        } else if !ChatClient.shared.send(text, attachments: attachments) {
            throw ApiError(code: 0, message: ChatClient.shared.error)
        }
        sentRevision += 1
    }

    // MARK: voice

    private func startRecording(_ mode: Recording) {
        guard !preparing, !sending, !transcribing, recording == nil else { return }
        let request = UUID()
        recordRequest = request
        preparing = true
        Task { @MainActor in
            let why = await Recorder.permit()
            guard recordRequest == request else { return }
            preparing = false
            recordRequest = nil
            if let why { holding = false; return fail(why) }
            if mode == .hold && !holding { return }
            do {
                retryAudio = nil
                try recorder.start()
                recording = mode
            } catch {
                holding = false
                fail(error.localizedDescription)
            }
        }
    }

    func pressHold() {
        guard !holding, recording == nil, !transcribing, !sending, !preparing else { return }
        holding = true
        holdCancel = false
        startRecording(.hold)
    }

    /// Released: transcribe and send what was said as a message.
    func releaseHold() {
        holding = false
        recordRequest = nil
        preparing = false
        guard recording == .hold else { return }
        recording = nil
        if holdCancel {
            recorder.cancel()
            return
        }
        guard let (data, seconds) = recorder.finish() else { return fail("没录到声音") }
        guard seconds >= 0.6 else { return fail("说话时间太短") }
        retryAudio = data
        retryTranscribe()
    }

    func retryTranscribe() {
        guard let data = retryAudio, !transcribing, !sending else { return }
        guard taskID != nil || ChatClient.shared.connected else { return fail("豆豆还没准备好，录音已保留，稍后再试") }
        transcribing = true
        operation = Task { @MainActor in
            do {
                let text = try await Api.transcribe(data, format: "m4a")
                try Task.checkCancellation()
                retryAudio = nil
                if text.isEmpty {
                    fail("没听清，再说一次")
                } else {
                    do {
                        try await deliver(text)
                        toChat()
                    } catch {
                        self.text = self.text.isEmpty ? text : self.text + "\n" + text
                        voiceMode = false
                        throw error
                    }
                }
            } catch is CancellationError {
                return
            } catch {
                if Task.isCancelled { return }
                fail(error.localizedDescription)
            }
            transcribing = false
        }
    }

    func startNote() {
        guard recording == nil else { return }
        startRecording(.note)
    }

    /// 完成: upload the note as a voice attachment and send it; the cloud transcribes it for 豆豆.
    func finishNote() {
        guard recording == .note else { return }
        recording = nil
        guard let (data, _) = recorder.finish() else { return fail("没录到声音") }
        let name = "语音笔记-\(Fmt.hm.string(from: Date()).replacingOccurrences(of: ":", with: "")).m4a"
        let draft = Draft(data: data, name: name, kind: "voice")
        guard taskID != nil || ChatClient.shared.connected else { drafts.append(draft); return fail("还没连上，录音已保留在输入框") }
        sending = true
        operation = Task { @MainActor in
            var att: Attachment?
            do {
                att = try await Api.upload(data, name: name, kind: "voice")
                try Task.checkCancellation()
                if let att {
                    try await deliver("", attachments: [att])
                    toChat()
                }
            } catch is CancellationError {
                return
            } catch {
                if Task.isCancelled { return }
                drafts.append(draft)
                fail("发送失败：\(error.localizedDescription)，录音已保留在输入框")
            }
            sending = false
        }
    }

    func cancelRecording() {
        recordRequest = nil
        preparing = false
        recording = nil
        holding = false
        recorder.cancel()
    }
}

// MARK: - The bar

struct ComposerBar: View {
    let placeholder: String
    @Bindable var c: Composer = .shared
    private var chat: ChatClient { .shared }
    @State private var focused = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if c.taskID == nil { TaskControls() }
            if c.recording != nil || c.transcribing { RecordingPanel(c: c) }
            if !c.drafts.isEmpty { drafts }
            if !c.error.isEmpty {
                Label(c.error, systemImage: "exclamationmark.circle").font(Theme.font(size: 12)).foregroundStyle(Theme.danger)
                    .padding(.horizontal, 8)
            }
            if c.retryAudio != nil && !c.transcribing {
                HStack(spacing: 10) {
                    Text("录音已保留，可稍后重新转写").font(Theme.font(size: 12)).foregroundStyle(Theme.sub)
                    Spacer()
                    Button("清除") { c.retryAudio = nil }.buttonStyle(SoftButtonStyle())
                    Button("重新转写") { c.retryTranscribe() }.buttonStyle(SoftButtonStyle()).disabled(c.taskID == nil && !chat.connected)
                }
                .padding(.horizontal, 8)
            }
            HStack(alignment: .bottom, spacing: 6) {
                plus
                if c.voiceMode { holdButton } else { field }
                trailing
            }
            .padding(5)
            .background(RoundedRectangle(cornerRadius: 24, style: .continuous).fill(Theme.field.opacity(0.95)))
            .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 28, style: .continuous).fill(Theme.card))
        .overlay(RoundedRectangle(cornerRadius: 28, style: .continuous).strokeBorder(Theme.line, lineWidth: 0.5))
        .shadow(color: Theme.ink.opacity(0.025), radius: 6, y: 2)
        #if MAC_VERIFY
        .onAppear { if c.taskID != nil { ComposerVerification.currentTask = c } }
        #endif
    }

    private var plus: some View {
        Menu {
            Button { c.pick(images: false) } label: { Label("上传文件", systemImage: "doc") }
            Button { c.pick(images: true) } label: { Label("图片", systemImage: "photo") }
            Button { c.startNote() } label: { Label("录制语音笔记", systemImage: "waveform") }
        } label: {
            Image(systemName: "plus").font(Theme.font(size: 16, weight: .regular)).foregroundStyle(Theme.ink.opacity(0.7))
                .frame(width: 38, height: 38).contentShape(Circle())
        }
        .disabled(c.sending || c.transcribing || c.preparing || c.recording != nil)
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .frame(width: 38, height: 38)
        .help("上传文件、图片或录一段语音笔记")
    }

    private var field: some View {
        GrowingInput(text: $c.text, focused: $focused, placeholder: placeholder, enabled: !c.sending,
                     onSubmit: { c.send() }, onAttachmentPaste: { c.paste($0) })
            .frame(maxWidth: .infinity)
    }

    private var holdButton: some View {
        Text(c.holding ? (c.holdCancel ? "松开 取消" : "松开 发送") : "按住 说话")
            .font(Theme.font(size: 14, weight: .medium))
            .foregroundStyle(c.holding ? Theme.goldText : Theme.ink)
            .frame(maxWidth: .infinity, minHeight: 38)
            .background { if c.holding { GoldBase() } else { Capsule().fill(Theme.card) } }
            .overlay(Capsule().strokeBorder(Theme.line, lineWidth: 0.5))
            .contentShape(Capsule())
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { v in
                    if !c.holding { c.pressHold() }
                    c.holdCancel = v.translation.height < -40
                }
                .onEnded { _ in c.releaseHold() })
            .padding(.vertical, 0)
    }

    @ViewBuilder
    private var trailing: some View {
        if c.voiceMode {
            roundButton("keyboard", help: "切回打字") {
                c.cancelRecording()
                c.voiceMode = false
                focused = true
            }
        } else if c.hasContent {
            Button { c.send() } label: {
                ZStack {
                    GoldBase()
                    if c.sending { ActiveProgress().controlSize(.small) } else {
                        Image(systemName: "arrow.up").font(Theme.font(size: 15, weight: .bold)).foregroundStyle(Theme.goldText)
                    }
                }
                .frame(width: 38, height: 38)
            }
            .buttonStyle(.plain)
            .disabled(c.sending)
            .help("发送（↩︎）· ⌥↩︎ 换行")
            .accessibilityLabel(c.taskID == nil ? "发送" : "发送续聊")
            .verificationAction(c.taskID == nil ? "发送" : "发送续聊")
        } else {
            roundButton("mic", help: "按住说话") { c.voiceMode = true }
        }
    }

    private func roundButton(_ icon: String, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon).font(Theme.font(size: 15, weight: .medium)).foregroundStyle(Theme.ink.opacity(0.75))
                .frame(width: 38, height: 38).contentShape(Circle())
        }
        .buttonStyle(.plain)
        .help(help)
    }

    private var drafts: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(c.drafts) { d in
                    HStack(spacing: 8) {
                        if let t = d.thumb {
                            Image(nsImage: t).resizable().aspectRatio(contentMode: .fill).frame(width: 34, height: 34)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                        } else {
                            IconTile(icon: d.kind == "voice" ? "waveform" : "doc.text", size: 34)
                        }
                        VStack(alignment: .leading, spacing: 1) {
                            Text(d.name).font(Theme.font(size: 12, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(1).frame(maxWidth: 140, alignment: .leading)
                            Text((d.kind == "image" ? "图片 · " : d.kind == "voice" ? "语音笔记 · " : "") + Fmt.size(d.data.count))
                                .font(Theme.font(size: 10.5)).foregroundStyle(Theme.faint)
                        }
                        Button { c.drafts.removeAll { $0.id == d.id } } label: {
                            Image(systemName: "xmark.circle.fill").font(Theme.font(size: 14)).foregroundStyle(Theme.faint)
                        }
                        .buttonStyle(.plain)
                        .help("移除")
                        .disabled(c.sending)
                    }
                    .padding(6)
                    .padding(.trailing, 2)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Theme.card))
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.line, lineWidth: 1))
                }
            }
            .padding(.horizontal, 4)
        }
    }
}

/// Recording overlay: waveform + timer; hold-to-talk hints, or 完成 / 取消 for a voice note.
struct RecordingPanel: View {
    var c: Composer = .shared

    var body: some View {
        HStack(spacing: 14) {
            if c.transcribing {
                ActiveProgress().controlSize(.small)
                Text("正在转写…").font(Theme.font(size: 13)).foregroundStyle(Theme.sub)
                Spacer()
            } else {
                Circle().fill(Theme.danger).frame(width: 8, height: 8)
                Text(c.recording == .note ? "正在录音 \(clock)" : clock)
                    .font(Theme.font(size: 13, weight: .medium).monospacedDigit()).foregroundStyle(Theme.ink)
                Wave(levels: c.recorder.levels).frame(height: 26)
                if c.recording == .note {
                    Button("取消") { c.cancelRecording() }.buttonStyle(SoftButtonStyle())
                    Button("完成") { c.finishNote() }.buttonStyle(GoldButtonStyle(height: 28))
                } else {
                    Text(c.holdCancel ? "松开取消" : "松开发送 · 上滑取消")
                        .font(Theme.font(size: 12)).foregroundStyle(c.holdCancel ? Theme.danger : Theme.sub)
                }
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 46)
        .background(RoundedRectangle(cornerRadius: 18).fill(Theme.field))
        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Theme.line, lineWidth: 1))
    }

    private var clock: String {
        let s = Int(c.recorder.elapsed)
        return String(format: "%02d:%02d", s / 60, s % 60)
    }
}

struct Wave: View {
    let levels: [Float]

    var body: some View {
        HStack(alignment: .center, spacing: 2.5) {
            ForEach(levels.indices, id: \.self) { i in
                Capsule().fill(Theme.accent.opacity(0.75))
                    .frame(width: 2.5, height: max(3, CGFloat(levels[i]) * 26))
            }
        }
        .frame(maxWidth: .infinity)
        .animation(.linear(duration: 0.06), value: levels)
    }
}

#if MAC_VERIFY
enum ComposerVerification { static weak var currentTask: Composer? }
#endif
