import AppKit
import DogearCore
import SwiftUI
import UniformTypeIdentifiers

struct ContentView: View {
    @ObservedObject var state: AppState
    let captureText: () -> Void
    let captureImage: () -> Void
    let deliver: (DeliveryTarget) -> Void
    let routingChanged: () -> Void
    let openAccessibilitySettings: () -> Void
    let refreshAccessibility: () -> Void
    let repairAccessibility: () -> Void
    let openScreenRecordingSettings: () -> Void
    let refreshScreenRecording: () -> Void
    let repairScreenRecording: () -> Void
    let restart: () -> Void
    @State private var queueDrag = QueueDragInteraction()
    @State private var cardHeights: [UUID: CGFloat] = [:]

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if state.queue.isEmpty {
                emptyState
            } else {
                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(Array(state.queue.enumerated()), id: \.element.id) { index, item in
                            QueueCard(
                                number: index + 1,
                                item: item,
                                assetDirectory: state.assetDirectory,
                                canMoveUp: index > 0,
                                canMoveDown: index < state.queue.count - 1,
                                updateMessage: { state.updateMessage(for: item.id, message: $0) },
                                moveUp: { state.move(item, offset: -1) },
                                moveDown: { state.move(item, offset: 1) },
                                remove: { state.remove(item) },
                                beginDrag: {
                                    queueDrag.begin(item.id)
                                    return NSItemProvider(object: item.id.uuidString as NSString)
                                }
                            )
                            .background(GeometryReader { proxy in
                                Color.clear.preference(
                                    key: QueueCardHeightPreferenceKey.self,
                                    value: [item.id: proxy.size.height]
                                )
                            })
                            .overlay {
                                QueueDropIndicator(location: queueDrag.location, itemID: item.id)
                            }
                            .onDrop(of: [UTType.text.identifier], delegate: QueueDropDelegate(
                                targetID: item.id,
                                targetHeight: cardHeights[item.id] ?? 1,
                                interaction: $queueDrag,
                                move: state.move(_:relativeTo:after:)
                            ))
                        }
                    }
                    .padding(12)
                    .onPreferenceChange(QueueCardHeightPreferenceKey.self) { cardHeights.merge($0) { _, new in new } }
                }
            }
            Divider()
            footer
        }
        .frame(minWidth: 390, idealWidth: 430, minHeight: 600)
        .overlay {
            if state.showScreenRecordingNotice {
                permissionNotice(
                    title: "Dogear needs Screen Recording access",
                    detail: "Without it, macOS gives Dogear the desktop wallpaper but hides app windows from region captures.",
                    instruction: "Turn on Dogear in System Settings → Privacy & Security → Screen & System Audio Recording. If it is already on but windows are still hidden, choose Set Up Access Again.",
                    repair: repairScreenRecording,
                    error: state.screenRecordingRecoveryError,
                    dismiss: { state.showScreenRecordingNotice = false },
                    openSettings: openScreenRecordingSettings
                )
            } else if state.showAccessibilityNotice {
                ZStack {
                    Color.black.opacity(0.2).ignoresSafeArea()
                    VStack(alignment: .leading, spacing: 16) {
                        Label("Dogear needs Accessibility access", systemImage: "exclamationmark.triangle.fill")
                            .font(.headline).foregroundStyle(.red)
                        Text("Dogear cannot capture selected text or paste into another app until you allow Accessibility access.")
                            .fixedSize(horizontal: false, vertical: true)
                        Text("Turn on Dogear in System Settings → Privacy & Security → Accessibility. If it is already on but capture still fails, choose Set Up Access Again, then turn on Dogear when Settings opens.")
                            .font(.callout).fixedSize(horizontal: false, vertical: true)
                        Button("Set Up Access Again", action: repairAccessibility)
                        Text("This resets only Dogear’s Accessibility permission. You’ll need to allow access again.")
                            .font(.caption).foregroundStyle(.secondary)
                        AccessibilityExplanation()
                        Button("Restart Dogear", action: restart)
                        if let error = state.accessibilityRecoveryError {
                            Text(error).font(.caption).foregroundStyle(.red)
                        }
                        HStack {
                            Button("Not now") { state.showAccessibilityNotice = false }
                            Spacer()
                            Button("Open Settings", action: openAccessibilitySettings)
                                .buttonStyle(.borderedProminent)
                        }
                    }
                    .padding(20)
                    .frame(maxWidth: 390)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.red.opacity(0.6)))
                    .padding(16)
                }
            }
        }
        .onReceive(Timer.publish(every: 1, on: .main, in: .common).autoconnect()) { _ in
            refreshAccessibility()
            refreshScreenRecording()
        }
        .toolbar {
            ToolbarItem(placement: .automatic) {
                Menu {
                    Toggle("Prefer Chrome extension", isOn: $state.preferChromeExtension)
                    Toggle("Prefer VS Code extension", isOn: $state.preferVSCodeExtension)
                    Divider()
                    Text("Desktop hotkey pauses in preferred apps")
                } label: { Image(systemName: "gearshape") }
            }
        }
        .onChange(of: state.preferChromeExtension) { _ in routingChanged() }
        .onChange(of: state.preferVSCodeExtension) { _ in routingChanged() }
    }

    private func permissionNotice(
        title: String,
        detail: String,
        instruction: String,
        repair: @escaping () -> Void,
        error: String?,
        dismiss: @escaping () -> Void,
        openSettings: @escaping () -> Void
    ) -> some View {
        ZStack {
            Color.black.opacity(0.2).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 16) {
                Label(title, systemImage: "exclamationmark.triangle.fill").font(.headline).foregroundStyle(.red)
                Text(detail).fixedSize(horizontal: false, vertical: true)
                Text(instruction).font(.callout).fixedSize(horizontal: false, vertical: true)
                Button("Set Up Access Again", action: repair)
                Text("This resets only Dogear’s permission. You’ll need to allow it again.")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Restart Dogear", action: restart)
                if let error { Text(error).font(.caption).foregroundStyle(.red) }
                HStack {
                    Button("Not now", action: dismiss)
                    Spacer()
                    Button("Open Settings", action: openSettings).buttonStyle(.borderedProminent)
                }
            }
            .padding(20).frame(maxWidth: 390)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.red.opacity(0.6)))
            .padding(16)
        }
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Dogear").font(.system(size: 23, weight: .semibold, design: .serif))
                Text("\(state.queue.count) queued").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button(action: captureText) { Label("Capture", systemImage: "text.viewfinder") }
            Button(action: captureImage) { Label("Region", systemImage: "viewfinder") }
        }
        .padding(14)
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "bookmark.square").font(.system(size: 38)).foregroundStyle(.secondary)
            Text("Mark questions without leaving your flow").font(.headline)
            Text("Press ⌃⌥Q in any app. Dogear captures selected text, or starts region capture when there is no selection.")
                .multilineTextAlignment(.center).foregroundStyle(.secondary)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    private var footer: some View {
        VStack(spacing: 9) {
            HStack {
                Button("Copy prompt", action: state.copyPrompt)
                Spacer()
                Button("→ Claude") { deliver(.claude) }.buttonStyle(.borderedProminent)
                Button("→ Codex") { deliver(.codex) }.buttonStyle(.borderedProminent)
                Button("→ Terminal") { deliver(.terminal) }.buttonStyle(.borderedProminent)
            }
            HStack {
                Text(state.status).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                Button("Clear", action: state.clear).disabled(state.queue.isEmpty)
            }
        }
        .padding(12)
    }
}

