import AppKit
import DogearCore
import SwiftUI
import UniformTypeIdentifiers

@MainActor
final class AppState: ObservableObject {
    @Published var queue: [QueueItem]
    @Published var draft: CaptureDraft?
    @Published var status = "Ready"
    @Published var showAccessibilityNotice = false
    @Published var accessibilityRecoveryError: String?
    @Published var showScreenRecordingNotice = false
    @Published var screenRecordingRecoveryError: String?
    @Published var preferChromeExtension: Bool {
        didSet { defaults.set(preferChromeExtension, forKey: "preferChromeExtension") }
    }
    @Published var preferVSCodeExtension: Bool {
        didSet { defaults.set(preferVSCodeExtension, forKey: "preferVSCodeExtension") }
    }
    @Published var shortcuts: ShortcutSettings {
        didSet { defaults.set(shortcuts.encoded(), forKey: "shortcuts") }
    }
    /// Actions whose combo macOS refused (another app already registered it).
    @Published var unavailableShortcuts: Set<HotKeyAction> = []
    @Published var appearance: AppearanceSetting {
        didSet {
            defaults.set(appearance.rawValue, forKey: "appearance")
            appearance.apply()
        }
    }
    @Published var lastExportDestination: ExportDestination {
        didSet { defaults.set(lastExportDestination.rawValue, forKey: "lastExportDestination") }
    }
    /// The last clear, kept (with its images) for ClearUndo.window.
    private var cleared: (items: [QueueItem], at: Date)?
    /// Drives the queue window's Undo button after a clear.
    @Published private(set) var clearUndoOffered = false

    private let queueURL: URL
    private let defaults: UserDefaults
    let assetDirectory: URL

    init(baseDirectory: URL? = nil, defaults: UserDefaults = .standard) {
        self.defaults = defaults
        preferChromeExtension = defaults.object(forKey: "preferChromeExtension") as? Bool ?? true
        preferVSCodeExtension = defaults.object(forKey: "preferVSCodeExtension") as? Bool ?? true
        shortcuts = ShortcutSettings.load(from: defaults.data(forKey: "shortcuts"))
        appearance = AppearanceSetting(rawValue: defaults.string(forKey: "appearance") ?? "") ?? .system
        lastExportDestination = ExportDestination(rawValue: defaults.string(forKey: "lastExportDestination") ?? "") ?? .copy
        let base = baseDirectory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("DogearDesktop", isDirectory: true)
        queueURL = base.appendingPathComponent("queue.json")
        assetDirectory = base.appendingPathComponent("assets", isDirectory: true)
        queue = QueuePersistence.load(from: queueURL)
        try? FileManager.default.createDirectory(at: assetDirectory, withIntermediateDirectories: true)
        removeOrphanedAssets()
    }

    func beginCapture(source: Source, context: [ContentPart]) {
        draft = CaptureDraft(source: source, context: context, editingID: nil, message: [.text("")])
        status = "Captured from \(source.applicationName)"
    }

    func submitDraft(message: [ContentPart], page: Int?) {
        guard var value = draft else { return }
        let previousImages = value.editingID
            .flatMap { id in queue.first(where: { $0.id == id })?.images } ?? []
        value.source.page = page
        guard message.contains(where: { part in
            switch part {
            case .text(let text): return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            case .image: return true
            }
        }) else { return }
        if let editingID = value.editingID,
           let index = queue.firstIndex(where: { $0.id == editingID }) {
            queue[index].source = value.source
            queue[index].selectedContext = value.context
            queue[index].message = message
        } else {
            queue.append(QueueItem(source: value.source, selectedContext: value.context, message: message))
        }
        draft = nil
        if save() { removeManagedAssetsIfUnreferenced(previousImages.map(\.path)) }
    }

    func updateDraftMessage(_ message: [ContentPart]) {
        draft?.message = message
    }

    func cancelDraft() {
        guard let abandoned = draft else { return }
        draft = nil
        removeManagedAssetsIfUnreferenced((abandoned.context + abandoned.message).compactMap {
            if case .image(let image) = $0 { return image.path }
            return nil
        })
    }

    func edit(_ item: QueueItem) {
        draft = CaptureDraft(
            source: item.source,
            context: item.selectedContext,
            editingID: item.id,
            message: item.message
        )
    }

    func updateMessage(for id: UUID, message: [ContentPart]) {
        guard let index = queue.firstIndex(where: { $0.id == id }), queue[index].message != message else { return }
        let previousImages = queue[index].message.compactMap {
            if case .image(let image) = $0 { return image.path }
            return nil
        }
        queue[index].message = message
        if save() { removeManagedAssetsIfUnreferenced(previousImages) }
    }

    func move(_ id: UUID, relativeTo target: UUID, after: Bool) {
        guard id != target,
              let sourceIndex = queue.firstIndex(where: { $0.id == id }),
              queue.contains(where: { $0.id == target }) else { return }
        let original = queue
        let item = queue.remove(at: sourceIndex)
        guard let targetIndex = queue.firstIndex(where: { $0.id == target }) else { return }
        let destination = min(targetIndex + (after ? 1 : 0), queue.count)
        queue.insert(item, at: destination)
        if queue != original { save() }
    }

