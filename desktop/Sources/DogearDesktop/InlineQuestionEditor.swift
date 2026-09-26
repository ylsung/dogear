import AppKit
import DogearCore
import SwiftUI
import UniformTypeIdentifiers

private extension NSAttributedString.Key {
    static let dogearImageID = NSAttributedString.Key("com.ylsung.dogear.image-id")
    static let dogearImagePath = NSAttributedString.Key("com.ylsung.dogear.image-path")
}

private final class DogearTextView: NSTextView {
    private var pressedAttachment: (range: NSRange, point: NSPoint)?
    private var isDraggingAttachment = false
    private var dragDestination: Int?
    private var contextAttachmentRange: NSRange?
    private var activationObserver: NSObjectProtocol?

    deinit {
        if let activationObserver { NSWorkspace.shared.notificationCenter.removeObserver(activationObserver) }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil, activationObserver == nil {
            activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
                forName: NSWorkspace.didActivateApplicationNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in self?.refreshAttachmentsFromDisk() }
        }
    }

    static func compactInsertionRect(_ rect: NSRect, font: NSFont) -> NSRect {
        let fontHeight = font.ascender - font.descender + 2
        // NSTextView is flipped. Attachments make the line fragment tall, but
        // the caret belongs on the text baseline at the bottom of that line.
        return NSRect(x: rect.minX, y: max(rect.minY, rect.maxY - fontHeight),
                      width: rect.width, height: min(fontHeight, rect.height))
    }

    override func drawInsertionPoint(in rect: NSRect, color: NSColor, turnedOn flag: Bool) {
        super.drawInsertionPoint(
            in: Self.compactInsertionRect(rect, font: font ?? .preferredFont(forTextStyle: .body)),
            color: color,
            turnedOn: flag
        )
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if let (range, frame) = attachment(at: point) {
            window?.makeFirstResponder(self)
            setSelectedRange(range)
            if InlineImageAttachmentCell.deleteButtonFrame(in: frame).contains(point) {
                if shouldChangeText(in: range, replacementString: "") {
                    textStorage?.replaceCharacters(in: range, with: "")
                    didChangeText()
                }
                return
            }
            // Keep AppKit from reconstructing the file attachment during its
            // native drag. That reconstruction briefly displays the original,
            // full-size screenshot and the generic attachment controls.
            pressedAttachment = (range, point)
            isDraggingAttachment = false
            return
        }
        super.mouseDown(with: event)
    }

    override func mouseDragged(with event: NSEvent) {
        guard let pressedAttachment else {
            super.mouseDragged(with: event)
            return
        }
        let point = convert(event.locationInWindow, from: nil)
        if hypot(point.x - pressedAttachment.point.x, point.y - pressedAttachment.point.y) >= 4 {
            isDraggingAttachment = true
            let destination = insertionIndex(at: point)
            dragDestination = destination
            setSelectedRange(NSRange(location: destination, length: 0))
            updateInsertionPointStateAndRestartTimer(true)
            NSCursor.closedHand.set()
        }
    }

    override func mouseUp(with event: NSEvent) {
        guard let pressedAttachment else {
            super.mouseUp(with: event)
            return
        }
        defer {
            self.pressedAttachment = nil
            isDraggingAttachment = false
            dragDestination = nil
            NSCursor.arrow.set()
        }
        guard isDraggingAttachment else { return }
        let moved = moveAttachment(
            from: pressedAttachment.range,
            to: dragDestination ?? insertionIndex(at: convert(event.locationInWindow, from: nil))
        )
        if !moved { setSelectedRange(pressedAttachment.range) }
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let point = convert(event.locationInWindow, from: nil)
        if let (range, _) = attachment(at: point) {
            contextAttachmentRange = range
            return attachmentMenu()
        }
        return super.menu(for: event)
    }

    func attachmentMenu() -> NSMenu {
        let menu = NSMenu()
        let markup = NSMenuItem(title: "Edit Original in Preview…", action: #selector(openMarkup), keyEquivalent: "")
        markup.target = self
        menu.addItem(markup)
        let replace = NSMenuItem(title: "Replace with Edited File…", action: #selector(replaceWithEditedFile), keyEquivalent: "")
        replace.target = self
        menu.addItem(replace)
        return menu
    }

    @objc private func openMarkup() {
        guard let range = contextAttachmentRange,
              let path = textStorage?.attribute(.dogearImagePath, at: range.location, effectiveRange: nil) as? String else { return }
        let imageURL = URL(fileURLWithPath: path)
        let previewURL = URL(fileURLWithPath: "/System/Applications/Preview.app", isDirectory: true)
        NSWorkspace.shared.open(
            [imageURL],
            withApplicationAt: previewURL,
            configuration: NSWorkspace.OpenConfiguration()
        ) { _, _ in }
    }

    @objc private func replaceWithEditedFile() {
        guard let range = contextAttachmentRange,
              let path = textStorage?.attribute(.dogearImagePath, at: range.location, effectiveRange: nil) as? String else { return }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.png, .jpeg, .gif, .webP, .tiff]
        panel.allowsMultipleSelection = false
        panel.message = "Choose the edited image to replace this Dogear attachment."
        guard panel.runModal() == .OK, let selectedURL = panel.url,
              let source = NSImage(contentsOf: selectedURL),
              let tiff = source.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:]) else { return }
        do {
            try png.write(to: URL(fileURLWithPath: path), options: .atomic)
            refreshAttachmentsFromDisk()
        } catch {
            NSSound.beep()
        }
    }

    private func insertionIndex(at point: NSPoint) -> Int {
        guard let layoutManager, let textContainer, let storage = textStorage else { return 0 }
        let containerPoint = NSPoint(x: point.x - textContainerOrigin.x, y: point.y - textContainerOrigin.y)
        var fraction: CGFloat = 0
        var destination = layoutManager.characterIndex(
            for: containerPoint,
            in: textContainer,
            fractionOfDistanceBetweenInsertionPoints: &fraction
        )
        if fraction >= 0.5 { destination += 1 }
        return min(destination, storage.length)
    }

    @discardableResult
    func moveAttachment(from sourceRange: NSRange, to point: NSPoint) -> Bool {
        moveAttachment(from: sourceRange, to: insertionIndex(at: point))
    }

    @discardableResult
    private func moveAttachment(from sourceRange: NSRange, to requestedDestination: Int) -> Bool {
        guard let storage = textStorage, NSMaxRange(sourceRange) <= storage.length else { return false }
        var destination = min(requestedDestination, storage.length)
        guard destination != sourceRange.location, destination != NSMaxRange(sourceRange) else { return false }

        let value = storage.attributedSubstring(from: sourceRange)
        if destination > sourceRange.location { destination -= sourceRange.length }
        guard shouldChangeText(in: sourceRange, replacementString: "") else { return false }
        storage.beginEditing()
        storage.deleteCharacters(in: sourceRange)
        storage.insert(value, at: destination)
        storage.endEditing()
        setSelectedRange(NSRange(location: destination, length: value.length))
        didChangeText()
        return true
    }

    private func refreshAttachmentsFromDisk() {
        guard let storage = textStorage, storage.length > 0 else { return }
        storage.enumerateAttributes(in: NSRange(location: 0, length: storage.length)) { attributes, range, _ in
            guard let attachment = attributes[.attachment] as? NSTextAttachment,
                  let path = attributes[.dogearImagePath] as? String,
                  let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
                  let image = NSImage(data: data) else { return }
            attachment.attachmentCell = InlineImageAttachmentCell(imageCell: image)
            attachment.bounds = NSRect(origin: .zero, size: InlineImageAttachmentCell.thumbnailSize)
            layoutManager?.invalidateDisplay(forCharacterRange: range)
        }
    }

    func attachment(at point: NSPoint) -> (NSRange, NSRect)? {
        guard let layoutManager, let textContainer, let textStorage, textStorage.length > 0 else { return nil }
        let containerPoint = NSPoint(x: point.x - textContainerOrigin.x, y: point.y - textContainerOrigin.y)
        let glyphIndex = layoutManager.glyphIndex(for: containerPoint, in: textContainer)
        let characterIndex = layoutManager.characterIndexForGlyph(at: glyphIndex)
        guard characterIndex < textStorage.length,
              textStorage.attribute(.attachment, at: characterIndex, effectiveRange: nil) != nil else { return nil }
        let range = NSRange(location: characterIndex, length: 1)
        let glyphRange = layoutManager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        var frame = layoutManager.boundingRect(forGlyphRange: glyphRange, in: textContainer)
        frame.origin.x += textContainerOrigin.x
        frame.origin.y += textContainerOrigin.y
        // glyphIndex(for:) returns the nearest glyph even for empty canvas.
        // Never let a nearby attachment receive a click outside its real box.
        guard frame.contains(point) else { return nil }
        return (range, frame)
    }
}

