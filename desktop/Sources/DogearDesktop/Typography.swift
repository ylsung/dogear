import AppKit
import CoreText
import SwiftUI

enum DogearTypography {
    enum Weight {
        case regular, medium, semibold

        var postScriptName: String {
            switch self {
            case .regular: "Commissioner-Regular"
            case .medium: "Commissioner-Medium"
            case .semibold: "Commissioner-SemiBold"
            }
        }
    }

    static let body = font(13)
    static let callout = font(12)
    static let caption = font(11)
    static let caption2 = font(10)
    static let headline = font(13, weight: .semibold)
    static let subheadline = font(12, weight: .semibold)
    static let title = font(23, weight: .semibold)

    static var editorFont: NSFont { nsFont(13) }

    static func font(_ size: CGFloat, weight: Weight = .regular) -> Font {
        Font(nsFont(size, weight: weight))
    }

    // Commissioner covers Latin, Greek, and Cyrillic. Han text cascades to
    // PingFang TC so Traditional Chinese keeps its glyph forms regardless of
    // the user's language order; other scripts use the system cascade.
    static func nsFont(_ size: CGFloat, weight: Weight = .regular) -> NSFont {
        let systemWeight: NSFont.Weight = weight == .semibold ? .semibold : weight == .medium ? .medium : .regular
        guard let base = NSFont(name: weight.postScriptName, size: size) else {
            return .systemFont(ofSize: size, weight: systemWeight)
        }
        let traditionalChinese = NSFontDescriptor(fontAttributes: [
            .family: "PingFang TC",
            .traits: [NSFontDescriptor.TraitKey.weight: systemWeight],
        ])
        let descriptor = base.fontDescriptor.addingAttributes([.cascadeList: [traditionalChinese]])
        return NSFont(descriptor: descriptor, size: size) ?? base
    }

    static func registerBundledFonts() {
        guard let resources = Bundle.main.resourceURL else { return }
        let directory = resources.appendingPathComponent("Fonts", isDirectory: true)
        for file in ["Commissioner-Regular.ttf", "Commissioner-Medium.ttf", "Commissioner-SemiBold.ttf"] {
            CTFontManagerRegisterFontsForURL(
                directory.appendingPathComponent(file) as CFURL,
                .process,
                nil
            )
        }
    }
}
