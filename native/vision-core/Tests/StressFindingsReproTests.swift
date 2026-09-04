import Foundation
import XCTest

@testable import PickleVisionCore

/// Deterministic reproductions of defects surfaced by the stress campaigns.
/// Each test asserts the CORRECT behaviour and is therefore expected to FAIL
/// until the underlying defect is fixed. They are skipped unless
/// STRESS_FINDINGS=1 so the regular suite stays green; run them with
///   STRESS_FINDINGS=1 swift test --filter StressFindingsReproTests
/// Once a defect is fixed, drop the skip guard on its test and keep it as
/// the regression pin.
final class StressFindingsReproTests: XCTestCase {
  override func setUpWithError() throws {
    try XCTSkipUnless(
      ProcessInfo.processInfo.environment["STRESS_FINDINGS"] == "1",
      "known-failing defect reproductions; set STRESS_FINDINGS=1 to run"
    )
  }

  /// F1 — PoseReadinessEvaluator only reports `ready` when a stability sample
  /// exists EXACTLY `stableDurationMs` before the current frame
  /// (PoseReadinessEvaluator.swift:173-176,180: the window prunes samples
  /// older than `t - 450` and `stableForMs = t - oldest`, so `stableForMs`
  /// can only equal 450 when a sample landed on that exact millisecond).
  /// CameraEngine stamps frames with `Int((seconds * 1000).rounded())`
  /// (native/camera-engine/Sources/CameraEngine.swift:674), i.e. 33/34 ms
  /// steps at 30 fps and 16/17 ms at 60 fps — `t - 450` is almost never a
  /// frame timestamp. A perfectly still, perfectly framed athlete is
  /// therefore reported `holdStill` on most frames, and `ready` only on the
  /// frames where the rounding happens to line up.
  func testF1_StillFramedBodyBecomesReadyAtRealCameraCadence() {
    for fps in [24.0, 25.0, 30.0, 60.0] {
      let evaluator = PoseReadinessEvaluator()
      var readyFrames = 0
      var eligibleFrames = 0
      var firstReadyMs: Int?
      let totalFrames = Int(fps * 5)
      for index in 0 ..< totalFrames {
        let t = Int((Double(index) / fps * 1_000).rounded())
        let snapshot = evaluator.ingest(pose: PoseFixture.frame(at: t))
        if t >= 450 {
          eligibleFrames += 1
          if snapshot.isReady {
            readyFrames += 1
            if firstReadyMs == nil { firstReadyMs = t }
          }
        }
      }
      XCTAssertEqual(
        readyFrames,
        eligibleFrames,
        "\(fps) fps: a still framed body should be ready on every frame after 450 ms; "
          + "ready on \(readyFrames)/\(eligibleFrames), first ready at \(firstReadyMs.map(String.init) ?? "never")"
      )
    }
  }

  /// F2 — TemporalStrokeDetector folds ANY measurable shoulder→ankle span into
  /// its body-scale EMA without checking that the coordinates are finite or
  /// inside the image (TemporalStrokeDetector.swift:424-460). One frame with
  /// an infinite landmark y makes `lastBodyScale` +inf, the next EMA step
  /// turns it into NaN (inf + 0.3 × (x − inf)), every later wrist speed is
  /// `distance / NaN`, and no stroke can ever be detected again until
  /// `reset()`. CaptureEvidenceAccumulator and PoseMotionTrailBuffer reject
  /// non-finite / out-of-range landmarks at ingest; the detector does not.
  func testF2_SingleInfiniteLandmarkDoesNotPoisonBodyScaleForever() {
    let detector = TemporalStrokeDetector()
    var poisoned = PoseFixture.frame(at: 0).landmarks
    poisoned = poisoned.map { $0.name == "left_shoulder" ? PoseLandmark(name: $0.name, x: $0.x, y: -.infinity, visibility: 0.95) : $0 }
    _ = detector.ingest(pose: PoseFrame(timestampMs: 0, landmarks: poisoned, confidence: 0.95), paddle: nil)

    // Ten seconds of clean, perfectly measurable frames then a canonical swing.
    var t = 33
    while t < 10_000 {
      _ = detector.ingest(pose: PoseFixture.frame(at: t), paddle: nil)
      t += 33
    }
    let scale: Double? = detector.lastBodyScale
    let scaleText = scale.map { String(describing: $0) } ?? "nil"
    XCTAssertTrue(scale?.isFinite ?? false, "body scale should recover on clean frames; lastBodyScale=\(scaleText)")
    let events = PoseFixture.swing(startMs: t).compactMap { detector.ingest(pose: $0, paddle: nil) }
    XCTAssertEqual(events.count, 1, "canonical swing after one corrupt frame + 10 s of clean frames should still be detected")
  }

  /// F2 (seeded variant) — astronomically large FINITE coordinates: the EMA
  /// stays finite but needs ~1 900 clean frames (≈ 60 s at 30 fps) to decay
  /// from 1e300 back to a body height, suppressing detection meanwhile.
  func testF2_HugeFiniteLandmarkDoesNotSuppressDetectionForSeconds() {
    StressCampaign.run("findings.F2-body-scale-poison", campaignIndex: 92) { rng, seed in
      let detector = TemporalStrokeDetector()
      var t = 0
      for _ in 0 ..< rng.int(in: 1 ... 40) {
        t += 33
        _ = detector.ingest(pose: PoseFixture.corrupt(at: t, rng: &rng), paddle: nil)
      }
      // 5 s of clean frames is far more than the 350 ms quiet run needs.
      let swing = PoseFixture.swing(startMs: t + 3_000, quietMs: 5_000)
      let events = swing.compactMap { detector.ingest(pose: $0, paddle: nil) }
      let scaleText = detector.lastBodyScale.map { String(describing: $0) } ?? "nil"
      return events.count == 1
        ? []
        : ["\(events.count) events after corrupt burst + 5 s clean frames; lastBodyScale=\(scaleText)"]
    }
  }

  /// F1 (seeded variant) — same as above with the frame drops a real capture
  /// session has (GuidedCaptureViewController skips frames while Vision is
  /// in flight), so the cadence is an irregular mix of 33/34/67/100 ms.
  func testF1_StillBodyWithVisionFrameDropsBecomesReady() {
    StressCampaign.run("findings.F1-readiness-cadence", campaignIndex: 91) { rng, seed in
      let evaluator = PoseReadinessEvaluator()
      var t = 0
      var readyFrames = 0
      var eligible = 0
      var firstReadyMs: Int?
      for _ in 0 ..< 150 {
        t += rng.pick([33, 34, 33, 34, 67, 100])
        let snapshot = evaluator.ingest(pose: PoseFixture.frame(at: t))
        if t >= 450 {
          eligible += 1
          if snapshot.isReady {
            readyFrames += 1
            if firstReadyMs == nil { firstReadyMs = t }
          }
        }
      }
      return readyFrames == eligible
        ? []
        : ["ready on \(readyFrames)/\(eligible) frames after 450 ms of stillness (first ready: \(firstReadyMs.map(String.init) ?? "never"))"]
    }
  }
}
