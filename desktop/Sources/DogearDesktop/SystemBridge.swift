import AppKit
import ApplicationServices
import DogearCore

struct FrontmostContext {
    var source: Source
    var application: NSRunningApplication?
}

@MainActor
final class SystemBridge {
    private let terminalBundleIDs = [
        "com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable",
        "com.github.wez.wezterm", "com.mitchellh.ghostty", "net.kovidgoyal.kitty",
    ]
    private let targetBundleIDs: [DeliveryTarget: [String]] = [
        .claude: ["com.anthropic.claudefordesktop", "com.anthropic.claude"],
        .codex: ["com.openai.codex", "com.openai.chat", "com.openai.chatgpt"],
        .terminal: [],
    ]

    func frontmostContext() -> FrontmostContext {
        context(for: NSWorkspace.shared.frontmostApplication)
    }

    func context(for app: NSRunningApplication?) -> FrontmostContext {
        let name = app?.localizedName ?? "Unknown application"
        let bundle = app?.bundleIdentifier
        let title = focusedWindowTitle(application: app) ?? name
        return FrontmostContext(source: Source(applicationName: name, bundleIdentifier: bundle, windowTitle: title), application: app)
    }

    func captureSelectedText(from context: FrontmostContext, completion: @escaping (String?) -> Void) {
        let snapshot = PasteboardSnapshot.capture()
        NSPasteboard.general.clearContents()
        context.application?.activate(options: [.activateIgnoringOtherApps])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
            self.sendCommandKey(8) // C
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
                let selected = NSPasteboard.general.string(forType: .string)?.trimmingCharacters(in: .whitespacesAndNewlines)
                snapshot.restore()
                completion(selected?.isEmpty == false ? selected : nil)
            }
        }
    }

    func captureScreenRegion(from sourceApplication: NSRunningApplication?, to directory: URL, completion: @escaping (ImageAsset?) -> Void) {
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("dogear-\(UUID().uuidString).png")
        sourceApplication?.activate(options: [.activateIgnoringOtherApps])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            process.arguments = ["-i", "-s", "-x", temporary.path]
            process.terminationHandler = { process in
                let asset = process.terminationStatus == 0 ? try? ImageAsset.importing(temporary, into: directory) : nil
                try? FileManager.default.removeItem(at: temporary)
                DispatchQueue.main.async { completion(asset) }
            }
            do { try process.run() } catch { completion(nil) }
        }
    }

    func deliver(_ plan: DeliveryPlan, capturedSourceBundle: String?, completion: @escaping (Bool) -> Void) {
        let candidates: [String]
        if plan.target == .terminal {
            candidates = [plan.preferredBundleIdentifier, capturedSourceBundle].compactMap { $0 } + terminalBundleIDs
        } else {
            candidates = [plan.preferredBundleIdentifier].compactMap { $0 } + (targetBundleIDs[plan.target] ?? [])
        }
        guard let app = candidates.lazy.compactMap({ self.runningApplication(bundleIdentifier: $0) }).first
                ?? self.runningApplication(namedFor: plan.target) else {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(planFallback(plan), forType: .string)
            completion(false)
            return
        }

        app.activate(options: [.activateIgnoringOtherApps])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            self.paste(plan.chunks, index: 0) { completion(true) }
        }
    }

    private func paste(_ chunks: [DeliveryChunk], index: Int, completion: @escaping () -> Void) {
        guard index < chunks.count else { completion(); return }
        NSPasteboard.general.clearContents()
        switch chunks[index] {
        case .text(let text):
            NSPasteboard.general.setString(text, forType: .string)
        case .image(let image):
            let url = URL(fileURLWithPath: image.path)
            guard let value = NSImage(contentsOf: url), let tiff = value.tiffRepresentation,
                  let bitmap = NSBitmapImageRep(data: tiff),
                  let png = bitmap.representation(using: .png, properties: [:]) else {
                paste(chunks, index: index + 1, completion: completion)
                return
            }
            let item = NSPasteboardItem()
            item.setData(png, forType: .png)
            item.setString(url.absoluteString, forType: .fileURL)
            NSPasteboard.general.writeObjects([item])
        }
        sendCommandKey(9) // V. Never synthesize Enter.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.16) {
            self.paste(chunks, index: index + 1, completion: completion)
        }
    }

    private func runningApplication(bundleIdentifier: String) -> NSRunningApplication? {
        NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier).first
    }

    private func runningApplication(namedFor target: DeliveryTarget) -> NSRunningApplication? {
        NSWorkspace.shared.runningApplications.first { app in
            let name = app.localizedName?.lowercased() ?? ""
            switch target {
            case .claude: return name.contains("claude")
            case .codex: return name.contains("codex") || name == "chatgpt"
            case .terminal:
                return SurfaceDetector.detect(
                    applicationName: name,
                    bundleIdentifier: app.bundleIdentifier,
                    windowTitle: ""
                ) == .terminal
            }
        }
    }

    private func focusedWindowTitle(application: NSRunningApplication?) -> String? {
        guard let pid = application?.processIdentifier else { return nil }
        let app = AXUIElementCreateApplication(pid)
        var window: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &window) == .success,
              let window else { return nil }
        var title: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window as! AXUIElement, kAXTitleAttribute as CFString, &title) == .success else { return nil }
        return title as? String
    }

    private func sendCommandKey(_ keyCode: CGKeyCode) {
        let source = CGEventSource(stateID: .combinedSessionState)
        let down = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true)
        down?.flags = .maskCommand
        let up = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false)
        up?.flags = .maskCommand
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
    }

    private func planFallback(_ plan: DeliveryPlan) -> String {
        plan.chunks.map {
            switch $0 {
            case .text(let text): return text
            case .image(let image): return "[Image file: \(image.path)]\n"
            }
        }.joined()
    }
}

private struct PasteboardSnapshot {
    let items: [[NSPasteboard.PasteboardType: Data]]

    static func capture() -> PasteboardSnapshot {
        PasteboardSnapshot(items: (NSPasteboard.general.pasteboardItems ?? []).map { item in
            Dictionary(uniqueKeysWithValues: item.types.compactMap { type in
                item.data(forType: type).map { (type, $0) }
            })
        })
    }

    func restore() {
        NSPasteboard.general.clearContents()
        let restored = items.map { values -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, data) in values { item.setData(data, forType: type) }
            return item
        }
        NSPasteboard.general.writeObjects(restored)
    }
}
