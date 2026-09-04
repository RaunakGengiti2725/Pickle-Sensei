import XCTest
@testable import PickleVisionCore

final class PoseReadinessEvaluatorTests: XCTestCase {
  func testMissingPoseCanNeverBecomeReady() {
    let evaluator = PoseReadinessEvaluator()
    XCTAssertEqual(evaluator.ingestMissing(timestampMs: 0).state, .noPerson)
    XCTAssertEqual(evaluator.ingestMissing(timestampMs: 5_000).state, .noPerson)
  }

  func testIncompleteBodyFailsCoverageGate() {
    let evaluator = PoseReadinessEvaluator()
    let incomplete = pose(timestampMs: 0, removing: ["left_ankle", "right_ankle"])
    let snapshot = evaluator.ingest(pose: incomplete)
    XCTAssertEqual(snapshot.state, .fullBodyRequired)
    XCTAssertTrue(snapshot.missingJoints.contains("left_ankle"))
  }

  /// Retuned window: 450 ms of stable evidence (was 700 ms).
  func testRealStablePoseMustPersistForTheStillnessWindowBeforeReady() {
    let evaluator = PoseReadinessEvaluator()
    XCTAssertEqual(evaluator.ingest(pose: pose(timestampMs: 0)).state, .holdStill)
    XCTAssertEqual(evaluator.ingest(pose: pose(timestampMs: 225)).state, .holdStill)
    let almost = evaluator.ingest(pose: pose(timestampMs: 440))
    XCTAssertEqual(almost.state, .holdStill)
    XCTAssertEqual(almost.stableForMs, 0)
    let ready = evaluator.ingest(pose: pose(timestampMs: 450))
    XCTAssertEqual(ready.state, .ready)
    XCTAssertGreaterThanOrEqual(ready.stableForMs, 450)
  }

  func testDefaultStillnessWindowIs450Ms() {
    XCTAssertEqual(PoseReadinessEvaluator.Config().stableDurationMs, 450)
    XCTAssertEqual(PoseReadinessEvaluator.Config().maximumCenterTravel, 0.055, accuracy: 1e-12)
  }

  func testMotionRestartsStabilityEvidence() {
    let evaluator = PoseReadinessEvaluator()
    _ = evaluator.ingest(pose: pose(timestampMs: 0))
    _ = evaluator.ingest(pose: pose(timestampMs: 225))
    XCTAssertEqual(evaluator.ingest(pose: pose(timestampMs: 450)).state, .ready)

    let moved = evaluator.ingest(pose: pose(timestampMs: 550, xOffset: 0.14))
    XCTAssertEqual(moved.state, .holdStill)
    XCTAssertEqual(moved.stableForMs, 0)
  }

  /// Retuned tolerance: centre travel up to 0.055 of the frame (was 0.045) is
  /// still "still", so breathing / paddle-tapping sway does not restart the
  /// window; a real step does.
  func testNaturalSwayWithinTravelToleranceKeepsStabilityEvidence() {
    let evaluator = PoseReadinessEvaluator()
    XCTAssertEqual(evaluator.ingest(pose: pose(timestampMs: 0)).state, .holdStill)
    XCTAssertEqual(evaluator.ingest(pose: pose(timestampMs: 150, xOffset: 0.05)).state, .holdStill)
    XCTAssertEqual(evaluator.ingest(pose: pose(timestampMs: 300)).state, .holdStill)
    let ready = evaluator.ingest(pose: pose(timestampMs: 450, xOffset: 0.05))
    XCTAssertEqual(ready.state, .ready)
    XCTAssertGreaterThanOrEqual(ready.stableForMs, 450)
  }

  func testStepBeyondTravelToleranceRestartsStabilityWindow() {
    let evaluator = PoseReadinessEvaluator()
    _ = evaluator.ingest(pose: pose(timestampMs: 0))
    _ = evaluator.ingest(pose: pose(timestampMs: 150))
    let stepped = evaluator.ingest(pose: pose(timestampMs: 300, xOffset: 0.06))
    XCTAssertEqual(stepped.state, .holdStill)
    XCTAssertEqual(stepped.stableForMs, 0)
    // Only 150 ms of evidence since the restart: still not ready.
    let later = evaluator.ingest(pose: pose(timestampMs: 450, xOffset: 0.06))
    XCTAssertEqual(later.state, .holdStill)
    // Holding the new position for the full window is.
    _ = evaluator.ingest(pose: pose(timestampMs: 600, xOffset: 0.06))
    XCTAssertEqual(evaluator.ingest(pose: pose(timestampMs: 750, xOffset: 0.06)).state, .ready)
  }

  // MARK: - Readiness must not depend on the frame cadence

  /// A still athlete must become `.ready` on the first sample at or after
  /// 450 ms of stillness, whatever the frame interval. Real cameras never
  /// deliver a sample exactly 450 ms after another one: 25 fps is a 40 ms
  /// step, 30 fps rounds to 33/33/34, Apple Vision's 24 fps grid is 42/41,
  /// and back-pressure at 60 fps processes every other frame.
  func testStillPoseAt25fpsBecomesReadyOnFirstSampleAfterWindow() {
    let run = readinessRun(timestamps: grid(cadence: [40]))
    assertReadyExactlyOnceWindowElapsed(run, maxStepMs: 40)
    XCTAssertEqual(run.firstReadyMs, 480)
  }

