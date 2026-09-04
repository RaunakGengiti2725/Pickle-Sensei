// swift-tools-version: 5.9
// Adversarial XCTest harness for native/camera-engine (pass 3, tester #3).
//
// The production camera engine is not a SwiftPM package of its own: the two
// files in native/camera-engine/Sources are compiled straight into the
// PickleNative CocoaPod together with native/vision-core and the pod's own
// helpers. This package rebuilds EXACTLY that compilation unit from symlinks
// (Sources/PickleCameraEngineUnderTest/* -> the real files; nothing copied,
// nothing patched) so XCTest can reach `CameraEngine`,
// `SessionCaptureCoordinator` and `PickleSessionPreviewView` via
// `@testable import`. The only stand-in is `Sources/ReactShim` — the two
// React symbols PickleSessionPreview.swift needs (`RCTDirectEventBlock`,
// `RCTViewManager`); the React Native bridge itself is not under test.
//
// iOS only: CameraEngine uses iOS-only AVFoundation API (virtual devices,
// zoom, interruption reasons), so this runs on the iOS Simulator or a device
// through `xcodebuild test`, never `swift test` on macOS. See README.md.
import PackageDescription

let package = Package(
  name: "PickleCameraEngineAttack",
  platforms: [.iOS(.v15)],
  targets: [
    .target(name: "React", path: "Sources/ReactShim"),
    .target(
      name: "PickleCameraEngineUnderTest",
      dependencies: ["React"],
      path: "Sources/PickleCameraEngineUnderTest"
    ),
    .testTarget(
      name: "CameraEngineAttackTests",
      dependencies: ["PickleCameraEngineUnderTest"],
      path: "Tests"
    ),
  ]
)
