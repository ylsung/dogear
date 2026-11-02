import DogearCore
import XCTest

final class ShortcutTests: XCTestCase {
    func testDefaultsMatchTheExtensions() {
        let settings = ShortcutSettings()
        XCTAssertEqual(settings.combo(for: .ask)?.displayString, "⇧⌘E")
        XCTAssertEqual(settings.combo(for: .export)?.displayString, "⇧⌘X")
        XCTAssertEqual(settings.combo(for: .clear)?.displayString, "⇧⌘0")
    }

    func testGlobalShortcutsNeedACommandControlOrOptionModifier() {
        XCTAssertFalse(KeyCombo(keyCode: 0x0E, modifiers: KeyCombo.shift).isValidGlobalShortcut)
        XCTAssertFalse(KeyCombo(keyCode: 0x0E, modifiers: 0).isValidGlobalShortcut)
        XCTAssertTrue(KeyCombo(keyCode: 0x0E, modifiers: KeyCombo.control | KeyCombo.shift).isValidGlobalShortcut)
        // Unknown key codes (e.g. F-keys we do not name) are rejected.
        XCTAssertFalse(KeyCombo(keyCode: 0x7A, modifiers: KeyCombo.command).isValidGlobalShortcut)
    }

    func testAssigningATakenComboUnbindsTheOtherAction() {
        var settings = ShortcutSettings()
        let askCombo = settings.combo(for: .ask)
        settings.set(askCombo, for: .clear)
        XCTAssertEqual(settings.combo(for: .clear), askCombo)
        XCTAssertNil(settings.combo(for: .ask))
    }

    func testSettingsRoundTripAndFallBackToDefaults() {
        var settings = ShortcutSettings()
        settings.set(KeyCombo(keyCode: 0x0C, modifiers: KeyCombo.control | KeyCombo.option), for: .ask)
        settings.set(nil, for: .clear)
        let decoded = ShortcutSettings.load(from: settings.encoded())
        XCTAssertEqual(decoded, settings)
        XCTAssertEqual(decoded.combo(for: .ask)?.displayString, "⌃⌥Q")
        XCTAssertNil(decoded.combo(for: .clear))
        XCTAssertEqual(ShortcutSettings.load(from: Data("garbage".utf8)), ShortcutSettings())
        XCTAssertEqual(ShortcutSettings.load(from: nil), ShortcutSettings())
    }

    func testUndoClearPutsClearedQuestionsAheadOfNewOnes() {
        let source = Source(applicationName: "Preview", windowTitle: "paper.pdf")
        let a = QueueItem(source: source, selectedContext: [.text("a")], message: [.text("1")])
        let b = QueueItem(source: source, selectedContext: [.text("b")], message: [.text("2")])
        let added = QueueItem(source: source, selectedContext: [.text("c")], message: [.text("3")])
        XCTAssertEqual(ClearUndo.restore([a, b], into: [added]).map(\.id), [a.id, b.id, added.id])
        // A restored question that somehow survived is not duplicated.
        XCTAssertEqual(ClearUndo.restore([a, b], into: [b, added]).map(\.id), [a.id, b.id, added.id])
    }

    func testExportDestinationsAreNumberedInButtonOrder() {
        XCTAssertEqual(ExportDestination.allCases.map(\.number), [1, 2, 3, 4])
        XCTAssertNil(ExportDestination.copy.deliveryTarget)
        XCTAssertEqual(ExportDestination.terminal.deliveryTarget, .terminal)
    }
}
