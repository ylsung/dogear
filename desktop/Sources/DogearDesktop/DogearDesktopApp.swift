import AppKit
import ApplicationServices
import DogearCore
import SwiftUI

@main
struct DogearDesktopApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    init() {
        guard let flag = CommandLine.arguments.firstIndex(of: "--editor-self-test") else { return }
        let path = CommandLine.arguments.indices.contains(flag + 1)
            ? CommandLine.arguments[flag + 1]
            : "/tmp/dogear-editor-selftest-render.png"
        do {
            try InlineQuestionEditorSelfTest.run(snapshotPath: path)
            print("PASS: native editor and deferred queue-drag interaction tests")
            exit(0)
        } catch {
            fputs("FAIL: \(error.localizedDescription)\n", stderr)
            exit(1)
        }
    }

    var body: some Scene {
        WindowGroup("Dogear") {
            ContentView(
                state: delegate.state,
                captureText: delegate.captureSelection,
                captureImage: delegate.captureRegion,
                deliver: delegate.deliver,
                routingChanged: delegate.updateHotKeyRouting,
                openAccessibilitySettings: delegate.openAccessibilitySettings,
                refreshAccessibility: delegate.refreshAccessibility,
                repairAccessibility: delegate.repairAccessibility,
                openScreenRecordingSettings: delegate.openScreenRecordingSettings,
                refreshScreenRecording: delegate.refreshScreenRecording,
                repairScreenRecording: delegate.repairScreenRecording,
                restart: delegate.restart
            )
        }
        .defaultSize(width: 430, height: 680)

        MenuBarExtra("Dogear", systemImage: "bookmark.square") {
            Button("Capture selection or region  ⌃⌥Q", action: delegate.captureSelection)
            Button("Capture screen region", action: delegate.captureRegion)
            Menu("Export prompt  ⌃⌥E") {
                Button("Choose destination…", action: delegate.showExportChooser)
                Divider()
                Button("Copy prompt", action: delegate.copyPrompt)
                Button("Send to Claude") { delegate.export(to: .claude) }
                Button("Send to Codex") { delegate.export(to: .codex) }
                Button("Send to Terminal") { delegate.export(to: .terminal) }
            }
            Divider()
            Button("Enable Accessibility…", action: delegate.requestAccessibility)
            Button("Enable Screen Recording…", action: delegate.requestScreenRecording)
            Button("Show queue", action: delegate.showWindow)
            Button("Quit Dogear") { NSApp.terminate(nil) }
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let state = AppState()
    private let bridge = SystemBridge()
    private let hotkeys = HotKeyMonitor()
    private var lastTerminalBundleIdentifier: String?
    private var lastExternalContext: FrontmostContext?
    private var permissionRepair: Process?
    private var screenPermissionRepair: Process?
    private var restarting = false
    private var composerPanel: NSPanel?
    private var exportPanel: NSPanel?
    private weak var composerReturnApplication: NSRunningApplication?
    private var queueWindow: NSWindow?
    private var restoreQueueAfterComposer = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        hotkeys.capture = captureSelection
        hotkeys.export = showExportChooser
        NSApp.servicesProvider = self
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(applicationActivated(_:)),
            name: NSWorkspace.didActivateApplicationNotification,
            object: nil
        )
        updateHotKeyRouting()
        DispatchQueue.main.async { [weak self] in self?.configureQueueWindow() }
    }

    @objc func askWithDogear(
        _ pasteboard: NSPasteboard,
        userData: String?,
        error: AutoreleasingUnsafeMutablePointer<NSString?>
    ) {
        guard let selected = pasteboard.string(forType: .string),
              !selected.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            error.pointee = "Ask with Dogear requires selected text."
            return
        }
        let current = bridge.frontmostContext()
        let context = current.application?.processIdentifier == ProcessInfo.processInfo.processIdentifier
            ? (lastExternalContext ?? current)
            : current
        rememberTerminal(context.source)
        state.beginCapture(source: context.source, context: [.text(selected)])
        showComposer(returningTo: context.application, restoreQueue: false)
    }

    @objc private func applicationActivated(_ notification: Notification) {
        if let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
           app.processIdentifier != ProcessInfo.processInfo.processIdentifier {
            lastExternalContext = bridge.context(for: app)
        }
        updateHotKeyRouting()
    }

    func applicationWillTerminate(_ notification: Notification) {
        NSWorkspace.shared.notificationCenter.removeObserver(self)
    }

    func captureSelection() {
        let current = bridge.frontmostContext()
        let initiatedFromDogear = current.application?.processIdentifier == ProcessInfo.processInfo.processIdentifier
        let context = current.application?.processIdentifier == ProcessInfo.processInfo.processIdentifier
            ? (lastExternalContext ?? current)
            : current
        rememberTerminal(context.source)
        guard ensureAccessibility() else { return }
        bridge.captureSelectedText(from: context) { [weak self] selected in
            guard let self else { return }
            guard let selected else {
                self.captureRegion(from: context, restoreQueue: initiatedFromDogear)
                return
            }
            self.state.beginCapture(source: context.source, context: [.text(selected)])
            self.showComposer(returningTo: context.application, restoreQueue: initiatedFromDogear)
        }
    }

    func captureRegion() {
        let current = bridge.frontmostContext()
        let initiatedFromDogear = current.application?.processIdentifier == ProcessInfo.processInfo.processIdentifier
        let context = current.application?.processIdentifier == ProcessInfo.processInfo.processIdentifier
            ? (lastExternalContext ?? current)
            : current
        captureRegion(from: context, restoreQueue: initiatedFromDogear)
    }

    private func captureRegion(from context: FrontmostContext, restoreQueue: Bool = false) {
        rememberTerminal(context.source)
        guard ensureScreenRecording() else { return }
        bridge.captureScreenRegion(from: context.application, to: state.assetDirectory) { [weak self] image in
            guard let self, let image else { return }
            self.state.beginCapture(source: context.source, context: [.image(image)])
            self.showComposer(returningTo: context.application, restoreQueue: restoreQueue)
        }
    }

    private func showComposer(returningTo application: NSRunningApplication?, restoreQueue: Bool) {
        guard let draft = state.draft else { return }
        composerReturnApplication = application
        restoreQueueAfterComposer = restoreQueue

        configureQueueWindow()
        queueWindow?.orderOut(nil)

        let panel = composerPanel ?? makeComposerPanel()
        panel.contentViewController = NSHostingController(rootView: ComposerView(
            state: state,
            draft: draft,
            close: { [weak self] in self?.closeComposer() }
        ))
        panel.setContentSize(NSSize(width: 500, height: 390))
        panel.center()
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func makeComposerPanel() -> NSPanel {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 500, height: 390),
            styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.title = "Ask Dogear"
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.minSize = NSSize(width: 440, height: 330)
        panel.delegate = self
        composerPanel = panel
        return panel
    }

    private func closeComposer() {
        state.cancelDraft()
        composerPanel?.orderOut(nil)
        if restoreQueueAfterComposer {
            queueWindow?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        } else {
            composerReturnApplication?.activate(options: [.activateIgnoringOtherApps])
        }
        restoreQueueAfterComposer = false
        composerReturnApplication = nil
    }

    func windowWillClose(_ notification: Notification) {
        guard notification.object as? NSWindow === composerPanel else { return }
        closeComposer()
    }

    func deliver(_ target: DeliveryTarget) {
        guard !state.queue.isEmpty else { return }
        guard ensureAccessibility() else { return }
        let preferred = target == .terminal ? lastTerminalBundleIdentifier : nil
        let plan = PromptComposer.plan(for: state.queue, target: target, preferredBundleIdentifier: preferred)
        bridge.deliver(plan, capturedSourceBundle: lastTerminalBundleIdentifier) { [weak self] delivered in
            self?.state.status = delivered
                ? "Inserted into \(target.rawValue.capitalized); review before sending"
                : "Destination not open; prompt and image paths copied"
        }
    }

    func export(to target: DeliveryTarget) {
        exportPanel?.orderOut(nil)
        deliver(target)
    }

    func copyPrompt() {
        guard !state.queue.isEmpty else { return }
        exportPanel?.orderOut(nil)
        state.copyPrompt()
    }

    func showExportChooser() {
        guard !state.queue.isEmpty else { return }
        let panel = exportPanel ?? makeExportPanel()
        panel.contentViewController = NSHostingController(rootView: ExportPromptView(
            state: state,
            copy: { [weak self] in self?.copyPrompt() },
            deliver: { [weak self] target in self?.export(to: target) },
            cancel: { [weak self] in self?.exportPanel?.orderOut(nil) }
        ))
        panel.center()
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func makeExportPanel() -> NSPanel {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 390, height: 170),
            styleMask: [.titled, .closable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.title = "Export Dogear Prompt"
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        exportPanel = panel
        return panel
    }

    func showWindow() {
        configureQueueWindow()
        NSApp.activate(ignoringOtherApps: true)
        if let queueWindow {
            queueWindow.makeKeyAndOrderFront(nil)
        } else {
            // SwiftUI may finish creating its WindowGroup one run-loop later.
            DispatchQueue.main.async { [weak self] in
                self?.configureQueueWindow()
                self?.queueWindow?.makeKeyAndOrderFront(nil)
            }
        }
    }

    private func configureQueueWindow() {
        guard queueWindow == nil else { return }
        guard let window = NSApp.windows.first(where: {
            $0 !== composerPanel && $0.title == "Dogear"
        }) ?? NSApp.windows.first(where: {
            $0 !== composerPanel && $0.canBecomeKey && !($0 is NSPanel)
        }) else { return }
        window.isReleasedWhenClosed = false
        queueWindow = window
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showWindow() }
        return true
    }

    func requestAccessibility() {
        if ensureAccessibility() { state.status = "Accessibility is enabled" }
        showWindow()
    }

    private func ensureAccessibility() -> Bool {
        if AXIsProcessTrusted() {
            state.showAccessibilityNotice = false
            return true
        }
        let shouldPrompt = !state.showAccessibilityNotice
        state.showAccessibilityNotice = true
        showWindow()
        // The system prompt is asynchronous. Keep the actionable in-app notice
        // visible and avoid prompting again while it is already being handled.
        if shouldPrompt {
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
        }
        return false
    }

    func openAccessibilitySettings() {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
    }

    func requestScreenRecording() {
        if ensureScreenRecording() { state.status = "Screen Recording is enabled" }
        showWindow()
    }

    private func ensureScreenRecording() -> Bool {
        if CGPreflightScreenCaptureAccess() {
            state.showScreenRecordingNotice = false
            return true
        }
        let shouldPrompt = !state.showScreenRecordingNotice
        state.showScreenRecordingNotice = true
        showWindow()
        if shouldPrompt { _ = CGRequestScreenCaptureAccess() }
        return false
    }

    func openScreenRecordingSettings() {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
    }

    func refreshScreenRecording() {
        guard state.showScreenRecordingNotice, !restarting else { return }
        if CGPreflightScreenCaptureAccess() {
            state.showScreenRecordingNotice = false
            state.screenRecordingRecoveryError = nil
            state.status = "Screen Recording enabled — region capture is ready."
        }
    }

    func repairScreenRecording() {
        guard screenPermissionRepair == nil else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/tccutil")
        process.arguments = ["reset", "ScreenCapture", "com.ylsung.dogear.desktop"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { [weak self] process in
            let succeeded = process.terminationStatus == 0
            guard let self else { return }
            Task { @MainActor in
                self.screenPermissionRepair = nil
                if succeeded {
                    self.state.screenRecordingRecoveryError = nil
                    self.state.status = "Screen Recording setup reset. Turn on Dogear in System Settings."
                    _ = CGRequestScreenCaptureAccess()
                    self.openScreenRecordingSettings()
                } else {
                    self.state.screenRecordingRecoveryError = "macOS could not reset Dogear’s Screen Recording access. Turn Dogear off and back on in Settings, then restart Dogear."
                }
            }
        }
        screenPermissionRepair = process
        do { try process.run() }
        catch {
            screenPermissionRepair = nil
            state.screenRecordingRecoveryError = "Could not start access setup: \(error.localizedDescription)"
        }
    }

    func refreshAccessibility() {
        guard state.showAccessibilityNotice, !restarting else { return }
        if AXIsProcessTrusted() {
            state.showAccessibilityNotice = false
            state.accessibilityRecoveryError = nil
            state.status = "Accessibility enabled — return to your source and press ⌃⌥Q."
            updateHotKeyRouting()
            return
        }
    }

    func repairAccessibility() {
        guard permissionRepair == nil else { return }
        // Reset only Dogear, never the permissions of other applications.
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/tccutil")
        process.arguments = ["reset", "Accessibility", "com.ylsung.dogear.desktop"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { [weak self] process in
            let succeeded = process.terminationStatus == 0
            guard let self else { return }
            Task { @MainActor in
                self.permissionRepair = nil
                if succeeded {
                    self.state.accessibilityRecoveryError = nil
                    self.state.status = "Access setup reset. Turn on Dogear in System Settings."
                    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
                    _ = AXIsProcessTrustedWithOptions(options)
                    self.openAccessibilitySettings()
                } else {
                    self.state.accessibilityRecoveryError = "macOS could not reset Dogear access. Open Settings, turn Dogear off and back on, then restart Dogear."
                }
            }
        }
        permissionRepair = process
        do {
            try process.run()
        } catch {
            permissionRepair = nil
            state.accessibilityRecoveryError = "Could not start access setup: \(error.localizedDescription)"
        }
    }

    func restart() {
        guard !restarting else { return }
        do {
            try state.saveBeforeRestart()
            let helper = Process()
            helper.executableURL = URL(fileURLWithPath: "/bin/sh")
            // Pass paths as separate arguments; never interpolate into shell code.
            helper.arguments = ["-c", "for attempt in $(seq 1 100); do if ! kill -0 \"$1\" 2>/dev/null; then exec /usr/bin/open -n \"$2\"; fi; sleep 0.1; done; exit 1",
                                "dogear-restart", String(ProcessInfo.processInfo.processIdentifier), Bundle.main.bundleURL.path]
            helper.standardOutput = FileHandle.nullDevice
            helper.standardError = FileHandle.nullDevice
            try helper.run()
            restarting = true
            hotkeys.setEnabled(false)
            NSApp.terminate(nil)
        } catch {
            state.accessibilityRecoveryError = "Could not restart: \(error.localizedDescription)"
        }
    }

    func updateHotKeyRouting() {
        let app = NSWorkspace.shared.frontmostApplication
        let owner = CaptureRouter.owner(
            applicationName: app?.localizedName ?? "",
            bundleIdentifier: app?.bundleIdentifier,
            preferChromeExtension: state.preferChromeExtension,
            preferVSCodeExtension: state.preferVSCodeExtension
        )
        hotkeys.setEnabled(owner == .desktop)
    }

    private func rememberTerminal(_ source: Source) {
        if source.surface == .terminal { lastTerminalBundleIdentifier = source.bundleIdentifier }
    }
}

private struct ExportPromptView: View {
    @ObservedObject var state: AppState
    let copy: () -> Void
    let deliver: (DeliveryTarget) -> Void
    let cancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Export prompt").font(.headline)
                Text("Choose where to send \(state.queue.count) queued \(state.queue.count == 1 ? "question" : "questions").")
                    .font(.callout).foregroundStyle(.secondary)
            }
            HStack {
                Button("Copy", action: copy)
                Spacer()
                Button("Claude") { deliver(.claude) }.buttonStyle(.borderedProminent)
                Button("Codex") { deliver(.codex) }.buttonStyle(.borderedProminent)
                Button("Terminal") { deliver(.terminal) }.buttonStyle(.borderedProminent)
            }
            HStack {
                Spacer()
                Button("Cancel", action: cancel).keyboardShortcut(.cancelAction)
            }
        }
        .padding(20)
        .frame(width: 390)
    }
}
