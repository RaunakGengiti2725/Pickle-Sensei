import Foundation
import XCTest
@testable import PickleNativeStressCore
@testable import PickleNativeStressKit

/// Long-running loops watching resident memory. Iteration count follows
/// `STRESS_ITER` (heavy scenario: iterations/25, minimum 1 → 60 000 frames).
final class MemoryPressureStressTests: XCTestCase {
  func testSixtyThousandFrameSessionsKeepResidentMemoryBounded() {
    let outcomes = StressCampaign.assertHeld(.memoryPressureLoop)
    XCTAssertEqual(outcomes.count, StressScenario.memoryPressureLoop.campaignIterations())
    for outcome in outcomes {
      XCTAssertGreaterThan(outcome.metrics["rssBeforeBytes"] ?? 0, 0, "seed \(outcome.seed): no RSS reading")
    }
  }

  func testAccumulatorsStayBoundedThroughLongSyntheticPlay() {
    // One minute of 60 fps play per STRESS_ITER (25 min by default) through
    // the retention-bearing components; every cap must hold regardless of
    // how long the session runs.
    var rng = StressRNG(seed: 0x5EED)
    let athlete = PoseSynth.Athlete.readyFraming(&rng)
    let evidence = CaptureEvidenceAccumulator(retentionMs: 4_000)
    let monitor = StrokeCompletionMonitor()
    var trail = PoseMotionTrailBuffer()
    let stream = SessionMotionStream()
    var t = 0
    let frames = 3_600 * StressCampaign.iterations
    for index in 0 ..< frames {
      t += 16
      let arm: PoseSynth.Arm = index % 240 < 40 ? .swing(phase: Double(index % 240) / 40, amplitude: 0.85) : .still
      let frame = PoseSynth.frame(athlete, arm: arm, timestampMs: t, rng: &rng)
      evidence.ingest(pose: frame)
      monitor.ingest(pose: frame)
      monitor.observeFrame(timestampMs: t)
      trail.ingest(landmarks: frame.landmarks, timestampMs: t)
      _ = stream.ingest(pose: frame)
    }
    let summary = evidence.summary(startMs: 0, endMs: t, poseSource: "s", poseModelVersion: "m", triggerAlgorithmVersion: "a")
    XCTAssertLessThanOrEqual(summary?.analysisInputFrameCount ?? 0, 4_000 / 16 + 2, "evidence retained more than its 4 s window")
    XCTAssertLessThanOrEqual(monitor.telemetry(strategy: .fixed, finalizeMs: t).observedSampleCount, 512)
    XCTAssertLessThanOrEqual(trail.storedSampleCount, 8 * 8)
  }
}
