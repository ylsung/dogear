import Foundation

/// The global actions that have a hotkey. The same three keys are the defaults
/// in the Chrome and VS Code extensions, so muscle memory carries across.
public enum HotKeyAction: String, CaseIterable, Codable, Sendable {
    case ask
    case export
    case clear

    public var title: String {
        switch self {
        case .ask: return "Ask about selection or region"
        case .export: return "Export prompt"
        case .clear: return "Clear queue"
        }
    }
}

/// A key plus modifiers, stored with Carbon's virtual key code and modifier
/// bits (what RegisterEventHotKey takes). Defined here without importing
/// Carbon so the model stays testable.
public struct KeyCombo: Codable, Equatable, Hashable, Sendable {
    public static let command: UInt32 = 1 << 8
    public static let shift: UInt32 = 1 << 9
    public static let option: UInt32 = 1 << 11
    public static let control: UInt32 = 1 << 12

    public var keyCode: UInt32
    public var modifiers: UInt32

    public init(keyCode: UInt32, modifiers: UInt32) {
        self.keyCode = keyCode
        self.modifiers = modifiers
    }

    /// A global hotkey needs ⌘, ⌃, or ⌥; Shift alone would swallow typing.
    public var isValidGlobalShortcut: Bool {
        modifiers & (Self.command | Self.control | Self.option) != 0 && KeyCombo.keyNames[keyCode] != nil
    }

    /// Display in macOS menu order: ⌃⌥⇧⌘ then the key.
    public var displayString: String {
        var text = ""
        if modifiers & Self.control != 0 { text += "⌃" }
        if modifiers & Self.option != 0 { text += "⌥" }
        if modifiers & Self.shift != 0 { text += "⇧" }
        if modifiers & Self.command != 0 { text += "⌘" }
        return text + (KeyCombo.keyNames[keyCode] ?? "?")
    }

    // Carbon kVK_ANSI_* codes (US layout positions) for the keys a shortcut
    // may use.
    static let keyNames: [UInt32: String] = [
        0x00: "A", 0x0B: "B", 0x08: "C", 0x02: "D", 0x0E: "E", 0x03: "F", 0x05: "G",
        0x04: "H", 0x22: "I", 0x26: "J", 0x28: "K", 0x25: "L", 0x2E: "M", 0x2D: "N",
        0x1F: "O", 0x23: "P", 0x0C: "Q", 0x0F: "R", 0x01: "S", 0x11: "T", 0x20: "U",
        0x09: "V", 0x0D: "W", 0x07: "X", 0x10: "Y", 0x06: "Z",
        0x1D: "0", 0x12: "1", 0x13: "2", 0x14: "3", 0x15: "4", 0x17: "5", 0x16: "6",
        0x1A: "7", 0x1C: "8", 0x19: "9",
        0x2B: ",", 0x2F: ".", 0x2C: "/", 0x29: ";", 0x27: "'", 0x21: "[", 0x1E: "]",
        0x2A: "\\", 0x18: "=", 0x1B: "-", 0x32: "`", 0x31: "Space",
    ]
}

/// The user's bindings, persisted as JSON in UserDefaults.
public struct ShortcutSettings: Codable, Equatable, Sendable {
    public static let defaults: [HotKeyAction: KeyCombo] = [
        .ask: KeyCombo(keyCode: 0x0E, modifiers: KeyCombo.command | KeyCombo.shift), // ⌘⇧E
        .export: KeyCombo(keyCode: 0x07, modifiers: KeyCombo.command | KeyCombo.shift), // ⌘⇧X
        .clear: KeyCombo(keyCode: 0x1D, modifiers: KeyCombo.command | KeyCombo.shift), // ⌘⇧0
    ]

    public var bindings: [HotKeyAction: KeyCombo]

    public init(bindings: [HotKeyAction: KeyCombo] = ShortcutSettings.defaults) {
        self.bindings = bindings
    }

    public func combo(for action: HotKeyAction) -> KeyCombo? {
        bindings[action]
    }

    /// Assigns `combo` to `action`, unbinding any other action that had it.
    public mutating func set(_ combo: KeyCombo?, for action: HotKeyAction) {
        if let combo {
            for (other, existing) in bindings where other != action && existing == combo {
                bindings[other] = nil
            }
        }
        bindings[action] = combo
    }

    public static func load(from data: Data?) -> ShortcutSettings {
        guard let data, let decoded = try? JSONDecoder().decode(ShortcutSettings.self, from: data) else {
            return ShortcutSettings()
        }
        return decoded
    }

    public func encoded() -> Data? {
        try? JSONEncoder().encode(self)
    }
}

/// Clear keeps the removed questions for a while instead of asking for
/// confirmation, so the clear hotkey is one keystroke and still safe.
public enum ClearUndo {
    /// How long a cleared queue can be restored.
    public static let window: TimeInterval = 5 * 60

    /// The cleared questions go back ahead of anything captured since.
    public static func restore(_ cleared: [QueueItem], into current: [QueueItem]) -> [QueueItem] {
        let restored = Set(cleared.map(\.id))
        return cleared + current.filter { !restored.contains($0.id) }
    }
}

/// The export chooser's destinations, in button order; the number key is the
/// position (1-based), matching the Chrome and VS Code export popups.
public enum ExportDestination: String, CaseIterable, Sendable {
    case copy
    case claude
    case codex
    case terminal

    public var title: String {
        switch self {
        case .copy: return "Copy"
        case .claude: return "Claude"
        case .codex: return "Codex"
        case .terminal: return "Terminal"
        }
    }

    public var number: Int { Self.allCases.firstIndex(of: self)! + 1 }

    public var deliveryTarget: DeliveryTarget? { DeliveryTarget(rawValue: rawValue) }
}
