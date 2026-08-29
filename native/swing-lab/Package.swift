// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "swing-lab",
  platforms: [.macOS(.v13)],
  dependencies: [
    .package(path: "../vision-core"),
  ],
  targets: [
    .executableTarget(
      name: "swing-lab",
      dependencies: [.product(name: "PickleVisionCore", package: "vision-core")],
      path: "Sources"
    ),
  ]
)
