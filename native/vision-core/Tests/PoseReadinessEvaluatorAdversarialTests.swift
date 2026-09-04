import XCTest
@testable import PickleVisionCore

/// Adversarial probes for the NVC-1 (frame cadence) and NVC-3 (duplicate
/// landmark names) fix in `PoseReadinessEvaluator`.
final class PoseReadinessEvaluatorAdversarialTests: XCTestCase {
  private let window = PoseReadinessEvaluator.Config().stableDurationMs

  // MARK: - NVC-1 cadence: exhaustive sweep, rounding modes, jitter, drops

  /// Every integer fps from 1 to 120 under all three integer-ms rounding
  /// modes a capture pipeline might use. A still body must arm within the
  /// window plus two frame intervals and must never lose `ready` afterwards.
  func testEveryCadenceAndRoundingModeReachesReadyAndHoldsIt() {
    for fps in 1...120 {
      let modes: [(String, FloatingPointRoundingRule)] = [
        ("round", .toNearestOrAwayFromZero), ("floor", .down), ("ceil", .up),
      ]
      for (modeName, rule) in modes {
        let interval = Int((1000.0 / Double(fps)).rounded(.up))
        let durationMs = max(1_500, window + 4 * interval)
        let timestamps = cadence(fps: fps, durationMs: durationMs, rule: rule)
        let evaluator = PoseReadinessEvaluator()
        var firstReady: Int?
        for ts in timestamps {
          let snapshot = evaluator.ingest(pose: stillPose(timestampMs: ts))
          if snapshot.state == .ready {
            if firstReady == nil { firstReady = ts }
            XCTAssertGreaterThanOrEqual(
              snapshot.stableForMs, window,
              "\(fps) fps/\(modeName) ready with stableForMs=\(snapshot.stableForMs) at \(ts)"
            )
          } else if firstReady != nil {
            XCTFail("\(fps) fps/\(modeName): ready revoked at \(ts) ms (state=\(snapshot.state.rawValue))")
          }
        }
        XCTAssertNotNil(firstReady, "\(fps) fps/\(modeName) never reached ready in \(durationMs) ms")
        if let firstReady {
          XCTAssertLessThanOrEqual(
            firstReady, window + 2 * interval,
            "\(fps) fps/\(modeName) first ready at \(firstReady)"
          )
        }
      }
    }
  }

  /// Real cameras jitter: ±3 ms per frame plus a random 15 % frame loss.
  func testJitteredCadenceWithRandomFrameLossReachesReadyAndHoldsIt() {
    for seed in UInt64(1)...UInt64(32) {
      var rng = SplitMix64(seed: seed)
      for fps in [24, 25, 30, 50, 60, 120] {
        let base = cadence(fps: fps, durationMs: 3_000, rule: .toNearestOrAwayFromZero)
        var timestamps: [Int] = []
        var last = -1
        for ts in base {
          if Double(rng.next() % 1000) / 1000.0 < 0.15 { continue }
          let jittered = max(last + 1, ts + Int(rng.next() % 7) - 3)
          timestamps.append(jittered)
          last = jittered
        }
        let maxGap = zip(timestamps.dropFirst(), timestamps).map { $0 - $1 }.max() ?? 0
        let evaluator = PoseReadinessEvaluator()
        var firstReady: Int?
        for ts in timestamps {
          let state = evaluator.ingest(pose: stillPose(timestampMs: ts)).state
          if state == .ready {
            if firstReady == nil { firstReady = ts }
          } else if firstReady != nil {
            XCTFail("seed \(seed) \(fps) fps: ready revoked at \(ts) (state=\(state.rawValue))")
          }
        }
        XCTAssertNotNil(firstReady, "seed \(seed) \(fps) fps never reached ready")
        if let firstReady, let firstFrame = timestamps.first {
          XCTAssertLessThanOrEqual(
            firstReady, firstFrame + window + maxGap,
            "seed \(seed) \(fps) fps first ready at \(firstReady), firstFrame=\(firstFrame) maxGap=\(maxGap)"
          )
        }
      }
    }
  }

