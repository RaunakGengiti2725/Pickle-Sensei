// swift-tools-version: 5.9
import PackageDescription

// Adversarial XCTest harness for native/camera-engine (adversarial tester #4,
// pass 3). The module under test is the EXACT set of sources the shipping
// PickleNative pod compiles together (see PickleNative.podspec source_files)
// reached through relative symlinks under Sources/CameraEngineUnderTest, so
// the tests exercise 4d812e1a byte-for-byte without copying production code.
//
// iOS-only on purpose: ClipMediaStore imports UIKit and the interruption
// reasons under test (videoDeviceNotAvailableWithMultipleForegroundApps) are
// iOS-only AVFoundation API. Run with xcodebuild against an iOS Simulator (the
// deterministic subset) or an attached iPhone (camera-backed scenarios); see
// ../run-mac.sh. Linux can only parse these files (swiftc -parse).
let package = Package(
  name: "CameraEngineAttack",
  platforms: [.iOS(.v15)],
  targets: [
    .target(
      name: "CameraEngineUnderTest",
      path: "Sources/CameraEngineUnderTest"
    ),
    .testTarget(
      name: "CameraEngineAttackTests",
      dependencies: ["CameraEngineUnderTest"],
      path: "Tests/CameraEngineAttackTests"
    ),
  ]
)
