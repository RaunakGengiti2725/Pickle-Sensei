import Foundation
import XCTest
@testable import PickleNativeStressKit

/// Each hand-minimized repro is executed in a CHILD `stress-runner` process
/// (two of them trap the Swift runtime, which would take the test host down).
/// The assertions state the DESIRED invariant, so every test here is red until
/// the corresponding production hardening lands — they are the findings.
final class MinimalReproTests: XCTestCase {
  private struct ChildResult {
    let exitStatus: Int32
    let signalled: Bool
    let stdout: String
    let stderr: String

    /// The Swift runtime's one-line diagnosis ("Fatal error: …" /
    /// "Swift runtime failure: …"), or the exit status when there is none.
    var diagnosis: String {
      let line = stderr.split(whereSeparator: \.isNewline).first {
        $0.contains("Fatal error") || $0.contains("Swift runtime failure")
      }
      if let line { return String(line.prefix(200)) }
      return "exit \(exitStatus)\(signalled ? " (signal)" : "") \(stdout.prefix(200))"
    }
  }

  private func runnerURL() throws -> URL {
    // `swift build`/`swift test` place the executable product beside the
    // .xctest bundle; Xcode-hosted runs need STRESS_RUNNER to point at it.
    if let override = ProcessInfo.processInfo.environment["STRESS_RUNNER"] {
      return URL(fileURLWithPath: override)
    }
    let candidates = [
      Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("stress-runner"),
      Bundle.main.bundleURL.appendingPathComponent("stress-runner"),
    ]
    guard let url = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0.path) }) else {
      throw XCTestError(.failureWhileWaiting, userInfo: [
        NSLocalizedDescriptionKey: "stress-runner not found next to \(Bundle.main.bundleURL.path); run `swift build` or set STRESS_RUNNER",
      ])
    }
    return url
  }

  private func runRepro(_ repro: MinimalRepro, environment: [String: String] = [:]) throws -> ChildResult {
    let process = Process()
    process.executableURL = try runnerURL()
    process.arguments = ["repro", "--name", repro.rawValue]
    if !environment.isEmpty {
      process.environment = ProcessInfo.processInfo.environment.merging(environment) { _, new in new }
    }
    let out = Pipe()
    let err = Pipe()
    process.standardOutput = out
    process.standardError = err
    try process.run()
    let stdoutData = out.fileHandleForReading.readDataToEndOfFile()
    let stderrData = err.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return ChildResult(
      exitStatus: process.terminationStatus,
      signalled: process.terminationReason == .uncaughtSignal,
      stdout: String(decoding: stdoutData, as: UTF8.self),
      stderr: String(decoding: stderrData, as: UTF8.self)
    )
  }

  func testDuplicateVisibleLandmarkNameDoesNotTrapTheReadinessEvaluator() throws {
    let result = try runRepro(.duplicateVisibleLandmarkName)
    XCTAssertFalse(result.signalled, "PoseReadinessEvaluator.ingest trapped: \(result.diagnosis)")
    XCTAssertEqual(result.exitStatus, 0, result.diagnosis)
  }

  func testObserveFrameNearIntMaxDoesNotOverflow() throws {
    let result = try runRepro(.observeFrameNearIntMax)
    XCTAssertFalse(result.signalled, "StrokeCompletionMonitor.observeFrame trapped: \(result.diagnosis)")
    XCTAssertEqual(result.exitStatus, 0, result.diagnosis)
  }

  func testInfiniteWristCoordinateStaysOutOfTheCompletionPayload() throws {
    let result = try runRepro(.infiniteWristCoordinateInPayload)
    XCTAssertFalse(result.signalled, result.diagnosis)
    XCTAssertEqual(result.exitStatus, 0, result.diagnosis)
  }

  /// The detector's answer to one input must not depend on the process's
  /// hash seed. Each child prints `event`/`none`; with a NaN in `wristPaths`
  /// the two outcomes are ~50/50 across processes (10 runs: P(all equal) ≈
  /// 0.2%), and the swing must complete since the finite wrist's path
  /// clears the gate.
  func testStrokeCompletionDoesNotDependOnDictionaryOrderWhenAWristPathIsNaN() throws {
    let runs = max(10, StressCampaign.iterations / 5)
    var outcomes: [String: Int] = [:]
    for _ in 0 ..< runs {
      let result = try runRepro(.nanWristPathMakesStrokeCompletionOrderDependent)
      XCTAssertFalse(result.signalled, result.diagnosis)
      let verdict = result.stdout.split(whereSeparator: \.isNewline).first.map(String.init) ?? "<no output>"
      outcomes[verdict, default: 0] += 1
    }
    XCTAssertEqual(outcomes.count, 1, "TemporalStrokeDetector gave different answers to the same frames: \(outcomes)")
    XCTAssertEqual(outcomes["event"], runs, "finite wrist path ≥ gate should complete the stroke: \(outcomes)")

    // Mechanism check: pinning the hash seed pins the answer.
    var pinned: Set<String> = []
    for _ in 0 ..< 3 {
      let result = try runRepro(.nanWristPathMakesStrokeCompletionOrderDependent, environment: ["SWIFT_DETERMINISTIC_HASHING": "1"])
      pinned.insert(result.stdout.split(whereSeparator: \.isNewline).first.map(String.init) ?? "<no output>")
    }
    XCTAssertEqual(pinned.count, 1, "outcome varies even with deterministic hashing: \(pinned)")
  }

  func testEveryMinimalReproIsExecutable() throws {
    let result = try runRepro(.infiniteWristCoordinateInPayload)
    XCTAssertTrue(result.stdout.hasPrefix("infiniteWristCoordinateInPayload:"), result.stdout)
    let process = Process()
    process.executableURL = try runnerURL()
    process.arguments = ["repro", "--name", "list"]
    let out = Pipe()
    process.standardOutput = out
    try process.run()
    let listed = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    process.waitUntilExit()
    XCTAssertEqual(process.terminationStatus, 0)
    for repro in MinimalRepro.allCases {
      XCTAssertTrue(listed.contains(repro.rawValue), "\(repro.rawValue) missing from `repro --name list`")
    }
  }
}
