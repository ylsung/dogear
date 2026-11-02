import Carbon.HIToolbox
import DogearCore

/// System-wide hotkeys. Registered combos are taken from every app, so all of
/// them are released while a preferred extension's app (Chrome, VS Code) is
/// frontmost — the extensions bind the same keys by default.
@MainActor
final class HotKeyMonitor {
    private var registered: [HotKeyAction: EventHotKeyRef] = [:]
    private var eventHandler: EventHandlerRef?
    var handlers: [HotKeyAction: () -> Void] = [:]
    var shortcuts = ShortcutSettings()

    var isEnabled: Bool { !registered.isEmpty }

    /// Returns the actions whose combo macOS refused (already registered by
    /// another app), so Settings can flag them.
    @discardableResult
    func setEnabled(_ enabled: Bool) -> Set<HotKeyAction> {
        installHandler()
        unregisterAll()
        guard enabled else { return [] }
        var unavailable: Set<HotKeyAction> = []
        for (index, action) in HotKeyAction.allCases.enumerated() {
            guard let combo = shortcuts.combo(for: action) else { continue }
            var ref: EventHotKeyRef?
            let identifier = EventHotKeyID(signature: fourCharacterCode("DOGR"), id: UInt32(index + 1))
            let status = RegisterEventHotKey(
                combo.keyCode, combo.modifiers, identifier,
                GetApplicationEventTarget(), 0, &ref
            )
            if status == noErr, let ref { registered[action] = ref }
            else { unavailable.insert(action) }
        }
        return unavailable
    }

    private func installHandler() {
        guard eventHandler == nil else { return }
        var specification = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        let callback: EventHandlerUPP = { _, event, userData in
            guard let event, let userData else { return OSStatus(eventNotHandledErr) }
            var identifier = EventHotKeyID()
            let status = GetEventParameter(
                event,
                EventParamName(kEventParamDirectObject),
                EventParamType(typeEventHotKeyID),
                nil,
                MemoryLayout<EventHotKeyID>.size,
                nil,
                &identifier
            )
            guard status == noErr else { return OSStatus(eventNotHandledErr) }
            let monitor = Unmanaged<HotKeyMonitor>.fromOpaque(userData).takeUnretainedValue()
            let index = Int(identifier.id) - 1
            Task { @MainActor in
                guard HotKeyAction.allCases.indices.contains(index) else { return }
                monitor.handlers[HotKeyAction.allCases[index]]?()
            }
            return noErr
        }
        InstallEventHandler(
            GetApplicationEventTarget(), callback, 1, &specification,
            Unmanaged.passUnretained(self).toOpaque(), &eventHandler
        )
    }

    private func unregisterAll() {
        for ref in registered.values { UnregisterEventHotKey(ref) }
        registered = [:]
    }

    deinit {
        for ref in registered.values { UnregisterEventHotKey(ref) }
        if let eventHandler { RemoveEventHandler(eventHandler) }
    }

    private func fourCharacterCode(_ value: String) -> OSType {
        value.utf8.reduce(0) { ($0 << 8) + OSType($1) }
    }
}
