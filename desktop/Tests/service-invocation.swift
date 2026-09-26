import AppKit

let pasteboard = NSPasteboard(name: NSPasteboard.Name("DogearServiceSimulation"))
pasteboard.clearContents()
pasteboard.setString("Dogear service integration test", forType: .string)

guard NSPerformService("Ask with Dogear", pasteboard) else {
    fputs("FAIL: Ask with Dogear service was unavailable\n", stderr)
    exit(1)
}

print("PASS: Ask with Dogear service accepted selected text")