  func testStillPoseOn30fpsMillisecondGridBecomesReadyOnFirstSampleAfterWindow() {
    let run = readinessRun(timestamps: grid(cadence: [33, 33, 34]))
    assertReadyExactlyOnceWindowElapsed(run, maxStepMs: 34)
    XCTAssertEqual(run.firstReadyMs, 466)
  }

  func testStillPoseOnRealVisionGridBecomesReadyOnFirstSampleAfterWindow() {
    // 42/41 ms steps: the timestamp grid observed in Apple Vision output on
    // the M4 runner (swing-lab-extract/pose.json).
    let run = readinessRun(timestamps: grid(cadence: [42, 41]))
    assertReadyExactlyOnceWindowElapsed(run, maxStepMs: 42)
    XCTAssertEqual(run.firstReadyMs, 457)
  }

  func testStillPoseOn60fpsGridProcessedEveryOtherFrameBecomesReady() {
    // Camera PTS at 60 fps rounded to integer milliseconds, with Vision
    // back-pressure dropping every other frame (retained samples 2 frames
    // apart, 27 frames = 450 ms is odd, so none sits exactly 450 ms back).
    let timestamps = stride(from: 0, to: 180, by: 2).map { k in
      Int((Double(k) * 1000 / 60).rounded())
    }
    let run = readinessRun(timestamps: timestamps)
    assertReadyExactlyOnceWindowElapsed(run, maxStepMs: 34)
    XCTAssertEqual(run.firstReadyMs, 467)
  }

  func testStillPoseStaysReadyOnEveryLaterSampleOnAnyCadence() {
    for cadence in [[40], [33, 33, 34], [42, 41]] {
      let run = readinessRun(timestamps: grid(cadence: cadence, untilMs: 3_000))
      guard let firstReady = run.firstReadyMs else {
        XCTFail("never ready on cadence \(cadence)")
        continue
      }
      let after = run.snapshots.filter { $0.timestampMs >= firstReady }
      XCTAssertTrue(after.allSatisfy(\.isReady), "readiness dropped out on cadence \(cadence)")
      XCTAssertTrue(
        after.allSatisfy { $0.stableForMs >= 450 && $0.stableForMs <= $0.timestampMs },
        "stableForMs must report the real held duration on cadence \(cadence)"
      )
    }
  }

  private struct ReadinessRun {
    let snapshots: [PoseReadinessEvaluator.Snapshot]
    var firstReadyMs: Int? { snapshots.first(where: \.isReady)?.timestampMs }
  }

  private func grid(cadence: [Int], untilMs: Int = 1_000) -> [Int] {
    var timestamps = [0]
    var i = 0
    while let last = timestamps.last, last + cadence[i % cadence.count] <= untilMs {
      timestamps.append(last + cadence[i % cadence.count])
      i += 1
    }
    return timestamps
  }

  private func readinessRun(timestamps: [Int]) -> ReadinessRun {
    let evaluator = PoseReadinessEvaluator()
    return ReadinessRun(snapshots: timestamps.map { evaluator.ingest(pose: pose(timestampMs: $0)) })
  }

  private func assertReadyExactlyOnceWindowElapsed(
    _ run: ReadinessRun,
    maxStepMs: Int,
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    let window = PoseReadinessEvaluator.Config().stableDurationMs
    for snapshot in run.snapshots where snapshot.timestampMs < window {
      XCTAssertFalse(snapshot.isReady, "ready at \(snapshot.timestampMs) ms, before \(window) ms of stillness", file: file, line: line)
      XCTAssertEqual(snapshot.state, .holdStill, file: file, line: line)
    }
    guard let first = run.snapshots.first(where: \.isReady) else {
      let maxStable = run.snapshots.map(\.stableForMs).max() ?? 0
      XCTFail("never ready; max stableForMs=\(maxStable)", file: file, line: line)
      return
    }
    XCTAssertGreaterThanOrEqual(first.timestampMs, window, file: file, line: line)
    XCTAssertLessThanOrEqual(first.timestampMs, window + maxStepMs, file: file, line: line)
    XCTAssertGreaterThanOrEqual(first.stableForMs, window, file: file, line: line)
    XCTAssertEqual(first.stableForMs, first.timestampMs, "stableForMs must be the real held duration", file: file, line: line)
  }

  private func pose(
    timestampMs: Int,
    xOffset: Double = 0,
    removing names: Set<String> = []
  ) -> PoseFrame {
    let points: [(String, Double, Double)] = [
      ("left_shoulder", 0.43, 0.25), ("right_shoulder", 0.57, 0.25),
      ("left_elbow", 0.39, 0.38), ("right_elbow", 0.61, 0.38),
      ("left_wrist", 0.36, 0.50), ("right_wrist", 0.64, 0.50),
      ("left_hip", 0.45, 0.52), ("right_hip", 0.55, 0.52),
      ("left_knee", 0.45, 0.70), ("right_knee", 0.55, 0.70),
      ("left_ankle", 0.44, 0.90), ("right_ankle", 0.56, 0.90),
    ]
    return PoseFrame(
      timestampMs: timestampMs,
      landmarks: points.compactMap { name, x, y in
        guard !names.contains(name) else { return nil }
        return PoseLandmark(name: name, x: x + xOffset, y: y, visibility: 0.95)
      },
      confidence: 0.95
    )
  }
}
