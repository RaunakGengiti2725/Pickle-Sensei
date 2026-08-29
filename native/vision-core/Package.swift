// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "PickleVisionCore",
  platforms: [.macOS(.v13), .iOS(.v15)],
  products: [
    .library(name: "PickleVisionCore", targets: ["PickleVisionCore"]),
  ],
  targets: [
    .target(name: "PickleVisionCore", path: "Sources"),
    .testTarget(
      name: "PickleVisionCoreTests",
      dependencies: ["PickleVisionCore"],
      path: "Tests"
    ),
  ]
)