private struct AccessibilityExplanation: View {
    @State private var expanded = false

    var body: some View {
        DisclosureGroup("Why does Dogear need Accessibility?", isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Dogear uses it to copy your selection, read the source window title, and paste into the destination you choose. It does not monitor general keystrokes or send automatically.")
            }
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 6)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }
}

private struct QueueCard: View {
    let number: Int
    let item: QueueItem
    let assetDirectory: URL
    let canMoveUp: Bool
    let canMoveDown: Bool
    let updateMessage: ([ContentPart]) -> Void
    let moveUp: () -> Void
    let moveDown: () -> Void
    let remove: () -> Void
    let beginDrag: () -> NSItemProvider
    @State private var insertion: InlineImageInsertion?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Q\(number)").font(.caption.bold()).padding(.horizontal, 7).padding(.vertical, 3)
                    .background(Color.accentColor.opacity(0.15), in: Capsule())
                Text(sourceHeading).font(.subheadline.bold()).lineLimit(1)
                    .textSelection(.enabled)
                Spacer()
                Image(systemName: "line.3.horizontal")
                    .font(.title3).foregroundStyle(.secondary)
                    .frame(width: 44, height: 34)
                    .contentShape(Rectangle())
                    .onDrag(beginDrag)
                    .help("Drag to reorder")
            }
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(item.selectedContext.enumerated()), id: \.offset) { _, part in
                    PartView(part: part, compactImage: true)
                }
            }
            .padding(9).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 8))

            InlineQuestionEditor(parts: item.message, insertion: $insertion, onChange: updateMessage)
                .frame(minHeight: 88, maxHeight: 150)
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.accentColor.opacity(0.35), lineWidth: 1.5))

            HStack {
                Text("Images are inline: drag them, or select and press Delete.")
                    .font(.caption2).foregroundStyle(.secondary)
                Spacer()
                Button("＋ Image", action: chooseImages)
                Button(action: moveUp) { Image(systemName: "arrow.up") }.disabled(!canMoveUp).help("Move up")
                Button(action: moveDown) { Image(systemName: "arrow.down") }.disabled(!canMoveDown).help("Move down")
                Button(action: remove) { Image(systemName: "trash") }.help("Delete question")
            }
        }
        .padding(12)
        .background(Color.accentColor.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.accentColor.opacity(0.22)))
    }

    private var sourceHeading: String {
        var components = [item.source.surface.label]
        if item.source.displayTitle.caseInsensitiveCompare(item.source.surface.label) != .orderedSame,
           item.source.displayTitle.caseInsensitiveCompare(item.source.applicationName) != .orderedSame {
            components.append(item.source.displayTitle)
        }
        if let page = item.source.page { components.append("p.\(page)") }
        return components.joined(separator: " — ")
    }

    private func chooseImages() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.png, .jpeg, .gif, .webP]
        panel.allowsMultipleSelection = true
        guard panel.runModal() == .OK else { return }
        let images = panel.urls.compactMap { try? ImageAsset.importing($0, into: assetDirectory) }
        if !images.isEmpty { insertion = InlineImageInsertion(images: images) }
    }
}

