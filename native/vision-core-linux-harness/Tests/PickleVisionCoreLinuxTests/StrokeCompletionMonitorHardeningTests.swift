import Foundation
import XCTest

@testable import PickleVisionCoreLinux

/// Linux pins for `StrokeCompletionMonitor` (apps/mobile/ios/LocalPods/
/// PickleNative/Sources), which has no XCTest target of its own in the pod.
/// The class is Foundation-only, so these run on the Linux toolchain; they say
/// nothing about the Vision/AVFoundation callers around it.
final class StrokeCompletionMonitorHardeningTests: XCTestCase {
  func testRollingBufferStaysWithinWindowAndHardCap() {
    let monitor = StrokeCompletionMonitor()
    var rng = SplitMix64(seed: 21)
    var timestampMs = 1_000
    var peak = 0
    for _ in 0 ..< 40_000 {
      timestampMs += rng.int(8 ... 18)
      monitor.ingest(pose: PoseStreamHardeningTests.standingPose(at: timestampMs, rng: &rng, jitter: 0.02))
      peak = max(peak, storedCount(monitor, "buffer") ?? .max)
    }
    XCTAssertLessThanOrEqual(peak, 512)
    XCTAssertGreaterThan(peak, 400, "the 8 s window at ~13 ms/frame should approach the cap")
  }

  func testArmedWindowAlwaysDecidesByTheSafetyMaxEvenWithoutPoses() {
    let monitor = StrokeCompletionMonitor()
    var rng = SplitMix64(seed: 22)
    var timestampMs = 1_000
    for _ in 0 ..< 60 {
      timestampMs += 16
      monitor.ingest(pose: PoseStreamHardeningTests.standingPose(at: timestampMs, rng: &rng, jitter: 0.02))
    }
    monitor.arm(eventStartMs: timestampMs - 600, eventEndMs: timestampMs, peakMotionMs: timestampMs - 300)
    XCTAssertNil(monitor.adaptiveDecision())
    // Pose stream lost: only the camera clock ticks.
    var decidedAt: Int?
    for _ in 0 ..< 400 {
      timestampMs += 16
      monitor.observeFrame(timestampMs: timestampMs)
      if let decision = monitor.adaptiveDecision() {
        decidedAt = decision.decidedAtMs
        XCTAssertEqual(decision.reason, .safetyMax)
        break
      }
    }
    XCTAssertNotNil(decidedAt)
    let telemetry = monitor.telemetry(strategy: .adaptive, finalizeMs: timestampMs)
    XCTAssertTrue(telemetry.safetyMaxHit)
    XCTAssertLessThanOrEqual(telemetry.samples.count, StrokeCompletionMonitor.recordedSampleCap)
    XCTAssertGreaterThanOrEqual(telemetry.observedUntilMs, telemetry.anchorMs)
  }

  func testTelemetryPayloadIsJSONSerializableAndCappedUnderScriptedStrokes() throws {
    for seed: UInt64 in 1 ... 6 {
      var athlete = PoseStreamHardeningTests.ScriptedAthlete(seed: seed)
      let detector = TemporalStrokeDetector()
      var monitor = StrokeCompletionMonitor()
      var decisions = 0
      for _ in 0 ..< 20_000 {
        let pose = athlete.next()
        monitor.ingest(pose: pose)
        if let event = detector.ingest(pose: pose, paddle: nil) {
          monitor.arm(eventStartMs: event.startMs, eventEndMs: event.endMs, peakMotionMs: event.peakMotionMs)
        }
        monitor.observeFrame(timestampMs: pose.timestampMs)
        guard let decision = monitor.adaptiveDecision() else { continue }
        decisions += 1
        XCTAssertLessThanOrEqual(decision.endMs, decision.decidedAtMs, "seed \(seed)")
        let telemetry = monitor.telemetry(strategy: .adaptive, finalizeMs: pose.timestampMs)
        XCTAssertLessThanOrEqual(telemetry.samples.count, StrokeCompletionMonitor.recordedSampleCap, "seed \(seed)")
        XCTAssertTrue(telemetry.peakMotionValue.isFinite, "seed \(seed)")
        let payload = StrokeCompletionMonitor.payload(for: telemetry, rebasedTo: event0(telemetry))
        XCTAssertTrue(JSONSerialization.isValidJSONObject(payload), "seed \(seed)")
        _ = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        // The controller discards the monitor after each finalize.
        monitor = StrokeCompletionMonitor()
      }
      XCTAssertGreaterThan(decisions, 10, "seed \(seed): scripted strokes must reach a completion decision")
    }
  }

  func testDownsampleKeepsTheFinalSampleAndRespectsCap() {
    let samples = (0 ..< 1_000).map { StrokeCompletionMonitor.MotionSample(timestampMs: $0 * 16, value: Double($0)) }
    for cap in [1, 2, 7, 50, 999, 1_000, 5_000] {
      let picked = StrokeCompletionMonitor.downsample(samples, cap: cap)
      XCTAssertLessThanOrEqual(picked.count, cap, "cap \(cap)")
      XCTAssertEqual(picked.last?.timestampMs, samples.last?.timestampMs, "cap \(cap)")
      XCTAssertEqual(picked.map(\.timestampMs), picked.map(\.timestampMs).sorted(), "cap \(cap)")
    }
    XCTAssertTrue(StrokeCompletionMonitor.downsample([], cap: 50).isEmpty)
  }

  private func event0(_ telemetry: StrokeCompletionMonitor.Telemetry) -> Int {
    max(0, telemetry.movementCompleteMs - 3_000)
  }
}