    func move(_ item: QueueItem, offset: Int) {
        guard let index = queue.firstIndex(where: { $0.id == item.id }) else { return }
        let destination = index + offset
        guard queue.indices.contains(destination) else { return }
        queue.swapAt(index, destination)
        save()
    }

    func remove(_ item: QueueItem) {
        queue.removeAll { $0.id == item.id }
        if save() { removeManagedAssetsIfUnreferenced(item.images.map(\.path)) }
    }

    func move(from offsets: IndexSet, to destination: Int) {
        queue.move(fromOffsets: offsets, toOffset: destination)
        save()
    }

    /// Empties the queue without confirmation; `undoClear` restores it within
    /// ClearUndo.window. Returns how many questions were cleared.
    @discardableResult
    func clear() -> Int {
        guard !queue.isEmpty else { return 0 }
        let previous = cleared
        cleared = (queue, Date())
        clearUndoOffered = true
        let count = queue.count
        queue.removeAll()
        guard save() else { return 0 }
        // The clear this one replaces is no longer undoable.
        if let previous { removeManagedAssetsIfUnreferenced(previous.items.flatMap(\.images).map(\.path)) }
        status = "Cleared \(count) \(count == 1 ? "question" : "questions")"
        return count
    }

    var canUndoClear: Bool {
        guard let cleared else { return false }
        return Date().timeIntervalSince(cleared.at) < ClearUndo.window
    }

    /// Returns how many questions came back (0 when nothing is undoable).
    @discardableResult
    func undoClear() -> Int {
        clearUndoOffered = false
        guard canUndoClear, let cleared else {
            status = "Nothing to restore"
            return 0
        }
        self.cleared = nil
        queue = ClearUndo.restore(cleared.items, into: queue)
        save()
        status = "Restored \(cleared.items.count) \(cleared.items.count == 1 ? "question" : "questions")"
        return cleared.items.count
    }

    func copyPrompt() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(PromptComposer.text(for: queue), forType: .string)
        status = "Prompt copied"
    }

    @discardableResult
    private func save() -> Bool {
        do {
            try QueuePersistence.save(queue, to: queueURL)
            return true
        } catch {
            status = "Could not save queue: \(error.localizedDescription)"
            return false
        }
    }

    private var referencedAssetPaths: Set<String> {
        let undoable = canUndoClear ? cleared?.items ?? [] : []
        var paths = Set((queue + undoable).flatMap(\.images).map { URL(fileURLWithPath: $0.path).standardizedFileURL.path })
        if let draft {
            for case .image(let image) in draft.context + draft.message {
                paths.insert(URL(fileURLWithPath: image.path).standardizedFileURL.path)
            }
        }
        return paths
    }

    private func removeOrphanedAssets() {
        let contents = (try? FileManager.default.contentsOfDirectory(
            at: assetDirectory,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )) ?? []
        removeManagedAssetsIfUnreferenced(contents.map(\.path))
    }

    private func removeManagedAssetsIfUnreferenced(_ paths: [String]) {
        let retained = referencedAssetPaths
        let root = assetDirectory.standardizedFileURL.path + "/"
        for path in Set(paths.map { URL(fileURLWithPath: $0).standardizedFileURL.path }) {
            guard path.hasPrefix(root), !retained.contains(path) else { continue }
            try? FileManager.default.removeItem(atPath: path)
        }
    }

    func saveBeforeRestart() throws {
        // The composer owns unsaved text; never discard it during a restart.
        guard draft == nil else {
            throw NSError(domain: "Dogear", code: 1, userInfo: [NSLocalizedDescriptionKey:
                "Finish or cancel the current question before restarting."])
        }
        try QueuePersistence.save(queue, to: queueURL)
    }
}

enum AppearanceSetting: String, CaseIterable {
    case system
    case light
    case dark

    var title: String {
        switch self {
        case .system: return "Match system"
        case .light: return "Light"
        case .dark: return "Dark"
        }
    }

    func apply() {
        switch self {
        case .system: NSApp?.appearance = nil
        case .light: NSApp?.appearance = NSAppearance(named: .aqua)
        case .dark: NSApp?.appearance = NSAppearance(named: .darkAqua)
        }
    }
}

struct CaptureDraft {
    let id = UUID()
    var source: Source
    var context: [ContentPart]
    var editingID: UUID?
    var message: [ContentPart]
}

extension ImageAsset {
    static func importing(_ url: URL, into directory: URL) throws -> ImageAsset {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let target = directory.appendingPathComponent("\(UUID().uuidString)-\(url.lastPathComponent)")
        try FileManager.default.copyItem(at: url, to: target)
        let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "image/png"
        return ImageAsset(path: target.path, mediaType: mime, label: url.lastPathComponent)
    }
}
