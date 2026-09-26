import Foundation

public enum SurfaceKind: String, Codable, CaseIterable, Sendable {
    case claude
    case codex
    case terminal
    case pdf
    case markdown
    case html
    case simulator
    case other

    public var label: String {
        switch self {
        case .claude: return "Claude"
        case .codex: return "Codex"
        case .terminal: return "Terminal"
        case .pdf: return "PDF"
        case .markdown: return "Markdown"
        case .html: return "HTML"
        case .simulator: return "Simulator"
        case .other: return "Desktop"
        }
    }
}

public struct Source: Codable, Equatable, Sendable {
    public var applicationName: String
    public var bundleIdentifier: String?
    public var windowTitle: String
    public var surface: SurfaceKind
    public var page: Int?

    public init(
        applicationName: String,
        bundleIdentifier: String? = nil,
        windowTitle: String = "",
        surface: SurfaceKind? = nil,
        page: Int? = nil
    ) {
        self.applicationName = applicationName
        self.bundleIdentifier = bundleIdentifier
        self.windowTitle = windowTitle
        self.surface = surface ?? SurfaceDetector.detect(
            applicationName: applicationName,
            bundleIdentifier: bundleIdentifier,
            windowTitle: windowTitle
        )
        self.page = page
    }

    public var displayTitle: String {
        let title = windowTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? applicationName : title
    }
}

public enum ContentPart: Codable, Equatable, Sendable {
    case text(String)
    case image(ImageAsset)

    private enum CodingKeys: String, CodingKey { case type, text, image }
    private enum Kind: String, Codable { case text, image }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(Kind.self, forKey: .type) {
        case .text: self = .text(try values.decode(String.self, forKey: .text))
        case .image: self = .image(try values.decode(ImageAsset.self, forKey: .image))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .text(let text):
            try values.encode(Kind.text, forKey: .type)
            try values.encode(text, forKey: .text)
        case .image(let image):
            try values.encode(Kind.image, forKey: .type)
            try values.encode(image, forKey: .image)
        }
    }
}

public struct ImageAsset: Codable, Equatable, Hashable, Sendable {
    public var id: UUID
    public var path: String
    public var mediaType: String
    public var label: String

    public init(id: UUID = UUID(), path: String, mediaType: String = "image/png", label: String) {
        self.id = id
        self.path = path
        self.mediaType = mediaType
        self.label = label
    }
}

public struct QueueItem: Codable, Identifiable, Equatable, Sendable {
    public var id: UUID
    public var source: Source
    public var selectedContext: [ContentPart]
    public var message: [ContentPart]
    public var createdAt: Date

    public init(
        id: UUID = UUID(),
        source: Source,
        selectedContext: [ContentPart],
        message: [ContentPart],
        createdAt: Date = Date()
    ) {
        self.id = id
        self.source = source
        self.selectedContext = selectedContext
        self.message = message
        self.createdAt = createdAt
    }

    public var questionText: String {
        var imageIndex = 0
        return message.map { part in
            switch part {
            case .text(let value): return value
            case .image:
                defer { imageIndex += 1 }
                return "[image \(Self.imageName(imageIndex))]"
            }
        }.joined()
    }

    public var images: [ImageAsset] {
        (selectedContext + message).compactMap {
            if case .image(let image) = $0 { return image }
            return nil
        }
    }

    private static func imageName(_ index: Int) -> String {
        String(UnicodeScalar(97 + min(index, 25))!)
    }
}

public enum InlineImageComposer {
    /// Replaces [image a], [image b], ... with actual image parts. Images that
    /// are not referenced are appended with a marker so they are never lost.
    public static func parts(text: String, images: [ImageAsset]) -> [ContentPart] {
        let pattern = #"\[image\s+([a-z])\]"#
        guard let expression = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return [.text(text)] + images.map(ContentPart.image)
        }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        let matches = expression.matches(in: text, range: range)
        var result: [ContentPart] = []
        var used = Set<Int>()
        var cursor = text.startIndex
        for match in matches {
            guard let whole = Range(match.range(at: 0), in: text),
                  let letterRange = Range(match.range(at: 1), in: text),
                  let scalar = text[letterRange].lowercased().unicodeScalars.first else { continue }
            let index = Int(scalar.value) - 97
            guard images.indices.contains(index) else { continue }
            if cursor < whole.lowerBound { result.append(.text(String(text[cursor..<whole.lowerBound]))) }
            result.append(.image(images[index]))
            used.insert(index)
            cursor = whole.upperBound
        }
        if cursor < text.endIndex { result.append(.text(String(text[cursor...]))) }
        for index in images.indices where !used.contains(index) {
            result.append(.image(images[index]))
        }
        return result.isEmpty ? [.text(text)] : result
    }

    public static func imageName(_ index: Int) -> String {
        String(UnicodeScalar(97 + min(index, 25))!)
    }
}

public enum SurfaceDetector {
    public static func detect(
        applicationName: String,
        bundleIdentifier: String?,
        windowTitle: String
    ) -> SurfaceKind {
        let application = [applicationName, bundleIdentifier ?? ""].joined(separator: " ").lowercased()
        let haystack = [application, windowTitle].joined(separator: " ").lowercased()
        if ["terminal", "iterm", "warp", "wezterm", "ghostty", "kitty", "alacritty"].contains(where: application.contains) {
            return .terminal
        }
        if application.contains("simulator") || application.contains("core simulator") { return .simulator }
        if application.contains("claude") || application.contains("anthropic") { return .claude }
        if application.contains("codex") || application.contains("openai") || application.contains("chatgpt") { return .codex }
        if haystack.contains(".pdf") || application.contains("preview") || application.contains("acrobat") { return .pdf }
        if haystack.contains(".md") || haystack.contains("markdown") { return .markdown }
        if haystack.contains(".html") || haystack.contains("localhost") || haystack.contains("safari") || haystack.contains("chrome") || haystack.contains("firefox") {
            return .html
        }
        return .other
    }
}

public enum CaptureOwner: String, Equatable, Sendable {
    case desktop
    case chromeExtension
    case vscodeExtension
}

public enum CaptureRouter {
    public static func owner(
        applicationName: String,
        bundleIdentifier: String?,
        preferChromeExtension: Bool,
        preferVSCodeExtension: Bool
    ) -> CaptureOwner {
        let name = applicationName.lowercased()
        let bundle = bundleIdentifier?.lowercased() ?? ""
        let isChrome = name.contains("chrome") || bundle.contains("chrome") || bundle.contains("chromium")
        if preferChromeExtension && isChrome { return .chromeExtension }

        let isVSCode = name.contains("visual studio code") || name == "code" || name.contains("cursor")
            || bundle.contains("vscode") || bundle.contains("visual-studio-code") || bundle.contains("cursor")
        if preferVSCodeExtension && isVSCode { return .vscodeExtension }
        return .desktop
    }
}
