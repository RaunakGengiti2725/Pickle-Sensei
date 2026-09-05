// swift-tools-version: 5.9
// Stress harness for the native iOS bridge core (apps/mobile/ios/LocalPods/PickleNative).
//
// The library target compiles the CANONICAL production sources (never copies):
// `scripts/prepare-sources.sh` populates `Sources/PickleNativeStressCore/Generated`
// with symlinks into native/vision-core, native/camera-engine and the LocalPod.
// On Linux only the Foundation-only subset is linked (Vision/AVFoundation/UIKit
// files are skipped and `import CoreVideo` is stripped from the contracts file
// into a generated copy); on Darwin every vision-core file is linked verbatim.
//
// Run `scripts/prepare-sources.sh` before `swift build` / `swift test`.
import PackageDescription

let package = Package(
  name: "PickleNativeStress",
  platforms: [.macOS(.v13), .iOS(.v15)],
  targets: [
    .target(
      name: "PickleNativeStressCore",
      path: "Sources/PickleNativeStressCore",
      exclude: ["README.md"]
    ),
    .target(
      name: "PickleNativeStressKit",
      dependencies: ["PickleNativeStressCore"],
      path: "Sources/PickleNativeStressKit"
    ),
    .executableTarget(
      name: "stress-runner",
      dependencies: ["PickleNativeStressKit"],
      path: "Sources/stress-runner"
    ),
    .testTarget(
      name: "PickleNativeStressTests",
      dependencies: ["PickleNativeStressKit"],
      path: "Tests/PickleNativeStressTests"
    ),
  ]
)
