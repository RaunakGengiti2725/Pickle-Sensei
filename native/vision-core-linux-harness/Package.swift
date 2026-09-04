// swift-tools-version: 5.9
// Linux-only adversarial harness for the Foundation-only parts of
// native/vision-core (and the Foundation-only StrokeCompletionMonitor from
// apps/mobile/ios/LocalPods/PickleNative). Sources are SYMLINKED from their
// canonical locations, so the exact production Swift is what runs here.
//
// This package proves pure-Swift logic (bounds, traps, lock coverage under
// ThreadSanitizer). It proves NOTHING about Apple Vision, AVFoundation, or
// iOS runtime behaviour: those need the M4 runner (see
// .agents/skills/macos-verification/SKILL.md).
import PackageDescription

let package = Package(
  name: "PickleVisionCoreLinuxHarness",
  platforms: [.macOS(.v13)],
  targets: [
    // Stand-in for the Apple CoreVideo module so VisionCoreContracts.swift
    // compiles unmodified on Linux. Only the type name is needed.
    .target(name: "CoreVideo", path: "Sources/CoreVideo"),
    .target(
      name: "PickleVisionCoreLinux",
      dependencies: ["CoreVideo"],
      path: "Sources/PickleVisionCoreLinux"
    ),
    .executableTarget(
      name: "ReviewHarness",
      dependencies: ["PickleVisionCoreLinux"],
      path: "Sources/ReviewHarness"
    ),
    .testTarget(
      name: "PickleVisionCoreLinuxTests",
      dependencies: ["PickleVisionCoreLinux"],
      path: "Tests/PickleVisionCoreLinuxTests"
    ),
  ]
)
