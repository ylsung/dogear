// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "DogearDesktop",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "DogearCore", targets: ["DogearCore"]),
        .executable(name: "DogearDesktop", targets: ["DogearDesktop"]),
        .executable(name: "DogearSimulation", targets: ["DogearSimulation"]),
    ],
    targets: [
        .target(name: "DogearCore"),
        .executableTarget(name: "DogearDesktop", dependencies: ["DogearCore"]),
        .executableTarget(name: "DogearSimulation", dependencies: ["DogearCore"]),
        .testTarget(name: "DogearCoreTests", dependencies: ["DogearCore"]),
    ]
)