private final class InlineImageAttachmentCell: NSTextAttachmentCell {
    static let thumbnailSize = NSSize(width: 76, height: 44)
    static func deleteButtonFrame(in frame: NSRect) -> NSRect {
        NSRect(x: frame.minX + 3, y: frame.minY + 3, width: 14, height: 14)
    }

    override var cellSize: NSSize { Self.thumbnailSize }

    override func draw(withFrame cellFrame: NSRect, in controlView: NSView?) {
        let background = NSBezierPath(roundedRect: cellFrame.insetBy(dx: 1, dy: 1), xRadius: 7, yRadius: 7)
        NSColor.controlAccentColor.withAlphaComponent(0.18).setFill()
        background.fill()
        NSColor.controlAccentColor.withAlphaComponent(0.75).setStroke()
        background.lineWidth = 1.5
        background.stroke()
        if let image {
            let available = cellFrame.insetBy(dx: 4, dy: 3)
            let scale = min(available.width / max(image.size.width, 1), available.height / max(image.size.height, 1))
            let size = NSSize(width: image.size.width * scale, height: image.size.height * scale)
            let destination = NSRect(x: available.midX - size.width / 2, y: available.midY - size.height / 2,
                                     width: size.width, height: size.height)
            image.draw(in: destination, from: .zero, operation: .sourceOver, fraction: 1,
                       respectFlipped: true, hints: [.interpolation: NSImageInterpolation.high])
        }
        let deleteFrame = Self.deleteButtonFrame(in: cellFrame)
        NSColor.systemRed.withAlphaComponent(0.92).setFill()
        NSBezierPath(ovalIn: deleteFrame).fill()
        NSColor.white.setStroke()
        let cross = NSBezierPath()
        cross.lineWidth = 1.25
        cross.move(to: NSPoint(x: deleteFrame.minX + 4, y: deleteFrame.minY + 4))
        cross.line(to: NSPoint(x: deleteFrame.maxX - 4, y: deleteFrame.maxY - 4))
        cross.move(to: NSPoint(x: deleteFrame.minX + 4, y: deleteFrame.maxY - 4))
        cross.line(to: NSPoint(x: deleteFrame.maxX - 4, y: deleteFrame.minY + 4))
        cross.stroke()
    }
}

