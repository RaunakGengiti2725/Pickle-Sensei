import Foundation
import XCTest

@testable import PickleVisionCore

/// Adjudicator reproductions for stress area `native` (base 1fb0efd7).
/// Each test asserts the CORRECT behaviour, so it is red until the defect is
/// fixed; the class is skipped unless ADJUDICATE_REPRO=1 so the regular suite
/// stays green. Linux plane:
///   ADJUDICATE_REPRO=1 native/vision-core/scripts/linux-shadow-test.sh \
///     --filter AdjudicationReproTests
/// Apple plane: ADJUDICATE_REPRO=1 swift test --filter AdjudicationReproTests
final class AdjudicationReproTests: XCTestCase {
  override func setUpWithError() throws {
    try XCTSkipUnless(
      ProcessInfo.processInfo.environment["ADJUDICATE_REPRO"] == "1",
      "known-failing defect reproductions; set ADJUDICATE_REPRO=1 to run"
    )
  }

  // MARK: - NATIVE-1: PoseReadinessEvaluator ready only on exact 450 ms alignment

  /// A perfectly still, fully framed body at 30 fps (33/34 ms steps, the
  /// cadence `CameraEngine` stamps with `Int((seconds * 1000).rounded())`)
  /// must be `ready` on every frame once 450 ms have elapsed.
  func testStillBodyAt30FpsIsReadyAfterStillnessWindow() {
    let evaluator = PoseReadinessEvaluator()
    var readyFrames = 0
    var eligible = 0
    for index in 0 ..< 150 {
      let t = Int((Double(index) / 30.0 * 1_000).rounded())
      let snapshot = evaluator.ingest(pose: Self.stillBody(at: t))
      guard t >= 450 else { continue }
      eligible += 1
      if snapshot.isReady { readyFrames += 1 }
    }
    XCTAssertEqual(readyFrames, eligible, "30 fps still body: ready on \(readyFrames)/\(eligible) frames after 450 ms")
  }

  /// Same body at exactly 60 fps with NO dropped frames aligns (27 × 16.667 ms
  /// = 450 ms) and is ready — this pins the mechanism: the defect is cadence
  /// alignment, not the stillness thresholds.
  func testStillBodyAt60FpsWithoutDropsIsReady() {
    let evaluator = PoseReadinessEvaluator()
    var readyFrames = 0
    var eligible = 0
    for index in 0 ..< 300 {
      let t = Int((Double(index) / 60.0 * 1_000).rounded())
      let snapshot = evaluator.ingest(pose: Self.stillBody(at: t))
      guard t >= 450 else { continue }
      eligible += 1
      if snapshot.isReady { readyFrames += 1 }
    }
    XCTAssertEqual(readyFrames, eligible, "60 fps still body: ready on \(readyFrames)/\(eligible)")
  }

  /// 60 fps with the frame gate `GuidedCaptureViewController.handleFrame`
  /// applies (frames arriving while Vision is in flight are skipped): a
  /// seeded ~30% drop pattern. Deterministic replay via the fixed seed.
  func testStillBodyAt60FpsWithVisionFrameDropsIsReady() {
    let seed: UInt64 = 1_683_590_610
    var rng = SplitMix64(seed: seed)
    let evaluator = PoseReadinessEvaluator()
    var readyFrames = 0
    var eligible = 0
    for index in 0 ..< 600 {
      if rng.next() % 10 < 3 { continue }
      let t = Int((Double(index) / 60.0 * 1_000).rounded())
      let snapshot = evaluator.ingest(pose: Self.stillBody(at: t))
      guard t >= 450 else { continue }
      eligible += 1
      if snapshot.isReady { readyFrames += 1 }
    }
    XCTAssertEqual(readyFrames, eligible, "seed \(seed): 60 fps with drops, ready on \(readyFrames)/\(eligible)")
  }

  // MARK: - NATIVE-2 (deferred P3): non-finite landmark coordinates are not rejected

  /// One landmark with an infinite coordinate poisons the detector's body-scale
  /// EMA (NaN) permanently and makes `SessionMotionStream` emit a non-finite
  /// speed. Production `PoseFrame`s only come from `ApplePoseProvider`
  /// (Vision-normalised points), so this is a hardening gap, not a live path.
  func testInfiniteLandmarkDoesNotPoisonDetectorOrMotionStream() {
    let detector = TemporalStrokeDetector()
    let stream = SessionMotionStream()
    _ = detector.ingest(pose: Self.stillBody(at: 0), paddle: nil)
    _ = stream.ingest(pose: Self.stillBody(at: 0))
    let corrupt = PoseFrame(
      timestampMs: 33,
      landmarks: Self.stillBody(at: 33).landmarks.map {
        PoseLandmark(
          name: $0.name,
          x: $0.name == "right_wrist" ? .infinity : $0.x,
          y: $0.name == "right_ankle" ? .infinity : $0.y,
          visibility: $0.visibility
        )
      },
      confidence: 0.95
    )
    _ = detector.ingest(pose: corrupt, paddle: nil)
    let sample = stream.ingest(pose: corrupt)
    XCTAssertTrue(sample?.value.isFinite ?? true, "SessionMotionStream emitted non-finite speed \(String(describing: sample?.value))")
    for index in 2 ..< 300 {
      _ = detector.ingest(pose: Self.stillBody(at: index * 33), paddle: nil)
    }
    XCTAssertTrue(detector.lastBodyScale?.isFinite ?? true, "lastBodyScale=\(String(describing: detector.lastBodyScale)) after 10 s of clean frames")
  }

  // MARK: - Fixtures

  private static func stillBody(at timestampMs: Int) -> PoseFrame {
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
      landmarks: points.map { PoseLandmark(name: $0.0, x: $0.1, y: $0.2, visibility: 0.95) },
      confidence: 0.95
    )
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
}
