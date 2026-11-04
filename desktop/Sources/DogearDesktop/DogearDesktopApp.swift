import AppKit
import ApplicationServices
import Combine
import DogearCore
import SwiftUI

@main
struct DogearDesktopApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    init() {
        if CommandLine.arguments.contains(AppDelegate.screenRecordingRequestFlag) {
            // macOS adds Dogear to the Settings list only for a request from a
            // running app, so check in as one (hidden, without a Dock icon) first.
            NSApplication.shared.setActivationPolicy(.accessory)
            NSApplication.shared.finishLaunching()
            _ = CGRequestScreenCaptureAccess()
            RunLoop.main.run(until: Date(timeIntervalSinceNow: 1.5))
            exit(0)
        }
        DogearTypography.registerBundledFonts()
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
                clearQueue: delegate.clearQueue,
                undoClear: delegate.undoClear,
                openSettings: delegate.openSettings,
                sendFeedback: delegate.sendFeedback,
                routingChanged: delegate.updateHotKeyRouting,
                openAccessibilitySettings: delegate.openAccessibilitySettings,
                refreshAccessibility: delegate.refreshAccessibility,
                repairAccessibility: delegate.repairAccessibility,
                openScreenRecordingSettings: delegate.openScreenRecordingSettings,
                refreshScreenRecording: delegate.refreshScreenRecording,
                repairScreenRecording: delegate.repairScreenRecording,
                restart: delegate.restart
            )
            .environment(\.font, DogearTypography.body)
        }
        .defaultSize(width: 430, height: 680)
        .commands {
            CommandGroup(replacing: .appSettings) {
                Button("Settings…", action: delegate.openSettings).keyboardShortcut(",")
            }
            CommandGroup(replacing: .help) {
                Button("Send feedback…", action: delegate.sendFeedback)
            }
        }

        MenuBarExtra {
            MenuBarContent(state: delegate.state, delegate: delegate)
        } label: {
            if let icon = BrandImages.menuBar {
                Image(nsImage: icon).accessibilityLabel("Dogear")
            } else {
                Label("Dogear", systemImage: "bookmark.square")
            }
        }
    }
}

/// Menu bar items; a view of its own so the shortcut labels follow Settings.
private struct MenuBarContent: View {
    @ObservedObject var state: AppState
    let delegate: AppDelegate

    private func label(_ title: String, _ action: HotKeyAction) -> String {
        state.shortcuts.combo(for: action).map { "\(title)  \($0.displayString)" } ?? title
    }

    var body: some View {
        Button(label("Capture selection or region", .ask), action: delegate.captureSelection)
        Button("Capture screen region", action: delegate.captureRegion)
        Menu(label("Export prompt", .export)) {
            Button("Choose destination…", action: delegate.showExportChooser)
            Divider()
            Button("Copy prompt", action: delegate.copyPrompt)
            Button("Send to Claude") { delegate.export(to: .claude) }
            Button("Send to Codex") { delegate.export(to: .codex) }
            Button("Send to Terminal") { delegate.export(to: .terminal) }
        }
        Button(label("Clear queue", .clear), action: delegate.clearQueue)
        if state.clearUndoOffered {
            Button("Undo clear", action: delegate.undoClear)
        }
        Divider()
        Button("Enable Accessibility…", action: delegate.requestAccessibility)
        Button("Enable Screen Recording…", action: delegate.requestScreenRecording)
        Button("Show queue", action: delegate.showWindow)
        Button("Settings…", action: delegate.openSettings)
        Button("Send feedback…", action: delegate.sendFeedback)
        Button("Quit Dogear") { NSApp.terminate(nil) }
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
    private var waitingForPermissionAlert = false
    private var screenRecordingRequestedHere = false
    private var screenRecordingHelperRunning = false
    private var restarting = false
    private var composerPanel: NSPanel?
    private var exportPanel: NSPanel?
    private weak var composerReturnApplication: NSRunningApplication?
    private var queueWindow: NSWindow?
    private var restoreQueueAfterComposer = false
    private var settingsWindow: NSWindow?
    private let toast = ToastPresenter()
    private var recordingShortcut = false
    private var subscriptions: Set<AnyCancellable> = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        hotkeys.handlers = [
            .ask: captureSelection,
            .export: showExportChooser,
            .clear: clearQueue,
        ]
        hotkeys.shortcuts = state.shortcuts
        state.appearance.apply()
        state.$shortcuts.dropFirst().sink { [weak self] shortcuts in
            self?.hotkeys.shortcuts = shortcuts
            // @Published fires before the value is stored; route on the next turn.
            DispatchQueue.main.async { self?.updateHotKeyRouting() }
        }.store(in: &subscriptions)
        state.$preferChromeExtension.combineLatest(state.$preferVSCodeExtension).dropFirst().sink { [weak self] _ in
            DispatchQueue.main.async { self?.updateHotKeyRouting() }
        }.store(in: &subscriptions)
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
        if let destination = ExportDestination(rawValue: target.rawValue) { state.lastExportDestination = destination }
        deliver(target)
    }

