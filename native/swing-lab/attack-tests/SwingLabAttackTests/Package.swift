// swift-tools-version: 5.9
// Standalone XCTest wrapper for the swing-lab adversarial pass (macOS only).
// It is deliberately NOT a test target of ../../Package.swift so the attack
// suite adds files without touching the production manifest.
//
//   cd native/swing-lab/attack-tests/SwingLabAttackTests && swift test
//
import PackageDescription

let package = Package(
  name: "SwingLabAttackTests",
  platforms: [.macOS(.v13)],
  targets: [
    .testTarget(
      name: "SwingLabAttackTests",
      path: "Tests/SwingLabAttackTests"
    ),
  ]
)
