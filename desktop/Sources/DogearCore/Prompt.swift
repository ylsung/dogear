import Foundation

public enum DeliveryTarget: String, CaseIterable, Sendable {
    case claude
    case codex
    case terminal
}

public enum DeliveryChunk: Equatable, Sendable {
    case text(String)
    case image(ImageAsset)
}

public struct DeliveryPlan: Equatable, Sendable {
    public var target: DeliveryTarget
    public var preferredBundleIdentifier: String?
    public var chunks: [DeliveryChunk]

    public init(target: DeliveryTarget, preferredBundleIdentifier: String?, chunks: [DeliveryChunk]) {
        self.target = target
        self.preferredBundleIdentifier = preferredBundleIdentifier
        self.chunks = chunks
    }
}

public enum PromptComposer {
    public static func text(for queue: [QueueItem]) -> String {
        var blocks: [String] = []
        var imageNumber = 0

        for (index, item) in queue.enumerated() {
            var lines = [
                "<question id=\"Q\(index + 1)\">",
                "<source>",
                escapeXML(sourceLabel(item.source)),
                "</source>",
                "",
                "<selected_context>",
            ]
            append(parts: item.selectedContext, to: &lines, imageNumber: &imageNumber)
            lines.append(contentsOf: ["</selected_context>", "", "<request>"])
            append(parts: item.message, to: &lines, imageNumber: &imageNumber)
            lines.append(contentsOf: ["</request>", "</question>"])
            blocks.append(lines.joined(separator: "\n"))
        }

        return blocks.joined(separator: "\n\n")
    }

    public static func plan(
        for queue: [QueueItem],
        target: DeliveryTarget,
        preferredBundleIdentifier: String? = nil
    ) -> DeliveryPlan {
        var chunks: [DeliveryChunk] = []
        var imageNumber = 0

        for (index, item) in queue.enumerated() {
            if index > 0 { chunks.append(.text("\n")) }
            chunks.append(.text(
                "<question id=\"Q\(index + 1)\">\n" +
                "<source>\n\(escapeXML(sourceLabel(item.source)))\n</source>\n\n" +
                "<selected_context>\n"
            ))
            appendInline(parts: item.selectedContext, chunks: &chunks, imageNumber: &imageNumber)
            chunks.append(.text("</selected_context>\n\n<request>\n"))
            appendInline(parts: item.message, chunks: &chunks, imageNumber: &imageNumber)
            chunks.append(.text("</request>\n</question>\n"))
        }

        return DeliveryPlan(target: target, preferredBundleIdentifier: preferredBundleIdentifier, chunks: coalesce(chunks))
    }

    private static func sourceLabel(_ source: Source) -> String {
        var result = "\(source.surface.label): \(source.displayTitle) — \(source.applicationName)"
        if let page = source.page { result += ", p.\(page)" }
        return result
    }

    private static func append(parts: [ContentPart], to lines: inout [String], imageNumber: inout Int) {
        for part in parts {
            switch part {
            case .text(let text):
                lines.append(escapeXML(text))
            case .image(let image):
                imageNumber += 1
                lines.append(imageTag(for: image, number: imageNumber))
            }
        }
    }

    private static func appendInline(parts: [ContentPart], chunks: inout [DeliveryChunk], imageNumber: inout Int) {
        for part in parts {
            switch part {
            case .text(let text):
                let escaped = escapeXML(text)
                chunks.append(.text(escaped + (escaped.hasSuffix("\n") ? "" : "\n")))
            case .image(let image):
                imageNumber += 1
                chunks.append(.text(imageTag(for: image, number: imageNumber) + "\n"))
                // Paste the real PNG as well as its path. Claude and Codex TUIs
                // consume this as an image attachment instead of visible text.
                chunks.append(.image(image))
                // chunks.append(.text("\n"))
            }
        }
    }

    private static func imageTag(for image: ImageAsset, number: Int) -> String {
        "<img src=\"\(escapeXML(image.path, attribute: true))\" alt=\"Image #\(number)\">"
    }

    private static func escapeXML(_ value: String, attribute: Bool = false) -> String {
        var escaped = value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
        if attribute {
            escaped = escaped
                .replacingOccurrences(of: "\"", with: "&quot;")
                .replacingOccurrences(of: "'", with: "&apos;")
        }
        return escaped
    }

    private static func coalesce(_ chunks: [DeliveryChunk]) -> [DeliveryChunk] {
        var result: [DeliveryChunk] = []
        for chunk in chunks {
            if case .text(let text) = chunk, case .text(let previous)? = result.last {
                result[result.count - 1] = .text(previous + text)
            } else {
                result.append(chunk)
            }
        }
        return result
    }

}
