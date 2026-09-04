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

  // MARK: - Readiness on real frame cadences

  /// Readiness must depend on how long the athlete has been still, not on a
  /// sample happening to land exactly `stableDurationMs` behind the current
  /// frame. Each cadence below never produces such a sample: 450 is not a
  /// multiple of 40, of the 33/33/34 ms grid a 30 fps camera rounds to, nor of
  /// the 42/41 ms grid Apple Vision emitted on the M4 runner (pose.json).
  func testStillAthleteAt40MsCadenceBecomesReadyWithinOneFrameOfTheWindow() {
    assertReadyWithinOneFrame(cadence: [40])
  }

  func testStillAthleteOn30FpsMillisecondGridBecomesReadyWithinOneFrameOfTheWindow() {
    assertReadyWithinOneFrame(cadence: [33, 33, 34])
  }

  func testStillAthleteOnRealAppleVisionGridBecomesReadyWithinOneFrameOfTheWindow() {
    assertReadyWithinOneFrame(cadence: [42, 41])
  }

  /// 60 fps camera PTS rounded to integer ms with a host-clock origin, as
  /// CameraEngine produces, with Vision back-pressure dropping every other
  /// frame: retained samples are two frames (~33 ms) apart and 450 ms is 27
  /// frames — an odd count, so no retained sample is ever exactly 450 ms old.
  func testStillAthleteOn60FpsGridProcessedEveryOtherFrameBecomesReadyWithinOneFrameOfTheWindow() {
    let originS = 123_456.789_123
    let timestamps = stride(from: 0, to: 180, by: 2).map { k in
      Int(((originS + Double(k) / 60.0) * 1000).rounded())
    }
    assertReadyWithinOneFrame(timestamps: timestamps, maxStepMs: 34)
  }

  /// `stableForMs` on a ready snapshot is the real held duration, not the
  /// window length: after 2 s of stillness it reports 2 s.
  func testStableForMsReportsTheRealHeldDurationOnceReady() {
    let evaluator = PoseReadinessEvaluator()
    var last: PoseReadinessEvaluator.Snapshot?
    for t in stride(from: 0, through: 2_000, by: 40) {
      last = evaluator.ingest(pose: pose(timestampMs: t))
    }
    XCTAssertEqual(last?.state, .ready)
    XCTAssertEqual(last?.stableForMs, 2_000)
  }

  /// Stillness evidence must be continuous: a gap between framed samples
  /// longer than the window is not evidence of stillness across the gap, so
  /// the window restarts at the first sample after it (no timer-only path).
  func testEvidenceGapLongerThanTheWindowRestartsStillness() {
    let evaluator = PoseReadinessEvaluator()
    for t in stride(from: 0, through: 440, by: 40) {
      XCTAssertEqual(evaluator.ingest(pose: pose(timestampMs: t)).state, .holdStill)
    }
    let afterGap = evaluator.ingest(pose: pose(timestampMs: 1_000))
    XCTAssertEqual(afterGap.state, .holdStill)
    XCTAssertEqual(afterGap.stableForMs, 0)
    XCTAssertEqual(evaluator.ingest(pose: pose(timestampMs: 1_400)).state, .holdStill)
    let ready = evaluator.ingest(pose: pose(timestampMs: 1_480))
    XCTAssertEqual(ready.state, .ready)
    XCTAssertEqual(ready.stableForMs, 480)
  }

  /// A missing person clears the window even when the surrounding framed
  /// samples would otherwise span it.
  func testMissingPoseBetweenFramedSamplesRestartsStillness() {
    let evaluator = PoseReadinessEvaluator()
    for t in stride(from: 0, through: 400, by: 40) {
      _ = evaluator.ingest(pose: pose(timestampMs: t))
    }
    XCTAssertEqual(evaluator.ingestMissing(timestampMs: 440).state, .noPerson)
    let resumed = evaluator.ingest(pose: pose(timestampMs: 480))
    XCTAssertEqual(resumed.state, .holdStill)
    XCTAssertEqual(evaluator.ingest(pose: pose(timestampMs: 920)).state, .holdStill)
    XCTAssertEqual(evaluator.ingest(pose: pose(timestampMs: 960)).state, .ready)
  }

  private func assertReadyWithinOneFrame(
    cadence: [Int],
    untilMs: Int = 3_000,
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    var timestamps: [Int] = []
    var t = 0
    var i = 0
    while t <= untilMs {
      timestamps.append(t)
      t += cadence[i % cadence.count]
      i += 1
    }
    assertReadyWithinOneFrame(
      timestamps: timestamps, maxStepMs: cadence.max() ?? 0, file: file, line: line
    )
  }

  private func assertReadyWithinOneFrame(
    timestamps: [Int],
    maxStepMs: Int,
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    let window = PoseReadinessEvaluator.Config().stableDurationMs
    let evaluator = PoseReadinessEvaluator()
    let origin = timestamps[0]
    var firstReady: (elapsedMs: Int, snapshot: PoseReadinessEvaluator.Snapshot)?
    for timestamp in timestamps {
      let snapshot = evaluator.ingest(pose: pose(timestampMs: timestamp))
      let elapsed = timestamp - origin
      if snapshot.state == .ready {
        XCTAssertGreaterThanOrEqual(
          elapsed, window, "ready after only \(elapsed) ms of stillness", file: file, line: line
        )
        if firstReady == nil { firstReady = (elapsed, snapshot) }
      } else {
        XCTAssertEqual(snapshot.stableForMs, 0, file: file, line: line)
      }
    }
    guard let (elapsed, snapshot) = firstReady.map({ ($0.elapsedMs, $0.snapshot) }) else {
      XCTFail("never ready within \(timestamps.last! - origin) ms of stillness", file: file, line: line)
      return
    }
    XCTAssertLessThanOrEqual(
      elapsed, window + maxStepMs,
      "first ready at \(elapsed) ms; expected within one frame (\(maxStepMs) ms) of the \(window) ms window",
      file: file, line: line
    )
    XCTAssertGreaterThanOrEqual(snapshot.stableForMs, window, file: file, line: line)
    XCTAssertEqual(snapshot.stableForMs, elapsed, file: file, line: line)
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
