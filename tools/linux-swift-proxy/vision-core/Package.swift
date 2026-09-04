// swift-tools-version:5.9
// Scratch package materialised by run.sh — mirrors native/vision-core with a
// Linux stub for CoreVideo so the Foundation-only sources and XCTests compile
// with the swift.org Linux toolchain. Never shipped; proxy plane only.
import PackageDescription

let package = Package(
  name: "PickleVisionCoreLinuxProxy",
  products: [.library(name: "PickleVisionCore", targets: ["PickleVisionCore"])],
  targets: [
    // Linux has no CoreGraphics module; Foundation supplies CGPoint. This
    // stand-in lets tests that `import CoreGraphics` compile unchanged.
    .target(name: "CoreGraphics", path: "Sources/CoreGraphics"),
    .target(name: "PickleVisionCore", path: "Sources/PickleVisionCore"),
    .testTarget(
      name: "PickleVisionCoreTests",
      dependencies: ["PickleVisionCore", "CoreGraphics"],
      path: "Tests/PickleVisionCoreTests"
    ),
  ]
)
