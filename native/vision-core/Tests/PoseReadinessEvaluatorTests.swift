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

  // MARK: - Frame cadence (NVC-1)

  /// A still, fully framed athlete must reach `ready` after the stillness
  /// window at ANY camera cadence — timestamps are integer milliseconds, so
  /// the frame interval rarely divides `stableDurationMs` exactly.
  func testStillBodyReachesReadyAtEveryCameraCadence() {
    let stableDurationMs = PoseReadinessEvaluator.Config().stableDurationMs
    for fps in [60, 50, 30, 25, 24] {
      let intervalMs = Int((1000.0 / Double(fps)).rounded(.up))
      let timestamps = cadenceTimestamps(fps: fps, durationMs: 3_000)
      let firstReady = firstReadyTimestamp(feeding: timestamps)
      XCTAssertNotNil(firstReady, "\(fps) fps never reached ready in 3 s")
      if let firstReady {
        XCTAssertLessThanOrEqual(
          firstReady,
          stableDurationMs + 2 * intervalMs,
          "\(fps) fps reached ready at \(firstReady) ms; expected within \(stableDurationMs + 2 * intervalMs) ms"
        )
      }
    }
  }

  /// 60 fps capture where Vision only keeps up with every other frame
  /// (33/34 ms effective cadence) must still arm.
  func testStillBodyReachesReadyAt60FpsWithEveryOtherFrameDropped() {
    let stableDurationMs = PoseReadinessEvaluator.Config().stableDurationMs
    let timestamps = cadenceTimestamps(fps: 60, durationMs: 3_000)
      .enumerated()
      .filter { $0.offset % 2 == 0 }
      .map(\.element)
    let firstReady = firstReadyTimestamp(feeding: timestamps)
    XCTAssertNotNil(firstReady, "60 fps with every other frame dropped never reached ready in 3 s")
    if let firstReady {
      XCTAssertLessThanOrEqual(firstReady, stableDurationMs + 2 * 34)
    }
  }

  /// Once `ready`, a single dropped frame in a still 60 fps run must not send
  /// the athlete back to `hold_still`.
  func testSingleDroppedFrameNeverRevokesReadyAt60Fps() {
    let evaluator = PoseReadinessEvaluator()
    let timestamps = cadenceTimestamps(fps: 60, durationMs: 3_000)
    var readyIndex: Int?
    for (index, timestampMs) in timestamps.enumerated() {
      if evaluator.ingest(pose: pose(timestampMs: timestampMs)).state == .ready {
        readyIndex = index
        break
      }
    }
    guard let readyIndex else {
      return XCTFail("still 60 fps run never reached ready in 3 s")
    }
    // Drop exactly one frame, then keep feeding the same still body.
    let afterDrop = timestamps[(readyIndex + 2)...]
    XCTAssertGreaterThanOrEqual(afterDrop.count, 10)
    for timestampMs in afterDrop {
      let snapshot = evaluator.ingest(pose: pose(timestampMs: timestampMs))
      XCTAssertEqual(snapshot.state, .ready, "ready revoked at \(timestampMs) ms after one dropped frame")
      XCTAssertGreaterThanOrEqual(snapshot.stableForMs, PoseReadinessEvaluator.Config().stableDurationMs)
    }
  }

  // MARK: - Duplicate landmark names (NVC-3)

  /// Two visible landmarks sharing a name must never trap the process; the
  /// higher-visibility one is evaluated (matching CaptureEvidenceAccumulator).
  func testDuplicateVisibleLandmarkNamesAreDeduplicatedByHighestVisibility() {
    // Duplicate wrist outside the frame margin but still "visible": if it
    // were the one evaluated, framing would fail with fullBodyRequired.
    let outOfFrameLowVisibility = PoseLandmark(name: "left_wrist", x: 0.995, y: 0.50, visibility: 0.50)
    let outOfFrameHighVisibility = PoseLandmark(name: "left_wrist", x: 0.995, y: 0.50, visibility: 0.99)

    let appended = PoseReadinessEvaluator().ingest(
      pose: pose(timestampMs: 0, appending: [outOfFrameLowVisibility])
    )
    XCTAssertEqual(appended.state, .holdStill)
    XCTAssertTrue(appended.missingJoints.isEmpty)
    XCTAssertEqual(appended.jointCoverage, 1, accuracy: 1e-12)

    let prepended = PoseReadinessEvaluator().ingest(
      pose: pose(timestampMs: 0, prepending: [outOfFrameLowVisibility])
    )
    XCTAssertEqual(prepended.state, .holdStill)
    XCTAssertTrue(prepended.missingJoints.isEmpty)

    // When the duplicate is the MORE visible one, it is the one evaluated.
    let higherWins = PoseReadinessEvaluator().ingest(
      pose: pose(timestampMs: 0, prepending: [outOfFrameHighVisibility])
    )
    XCTAssertEqual(higherWins.state, .fullBodyRequired)
    XCTAssertTrue(higherWins.missingJoints.isEmpty)
    XCTAssertEqual(higherWins.jointCoverage, 1, accuracy: 1e-12)
  }

  func testDuplicateLandmarkNamesStillReachReadyOverTheStillnessWindow() {
    let evaluator = PoseReadinessEvaluator()
    let duplicate = PoseLandmark(name: "right_hip", x: 0.55, y: 0.52, visibility: 0.40)
    var states: [PoseReadinessEvaluator.State] = []
    for timestampMs in cadenceTimestamps(fps: 30, durationMs: 1_000) {
      states.append(evaluator.ingest(pose: pose(timestampMs: timestampMs, appending: [duplicate])).state)
    }
    XCTAssertTrue(states.contains(.ready), "states=\(states.map(\.rawValue))")
  }

  // MARK: - Helpers

  /// Camera timestamps for `fps` over `durationMs`, rounded to integer
  /// milliseconds exactly like a capture pipeline would report them.
  private func cadenceTimestamps(fps: Int, durationMs: Int) -> [Int] {
    let frameCount = durationMs * fps / 1000
    return (0...frameCount).map { Int((Double($0) * 1000.0 / Double(fps)).rounded()) }
  }

  private func firstReadyTimestamp(feeding timestamps: [Int]) -> Int? {
    let evaluator = PoseReadinessEvaluator()
    for timestampMs in timestamps {
      if evaluator.ingest(pose: pose(timestampMs: timestampMs)).state == .ready {
        return timestampMs
      }
    }
    return nil
  }

  private func pose(
    timestampMs: Int,
    xOffset: Double = 0,
    removing names: Set<String> = [],
    prepending leading: [PoseLandmark] = [],
    appending trailing: [PoseLandmark] = []
  ) -> PoseFrame {
    let points: [(String, Double, Double)] = [
      ("left_shoulder", 0.43, 0.25), ("right_shoulder", 0.57, 0.25),
      ("left_elbow", 0.39, 0.38), ("right_elbow", 0.61, 0.38),
      ("left_wrist", 0.36, 0.50), ("right_wrist", 0.64, 0.50),
      ("left_hip", 0.45, 0.52), ("right_hip", 0.55, 0.52),
      ("left_knee", 0.45, 0.70), ("right_knee", 0.55, 0.70),
      ("left_ankle", 0.44, 0.90), ("right_ankle", 0.56, 0.90),
    ]
    let landmarks: [PoseLandmark] = points.compactMap { name, x, y in
      guard !names.contains(name) else { return nil }
      return PoseLandmark(name: name, x: x + xOffset, y: y, visibility: 0.95)
    }
    return PoseFrame(
      timestampMs: timestampMs,
      landmarks: leading + landmarks + trailing,
      confidence: 0.95
    )
  }
}
