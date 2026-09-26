import Foundation

public enum QueuePersistence {
    public static func load(from url: URL) -> [QueueItem] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([QueueItem].self, from: data)) ?? []
    }

    public static func save(_ queue: [QueueItem], to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(queue).write(to: url, options: .atomic)
    }
}