  /// One, two and three consecutive dropped frames at 24/25/30 fps must not
  /// revoke an already-`ready` evaluator.
  func testUpToThreeDroppedFramesNeverRevokeReadyAtLowCadences() {
    for fps in [24, 25, 30] {
      for drop in 1...3 {
        let timestamps = cadence(fps: fps, durationMs: 3_000, rule: .toNearestOrAwayFromZero)
        let evaluator = PoseReadinessEvaluator()
        var readyIndex: Int?
        for (index, ts) in timestamps.enumerated()
        where evaluator.ingest(pose: stillPose(timestampMs: ts)).state == .ready {
          readyIndex = index
          break
        }
        guard let readyIndex else { return XCTFail("\(fps) fps never ready") }
        for ts in timestamps[(readyIndex + 1 + drop)...] {
          let snapshot = evaluator.ingest(pose: stillPose(timestampMs: ts))
          XCTAssertEqual(snapshot.state, .ready, "\(fps) fps: \(drop) dropped frame(s) revoked ready at \(ts)")
        }
      }
    }
  }

  /// A still 60 fps run for 60 s: `ready` must be continuous and the
  /// evaluator must stay O(window) — 3 600 ingests well under a second.
  func testSixtySecondsStillAt60FpsStaysReadyAndBounded() {
    let evaluator = PoseReadinessEvaluator()
    let timestamps = cadence(fps: 60, durationMs: 60_000, rule: .toNearestOrAwayFromZero)
    let started = Date()
    var readySince: Int?
    for ts in timestamps {
      let snapshot = evaluator.ingest(pose: stillPose(timestampMs: ts))
      if snapshot.state == .ready {
        if readySince == nil { readySince = ts }
        XCTAssertLessThanOrEqual(
          snapshot.stableForMs, window + 2 * 17,
          "stableForMs=\(snapshot.stableForMs) at \(ts) exceeds window + 2 frames"
        )
      } else if readySince != nil {
        XCTFail("ready revoked at \(ts)")
      }
    }
    XCTAssertNotNil(readySince)
    XCTAssertLessThan(Date().timeIntervalSince(started), 1.0)
  }

  // MARK: - NVC-1 semantics that must NOT have regressed

  /// A walking athlete (centre drifting 0.02 per frame) never becomes ready
  /// at any cadence — the anchor must not weaken the travel gate.
  func testWalkingAthleteNeverReadyAtAnyCadence() {
    for fps in [24, 30, 60] {
      let evaluator = PoseReadinessEvaluator()
      var x = 0.0
      for ts in cadence(fps: fps, durationMs: 3_000, rule: .toNearestOrAwayFromZero) {
        x += 0.02
        if x > 0.3 { x = -0.3 }
        XCTAssertNotEqual(
          evaluator.ingest(pose: stillPose(timestampMs: ts, xOffset: x)).state, .ready,
          "\(fps) fps walking ready at \(ts)"
        )
      }
    }
  }

  /// A step (> travel tolerance) taken 1 ms before the window would have
  /// completed restarts the window: ready must come no earlier than
  /// `window` ms after the step, and the pre-step anchor must be discarded.
  func testStepJustBeforeWindowCompletionRestartsFromTheStep() {
    let evaluator = PoseReadinessEvaluator()
    var ts = 0
    while ts < 440 {
      XCTAssertEqual(evaluator.ingest(pose: stillPose(timestampMs: ts)).state, .holdStill)
      ts += 20
    }
    XCTAssertEqual(evaluator.ingest(pose: stillPose(timestampMs: 449, xOffset: 0.2)).state, .holdStill)
    var firstReady: Int?
    for after in stride(from: 470, through: 1_200, by: 20) {
      if evaluator.ingest(pose: stillPose(timestampMs: after, xOffset: 0.2)).state == .ready {
        firstReady = after
        break
      }
    }
    XCTAssertNotNil(firstReady)
    if let firstReady { XCTAssertGreaterThanOrEqual(firstReady, 449 + window) }
  }

  /// Returning to the ORIGINAL spot after a step must not resurrect the
  /// pre-step evidence (an anchor from before the step would be at the same
  /// place as the athlete now).
  func testReturningToOriginalSpotDoesNotResurrectPreStepEvidence() {
    let evaluator = PoseReadinessEvaluator()
    for ts in stride(from: 0, through: 600, by: 20) {
      _ = evaluator.ingest(pose: stillPose(timestampMs: ts))
    }
    XCTAssertEqual(evaluator.ingest(pose: stillPose(timestampMs: 620)).state, .ready)
    XCTAssertEqual(evaluator.ingest(pose: stillPose(timestampMs: 640, xOffset: 0.2)).state, .holdStill)
    let back = evaluator.ingest(pose: stillPose(timestampMs: 660))
    XCTAssertEqual(back.state, .holdStill, "returned to original spot: stale evidence must not make it ready")
    XCTAssertEqual(back.stableForMs, 0)
    var firstReady: Int?
    for ts in stride(from: 680, through: 1_400, by: 20)
    where evaluator.ingest(pose: stillPose(timestampMs: ts)).state == .ready {
      firstReady = ts
      break
    }
    XCTAssertNotNil(firstReady)
    if let firstReady { XCTAssertGreaterThanOrEqual(firstReady, 660 + window) }
  }

