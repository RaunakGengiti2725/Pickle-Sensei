// swift-tools-version: 5.9
// Linux replay harness for the structural audit of native/vision-core.
//
// The real package (`native/vision-core/Package.swift`) imports Vision in
// ApplePoseProvider.swift and therefore only builds on Apple platforms. Every
// other source file is pure Foundation, so this harness symlinks those files
// plus the Foundation-only test files and lets `swift test` run on Linux.
//
// This proves Swift *logic* (Double arithmetic, state machines) on the same
// source bytes; it is NOT Apple runtime evidence. Vision inference,
// ApplePoseProvider and XCTest-on-iOS claims still need the M4 runner.
import PackageDescription

let package = Package(
  name: "PickleVisionCoreAuditHarness",
  platforms: [.macOS(.v13)],
  targets: [
    .target(name: "PickleVisionCore", path: "Sources"),
    .testTarget(
      name: "PickleVisionCoreTests",
      dependencies: ["PickleVisionCore"],
      path: "Tests"
    ),
  ]
)
