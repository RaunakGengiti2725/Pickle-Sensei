// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "PickleManagedMedia",
  platforms: [.macOS(.v13), .iOS("15.1")],
  products: [
    .library(name: "PickleManagedMedia", targets: ["PickleManagedMedia"]),
  ],
  targets: [
    .target(name: "PickleManagedMedia", path: "Sources"),
    .testTarget(
      name: "PickleManagedMediaTests",
      dependencies: ["PickleManagedMedia"],
      path: "Tests"
    ),
  ]
)