struct InlineImageInsertion: Equatable {
    let id = UUID()
    let images: [ImageAsset]
}

/// A native rich-text editor. Images are real text attachments, so they can be
/// selected, dragged with the surrounding text, cut, copied, pasted, or deleted.
struct InlineQuestionEditor: NSViewRepresentable {
    let parts: [ContentPart]
    @Binding var insertion: InlineImageInsertion?
    var onChange: ([ContentPart]) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onChange: onChange) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        scroll.drawsBackground = false

        let editor = DogearTextView(frame: scroll.contentView.bounds)
        editor.delegate = context.coordinator
        editor.isRichText = true
        editor.importsGraphics = true
        editor.allowsUndo = true
        editor.isEditable = true
        editor.isSelectable = true
        editor.allowsImageEditing = false
        editor.usesRolloverButtonForSelection = false
        editor.drawsBackground = false
        editor.textColor = .labelColor
        editor.insertionPointColor = .controlAccentColor
        editor.textContainerInset = NSSize(width: 7, height: 7)
        editor.font = .preferredFont(forTextStyle: .body)
        editor.minSize = .zero
        editor.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        editor.isVerticallyResizable = true
        editor.isHorizontallyResizable = false
        editor.autoresizingMask = [.width]
        editor.textContainer?.containerSize = NSSize(width: max(scroll.contentSize.width, 1), height: CGFloat.greatestFiniteMagnitude)
        editor.textContainer?.widthTracksTextView = true
        editor.typingAttributes = context.coordinator.textAttributes
        scroll.documentView = editor
        context.coordinator.replaceContents(of: editor, with: parts)
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let editor = scroll.documentView as? NSTextView else { return }
        context.coordinator.onChange = onChange
        context.coordinator.register(parts)

        if !context.coordinator.isEditing, context.coordinator.parts(in: editor) != parts {
            context.coordinator.replaceContents(of: editor, with: parts)
        }
        if let insertion, context.coordinator.lastInsertion != insertion.id {
            context.coordinator.insert(insertion.images, into: editor)
            context.coordinator.lastInsertion = insertion.id
            DispatchQueue.main.async { self.insertion = nil }
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var onChange: ([ContentPart]) -> Void
        var images: [String: ImageAsset] = [:]
        var lastInsertion: UUID?
        var isEditing = false
        private var programmatic = false

        init(onChange: @escaping ([ContentPart]) -> Void) {
            self.onChange = onChange
        }

        func register(_ parts: [ContentPart]) {
            for case .image(let image) in parts { images[image.id.uuidString] = image }
        }

        func textDidBeginEditing(_ notification: Notification) { isEditing = true }

        func textDidEndEditing(_ notification: Notification) {
            isEditing = false
            publish(notification)
        }

        func textDidChange(_ notification: Notification) {
            guard !programmatic else { return }
            if let editor = notification.object as? NSTextView { normalizeAttachments(in: editor) }
            publish(notification)
        }

        func textViewDidChangeSelection(_ notification: Notification) {
            guard let editor = notification.object as? NSTextView else { return }
            editor.typingAttributes = textAttributes
        }

        var textAttributes: [NSAttributedString.Key: Any] {
            [.font: NSFont.preferredFont(forTextStyle: .body), .foregroundColor: NSColor.labelColor]
        }

        private func publish(_ notification: Notification) {
            guard let editor = notification.object as? NSTextView else { return }
            let value = parts(in: editor)
            DispatchQueue.main.async { self.onChange(value) }
        }

        func insert(_ newImages: [ImageAsset], into editor: NSTextView) {
            guard !newImages.isEmpty else { return }
            newImages.forEach { images[$0.id.uuidString] = $0 }
            let attachment = NSMutableAttributedString()
            newImages.forEach { attachment.append(attributedImage($0)) }
            programmatic = true
            editor.textStorage?.replaceCharacters(in: editor.selectedRange(), with: attachment)
            editor.setSelectedRange(NSRange(
                location: min(editor.selectedRange().location + newImages.count, editor.string.utf16.count),
                length: 0
            ))
            programmatic = false
            editor.typingAttributes = textAttributes
            let value = parts(in: editor)
            DispatchQueue.main.async { self.onChange(value) }
        }

        func replaceContents(of editor: NSTextView, with parts: [ContentPart]) {
            register(parts)
            programmatic = true
            editor.textStorage?.setAttributedString(attributed(parts))
            programmatic = false
            editor.typingAttributes = textAttributes
        }

        func parts(in editor: NSTextView) -> [ContentPart] {
            guard let storage = editor.textStorage else { return [] }
            var result: [ContentPart] = []
            storage.enumerateAttributes(in: NSRange(location: 0, length: storage.length)) { attributes, range, _ in
                if let identifier = imageIdentifier(attributes: attributes),
                   let image = images[identifier] {
                    result.append(.image(image))
                } else {
                    let text = storage.attributedSubstring(from: range).string
                        .replacingOccurrences(of: "\u{fffc}", with: "")
                    guard !text.isEmpty else { return }
                    if case .text(let prior)? = result.last {
                        result[result.count - 1] = .text(prior + text)
                    } else {
                        result.append(.text(text))
                    }
                }
            }
            return result
        }

        private func attributed(_ parts: [ContentPart]) -> NSAttributedString {
            let result = NSMutableAttributedString()
            for part in parts {
                switch part {
                case .text(let text):
                    result.append(NSAttributedString(string: text, attributes: textAttributes))
                case .image(let image):
                    result.append(attributedImage(image))
                }
            }
            return result
        }

        private func attributedImage(_ image: ImageAsset) -> NSAttributedString {
            let fileWrapper: FileWrapper?
            if let data = try? Data(contentsOf: URL(fileURLWithPath: image.path)) {
                let wrapper = FileWrapper(regularFileWithContents: data)
                let fileExtension = URL(fileURLWithPath: image.path).pathExtension
                wrapper.preferredFilename = "dogear-image-\(image.id.uuidString)" + (fileExtension.isEmpty ? "" : ".\(fileExtension)")
                fileWrapper = wrapper
            } else {
                fileWrapper = nil
            }
            let attachment = NSTextAttachment(fileWrapper: fileWrapper)
            attachment.allowsTextAttachmentView = false
            attachment.bounds = NSRect(origin: .zero, size: InlineImageAttachmentCell.thumbnailSize)
            if let source = NSImage(contentsOfFile: image.path) {
                attachment.attachmentCell = InlineImageAttachmentCell(imageCell: source)
            }
            let result = NSMutableAttributedString(attachment: attachment)
            result.addAttribute(.dogearImageID, value: image.id.uuidString, range: NSRange(location: 0, length: result.length))
            result.addAttribute(.dogearImagePath, value: image.path, range: NSRange(location: 0, length: result.length))
            return result
        }

        func normalizeAttachments(in editor: NSTextView) {
            guard let storage = editor.textStorage, storage.length > 0 else { return }
            var repairs: [(NSRange, NSTextAttachment, ImageAsset)] = []
            storage.enumerateAttributes(in: NSRange(location: 0, length: storage.length)) { attributes, range, _ in
                guard let attachment = attributes[.attachment] as? NSTextAttachment,
                      let identifier = imageIdentifier(attributes: attributes, attachment: attachment),
                      let image = images[identifier] else { return }
                if !(attachment.attachmentCell is InlineImageAttachmentCell)
                    || attributes[.dogearImageID] as? String != identifier {
                    repairs.append((range, attachment, image))
                }
            }
            guard !repairs.isEmpty else { return }
            programmatic = true
            for (range, attachment, image) in repairs {
                if let source = NSImage(contentsOfFile: image.path)
                    ?? attachment.fileWrapper?.regularFileContents.flatMap(NSImage.init(data:)) {
                    attachment.attachmentCell = InlineImageAttachmentCell(imageCell: source)
                }
                attachment.allowsTextAttachmentView = false
                attachment.bounds = NSRect(origin: .zero, size: InlineImageAttachmentCell.thumbnailSize)
                storage.addAttribute(.dogearImageID, value: image.id.uuidString, range: range)
                storage.addAttribute(.dogearImagePath, value: image.path, range: range)
            }
            programmatic = false
            editor.typingAttributes = textAttributes
        }

        private func imageIdentifier(
            attributes: [NSAttributedString.Key: Any],
            attachment: NSTextAttachment? = nil
        ) -> String? {
            if let identifier = attributes[.dogearImageID] as? String { return identifier }
            let attachment = attachment ?? attributes[.attachment] as? NSTextAttachment
            guard let name = attachment?.fileWrapper?.preferredFilename,
                  name.hasPrefix("dogear-image-") else { return nil }
            let start = name.index(name.startIndex, offsetBy: "dogear-image-".count)
            let remainder = name[start...]
            guard remainder.count >= 36 else { return nil }
            return String(remainder.prefix(36))
        }
    }
}

