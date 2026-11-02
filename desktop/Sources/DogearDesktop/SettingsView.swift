import AppKit
import Carbon.HIToolbox
import DogearCore
import SwiftUI

/// Dogear → Settings (⌘,): global shortcuts, appearance, and which apps'
/// extensions take the shortcuts over. The prompt is Dogear's XML format on
/// desktop, so there is no prompt-language choice here.
struct SettingsView: View {
    @ObservedObject var state: AppState
    let recordingChanged: (Bool) -> Void

    var body: some View {
        Form {
            Section {
                ForEach(HotKeyAction.allCases, id: \.self) { action in
                    LabeledContent(action.title) {
                        HStack(spacing: 8) {
                            if state.unavailableShortcuts.contains(action) {
                                Image(systemName: "exclamationmark.triangle.fill")
                                    .foregroundStyle(DogearTheme.danger)
                                    .help("macOS would not register this shortcut — another app may own it. Pick a different one.")
                            }
                            ShortcutRecorder(
                                combo: state.shortcuts.combo(for: action),
                                set: { state.shortcuts.set($0, for: action) },
                                recordingChanged: recordingChanged
                            )
                            .frame(width: 130, height: 24)
                        }
                    }
                }
                HStack {
                    Spacer()
                    Button("Restore defaults") { state.shortcuts = ShortcutSettings() }
                        .disabled(state.shortcuts == ShortcutSettings())
                }
            } header: {
                Text("Keyboard shortcuts")
            } footer: {
                Text("Click a shortcut, then press the new keys (⌘, ⌃, or ⌥ required). Delete removes it; Esc cancels. The Chrome and VS Code extensions use the same defaults.")
                    .font(DogearTypography.caption).foregroundStyle(DogearTheme.textMuted)
            }

            Section {
                Toggle("Chrome: let the Dogear extension handle shortcuts", isOn: $state.preferChromeExtension)
                Toggle("VS Code / Cursor: let the Dogear extension handle shortcuts", isOn: $state.preferVSCodeExtension)
            } header: {
                Text("Extensions")
            } footer: {
                Text("While that app is in front, the desktop shortcuts pause so the extension receives them.")
                    .font(DogearTypography.caption).foregroundStyle(DogearTheme.textMuted)
            }

            Section("Appearance") {
                Picker("Theme", selection: $state.appearance) {
                    ForEach(AppearanceSetting.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
            }
        }
        .formStyle(.grouped)
        .font(DogearTypography.body)
        .frame(width: 480)
        .fixedSize(horizontal: false, vertical: true)
        .tint(DogearTheme.primary)
    }
}

/// A click-to-record shortcut field. While recording, the app's global hotkeys
/// are suspended (via `recordingChanged`) so pressing the current combo
/// records it instead of triggering it.
struct ShortcutRecorder: NSViewRepresentable {
    let combo: KeyCombo?
    let set: (KeyCombo?) -> Void
    let recordingChanged: (Bool) -> Void

    func makeNSView(context: Context) -> RecorderButton {
        let view = RecorderButton()
        view.onChange = set
        view.onRecordingChanged = recordingChanged
        view.combo = combo
        return view
    }

    func updateNSView(_ view: RecorderButton, context: Context) {
        view.onChange = set
        view.onRecordingChanged = recordingChanged
        view.combo = combo
    }

    final class RecorderButton: NSButton {
        var onChange: ((KeyCombo?) -> Void)?
        var onRecordingChanged: ((Bool) -> Void)?
        var combo: KeyCombo? { didSet { refreshTitle() } }
        private var recording = false { didSet { refreshTitle() } }

        override init(frame: NSRect) {
            super.init(frame: frame)
            bezelStyle = .rounded
            setButtonType(.momentaryPushIn)
            target = self
            action = #selector(toggle)
            refreshTitle()
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

        override var acceptsFirstResponder: Bool { true }

        @objc private func toggle() {
            recording ? stop() : start()
        }

        private func start() {
            recording = true
            window?.makeFirstResponder(self)
            onRecordingChanged?(true)
        }

        private func stop() {
            guard recording else { return }
            recording = false
            onRecordingChanged?(false)
        }

        override func resignFirstResponder() -> Bool {
            stop()
            return super.resignFirstResponder()
        }

        // performKeyEquivalent sees ⌘ combos before the menu bar does.
        override func performKeyEquivalent(with event: NSEvent) -> Bool {
            guard recording else { return super.performKeyEquivalent(with: event) }
            record(event)
            return true
        }

        override func keyDown(with event: NSEvent) {
            guard recording else { return super.keyDown(with: event) }
            record(event)
        }

        private func record(_ event: NSEvent) {
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            if flags.isEmpty, event.keyCode == UInt16(kVK_Escape) {
                stop()
                return
            }
            if flags.isEmpty, event.keyCode == UInt16(kVK_Delete) || event.keyCode == UInt16(kVK_ForwardDelete) {
                onChange?(nil)
                stop()
                return
            }
            var modifiers: UInt32 = 0
            if flags.contains(.command) { modifiers |= KeyCombo.command }
            if flags.contains(.shift) { modifiers |= KeyCombo.shift }
            if flags.contains(.option) { modifiers |= KeyCombo.option }
            if flags.contains(.control) { modifiers |= KeyCombo.control }
            let candidate = KeyCombo(keyCode: UInt32(event.keyCode), modifiers: modifiers)
            guard candidate.isValidGlobalShortcut else {
                NSSound.beep()
                return
            }
            onChange?(candidate)
            stop()
        }

        private func refreshTitle() {
            title = recording ? "Press keys…" : (combo?.displayString ?? "None")
        }
    }
}

/// A small floating notice that does not take focus from the app the user is
/// working in — e.g. "Cleared 6 questions · Undo" after the clear hotkey.
@MainActor
final class ToastPresenter {
    private var panel: NSPanel?
    private var hideWork: DispatchWorkItem?

    func show(_ message: String, actionTitle: String? = nil, action: (() -> Void)? = nil) {
        let panel = self.panel ?? makePanel()
        self.panel = panel
        let host = NSHostingView(rootView: ToastView(
            message: message,
            actionTitle: actionTitle,
            action: action.map { action in { [weak self] in
                self?.hide()
                action()
            } }
        ))
        panel.contentView = host
        let size = host.fittingSize
        if let screen = NSScreen.main {
            let frame = screen.visibleFrame
            panel.setFrame(NSRect(x: frame.midX - size.width / 2, y: frame.maxY - size.height - 24,
                                  width: size.width, height: size.height), display: true)
        }
        panel.orderFrontRegardless()
        hideWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.hide() }
        hideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + (action == nil ? 2.5 : 8), execute: work)
    }

    func hide() {
        hideWork?.cancel()
        panel?.orderOut(nil)
    }

    private func makePanel() -> NSPanel {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 300, height: 44),
            styleMask: [.nonactivatingPanel, .borderless],
            backing: .buffered,
            defer: false
        )
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        return panel
    }
}

private struct ToastView: View {
    let message: String
    let actionTitle: String?
    let action: (() -> Void)?

    var body: some View {
        HStack(spacing: 12) {
            Text(message).foregroundStyle(Color.white)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(.bordered)
                    .tint(.white)
            }
        }
        .font(DogearTypography.callout)
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(RoundedRectangle(cornerRadius: 9).fill(Color(red: 0x2b / 255, green: 0x2e / 255, blue: 0x5c / 255)))
        .fixedSize()
    }
}
