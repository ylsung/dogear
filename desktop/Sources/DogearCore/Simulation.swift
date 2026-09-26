import Foundation

public enum SimulatedEvent: Equatable, Sendable {
    case activate(DeliveryTarget, String?)
    case pasteText(String)
    case pasteImage(ImageAsset)
}

public struct DeliverySimulator: Sendable {
    public init() {}

    public func run(_ plan: DeliveryPlan) -> [SimulatedEvent] {
        var events: [SimulatedEvent] = [.activate(plan.target, plan.preferredBundleIdentifier)]
        for chunk in plan.chunks {
            switch chunk {
            case .text(let text): events.append(.pasteText(text))
            case .image(let image): events.append(.pasteImage(image))
            }
        }
        return events
    }
}
