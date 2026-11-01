import AppKit
import SwiftUI

// Dogear palette "Bilberry Apricot". Mirrors extension/theme.js: the first
// value is `colors` (light), the second is `colorsDark`. Keep them in sync.
// Each NSColor resolves against the current appearance, so light and dark
// mode share one set of roles.
enum DogearTheme {
    static let nsPrimary = dynamic(0x5960b3, 0x5960b3)
    static let nsTextOnPrimary = dynamic(0xf5f5fa, 0xf5f5fa)
    static let nsText = dynamic(0x161827, 0xf5f5fa)
    static let nsTextMuted = dynamic(0x545664, 0xa5a7b0)
    static let nsBg = dynamic(0xf2f2f9, 0x222434)
    static let nsPanel = dynamic(0xf5f5fa, 0x161827)
    static let nsGroupBg = dynamic(0xebecf7, 0x3c3e51)
    static let nsBorder = dynamic(0xd4d5dc, 0x2e303f)
    static let nsDanger = dynamic(0xd4474f, 0xd4474f)

    static let primary = Color(nsColor: nsPrimary)
    static let textOnPrimary = Color(nsColor: nsTextOnPrimary)
    static let text = Color(nsColor: nsText)
    static let textMuted = Color(nsColor: nsTextMuted)
    static let bg = Color(nsColor: nsBg)
    static let panel = Color(nsColor: nsPanel)
    static let groupBg = Color(nsColor: nsGroupBg)
    static let border = Color(nsColor: nsBorder)
    static let danger = Color(nsColor: nsDanger)

    private static func dynamic(_ light: UInt32, _ dark: UInt32) -> NSColor {
        NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            return rgb(isDark ? dark : light)
        }
    }

    private static func rgb(_ hex: UInt32) -> NSColor {
        NSColor(srgbRed: CGFloat(hex >> 16 & 0xff) / 255,
                green: CGFloat(hex >> 8 & 0xff) / 255,
                blue: CGFloat(hex & 0xff) / 255,
                alpha: 1)
    }
}
