// swift-tools-version: 5.9
import PackageDescription

// Stress XCTests for native/camera-engine/Sources/CameraEngine.swift, which
// ships only through the PickleNative CocoaPod (no SwiftPM manifest of its
// own). `Sources/PickleCameraEngine/CameraEngine.swift` is a symlink to the
// production file so this package never carries a copy that could drift.
//
// iOS-only (AVCaptureDevice.Position/zoom APIs are unavailable on macOS):
//   xcodebuild test -scheme PickleCameraEngineStress-Package \
//     -destination 'platform=iOS Simulator,name=iPhone 16' \
//     -resultBundlePath /tmp/camera-engine-stress.xcresult
// from native/stress/camera-engine-xctest. Lifecycle tests run without a
// camera (Simulator); recording-path tests XCTSkip until a real device
// grants camera access.
let package = Package(
  name: "PickleCameraEngineStress",
  platforms: [.iOS(.v15)],
  targets: [
    .target(name: "PickleCameraEngine", path: "Sources/PickleCameraEngine"),
    .testTarget(
      name: "CameraEngineStressTests",
      dependencies: ["PickleCameraEngine"],
      path: "Tests/CameraEngineStressTests"
    ),
  ]
)
