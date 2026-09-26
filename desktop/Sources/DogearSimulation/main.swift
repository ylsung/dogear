import DogearCore
import Foundation

let screenshot = ImageAsset(path: "/simulation/mobile.png", label: "mobile.png")
let detail = ImageAsset(path: "/simulation/detail.png", label: "detail.png")
let inline = InlineImageComposer.parts(
    text: "Make this [image a] match the footer in [image b].",
    images: [screenshot, detail]
)
precondition(inline == [.text("Make this "), .image(screenshot), .text(" match the footer in "), .image(detail), .text(".")])
precondition(InlineImageComposer.parts(text: "Use this", images: [screenshot]) == [.text("Use this"), .image(screenshot)])
let captures = [
    QueueItem(source: Source(applicationName: "Claude", windowTitle: "Refactor chat"), selectedContext: [.text("The cache is global.")], message: [.text("Should this be per project?")]),
    QueueItem(source: Source(applicationName: "Codex", windowTitle: "dogear"), selectedContext: [.text("Implementation complete.")], message: [.text("Explain this change.")]),
    QueueItem(source: Source(applicationName: "Terminal", bundleIdentifier: "com.apple.Terminal", windowTitle: "codex — dogear"), selectedContext: [.text("FAIL ui.test.ts")], message: [.text("Fix this failure.")]),
    QueueItem(source: Source(applicationName: "Preview", windowTitle: "design.pdf", page: 7), selectedContext: [.text("Interaction model")], message: [.text("Explain this section.")]),
    QueueItem(source: Source(applicationName: "Marked", windowTitle: "README.md"), selectedContext: [.text("Old copy")], message: [.text("Revise this Markdown.")]),
    QueueItem(source: Source(applicationName: "Safari", windowTitle: "localhost:3000/index.html"), selectedContext: [.text("Save changes")], message: [.text("Revise this HTML state.")]),
    QueueItem(source: Source(applicationName: "Simulator", windowTitle: "iPhone 17 Pro"), selectedContext: [.image(screenshot)], message: [.text("Match this mobile layout.")]),
]
let plan = PromptComposer.plan(for: captures, target: .codex)
let events = DeliverySimulator().run(plan)

precondition(captures.map(\.source.surface) == [.claude, .codex, .terminal, .pdf, .markdown, .html, .simulator])
precondition(events.contains(.activate(.codex, nil)))
precondition(events.contains(.pasteImage(screenshot)))
precondition(DeliverySimulator().run(PromptComposer.plan(for: captures, target: .claude)).first == .activate(.claude, nil))
precondition(DeliverySimulator().run(PromptComposer.plan(for: captures, target: .terminal)).first == .activate(.terminal, nil))
let imageIndex = events.firstIndex(of: .pasteImage(screenshot))!
guard case .pasteText(let beforeImage) = events[imageIndex - 1], beforeImage.contains("<img src=\"/simulation/mobile.png\" alt=\"Image #1\">") else {
    preconditionFailure("Image tag was not immediately before the inline image")
}
guard case .pasteText(let afterImage) = events[imageIndex + 1], afterImage.contains("Match this mobile layout") else {
    preconditionFailure("Image was not kept inline before its request")
}
let prompt = PromptComposer.text(for: captures)
precondition(prompt.contains("<question id=\"Q4\">\n<source>\nPDF: design.pdf — Preview, p.7\n</source>"))
precondition(prompt.contains("<question id=\"Q5\">\n<source>\nMarkdown: README.md — Marked\n</source>"))

let persistenceURL = FileManager.default.temporaryDirectory.appendingPathComponent("dogear-simulation-\(UUID().uuidString)/queue.json")
try QueuePersistence.save(captures, to: persistenceURL)
precondition(QueuePersistence.load(from: persistenceURL) == captures)
try? FileManager.default.removeItem(at: persistenceURL.deletingLastPathComponent())

precondition(CaptureRouter.owner(
    applicationName: "Google Chrome", bundleIdentifier: "com.google.Chrome",
    preferChromeExtension: true, preferVSCodeExtension: true
) == .chromeExtension)
precondition(CaptureRouter.owner(
    applicationName: "Visual Studio Code", bundleIdentifier: "com.microsoft.VSCode",
    preferChromeExtension: true, preferVSCodeExtension: true
) == .vscodeExtension)
precondition(CaptureRouter.owner(
    applicationName: "Google Chrome", bundleIdentifier: "com.google.Chrome",
    preferChromeExtension: false, preferVSCodeExtension: true
) == .desktop)

print("PASS: capture routing, Claude, Codex, terminal, PDF, Markdown, HTML, Simulator, persistence, inline image, and no auto-send")
