import Foundation
import XCTest
@testable import PickleNativeStressCore
@testable import PickleNativeStressKit

/// Imported-video extraction loop MODEL (see `ImportExtractionModel`): empty
/// media, one frame, 10-minute 240 fps timelines, rewinding PTS, and a provider
/// that throws every `VisionFailure` — including `.cancelled` — mid-sequence.
final class ImportExtractionStressTests: XCTestCase {
  private func stillFrames(_ count: Int, seed: UInt64) -> [ScriptedPoseProvider.Step] {
    var rng = StressRNG(seed: seed)
    let athlete = PoseSynth.Athlete.readyFraming(&rng)
    return (0 ..< count).map { _ in .pose(PoseSynth.frame(athlete, arm: .still, timestampMs: 0, rng: &rng)) }
  }

  func testSeededTimelinesHoldDecimationCapAndGapInvariants() {
    let outcomes = StressCampaign.assertHeld(.importExtractionModel)
    XCTAssertEqual(outcomes.count, StressCampaign.iterations)
    XCTAssertGreaterThan(outcomes.reduce(0.0) { $0 + ($1.metrics["scriptedGaps"] ?? 0) }, 0)
  }

  func testEmptyMediaIsInvalidNotNoPerson() {
    let (result, trace) = ImportExtractionModel.run(samples: [], durationSeconds: 5, provider: ScriptedPoseProvider(steps: []))
    XCTAssertEqual(result, .invalidMedia)
    XCTAssertEqual(trace.providerCalls, 0)
    let nonNumeric = (0 ..< 100).map { _ in ImportExtractionModel.Sample(presentationSeconds: nil) }
    XCTAssertEqual(ImportExtractionModel.run(samples: nonNumeric, durationSeconds: 5, provider: ScriptedPoseProvider(steps: [])).0, .invalidMedia)
  }

  func testOneFrameProducesAOneFrameSequenceAtZero() {
    let (result, trace) = ImportExtractionModel.run(
      samples: [.init(presentationSeconds: 12.345)],
      durationSeconds: 1.0 / 30,
      provider: ScriptedPoseProvider(steps: stillFrames(1, seed: 3))
    )
    XCTAssertEqual(result, .sequence(framesWithPose: 1, framesTotal: 1, lastKeptTimestampMs: 0, reachedCap: false))
    XCTAssertEqual(trace.poses.map(\.timestampMs), [0])
    XCTAssertEqual(trace.progress.first, 0)
    XCTAssertEqual(trace.progress.last, 1)
  }

  func testHugeSlowMotionTimelineIsCappedAndDecimated() {
    let fps = 240.0
    let seconds = 600.0
    let samples = (0 ..< Int(fps * seconds)).map { ImportExtractionModel.Sample(presentationSeconds: Double($0) / fps) }
    let (result, trace) = ImportExtractionModel.run(
      samples: samples,
      durationSeconds: seconds,
      provider: ScriptedPoseProvider(steps: stillFrames(4_000, seed: 4))
    )
    guard case .sequence(let withPose, let total, let lastKept, let reachedCap) = result else {
      return XCTFail("expected a sequence, got \(result)")
    }
    XCTAssertTrue(reachedCap)
    XCTAssertEqual(withPose, total)
    XCTAssertLessThanOrEqual(total, Int(60_000 / ImportExtractionModel.minimumIntervalMs) + 1)
    XCTAssertGreaterThanOrEqual(total, 60 * 60)
    XCTAssertLessThanOrEqual(lastKept, 60_000)
    let gaps = zip(trace.poses, trace.poses.dropFirst()).map { $1.timestampMs - $0.timestampMs }
    XCTAssertTrue(gaps.allSatisfy { $0 >= 16 && $0 <= 17 }, "240 fps must settle at ~60 fps, gaps: \(Set(gaps))")
  }

  func testCancelledAndCorruptedMediaFailuresBecomeGapsNotAbort() {
    var steps = stillFrames(30, seed: 5)
    steps[5] = .failure(.cancelled)
    steps[6] = .failure(.corruptedMedia("decoder"))
    steps[7] = .failure(.lowConfidence("nobody"))
    let samples = (0 ..< 30).map { ImportExtractionModel.Sample(presentationSeconds: Double($0) / 30) }
    let (result, trace) = ImportExtractionModel.run(samples: samples, durationSeconds: 1, provider: ScriptedPoseProvider(steps: steps))
    XCTAssertEqual(result, .sequence(framesWithPose: 27, framesTotal: 30, lastKeptTimestampMs: 967, reachedCap: false))
    XCTAssertFalse(trace.poses.map(\.timestampMs).contains(where: { (167 ... 233).contains($0) }), "gap frames were fabricated")
  }

  func testCancellationRequestMidExtractionIsIgnoredByTheLoop() {
    let samples = (0 ..< 300).map { ImportExtractionModel.Sample(presentationSeconds: Double($0) / 30) }
    var visited = 0
    let (cancelled, cancelledTrace) = ImportExtractionModel.run(
      samples: samples,
      durationSeconds: 10,
      provider: ScriptedPoseProvider(steps: stillFrames(300, seed: 6))
    ) {
      visited += 1
      return visited > 40
    }
    let (plain, plainTrace) = ImportExtractionModel.run(samples: samples, durationSeconds: 10, provider: ScriptedPoseProvider(steps: stillFrames(300, seed: 6)))
    XCTAssertTrue(cancelledTrace.ranPastCancellation)
    XCTAssertEqual(cancelled, plain)
    XCTAssertEqual(cancelledTrace.providerCalls, plainTrace.providerCalls)
    XCTAssertEqual(cancelledTrace.providerCalls, 300)
  }

  func testRewindingPresentationTimestampsAreSkippedNotRemapped() {
    var samples = (0 ..< 60).map { ImportExtractionModel.Sample(presentationSeconds: 100 + Double($0) / 30) }
    samples.insert(.init(presentationSeconds: 99.0), at: 10)
    samples.insert(.init(presentationSeconds: .nan), at: 20)
    samples.insert(.init(presentationSeconds: -.infinity), at: 30)
    let (result, trace) = ImportExtractionModel.run(samples: samples, durationSeconds: 2, provider: ScriptedPoseProvider(steps: stillFrames(60, seed: 7)))
    XCTAssertEqual(result, .sequence(framesWithPose: 60, framesTotal: 60, lastKeptTimestampMs: 1_967, reachedCap: false))
    XCTAssertEqual(trace.poses.first?.timestampMs, 0)
  }
}
