import Carbon.HIToolbox

@MainActor
final class HotKeyMonitor {
    private var captureHotKey: EventHotKeyRef?
    private var exportHotKey: EventHotKeyRef?
    private var eventHandler: EventHandlerRef?
    var capture: (() -> Void)?
    var export: (() -> Void)?

    var isEnabled: Bool { captureHotKey != nil }

    func setEnabled(_ enabled: Bool) {
        registerExportAndHandler()
        if enabled { registerCapture() }
        else { unregisterCapture() }
    }

    private func registerExportAndHandler() {
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
            Task { @MainActor in
                switch identifier.id {
                case 1: monitor.capture?()
                case 2: monitor.export?()
                default: break
                }
            }
            return noErr
        }
        InstallEventHandler(
            GetApplicationEventTarget(), callback, 1, &specification,
            Unmanaged.passUnretained(self).toOpaque(), &eventHandler
        )
        let exportIdentifier = EventHotKeyID(signature: fourCharacterCode("DOGR"), id: 2)
        let exportStatus = RegisterEventHotKey(
            UInt32(kVK_ANSI_E), UInt32(controlKey | optionKey), exportIdentifier,
            GetApplicationEventTarget(), 0, &exportHotKey
        )
        if exportStatus != noErr { unregister() }
    }

    private func registerCapture() {
        guard captureHotKey == nil, eventHandler != nil else { return }
        let identifier = EventHotKeyID(signature: fourCharacterCode("DOGR"), id: 1)
        let status = RegisterEventHotKey(
            UInt32(kVK_ANSI_Q), UInt32(controlKey | optionKey), identifier,
            GetApplicationEventTarget(), 0, &captureHotKey
        )
        if status != noErr { unregisterCapture() }
    }

    private func unregisterCapture() {
        if let captureHotKey { UnregisterEventHotKey(captureHotKey) }
        captureHotKey = nil
    }

    private func unregister() {
        if let captureHotKey { UnregisterEventHotKey(captureHotKey) }
        if let exportHotKey { UnregisterEventHotKey(exportHotKey) }
        if let eventHandler { RemoveEventHandler(eventHandler) }
        captureHotKey = nil
        exportHotKey = nil
        eventHandler = nil
    }

    deinit {
        if let captureHotKey { UnregisterEventHotKey(captureHotKey) }
        if let exportHotKey { UnregisterEventHotKey(exportHotKey) }
        if let eventHandler { RemoveEventHandler(eventHandler) }
    }

    private func fourCharacterCode(_ value: String) -> OSType {
        value.utf8.reduce(0) { ($0 << 8) + OSType($1) }
    }
}