    func copyPrompt() {
        guard !state.queue.isEmpty else { return }
        exportPanel?.orderOut(nil)
        state.lastExportDestination = .copy
        state.copyPrompt()
    }

    func export(_ destination: ExportDestination) {
        if let target = destination.deliveryTarget { export(to: target) }
        else { copyPrompt() }
    }

    /// The export hotkey. Pressing it again while the chooser is up sends to
    /// the last-used destination, so the common case is two keystrokes.
    func showExportChooser() {
        guard !state.queue.isEmpty else {
            toast.show("Dogear: the queue is empty.")
            return
        }
        if let exportPanel, exportPanel.isVisible {
            export(state.lastExportDestination)
            return
        }
        let panel = exportPanel ?? makeExportPanel()
        panel.contentViewController = NSHostingController(rootView: ExportPromptView(
            state: state,
            choose: { [weak self] destination in self?.export(destination) },
            cancel: { [weak self] in self?.exportPanel?.orderOut(nil) }
        ))
        panel.center()
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// The clear hotkey: no confirmation, an Undo in the toast instead.
    func clearQueue() {
        let cleared = state.clear()
        guard cleared > 0 else {
            toast.show("Dogear: the queue is already empty.")
            return
        }
        toast.show(
            "Dogear: cleared \(cleared) \(cleared == 1 ? "question" : "questions").",
            actionTitle: "Undo",
            action: { [weak self] in self?.undoClear() }
        )
    }

    func undoClear() {
        let restored = state.undoClear()
        toast.show(restored > 0
            ? "Dogear: restored \(restored) \(restored == 1 ? "question" : "questions")."
            : "Dogear: nothing to restore.")
    }

    func openSettings() {
        let window = settingsWindow ?? {
            let window = NSWindow(contentViewController: NSHostingController(rootView: SettingsView(
                state: state,
                recordingChanged: { [weak self] recording in
                    self?.recordingShortcut = recording
                    self?.updateHotKeyRouting()
                }
            )))
            window.title = "Dogear Settings"
            window.styleMask = [.titled, .closable]
            window.isReleasedWhenClosed = false
            settingsWindow = window
            return window
        }()
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Opens the feedback form with its Platform question prefilled.
    func sendFeedback() {
        NSWorkspace.shared.open(URL(string: "https://docs.google.com/forms/d/e/1FAIpQLSdlqToT9hgAQiGizo-yyDEgoAse1_jptcYpOOjzHyVRojQ7tA/viewform?usp=pp_url&entry.28375611=Desktop+(MacOS)")!)
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
        state.conflictingAppCopies = AppIdentity.differentlySignedCopies()
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
        // As for Screen Recording: ask first so Dogear is listed to turn on.
        AppIdentity.registerSelf()
        if !AXIsProcessTrusted() {
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
        }
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
        state.conflictingAppCopies = AppIdentity.differentlySignedCopies()
        state.showScreenRecordingNotice = true
        showWindow()
        if shouldPrompt { requestScreenRecordingListing() }
        return false
    }

    static let screenRecordingRequestFlag = "--request-screen-recording"

    /// Asks macOS for Screen Recording, which also lists Dogear in Settings.
    private func requestScreenRecordingListing(then completion: (() -> Void)? = nil) {
        // While macOS still shows its alert from an earlier request, it ignores
        // new ones, so a reset Dogear would stay unlisted. Ask once it closes.
        if AppIdentity.permissionAlertIsShowing() {
            guard !waitingForPermissionAlert else { return }
            waitingForPermissionAlert = true
            state.status = "Close macOS’s Screen Recording alert to continue."
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                self?.waitingForPermissionAlert = false
                self?.requestScreenRecordingListing(then: completion)
            }
            return
        }
        guard screenRecordingRequestedHere else {
            screenRecordingRequestedHere = true
            _ = CGRequestScreenCaptureAccess()
            completion?()
            return
        }
        launchScreenRecordingHelper(then: completion)
    }

    /// CoreGraphics asks macOS only once per process, so after Set Up Access
    /// Again resets the approval, another request from this process does nothing
    /// and Dogear stays missing from the Settings list. A brief, hidden second
    /// launch of this same copy asks afresh, under its signature. It must be
    /// launched as an app of its own, not as a child process: macOS lists the app
    /// only when the asking process is responsible for itself.
    private func launchScreenRecordingHelper(then completion: (() -> Void)?) {
        guard !screenRecordingHelperRunning else { completion?(); return }
        screenRecordingHelperRunning = true
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.createsNewApplicationInstance = true
        configuration.activates = false
        configuration.addsToRecentItems = false
        configuration.arguments = [Self.screenRecordingRequestFlag]
        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: configuration) { [weak self] _, _ in
            Task { @MainActor in
                // The helper asks as soon as it starts; give macOS a moment to list Dogear.
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                self?.screenRecordingHelperRunning = false
                completion?()
            }
        }
    }