  /// A missing-pose frame (Vision found nobody) clears every sample
  /// INCLUDING the anchor: the next pose must start the window from zero.
  func testMissingFrameAfterReadyClearsTheAnchorToo() {
    let evaluator = PoseReadinessEvaluator()
    for ts in stride(from: 0, through: 600, by: 20) { _ = evaluator.ingest(pose: stillPose(timestampMs: ts)) }
    XCTAssertEqual(evaluator.ingest(pose: stillPose(timestampMs: 620)).state, .ready)
    XCTAssertEqual(evaluator.ingestMissing(timestampMs: 640).state, .noPerson)
    let next = evaluator.ingest(pose: stillPose(timestampMs: 660))
    XCTAssertEqual(next.state, .holdStill)
    XCTAssertEqual(next.stableForMs, 0)
    // Same for a low-confidence pose and for a framing failure.
    for ts in stride(from: 680, through: 1_200, by: 20) { _ = evaluator.ingest(pose: stillPose(timestampMs: ts)) }
    XCTAssertEqual(evaluator.ingest(pose: stillPose(timestampMs: 1_220)).state, .ready)
    XCTAssertEqual(evaluator.ingest(pose: stillPose(timestampMs: 1_240, confidence: 0.1)).state, .noPerson)
    XCTAssertEqual(evaluator.ingest(pose: stillPose(timestampMs: 1_260)).state, .holdStill)
    for ts in stride(from: 1_280, through: 1_800, by: 20) { _ = evaluator.ingest(pose: stillPose(timestampMs: ts)) }
    XCTAssertEqual(evaluator.ingest(pose: stillPose(timestampMs: 1_820)).state, .ready)
    XCTAssertEqual(
      evaluator.ingest(pose: stillPose(timestampMs: 1_840, removing: ["left_ankle"])).state,
      .fullBodyRequired
    )
    XCTAssertEqual(evaluator.ingest(pose: stillPose(timestampMs: 1_860)).state, .holdStill)
  }

  /// `reset()` discards the anchor as well.
  func testResetDiscardsAnchor() {
    let evaluator = PoseReadinessEvaluator()
    for ts in stride(from: 0, through: 600, by: 20) { _ = evaluator.ingest(pose: stillPose(timestampMs: ts)) }
    XCTAssertEqual(evaluator.ingest(pose: stillPose(timestampMs: 620)).state, .ready)
    evaluator.reset()
    XCTAssertEqual(evaluator.ingest(pose: stillPose(timestampMs: 640)).state, .holdStill)
    XCTAssertEqual(evaluator.ingest(pose: stillPose(timestampMs: 1_000)).state, .holdStill)
  }

  /// Timestamps that go backwards (a late Vision result) or repeat must
  /// neither trap nor produce ready before the window is truthfully spanned.
  func testNonMonotonicAndRepeatedTimestampsNeverTrapOrLie() {
    let evaluator = PoseReadinessEvaluator()
    XCTAssertEqual(evaluator.ingest(pose: stillPose(timestampMs: 100)).state, .holdStill)
    XCTAssertEqual(evaluator.ingest(pose: stillPose(timestampMs: 100)).state, .holdStill)
    XCTAssertEqual(evaluator.ingest(pose: stillPose(timestampMs: 50)).state, .holdStill)
    XCTAssertEqual(evaluator.ingest(pose: stillPose(timestampMs: 400)).state, .holdStill)
    let first = evaluator.ingest(pose: stillPose(timestampMs: 560))
    XCTAssertEqual(first.state, .ready)
    // A late frame older than the anchor: must not report negative or inflated stability.
    let late = evaluator.ingest(pose: stillPose(timestampMs: 30))
    XCTAssertNotEqual(late.state, .ready)
    XCTAssertEqual(late.stableForMs, 0)
    // Extreme values must not overflow.
    let fresh = PoseReadinessEvaluator()
    XCTAssertEqual(fresh.ingest(pose: stillPose(timestampMs: Int.max - 1)).state, .holdStill)
    XCTAssertEqual(fresh.ingest(pose: stillPose(timestampMs: Int.max)).state, .holdStill)
  }

