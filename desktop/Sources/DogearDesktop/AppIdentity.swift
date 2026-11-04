import AppKit
import Security

enum AppIdentity {
    /// Other copies of Dogear that Launch Services knows about whose signature
    /// this process does not satisfy. macOS keeps one Screen Recording and
    /// Accessibility approval per bundle ID, and System Settings records the
    /// signature of whichever copy it resolves; when that is one of these, the
    /// switch shows Dogear as on while this copy stays denied.
    static func differentlySignedCopies() -> [URL] {
        guard let bundleID = Bundle.main.bundleIdentifier else { return [] }
        var selfCode: SecCode?
        guard SecCodeCopySelf([], &selfCode) == errSecSuccess, let selfCode else { return [] }
        let ownPath = Bundle.main.bundleURL.resolvingSymlinksInPath().standardizedFileURL.path
        return NSWorkspace.shared.urlsForApplications(withBundleIdentifier: bundleID).filter { url in
            let path = url.resolvingSymlinksInPath().standardizedFileURL.path
            guard path != ownPath, FileManager.default.fileExists(atPath: path) else { return false }
            var staticCode: SecStaticCode?
            var requirement: SecRequirement?
            guard SecStaticCodeCreateWithPath(url as CFURL, [], &staticCode) == errSecSuccess, let staticCode,
                  SecCodeCopyDesignatedRequirement(staticCode, [], &requirement) == errSecSuccess, let requirement
            else { return true }
            return SecCodeCheckValidity(selfCode, [], requirement) != errSecSuccess
        }
    }

    /// Whether macOS's own privacy alert ("… would like to record this
    /// computer's screen") is on screen. Window owners need no permission to read.
    static func permissionAlertIsShowing() -> Bool {
        let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
        return windows.contains { ($0[kCGWindowOwnerName as String] as? String) == "universalAccessAuthWarn" }
    }

    /// Makes this copy the one Launch Services knows about, so the next approval
    /// in System Settings records its signature.
    static func registerSelf() {
        LSRegisterURL(Bundle.main.bundleURL as CFURL, true)
    }
}
