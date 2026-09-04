// swift-tools-version: 5.9
import PackageDescription

// LINUX PLANE ONLY. Builds the pure-Swift (Foundation-only) stages of
// native/vision-core — SessionMotionStream, CaptureEvidenceAccumulator,
// TemporalStrokeDetector, PoseMotionTrail, PoseReadinessEvaluator,
// CaptureQualitySignals — from symlinks to the production files, and runs the
// seeded two-person stress suite against them with swift-corelibs-xctest:
//
//   swift test   (Swift 6.0.3 Linux toolchain; STRESS_ITER / STRESS_SEED /
//                 STRESS_RESULTS_DIR as in the Apple packages)
//
// It says nothing about Apple Vision, AVFoundation or iOS: ApplePoseProvider
// is deliberately excluded and `CoreVideo` is a one-line typealias shim.
// On macOS use native/stress/vision-stress-xctest instead.
let package = Package(
  name: "PickleLinuxLogicStress",
  targets: [
    .target(name: "CoreVideo", path: "Sources/CoreVideo"),
    .target(name: "PickleVisionCore", dependencies: ["CoreVideo"], path: "Sources/PickleVisionCore"),
    .target(name: "StressSupport", path: "Sources/StressSupport"),
    .testTarget(
      name: "LinuxLogicStressTests",
      dependencies: ["PickleVisionCore", "StressSupport"],
      path: "Tests/LinuxLogicStressTests"
    ),
  ]
)