  // MARK: - Gap semantics (documented behaviour of the anchor)

  /// Two still frames separated by an unobserved 5 s gap: the anchor makes
  /// the evaluator arm on the SECOND observation. The evaluator has no
  /// knowledge of frames it was never handed, so the caller owns the gap:
  /// GuidedCaptureViewController feeds `ingestMissing` for every frame with
  /// no pose and ends the session on background/interruption, and
  /// `reset()` clears the anchor (see testResetDiscardsAnchor).
  func testTwoFramesAcrossAnUnobservedGapArmOnTheSecondFrame() {
    let evaluator = PoseReadinessEvaluator()
    XCTAssertEqual(evaluator.ingest(pose: stillPose(timestampMs: 0)).state, .holdStill)
    let snapshot = evaluator.ingest(pose: stillPose(timestampMs: 5_000))
    XCTAssertEqual(snapshot.state, .ready)
    XCTAssertEqual(snapshot.stableForMs, 5_000)
  }

  // MARK: - NVC-3 duplicates: boundary and ordering

  /// Massive duplication, non-finite visibilities and ties must never trap
  /// and must still arm over the window.
  func testPathologicalDuplicateLandmarksNeverTrapAndStillArm() {
    let evaluator = PoseReadinessEvaluator()
    var states: [PoseReadinessEvaluator.State] = []
    for ts in cadence(fps: 30, durationMs: 1_000, rule: .toNearestOrAwayFromZero) {
      var extras: [PoseLandmark] = []
      for (name, x, y) in Self.points {
        for i in 0..<50 {
          let visibility: Double
          switch i % 5 {
          case 0: visibility = .nan
          case 1: visibility = -.infinity
          case 2: visibility = .infinity
          case 3: visibility = 0.95
          default: visibility = 0.34
          }
          extras.append(PoseLandmark(name: name, x: x, y: y, visibility: visibility))
        }
      }
      // Also duplicate names that are not joints at all, and unicode names.
      extras.append(PoseLandmark(name: "", x: 0.5, y: 0.5, visibility: 1))
      extras.append(PoseLandmark(name: "", x: 0.5, y: 0.5, visibility: 1))
      extras.append(PoseLandmark(name: "left_wrist\u{301}", x: 0.99, y: 0.99, visibility: 1))
      extras.append(PoseLandmark(name: "left_wrist\u{301}", x: 0.99, y: 0.99, visibility: 1))
      let snapshot = evaluator.ingest(pose: stillPose(timestampMs: ts, prepending: extras, appending: extras))
      states.append(snapshot.state)
      XCTAssertTrue(snapshot.missingJoints.isEmpty)
      XCTAssertEqual(snapshot.jointCoverage, 1, accuracy: 1e-12)
    }
    XCTAssertTrue(states.contains(.ready), "states=\(states.map(\.rawValue))")
  }

  /// Order independence: the same duplicate set in either order yields the
  /// same framing verdict when visibilities differ.
  func testDuplicateResolutionIsOrderIndependentWhenVisibilitiesDiffer() {
    let inFrame = PoseLandmark(name: "left_wrist", x: 0.40, y: 0.45, visibility: 0.60)
    let outOfFrame = PoseLandmark(name: "left_wrist", x: 0.995, y: 0.45, visibility: 0.90)
    let a = PoseReadinessEvaluator().ingest(
      pose: stillPose(timestampMs: 0, removing: ["left_wrist"], prepending: [inFrame, outOfFrame])
    )
    let b = PoseReadinessEvaluator().ingest(
      pose: stillPose(timestampMs: 0, removing: ["left_wrist"], prepending: [outOfFrame, inFrame])
    )
    XCTAssertEqual(a.state, b.state)
    XCTAssertEqual(a.state, .fullBodyRequired)
    let c = PoseReadinessEvaluator().ingest(
      pose: stillPose(timestampMs: 0, removing: ["left_wrist"], appending: [inFrame, outOfFrame])
    )
    XCTAssertEqual(c.state, .fullBodyRequired)
  }