    func openScreenRecordingSettings() {
        // Settings lists only apps that have asked. Ask first so Dogear is always
        // there to turn on, with this copy's signature, and the user never has to
        // add it by path. Once listed, macOS does not prompt again.
        AppIdentity.registerSelf()
        let open = {
            _ = NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
        }
        if CGPreflightScreenCaptureAccess() { open() } else { requestScreenRecordingListing(then: open) }
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
        AppIdentity.registerSelf()
        state.conflictingAppCopies = AppIdentity.differentlySignedCopies()
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
            state.status = "Accessibility enabled — return to your source and press ⌘⇧E."
            updateHotKeyRouting()
            return
        }
    }

    func repairAccessibility() {
        guard permissionRepair == nil else { return }
        AppIdentity.registerSelf()
        state.conflictingAppCopies = AppIdentity.differentlySignedCopies()
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
        state.unavailableShortcuts = hotkeys.setEnabled(owner == .desktop && !recordingShortcut)
    }

    private func rememberTerminal(_ source: Source) {
        if source.surface == .terminal { lastTerminalBundleIdentifier = source.bundleIdentifier }
    }
}

private struct ExportPromptView: View {
    @ObservedObject var state: AppState
    let choose: (ExportDestination) -> Void
    let cancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Export prompt").font(DogearTypography.headline)
                Text("Choose where to send \(state.queue.count) queued \(state.queue.count == 1 ? "question" : "questions").")
                    .font(DogearTypography.callout).foregroundStyle(DogearTheme.textMuted)
            }
            HStack {
                ForEach(ExportDestination.allCases, id: \.self) { destination in
                    destinationButton(destination)
                }
            }
            HStack {
                Text("1–\(ExportDestination.allCases.count) or click · Enter: \(state.lastExportDestination.title) (last used)")
                    .font(DogearTypography.caption).foregroundStyle(DogearTheme.textMuted)
                Spacer()
                Button("Cancel", action: cancel).keyboardShortcut(.cancelAction)
                // Enter repeats the last-used destination; a button carries
                // only one shortcut, so this one is invisible.
                Button("") { choose(state.lastExportDestination) }
                    .keyboardShortcut(.defaultAction)
                    .opacity(0)
                    .frame(width: 0, height: 0)
                    .accessibilityHidden(true)
            }
        }
        .padding(20)
        .frame(width: 420)
        .font(DogearTypography.body)
        .background(DogearTheme.panel)
        .tint(DogearTheme.primary)
    }

    @ViewBuilder
    private func destinationButton(_ destination: ExportDestination) -> some View {
        let button = Button { choose(destination) } label: {
            HStack(spacing: 5) {
                Text("\(destination.number)")
                    .font(DogearTypography.caption2.monospacedDigit())
                    .padding(.horizontal, 4)
                    .background(RoundedRectangle(cornerRadius: 3).fill(Color.white.opacity(0.22)))
                Text(destination.title)
            }
        }
        .keyboardShortcut(KeyEquivalent(Character("\(destination.number)")), modifiers: [])
        if destination == state.lastExportDestination {
            button.buttonStyle(.borderedProminent)
        } else {
            button.buttonStyle(.bordered)
        }
    }
}
