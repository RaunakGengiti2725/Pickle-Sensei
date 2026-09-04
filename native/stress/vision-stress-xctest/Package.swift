// swift-tools-version: 5.9
import PackageDescription

// Stress XCTests for native/vision-core + native/swing-lab. Lives OUTSIDE the
// production packages so it never changes their manifests or existing tests.
// Run (macOS host):
//   swift test --package-path native/stress/vision-stress-xctest
//   STRESS_ITER=200 swift test --package-path native/stress/vision-stress-xctest
// The swing-lab process tests need the release binary
// (`cd native/swing-lab && swift build -c release`) or SWING_LAB_BIN=<path>;
// otherwise they XCTSkip.
let package = Package(
  name: "PickleNativeStress",
  platforms: [.macOS(.v13), .iOS(.v15)],
  dependencies: [
    .package(path: "../../vision-core"),
  ],
  targets: [
    .target(name: "StressSupport", path: "Sources/StressSupport"),
    .testTarget(
      name: "VisionStressTests",
      dependencies: [
        "StressSupport",
        .product(name: "PickleVisionCore", package: "vision-core"),
      ],
      path: "Tests/VisionStressTests"
    ),
  ]
)