  /// A duplicate whose visibility is BELOW the threshold must never displace
  /// the visible one, regardless of order.
  func testInvisibleDuplicateNeverDisplacesVisibleLandmark() {
    let invisibleOutOfFrame = PoseLandmark(name: "right_ankle", x: 0.999, y: 0.999, visibility: 0.10)
    let a = PoseReadinessEvaluator().ingest(pose: stillPose(timestampMs: 0, prepending: [invisibleOutOfFrame]))
    let b = PoseReadinessEvaluator().ingest(pose: stillPose(timestampMs: 0, appending: [invisibleOutOfFrame]))
    XCTAssertEqual(a.state, .holdStill)
    XCTAssertEqual(b.state, .holdStill)
    XCTAssertTrue(a.missingJoints.isEmpty)
  }

  /// Duplicates must not inflate joint coverage past 1 or let a body that is
  /// missing mandatory joints pass the coverage gate.
  func testDuplicatesCannotInflateCoverage() {
    let dupes = (0..<40).map { _ in PoseLandmark(name: "left_shoulder", x: 0.43, y: 0.25, visibility: 0.95) }
    let snapshot = PoseReadinessEvaluator().ingest(
      pose: stillPose(timestampMs: 0, removing: ["left_ankle", "right_ankle", "left_knee"], appending: dupes)
    )
    XCTAssertEqual(snapshot.state, .fullBodyRequired)
    XCTAssertEqual(snapshot.jointCoverage, 9.0 / 12.0, accuracy: 1e-12)
    XCTAssertEqual(Set(snapshot.missingJoints), ["left_ankle", "right_ankle", "left_knee"])
  }

  /// Parity with CaptureEvidenceAccumulator: for the same duplicate input,
  /// the landmark readiness evaluates is the one the accumulator keeps.
  func testDuplicateChoiceMatchesCaptureEvidenceAccumulator() {
    let low = PoseLandmark(name: "left_wrist", x: 0.40, y: 0.45, visibility: 0.50)
    let high = PoseLandmark(name: "left_wrist", x: 0.995, y: 0.45, visibility: 0.90)
    let frame = stillPose(timestampMs: 0, removing: ["left_wrist"], prepending: [low], appending: [high])
    let accumulator = CaptureEvidenceAccumulator()
    accumulator.ingest(pose: frame)
    let summary = accumulator.summary(
      startMs: 0, endMs: 0, poseSource: "test", poseModelVersion: "test", triggerAlgorithmVersion: "test"
    )
    XCTAssertNotNil(summary)
    // Both keep the high-visibility wrist: the accumulator counts a full body
    // (it does not gate on framing), readiness fails framing on that wrist.
    XCTAssertEqual(summary?.fullBodyVisibleFrameCount, 1)
    XCTAssertEqual(PoseReadinessEvaluator().ingest(pose: frame).state, .fullBodyRequired)
  }

  // MARK: - Helpers

  private static let points: [(String, Double, Double)] = [
    ("left_shoulder", 0.43, 0.25), ("right_shoulder", 0.57, 0.25),
    ("left_elbow", 0.40, 0.38), ("right_elbow", 0.60, 0.38),
    ("left_wrist", 0.38, 0.50), ("right_wrist", 0.62, 0.50),
    ("left_hip", 0.45, 0.52), ("right_hip", 0.55, 0.52),
    ("left_knee", 0.45, 0.70), ("right_knee", 0.55, 0.70),
    ("left_ankle", 0.44, 0.90), ("right_ankle", 0.56, 0.90),
  ]

  private func cadence(fps: Int, durationMs: Int, rule: FloatingPointRoundingRule) -> [Int] {
    let frameCount = durationMs * fps / 1000
    return (0...frameCount).map { Int((Double($0) * 1000.0 / Double(fps)).rounded(rule)) }
  }

  private func stillPose(
    timestampMs: Int,
    xOffset: Double = 0,
    confidence: Double = 0.95,
    removing names: Set<String> = [],
    prepending leading: [PoseLandmark] = [],
    appending trailing: [PoseLandmark] = []
  ) -> PoseFrame {
    let landmarks: [PoseLandmark] = Self.points.compactMap { name, x, y in
      guard !names.contains(name) else { return nil }
      return PoseLandmark(name: name, x: x + xOffset, y: y, visibility: 0.95)
    }
    return PoseFrame(timestampMs: timestampMs, landmarks: leading + landmarks + trailing, confidence: confidence)
  }
}

private struct SplitMix64 {
  private var state: UInt64
  init(seed: UInt64) { state = seed &+ 0x9E37_79B9_7F4A_7C15 }
  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }
}
