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

  /// A still body at 30 fps (`CameraEngine` stamps `Int((seconds * 1000).rounded())`,
  /// so 33/34 ms steps) must be ready on every frame once 450 ms of stillness
  /// have been observed — no frame lands exactly on `t - 450` at this cadence.
  func testStillBodyAt30FpsIsReadyOnEveryFrameAfterTheWindow() {
    let evaluator = PoseReadinessEvaluator()
    var notReady: [Int] = []
    var eligible = 0
    for index in 0 ..< 150 {
      let t = Int((Double(index) / 30.0 * 1_000).rounded())
      let snapshot = evaluator.ingest(pose: pose(timestampMs: t))
      guard t >= 450 else {
        XCTAssertEqual(snapshot.state, .holdStill, "t=\(t)")
        continue
      }
      eligible += 1
      if !snapshot.isReady { notReady.append(t) }
    }
    XCTAssertEqual(eligible, 136)
    XCTAssertEqual(notReady, [], "30 fps still body not ready at \(notReady)")
  }

  /// 60 fps with the ~30 % of frames the capture path skips while Vision is
  /// in flight (seeded, replayable). Readiness is measured from the first
  /// OBSERVED frame: the evaluator cannot vouch for stillness before it.
  func testStillBodyAt60FpsWithDroppedFramesIsReadyOnEveryFrameAfterTheWindow() {
    let evaluator = PoseReadinessEvaluator()
    var rng = SplitMix64(seed: 1_683_590_610)
    var firstObservedMs: Int?
    var notReady: [Int] = []
    var eligible = 0
    for index in 0 ..< 600 {
      if rng.next() % 10 < 3 { continue }
      let t = Int((Double(index) / 60.0 * 1_000).rounded())
      let snapshot = evaluator.ingest(pose: pose(timestampMs: t))
      let first = firstObservedMs ?? t
      firstObservedMs = first
      guard t - first >= 450 else {
        XCTAssertEqual(snapshot.state, .holdStill, "t=\(t)")
        continue
      }
      eligible += 1
      if !snapshot.isReady { notReady.append(t) }
    }
    XCTAssertEqual(firstObservedMs, 50)
    XCTAssertGreaterThan(eligible, 300)
    XCTAssertEqual(notReady, [], "60 fps with drops not ready at \(notReady)")
  }

  /// The window anchor is the newest sample at or before `t - 450`, never an
  /// older one: a body that stepped 460 ms ago and has been still since is
  /// ready, but 440 ms of stillness after a step is not.
  func testWindowAnchorIsTheNewestSampleOutsideTheWindow() {
    let evaluator = PoseReadinessEvaluator()
    _ = evaluator.ingest(pose: pose(timestampMs: 0))
    _ = evaluator.ingest(pose: pose(timestampMs: 200))
    _ = evaluator.ingest(pose: pose(timestampMs: 400, xOffset: 0.2))
    _ = evaluator.ingest(pose: pose(timestampMs: 600, xOffset: 0.2))
    let early = evaluator.ingest(pose: pose(timestampMs: 840, xOffset: 0.2))
    XCTAssertEqual(early.state, .holdStill)
    XCTAssertEqual(early.stableForMs, 0)
    let ready = evaluator.ingest(pose: pose(timestampMs: 860, xOffset: 0.2))
    XCTAssertEqual(ready.state, .ready)
    XCTAssertEqual(ready.stableForMs, 460)
  }

  func testDuplicateLandmarkNamesKeepTheMoreVisibleSampleWithoutTrapping() {
    let evaluator = PoseReadinessEvaluator()
    let base = pose(timestampMs: 0)
    let duplicated = PoseFrame(
      timestampMs: 0,
      landmarks: base.landmarks + [PoseLandmark(name: "left_ankle", x: 0.44, y: 0.99, visibility: 0.5)],
      confidence: base.confidence
    )
    let snapshot = evaluator.ingest(pose: duplicated)
    // The lower-visibility duplicate at y=0.99 would breach the frame margin.
    XCTAssertEqual(snapshot.state, .holdStill)
    XCTAssertEqual(snapshot.missingJoints, [])
  }

  private struct SplitMix64 {
    private var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
      state &+= 0x9E37_79B9_7F4A_7C15
      var z = state
      z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
      z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
      return z ^ (z >> 31)
    }
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