private struct PartView: View {
    let part: ContentPart
    var compactImage = false
    var body: some View {
        switch part {
        case .text(let text):
            Text(text).font(.callout).textSelection(.enabled).padding(8).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.secondary.opacity(0.09), in: RoundedRectangle(cornerRadius: 7))
        case .image(let image):
            if let value = NSImage(contentsOfFile: image.path) {
                Image(nsImage: value).resizable().scaledToFit()
                    .frame(maxWidth: compactImage ? 180 : 320, maxHeight: compactImage ? 95 : 170, alignment: .leading)
                    .cornerRadius(7)
            }
        }
    }
}

struct ComposerView: View {
    @ObservedObject var state: AppState
    let draft: CaptureDraft
    let close: () -> Void
    @State private var message: [ContentPart]
    @State private var pageText = ""
    @State private var insertion: InlineImageInsertion?

    init(state: AppState, draft: CaptureDraft, close: @escaping () -> Void) {
        self.state = state
        self.draft = draft
        self.close = close
        _message = State(initialValue: draft.message)
        _pageText = State(initialValue: draft.source.page.map(String.init) ?? "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(composerHeading).font(.headline)
            VStack(alignment: .leading, spacing: 6) {
                Text("Captured target").font(.caption.bold()).foregroundStyle(.secondary)
                ForEach(Array(draft.context.enumerated()), id: \.offset) { _, part in PartView(part: part, compactImage: true) }
            }
            .padding(9).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 5) {
                Text("Question").font(.caption.bold()).foregroundStyle(.secondary)
                InlineQuestionEditor(parts: message, insertion: $insertion) {
                    message = $0
                    state.updateDraftMessage($0)
                }
                    .frame(minHeight: 115)
                    .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.accentColor.opacity(0.4), lineWidth: 1.5))
                Text("Inline images can be dragged, cut, copied, or deleted like text.")
                    .font(.caption2).foregroundStyle(.secondary)
                }
            HStack {
                if draft.source.surface == .pdf {
                    TextField("PDF page (optional)", text: $pageText).frame(width: 140)
                }
                Button("＋ Image") { chooseImages() }
                Spacer()
                Button("Cancel", action: close)
                Button(draft.editingID == nil ? "Add to queue" : "Save changes") {
                    state.submitDraft(message: message, page: Int(pageText))
                    close()
                }.buttonStyle(.borderedProminent).disabled(!hasContent)
            }
        }
        .padding(18).frame(width: 470)
    }

    private var composerHeading: String {
        let title = draft.source.displayTitle
        return title.caseInsensitiveCompare(draft.source.applicationName) == .orderedSame
            ? draft.source.surface.label
            : "\(draft.source.surface.label) — \(title)"
    }

    private var hasContent: Bool {
        message.contains { part in
            switch part {
            case .text(let text): return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            case .image: return true
            }
        }
    }

    private func chooseImages() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.png, .jpeg, .gif, .webP]
        panel.allowsMultipleSelection = true
        guard panel.runModal() == .OK else { return }
        let imported = panel.urls.compactMap { try? ImageAsset.importing($0, into: state.assetDirectory) }
        if !imported.isEmpty { insertion = InlineImageInsertion(images: imported) }
    }
}