enum InlineQuestionEditorSelfTest {
    private static func failure(_ message: String) -> NSError {
        NSError(domain: "DogearEditorSelfTest", code: 1,
                userInfo: [NSLocalizedDescriptionKey: message])
    }

    @MainActor
    static func run(snapshotPath: String) throws {
        try QueueDragInteraction.runSelfTest()
        let queueTestDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("dogear-queue-drag-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: queueTestDirectory) }
        let queueState = AppState(baseDirectory: queueTestDirectory)
        let first = QueueItem(source: Source(applicationName: "A"), selectedContext: [], message: [.text("A")])
        let second = QueueItem(source: Source(applicationName: "B"), selectedContext: [], message: [.text("B")])
        let third = QueueItem(source: Source(applicationName: "C"), selectedContext: [], message: [.text("C")])
        queueState.queue = [first, second, third]
        var drag = QueueDragInteraction()
        drag.begin(first.id)
        drag.hover(targetID: third.id, pointerY: 80, targetHeight: 100)
        guard queueState.queue.map(\.id) == [first.id, second.id, third.id] else {
            throw failure("Queue mutated while drag was only hovering")
        }
        guard let command = drag.drop(targetID: third.id, pointerY: 80, targetHeight: 100) else {
            throw failure("Queue drop did not produce a move")
        }
        queueState.move(command.draggedID, relativeTo: command.targetID, after: command.after)
        guard queueState.queue.map(\.id) == [second.id, third.id, first.id] else {
            throw failure("Queue did not commit the move on drop")
        }

        let cleanupDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("dogear-asset-cleanup-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: cleanupDirectory) }
        let cleanupState = AppState(baseDirectory: cleanupDirectory)
        let removedURL = cleanupState.assetDirectory.appendingPathComponent("removed.png")
        try Data([1]).write(to: removedURL)
        let removedAsset = ImageAsset(path: removedURL.path, label: "removed.png")
        cleanupState.beginCapture(source: Source(applicationName: "Test"), context: [.image(removedAsset)])
        cleanupState.submitDraft(message: [.text("Keep until the question is deleted")], page: nil)
        guard FileManager.default.fileExists(atPath: removedURL.path), let cleanupItem = cleanupState.queue.last else {
            throw failure("Managed image was removed while its question still referenced it")
        }
        cleanupState.remove(cleanupItem)
        guard !FileManager.default.fileExists(atPath: removedURL.path) else {
            throw failure("Deleting a question did not remove its managed image")
        }

        let cancelledURL = cleanupState.assetDirectory.appendingPathComponent("cancelled.png")
        try Data([2]).write(to: cancelledURL)
        cleanupState.beginCapture(
            source: Source(applicationName: "Test"),
            context: [.image(ImageAsset(path: cancelledURL.path, label: "cancelled.png"))]
        )
        cleanupState.cancelDraft()
        guard !FileManager.default.fileExists(atPath: cancelledURL.path) else {
            throw failure("Cancelling a draft did not remove its managed image")
        }

        let orphanURL = cleanupState.assetDirectory.appendingPathComponent("orphan.png")
        try Data([3]).write(to: orphanURL)
        _ = AppState(baseDirectory: cleanupDirectory)
        guard !FileManager.default.fileExists(atPath: orphanURL.path) else {
            throw failure("Startup cleanup did not remove an orphaned managed image")
        }

        let imageURL = FileManager.default.temporaryDirectory.appendingPathComponent("dogear-editor-selftest.png")
        let sourceImage = NSImage(size: NSSize(width: 160, height: 90))
        sourceImage.lockFocus()
        NSColor.systemIndigo.setFill()
        NSBezierPath(rect: NSRect(x: 0, y: 0, width: 160, height: 90)).fill()
        NSColor.systemYellow.setFill()
        NSBezierPath(roundedRect: NSRect(x: 20, y: 20, width: 120, height: 50), xRadius: 8, yRadius: 8).fill()
        sourceImage.unlockFocus()
        guard let tiff = sourceImage.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:]) else {
            throw failure("Could not create fixture image")
        }
        try png.write(to: imageURL)
        let asset = ImageAsset(path: imageURL.path, label: "selftest.png")

        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 390, height: 150))
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = true
        scroll.backgroundColor = .textBackgroundColor
        let editor = DogearTextView(frame: scroll.contentView.bounds)
        let coordinator = InlineQuestionEditor.Coordinator(onChange: { _ in })
        editor.delegate = coordinator
        editor.isRichText = true
        editor.isEditable = true
        editor.isSelectable = true
        editor.allowsImageEditing = false
        editor.usesRolloverButtonForSelection = false
        editor.textColor = .labelColor
        editor.font = .preferredFont(forTextStyle: .body)
        editor.textContainerInset = NSSize(width: 7, height: 7)
        editor.isVerticallyResizable = true
        editor.isHorizontallyResizable = false
        editor.autoresizingMask = [.width]
        editor.textContainer?.containerSize = NSSize(width: scroll.contentSize.width, height: CGFloat.greatestFiniteMagnitude)
        editor.textContainer?.widthTracksTextView = true
        editor.typingAttributes = coordinator.textAttributes
        scroll.documentView = editor
        guard !editor.allowsImageEditing, !editor.usesRolloverButtonForSelection else {
            throw failure("Generic AppKit attachment editing controls are still enabled")
        }
        coordinator.replaceContents(of: editor, with: [
            .text("Before "), .image(asset),
            .text(" after the image, this long sentence must wrap inside the editor instead of expanding horizontally past its border.")
        ])

        guard let storage = editor.textStorage else { throw failure("Missing text storage") }
        var attachmentRange: NSRange?
        storage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: storage.length)) { value, range, stop in
            if value != nil { attachmentRange = range; stop.pointee = true }
        }
        guard let originalRange = attachmentRange else { throw failure("Fixture attachment missing") }

        // Model AppKit's drag/drop reconstruction: the file wrapper survives,
        // while custom attributes and the thumbnail cell may not.
        let original = storage.attribute(.attachment, at: originalRange.location, effectiveRange: nil) as! NSTextAttachment
        let reconstructed = NSTextAttachment(fileWrapper: original.fileWrapper)
        reconstructed.attachmentCell = NSTextAttachmentCell(imageCell: sourceImage)
        storage.deleteCharacters(in: originalRange)
        storage.append(NSAttributedString(string: " moved ", attributes: coordinator.textAttributes))
        storage.append(NSAttributedString(attachment: reconstructed))
        coordinator.normalizeAttachments(in: editor)

        let finalIndex = storage.length - 1
        guard let repaired = storage.attribute(.attachment, at: finalIndex, effectiveRange: nil) as? NSTextAttachment,
              repaired.attachmentCell is InlineImageAttachmentCell,
              repaired.attachmentCell?.cellSize() == NSSize(width: 76, height: 44) else {
            throw failure("Dragged attachment was not restored to thumbnail size")
        }
        guard coordinator.parts(in: editor).contains(.image(asset)) else {
            throw failure("Dragged attachment lost its image identity")
        }
        editor.layoutManager?.ensureLayout(for: editor.textContainer!)
        let movedRange = NSRange(location: finalIndex, length: 1)
        let movedGlyph = editor.layoutManager!.glyphRange(forCharacterRange: movedRange, actualCharacterRange: nil)
        var movedFrame = editor.layoutManager!.boundingRect(forGlyphRange: movedGlyph, in: editor.textContainer!)
        movedFrame.origin.x += editor.textContainerOrigin.x
        movedFrame.origin.y += editor.textContainerOrigin.y
        guard editor.attachment(at: NSPoint(x: movedFrame.midX, y: movedFrame.midY)) != nil else {
            throw failure("Attachment does not receive clicks inside its bounds")
        }
        guard editor.attachmentMenu().items.map(\.title) == [
            "Edit Original in Preview…", "Replace with Edited File…"
        ] else {
            throw failure("Attachment did not provide the controlled image editing menu")
        }
        guard editor.attachment(at: NSPoint(x: movedFrame.maxX + 35, y: movedFrame.midY)) == nil else {
            throw failure("Attachment receives clicks from empty canvas")
        }
        let deleteFrame = InlineImageAttachmentCell.deleteButtonFrame(in: movedFrame)
        guard deleteFrame.contains(NSPoint(x: deleteFrame.midX, y: deleteFrame.midY)),
              !deleteFrame.contains(NSPoint(x: movedFrame.maxX - 2, y: movedFrame.midY)) else {
            throw failure("Attachment delete target is not restricted to the top-left button")
        }

        editor.moveAttachment(
            from: movedRange,
            to: NSPoint(x: editor.textContainerOrigin.x + 1, y: editor.textContainerOrigin.y + 2)
        )
        guard storage.attribute(.attachment, at: 0, effectiveRange: nil) is NSTextAttachment,
              coordinator.parts(in: editor).first == .image(asset) else {
            throw failure("Controlled attachment drag did not move the image without reconstruction")
        }

        editor.setSelectedRange(NSRange(location: storage.length, length: 0))
        coordinator.textViewDidChangeSelection(Notification(name: NSTextView.didChangeSelectionNotification, object: editor))
        editor.insertText(" visible", replacementRange: editor.selectedRange())
        let color = storage.attribute(.foregroundColor, at: storage.length - 1, effectiveRange: nil) as? NSColor
        guard color == NSColor.labelColor else { throw failure("Text after an image inherited the wrong color") }

        editor.layoutManager?.ensureLayout(for: editor.textContainer!)
        let used = editor.layoutManager?.usedRect(for: editor.textContainer!) ?? .zero
        guard used.width <= scroll.contentSize.width + 1, used.height > 35 else {
            throw failure("Text did not wrap to the editor width")
        }
        let testRect = NSRect(x: 10, y: 5, width: 2, height: 44)
        let caret = DogearTextView.compactInsertionRect(testRect, font: editor.font!)
        guard caret.maxY == testRect.maxY, caret.height < testRect.height else {
            throw failure("Caret is not aligned to the text baseline")
        }

        scroll.layoutSubtreeIfNeeded()
        guard let representation = scroll.bitmapImageRepForCachingDisplay(in: scroll.bounds) else {
            throw failure("Could not render editor fixture")
        }
        scroll.cacheDisplay(in: scroll.bounds, to: representation)
        guard let rendered = representation.representation(using: .png, properties: [:]) else {
            throw failure("Could not encode editor snapshot")
        }
        try rendered.write(to: URL(fileURLWithPath: snapshotPath))
    }
}
