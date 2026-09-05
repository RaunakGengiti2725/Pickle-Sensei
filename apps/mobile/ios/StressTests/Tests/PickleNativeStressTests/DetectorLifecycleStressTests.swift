import Foundation
import XCTest
@testable import PickleNativeStressCore
@testable import PickleNativeStressKit

/// Seeded campaigns over the stroke detector, readiness evaluator, evidence
/// accumulator and motion trail: two people, rapid start/stop (reset), exact
/// retention windows. Each failure names the seed + replay command.
final class DetectorLifecycleStressTests: XCTestCase {
  func testRandomSessionsProduceWellFormedOrderedEvents() {
    let outcomes = StressCampaign.assertHeld(.detectorRandomStream)
    XCTAssertEqual(outcomes.count, StressCampaign.iterations)
  }

  func testRapidResetNeverLeaksHistoryAcrossStarts() {
    let outcomes = StressCampaign.assertHeld(.detectorRapidReset)
    let resets = outcomes.reduce(0.0) { $0 + ($1.metrics["resets"] ?? 0) }
    XCTAssertGreaterThan(resets, 0)
  }

  func testTwoPeopleAlternatingAsPrimaryDoesNotSpoofStrokes() {
    let outcomes = StressCampaign.assertHeld(.twoPeopleAlternating)
    let flips = outcomes.reduce(0.0) { $0 + ($1.metrics["flips"] ?? 0) }
    XCTAssertGreaterThan(flips, 0)
  }

  func testEvidenceRetentionMatchesAnIndependentWindowModel() {
    _ = StressCampaign.assertHeld(.evidenceRetentionExact)
  }

  func testReadinessStateMachineInvariants() {
    _ = StressCampaign.assertHeld(.readinessRandom)
  }

  func testMotionTrailStaysBoundedAndInsideTheFrame() {
    _ = StressCampaign.assertHeld(.motionTrailRandom)
  }

  func testStartStopStormOnFreshDetectorsIsAllocationNeutral() throws {
    // Rapid start/stop as the guided controller performs it: a fresh detector
    // + evaluator + accumulator per start, a handful of frames, then drop.
    var rng = StressRNG(seed: 99)
    let athlete = PoseSynth.Athlete.readyFraming(&rng)
    var t = 0
    func cycle() {
      let detector = TemporalStrokeDetector()
      let readiness = PoseReadinessEvaluator()
      let evidence = CaptureEvidenceAccumulator()
      let stream = SessionMotionStream()
      for _ in 0 ..< rng.int(in: 0 ... 12) {
        t += 16
        let frame = PoseSynth.frame(athlete, arm: .still, timestampMs: t, rng: &rng)
        _ = detector.ingest(pose: frame, paddle: nil)
        _ = readiness.ingest(pose: frame)
        evidence.ingest(pose: frame)
        _ = stream.ingest(pose: frame)
      }
      detector.reset()
      readiness.reset()
      evidence.reset()
    }
    for _ in 0 ..< 500 { cycle() }
    let before = try XCTUnwrap(ProcessMemory.residentBytes())
    let cycles = StressCampaign.iterations * 200
    for _ in 0 ..< cycles { cycle() }
    let after = try XCTUnwrap(ProcessMemory.residentBytes())
    XCTAssertLessThan(after - before, 32 * 1024 * 1024, "\(cycles) start/stop cycles grew RSS by \(after - before) bytes")
  }
}