enum QueueDropEdge: Equatable { case before, after }

struct QueueDropLocation: Equatable {
    let itemID: UUID
    let edge: QueueDropEdge
}

struct QueueDragMove: Equatable {
    let draggedID: UUID
    let targetID: UUID
    let after: Bool
}

struct QueueDragInteraction: Equatable {
    var draggingID: UUID?
    var location: QueueDropLocation?

    mutating func begin(_ id: UUID) {
        draggingID = id
        location = nil
    }

    mutating func hover(targetID: UUID, pointerY: CGFloat, targetHeight: CGFloat) {
        guard let draggingID, draggingID != targetID else {
            if location?.itemID == targetID { location = nil }
            return
        }
        location = QueueDropLocation(
            itemID: targetID,
            edge: pointerY < targetHeight / 2 ? .before : .after
        )
    }

    mutating func exit(targetID: UUID) {
        if location?.itemID == targetID { location = nil }
    }

    mutating func drop(targetID: UUID, pointerY: CGFloat, targetHeight: CGFloat) -> QueueDragMove? {
        guard let draggedID = draggingID, draggedID != targetID else {
            self.draggingID = nil
            location = nil
            return nil
        }
        let edge = location?.itemID == targetID
            ? location!.edge
            : (pointerY < targetHeight / 2 ? .before : .after)
        self.draggingID = nil
        location = nil
        return QueueDragMove(draggedID: draggedID, targetID: targetID, after: edge == .after)
    }

    static func runSelfTest() throws {
        let first = UUID(), second = UUID()
        var drag = QueueDragInteraction()
        drag.begin(first)
        drag.hover(targetID: second, pointerY: 20, targetHeight: 100)
        guard drag.draggingID == first,
              drag.location == QueueDropLocation(itemID: second, edge: .before) else {
            throw NSError(domain: "DogearQueueDragSelfTest", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Hover did not remain a non-committing preview"])
        }
        guard drag.drop(targetID: second, pointerY: 20, targetHeight: 100)
                == QueueDragMove(draggedID: first, targetID: second, after: false),
              drag.draggingID == nil, drag.location == nil else {
            throw NSError(domain: "DogearQueueDragSelfTest", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "Drop did not commit and clear exactly once"])
        }
        drag.begin(first)
        drag.hover(targetID: second, pointerY: 80, targetHeight: 100)
        guard drag.location?.edge == .after else {
            throw NSError(domain: "DogearQueueDragSelfTest", code: 3,
                          userInfo: [NSLocalizedDescriptionKey: "Target midpoint rule is incorrect"])
        }
    }
}

private struct QueueCardHeightPreferenceKey: PreferenceKey {
    static var defaultValue: [UUID: CGFloat] = [:]
    static func reduce(value: inout [UUID: CGFloat], nextValue: () -> [UUID: CGFloat]) {
        value.merge(nextValue()) { _, new in new }
    }
}

private struct QueueDropIndicator: View {
    let location: QueueDropLocation?
    let itemID: UUID

    var body: some View {
        VStack(spacing: 0) {
            if location == QueueDropLocation(itemID: itemID, edge: .before) { indicator }
            Spacer(minLength: 0)
            if location == QueueDropLocation(itemID: itemID, edge: .after) { indicator }
        }
        .allowsHitTesting(false)
    }

    private var indicator: some View {
        Capsule().fill(Color.accentColor).frame(height: 4).shadow(color: Color.accentColor.opacity(0.35), radius: 2)
    }
}

private struct QueueDropDelegate: DropDelegate {
    let targetID: UUID
    let targetHeight: CGFloat
    @Binding var interaction: QueueDragInteraction
    let move: (UUID, UUID, Bool) -> Void

    func validateDrop(info: DropInfo) -> Bool {
        guard let draggingID = interaction.draggingID else { return false }
        return draggingID != targetID
    }

    func dropEntered(info: DropInfo) {
        interaction.hover(targetID: targetID, pointerY: info.location.y, targetHeight: targetHeight)
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        interaction.hover(targetID: targetID, pointerY: info.location.y, targetHeight: targetHeight)
        return DropProposal(operation: .move)
    }

    func dropExited(info: DropInfo) {
        interaction.exit(targetID: targetID)
    }

    func performDrop(info: DropInfo) -> Bool {
        guard let command = interaction.drop(
            targetID: targetID,
            pointerY: info.location.y,
            targetHeight: targetHeight
        ) else { return false }
        move(command.draggedID, command.targetID, command.after)
        return true
    }
}
