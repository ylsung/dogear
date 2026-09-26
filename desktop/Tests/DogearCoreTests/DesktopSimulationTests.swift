import DogearCore
import XCTest

final class DesktopSimulationTests: XCTestCase {
    func testInlineImageMarkersControlDeliveryOrder() {
        let first = ImageAsset(path: "/tmp/a.png", label: "a.png")
        let second = ImageAsset(path: "/tmp/b.png", label: "b.png")
        XCTAssertEqual(
            InlineImageComposer.parts(text: "Top [image b], bottom [image a]", images: [first, second]),
            [.text("Top "), .image(second), .text(", bottom "), .image(first)]
        )
    }

    func testRecognizesRequestedDesktopSurfaces() {
        XCTAssertEqual(Source(applicationName: "Claude", windowTitle: "Chat").surface, .claude)
        XCTAssertEqual(Source(applicationName: "Codex", windowTitle: "dogear").surface, .codex)
        XCTAssertEqual(Source(applicationName: "iTerm2", windowTitle: "claude").surface, .terminal)
        XCTAssertEqual(Source(applicationName: "Preview", windowTitle: "paper.pdf").surface, .pdf)
        XCTAssertEqual(Source(applicationName: "Marked", windowTitle: "README.md").surface, .markdown)
        XCTAssertEqual(Source(applicationName: "Safari", windowTitle: "localhost:5173").surface, .html)
        XCTAssertEqual(Source(applicationName: "Simulator", windowTitle: "iPhone 17").surface, .simulator)
    }

    func testSimulationKeepsImageInlineAndDoesNotSend() {
        let image = ImageAsset(path: "/tmp/mockup.png", label: "mockup.png")
        let item = QueueItem(
            source: Source(applicationName: "Simulator", windowTitle: "iPhone 17"),
            selectedContext: [.image(image)],
            message: [.text("Reduce the card padding.")]
        )
        let plan = PromptComposer.plan(for: [item], target: .terminal, preferredBundleIdentifier: "com.apple.Terminal")
        let events = DeliverySimulator().run(plan)
        let imageIndex = events.firstIndex(of: .pasteImage(image))
        let requestIndex = events.firstIndex { event in
            if case .pasteText(let text) = event { return text.contains("Reduce the card padding") }
            return false
        }
        XCTAssertNotNil(imageIndex)
        XCTAssertNotNil(requestIndex)
        XCTAssertLessThan(imageIndex!, requestIndex!)
        XCTAssertFalse(events.contains { event in
            if case .pasteText(let text) = event { return text.contains("\u{0D}") }
            return false
        })
    }

    func testPromptUsesStructuredQuestionsAndEscapesXML() {
        let items = [
            QueueItem(source: Source(applicationName: "Preview", windowTitle: "paper.pdf", page: 12), selectedContext: [.text("Ablation < baseline")], message: [.text("Why & how?")]),
            QueueItem(source: Source(applicationName: "Claude", windowTitle: "Earlier chat"), selectedContext: [.text("Use SQLite")], message: [.text("Reconsider this.")]),
        ]
        let prompt = PromptComposer.text(for: items)
        XCTAssertTrue(prompt.contains("<question id=\"Q1\">\n<source>\nPDF: paper.pdf — Preview, p.12\n</source>"))
        XCTAssertTrue(prompt.contains("<question id=\"Q2\">\n<source>\nClaude: Earlier chat — Claude\n</source>"))
        XCTAssertTrue(prompt.contains("Ablation &lt; baseline"))
        XCTAssertTrue(prompt.contains("Why &amp; how?"))
        XCTAssertFalse(prompt.contains("I collected"))
    }

    func testPromptUsesImageFileNamesAndKeepsImagesInline() {
        let image = ImageAsset(path: "/private/data/renamed.png", label: "Screenshot \"one\".png")
        let item = QueueItem(
            source: Source(applicationName: "Terminal", windowTitle: "yilin — -bash — 171×46"),
            selectedContext: [.image(image)],
            message: [.text("what is the issue?")]
        )

        let prompt = PromptComposer.text(for: [item])
        XCTAssertTrue(prompt.contains("<img src=\"/private/data/renamed.png\" alt=\"Image #1\">"))

        let plan = PromptComposer.plan(for: [item], target: .terminal)
        let imageIndex = plan.chunks.firstIndex(of: .image(image))!
        guard case .text(let beforeImage) = plan.chunks[imageIndex - 1] else {
            return XCTFail("Expected the img tag before its attachment")
        }
        XCTAssertTrue(beforeImage.hasSuffix("<img src=\"/private/data/renamed.png\" alt=\"Image #1\">\n"))
    }

    func testCaptureRoutingPrefersExtensionsButCanBeOverridden() {
        XCTAssertEqual(CaptureRouter.owner(
            applicationName: "Google Chrome", bundleIdentifier: "com.google.Chrome",
            preferChromeExtension: true, preferVSCodeExtension: true
        ), .chromeExtension)
        XCTAssertEqual(CaptureRouter.owner(
            applicationName: "Visual Studio Code", bundleIdentifier: "com.microsoft.VSCode",
            preferChromeExtension: true, preferVSCodeExtension: true
        ), .vscodeExtension)
        XCTAssertEqual(CaptureRouter.owner(
            applicationName: "Google Chrome", bundleIdentifier: "com.google.Chrome",
            preferChromeExtension: false, preferVSCodeExtension: true
        ), .desktop)
    }
}
