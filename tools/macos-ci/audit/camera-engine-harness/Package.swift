// swift-tools-version: 5.9
// Audit-only XCTest harness for native/camera-engine/Sources/CameraEngine.swift.
//
// CameraEngine uses iOS-only AVFoundation API (builtInDualWideCamera,
// AVCaptureSession.InterruptionReason, video stabilization), so it cannot be
// built by `swift build` on a macOS host. Run it on the iOS Simulator from the
// self-hosted Mac exactly like native/vision-core's simulator stage:
//
//   udid="$(tools/macos-ci/select-simulator.sh --boot)"
//   (cd tools/macos-ci/audit/camera-engine-harness && xcodebuild test \
//      -scheme CameraEngineAudit-Package \
//      -destination "platform=iOS Simulator,id=$udid" \
//      -resultBundlePath "$ARTIFACTS/camera-engine-audit.xcresult" \
//      CODE_SIGNING_ALLOWED=NO)
//
// Sources/CameraEngineAudit/CameraEngine.swift is a symlink to the canonical
// file; no production code is copied or modified.
import PackageDescription

let package = Package(
  name: "CameraEngineAudit",
  platforms: [.iOS(.v15)],
  targets: [
    .target(name: "CameraEngineAudit", path: "Sources/CameraEngineAudit"),
    .testTarget(
      name: "CameraEngineAuditTests",
      dependencies: ["CameraEngineAudit"],
      path: "Tests/CameraEngineAuditTests"
    ),
  ]
)
