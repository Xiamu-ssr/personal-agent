import AppKit
import ImageIO
import UniformTypeIdentifiers

@MainActor enum PasteFixtures {
    static func run() async throws {
        let pb = NSPasteboard.withUniqueName(), composer = Composer()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("doudou-paste-\(UUID())", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { pb.releaseGlobally(); composer.reset(); try? FileManager.default.removeItem(at: root) }
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 40, pixelsHigh: 20, bitsPerSample: 8, samplesPerPixel: 4,
                                   hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        rep.bitmapData!.initialize(repeating: 255, count: rep.bytesPerRow * rep.pixelsHigh)
        func imageData(_ type: UTType) throws -> Data {
            let data = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil), let image = rep.cgImage else {
                throw VerificationError(description: "private paste image encoder \(type.identifier)")
            }
            CGImageDestinationAddImage(destination, image, nil)
            try check(CGImageDestinationFinalize(destination), "private paste image encoding \(type.identifier)")
            return data as Data
        }
        let png = try imageData(.png), tiff = try imageData(.tiff)
        let file = root.appendingPathComponent("参考.txt"), other = root.appendingPathComponent("第二份.csv")
        let picture = root.appendingPathComponent("图片.png"), folder = root.appendingPathComponent("文件夹", isDirectory: true)
        try Data("本地文件".utf8).write(to: file); try Data("a,b\n1,2".utf8).write(to: other); try png.write(to: picture)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        func files(_ urls: [URL]) throws {
            composer.reset(); pb.clearContents()
            try check(pb.writeObjects(urls.map { $0 as NSURL }), "private file URL clipboard write")
            guard case .files(let read) = PasteContent.read(pb) else { throw VerificationError(description: "file URLs must be attachments") }
            try check(read == urls, "file URL order and count")
            try check(composer.paste(pb), "file URLs consume attachment paste")
        }
        try files([file])
        try check(composer.drafts.count == 1 && composer.drafts[0].kind == "file" && composer.drafts[0].name == "参考.txt" &&
                  composer.drafts[0].data.count == Data("本地文件".utf8).count, "single pasted file retains its name and byte size")
        print("PASS: paste single Finder file URL with name and byte size")
        try files([file, other])
        try check(composer.drafts.map(\.name) == ["参考.txt", "第二份.csv"] && composer.drafts.allSatisfy { $0.kind == "file" }, "multiple Finder files remain separate attachments")
        print("PASS: paste multiple Finder file URLs")
        try files([picture])
        try check(composer.drafts.first?.kind == "image" && composer.drafts.first?.name == "图片.jpg" &&
                  composer.drafts.first.flatMap { NSBitmapImageRep(data: $0.data) } != nil, "pasted image files use existing JPEG conversion")
        print("PASS: paste Finder image file as JPEG image")
        try files([folder])
        try check(composer.drafts.isEmpty && composer.error == "文件夹发不了，选里面的文件", "pasted folders report existing error")
        print("PASS: paste Finder folder reports error without an attachment")
        let item = NSPasteboardItem()
        item.setString("Finder 文件名", forType: .string); item.setData(png, forType: .png); item.setString(file.absoluteString, forType: .fileURL)
        pb.clearContents(); composer.reset(); try check(pb.writeObjects([item]), "Finder mixed clipboard write")
        try check(composer.paste(pb) && composer.drafts.first?.kind == "file", "file URL takes priority over text and image preview")
        print("PASS: Finder file URL takes priority over text and image representations")

        for type in [UTType.png, .tiff, .jpeg, .heic] {
            composer.reset(); let pasteType = NSPasteboard.PasteboardType(type.identifier)
            pb.declareTypes([pasteType], owner: nil); pb.setData(try imageData(type), forType: pasteType)
            guard case .image = PasteContent.read(pb) else { throw VerificationError(description: "image-only clipboard \(type.identifier)") }
            try check(composer.paste(pb) && composer.drafts.count == 1 && composer.drafts[0].kind == "image", "image-only paste becomes image draft")
            print("PASS: paste image-only \(type.identifier) (screenshot/Preview/browser representation)")
        }
        let richText: [(String, [NSPasteboard.PasteboardType], String)] = [
            ("Excel", [.string, .html, .tiff], "产品\t价格\n示例\t12"),
            ("Numbers", [.rtf, .string, .tiff], "名称\t数量\n示例\t3"),
            ("Word", [.rtf, .string, .png], "文档里的文字"),
            ("web", [.html, .string, .png], "网页里的文字"),
        ]
        let editor = ComposerTextView(); editor.isEditable = true; editor.string = "现有草稿"
        editor.onAttachmentPaste = { composer.paste($0) }
        for (name, types, text) in richText {
            composer.reset(); composer.text = "现有草稿"
            pb.declareTypes(types, owner: nil); pb.setString(text, forType: .string)
            if types.contains(.html) { pb.setString("<p>\(text)</p>", forType: .html) }
            if types.contains(.rtf) { pb.setData(Data(#"{\rtf1\ansi rich text}"#.utf8), forType: .rtf) }
            if types.contains(.png) { pb.setData(png, forType: .png) }
            if types.contains(.tiff) { pb.setData(tiff, forType: .tiff) }
            try check(pb.types?.first == types.first, "rich clipboard preserves preferred type")
            guard case .text = PasteContent.read(pb) else { throw VerificationError(description: "\(name) rich text must fall through") }
            try check(!editor.pasteAttachment(from: pb) && composer.drafts.isEmpty && composer.text == "现有草稿" && editor.string == "现有草稿",
                      "rich text returns to native text paste without consuming drafts")
            print("PASS: paste \(name) rich text with image returns to native text paste")
        }
        composer.reset(); pb.declareTypes([.png, .string], owner: nil)
        pb.setData(png, forType: .png); pb.setString("图像附带说明", forType: .string)
        try check(composer.paste(pb) && composer.drafts.first?.kind == "image", "image-first clipboard still prefers its image")
        print("PASS: paste image-first clipboard with secondary text as image")
        composer.reset(); pb.declareTypes([.string, .png], owner: nil)
        pb.setString(" \n\t ", forType: .string); pb.setData(png, forType: .png)
        try check(composer.paste(pb) && composer.drafts.first?.kind == "image", "whitespace-only text does not mask image data")
        print("PASS: paste image with whitespace-only text as image")
        composer.reset(); pb.declareTypes([.string], owner: nil); pb.setString("纯文本\n第二行", forType: .string)
        guard case .text = PasteContent.read(pb) else { throw VerificationError(description: "plain text clipboard") }
        try check(!editor.pasteAttachment(from: pb) && composer.drafts.isEmpty, "plain text follows native paste")
        print("PASS: paste plain text returns to native text paste")
        pb.clearContents()
        guard case .text = PasteContent.read(pb) else { throw VerificationError(description: "empty clipboard") }
        try check(!composer.paste(pb) && composer.drafts.isEmpty, "empty clipboard has no attachment")
        print("PASS: paste empty private clipboard returns to native text paste")

        let path = "data/uploads/fixture/参考.txt"
        let json = try JSONSerialization.jsonObject(with: Data(#"{"path":"data/uploads/fixture/参考.txt","name":"参考.txt","kind":"file","size":12288}"#.utf8)) as! [String: Any]
        let att = Attachment(json), legacy = Attachment(["path": path, "kind": "file"])
        try check(att.size == 12288 && legacy.size == nil && legacy.name == "参考.txt", "attachment JSON size and legacy name fallback")
        try check(Attachment(["path": path, "size": NSNull()]).size == nil && Attachment(["path": path, "size": 0]).size == 0, "null and zero attachment size")
        try check(att.json["size"] == nil && att.json["path"] as? String == path, "outgoing attachment JSON keeps original protocol")
        let merged = Attachment.merging([legacy, Attachment(path: "data/uploads/fixture/other.txt", name: "other", kind: "file")], with: [att])
        try check(merged[0].size == 12288 && merged[1].size == nil, "size fallback only matches the same path")
        let authoritative = Attachment(path: path, name: "server", kind: "file", size: 0)
        try check(Attachment.merging([authoritative], with: [att])[0] == authoritative, "server size including zero is authoritative")
        print("PASS: attachment JSON parses size/legacy/null/zero; outgoing JSON and path-based size merge")

        let respond = FixtureProtocol.respond
        defer { FixtureProtocol.respond = respond }
        FixtureProtocol.respond = { req in
            try check(req.httpMethod == "POST" && req.url?.path.hasSuffix("/api/upload") == true, "upload size fixture route")
            return (200, [:], try JSONSerialization.data(withJSONObject: json))
        }
        let uploaded = try await Api.upload(Data([1, 2, 3]), name: "参考.txt", kind: "file")
        try check(uploaded.size == 12288, "upload trusts response size rather than local data length")
        FixtureProtocol.respond = { _ in (200, [:], try JSONSerialization.data(withJSONObject: legacy.json)) }
        let oldUpload = try await Api.upload(Data([1]), name: "参考.txt", kind: "file")
        try check(oldUpload.size == nil, "upload without response size remains compatible")
        print("PASS: upload response fills attachment size; missing size remains optional")

        let chat = ChatClient(sender: { _ in true })
        defer { chat.stop() }
        let voice = Attachment(path: "data/uploads/fixture/note.m4a", name: "note", kind: "voice", size: 4)
        try check(chat.send("文件", attachments: [uploaded, voice]), "local attachment send")
        let echoes: [[String: Any]] = [legacy.json, ["path": voice.path, "name": voice.name, "kind": voice.kind, "transcript": "回显转写"]]
        chat.handle(["t": "user", "id": "paste-echo", "text": "文件", "attachments": echoes])
        try check(chat.items.count == 1 && !chat.items[0].pending && chat.items[0].attachments.map(\.size) == [12288, 4] &&
                  chat.items[0].attachments[1].transcript == "回显转写", "pending path echo keeps size and gains voice transcript")
        print("PASS: pending attachment echo without size keeps local size and server transcript")
        chat.handle(["t": "user", "id": "paste-echo", "text": "文件", "attachments": echoes])
        try check(chat.items.count == 1 && chat.items[0].attachments.map(\.size) == [12288, 4], "repeated server-id echo keeps known sizes")
        chat.handle(["t": "user", "id": "paste-echo", "text": "文件", "attachments": [authoritative.json.merging(["size": 0]) { _, new in new }]])
        try check(chat.items[0].attachments.first?.size == 0, "server echo size overrides local known size")
        print("PASS: repeated server-id echo keeps missing sizes and accepts authoritative size")

        let snapshot = ChatClient(sender: { _ in true })
        defer { snapshot.stop() }
        snapshot.items = [ChatItem(kind: .user, text: "快照", attachments: [uploaded], ts: Date())]
        let identity = snapshot.items[0].id
        snapshot.rememberSnapshotEchoes(snapshot.items)
        snapshot.handle(["t": "user", "id": "snapshot-echo", "text": "快照", "attachments": [legacy.json]])
        try check(snapshot.items.count == 1 && snapshot.items[0].id == identity && snapshot.items[0].attachments.first?.size == 12288,
                  "snapshot path echo preserves known size and identity")
        print("PASS: snapshot echo without size keeps local attachment size")

        let history = ChatClient(sender: { _ in true })
        defer { history.stop() }
        FixtureProtocol.respond = { req in
            let body: [String: Any] = req.url?.path.hasSuffix("/api/history") == true ?
                ["items": [["role": "user", "text": "历史", "attachments": [legacy.json]]]] : ["running": []]
            return (200, [:], try JSONSerialization.data(withJSONObject: body))
        }
        history.handle(["t": "hello", "history": []])
        try check(history.send("历史", attachments: [uploaded]), "local send during history refresh")
        for _ in 0..<100 where history.items.first?.ts != nil { try await Task.sleep(nanoseconds: 5_000_000) }
        try check(history.items.count == 1 && history.items[0].ts == nil && history.items[0].attachments.first?.size == 12288,
                  "HTTP history reconciliation keeps known size for matched local attachment")
        let reloaded = ChatClient.item(["role": "user", "text": "", "attachments": [json]])
        let old = ChatClient.item(["role": "user", "text": "", "attachments": [legacy.json]])
        let task = try TaskHistory.parse(["id": "paste-task", "title": "附件任务", "status": "done", "items": [
            ["kind": "prompt", "from": "user", "text": "", "attachments": [json]],
            ["kind": "prompt", "from": "user", "text": "", "attachments": [legacy.json]]]], id: "paste-task")
        try check(reloaded?.attachments.first?.size == 12288 && old?.attachments.first?.size == nil &&
                  task.items[0].message.attachments.first?.size == 12288 && task.items[1].message.attachments.first?.size == nil,
                  "chat and task history reload sizes while legacy records remain readable")
        print("PASS: HTTP reconciliation and chat/task history reload preserve size and legacy records")
    }
}
