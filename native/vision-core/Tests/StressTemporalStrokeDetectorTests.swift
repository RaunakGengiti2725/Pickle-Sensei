import Foundation
import XCTest

@testable import PickleVisionCore

/// Seeded stress campaigns for TemporalStrokeDetector: frame storms, corrupt
/// coordinates, rapid start/stop, two-person identity swaps, huge sessions.
/// Every iteration is replayable with STRESS_ONLY_SEED=<seed>; see
/// StressSupport.swift for the knobs.
final class StressTemporalStrokeDetectorTests: XCTestCase {
  // MARK: - Fixture sanity (deterministic)

  func testCanonicalSwingFixtureEmitsExactlyOneEvent() {
    let detector = TemporalStrokeDetector()
    let frames = PoseFixture.swing()
    let events = frames.compactMap { detector.ingest(pose: $0, paddle: nil) }
    XCTAssertEqual(events.count, 1, "fixture must emit exactly one event: \(events.map(\.stressSignature))")
    guard let event = events.first else { return }
    XCTAssertLessThan(event.startMs, event.endMs)
    XCTAssertGreaterThanOrEqual(event.startMs, 0)
    XCTAssertLessThan(event.startMs, 500, "startMs is the onset inside the quiet run")
    XCTAssertGreaterThan(event.endMs, 500 + 10 * 33, "endMs lands in the settled tail")
    XCTAssertEqual(event.recognition.status, .unknown)
  }

  // MARK: - Empty / one-frame

  func testEmptyAndOneFrameInputsProduceNothing() {
    XCTAssertNil(TemporalStrokeDetector.strongestEvent(in: []))
    XCTAssertNil(TemporalStrokeDetector.strongestEvent(in: [PoseFixture.frame(at: 0)]))
    XCTAssertNil(TemporalStrokeDetector.strongestEvent(in: Array(PoseFixture.swing().prefix(2))))

    let detector = TemporalStrokeDetector()
    XCTAssertNil(detector.ingest(pose: PoseFrame(timestampMs: 0, landmarks: [], confidence: 1), paddle: nil))
    XCTAssertNil(detector.lastBodyScale, "an empty frame must not seed a body scale")
    XCTAssertNil(detector.ingest(pose: PoseFixture.frame(at: 33), paddle: nil))
    XCTAssertEqual(detector.lastBodyScale ?? -1, PoseFixture.bodyScale, accuracy: 1e-9)
  }

  // MARK: - Campaign 1: random frame storm

  func testRandomFrameStormHoldsEventInvariantsAndIsReplayable() {
    StressCampaign.run("detector.random-storm", campaignIndex: 1) { rng, seed in
      let frameCount = rng.int(in: 1 ... 400)
      var frames: [PoseFrame] = []
      var t = rng.int(in: 0 ... 100_000)
      for _ in 0 ..< frameCount {
        // Mostly camera cadence, sometimes stalls, gaps and regressions.
        switch rng.int(in: 0 ... 19) {
        case 0: t -= rng.int(in: 1 ... 500)
        case 1: break
        case 2: t += rng.int(in: 251 ... 5_000)
        default: t += rng.int(in: 1 ... 60)
        }
        frames.append(PoseFixture.random(at: t, rng: &rng))
      }
      let first = Self.replay(frames)
      let second = Self.replay(frames)
      var violations = Self.checkEventInvariants(first, frames: frames)
      if first.map(\.event.stressSignature) != second.map(\.event.stressSignature) {
        violations.append("non-deterministic replay for identical input")
      }
      return violations
    }
  }

  // MARK: - Campaign 2: corrupt coordinates then reset

  func testCorruptFramesNeverCrashAndResetRestoresDetection() {
    StressCampaign.run("detector.corrupt-then-reset", campaignIndex: 2) { rng, seed in
      let detector = TemporalStrokeDetector()
      var t = 0
      var violations: [String] = []
      for _ in 0 ..< rng.int(in: 1 ... 200) {
        t += rng.int(in: 1 ... 60)
        let frame = rng.chance(0.6) ? PoseFixture.corrupt(at: t, rng: &rng) : PoseFixture.random(at: t, rng: &rng)
        if let event = detector.ingest(pose: frame, paddle: nil) {
          if !event.confidence.isFinite || event.confidence < 0 || event.confidence > 0.95 {
            violations.append("event confidence out of range: \(event.confidence)")
          }
          if event.startMs > event.endMs { violations.append("event start>end \(event.stressSignature)") }
        }
        if let scale = detector.lastBodyScale, !(scale.isFinite && scale > 0) {
          violations.append("lastBodyScale not finite/positive after corrupt input: \(scale)")
        }
      }
      detector.reset()
      if detector.lastBodyScale != nil { violations.append("reset did not clear lastBodyScale") }
      let swing = PoseFixture.swing(startMs: t + 1_000)
      let events = swing.compactMap { detector.ingest(pose: $0, paddle: nil) }
      if events.count != 1 {
        violations.append("after reset the canonical swing emitted \(events.count) events, expected 1")
      }
      return violations
    }
  }

  // MARK: - Campaign 3: corrupt burst, no reset, long gap, then swing

  /// Bounded corruption only (NaN / |coordinate| ≤ 50): the body-scale EMA
  /// (smoothing 0.3) must decay back to the athlete's scale within the 1.5 s
  /// quiet run, so the swing is still detected without a reset(). The
  /// unbounded variants (±inf, 1e300) are StressFindingsReproTests.F2.
  func testCorruptBurstWithoutResetStillDetectsAfterGap() {
    StressCampaign.run("detector.corrupt-no-reset", campaignIndex: 3) { rng, seed in
      let detector = TemporalStrokeDetector()
      var t = 0
      for _ in 0 ..< rng.int(in: 1 ... 120) {
        t += rng.int(in: 1 ... 60)
        _ = detector.ingest(pose: PoseFixture.corrupt(at: t, rng: &rng, bounded: true), paddle: nil)
      }
      // A ≥ maxStrokeMs silence: any open candidate must time out and the
      // sample-gap rule must discard the stale points.
      let swing = PoseFixture.swing(startMs: t + 3_000, quietMs: 1_500)
      let events = swing.compactMap { detector.ingest(pose: $0, paddle: nil) }
      var violations: [String] = []
      if events.count != 1 {
        violations.append("swing after corrupt burst emitted \(events.count) events, expected 1")
      }
      if let event = events.first, !(event.startMs >= t + 3_000 && event.endMs <= swing.last!.timestampMs) {
        violations.append("event window \(event.stressSignature) leaks outside the swing frames")
      }
      return violations
    }
  }

  // MARK: - Campaign 4: rapid start/stop

  func testResetIsEquivalentToFreshDetector() {
    StressCampaign.run("detector.rapid-start-stop", campaignIndex: 4) { rng, seed in
      let reused = TemporalStrokeDetector()
      var violations: [String] = []
      var t = 0
      for cycle in 0 ..< rng.int(in: 1 ... 6) {
        // Random dirty prefix: random + corrupt frames, sometimes a partial swing.
        for _ in 0 ..< rng.int(in: 0 ... 60) {
          t += rng.int(in: 1 ... 60)
          _ = reused.ingest(pose: rng.chance(0.3) ? PoseFixture.corrupt(at: t, rng: &rng) : PoseFixture.random(at: t, rng: &rng), paddle: nil)
        }
        if rng.chance(0.5) {
          let partial = PoseFixture.swing(startMs: t + 40)
          let cut = rng.int(in: 1 ... (partial.count - 1))
          for frame in partial.prefix(cut) {
            _ = reused.ingest(pose: frame, paddle: nil)
          }
          t = partial[cut - 1].timestampMs
        }
        reused.reset()
        // After reset the reused detector must behave exactly like a fresh one
        // on the same input, even when that input starts immediately.
        let startMs = t + rng.int(in: 1 ... 40)
        let swing = PoseFixture.swing(startMs: startMs, frameMs: rng.pick([16, 33, 40]))
        let fresh = TemporalStrokeDetector()
        let reusedEvents = swing.compactMap { reused.ingest(pose: $0, paddle: nil) }.map(\.stressSignature)
        let freshEvents = swing.compactMap { fresh.ingest(pose: $0, paddle: nil) }.map(\.stressSignature)
        if reusedEvents != freshEvents {
          violations.append("cycle \(cycle): reused \(reusedEvents) != fresh \(freshEvents)")
        }
        if freshEvents.count != 1 {
          violations.append("cycle \(cycle): fresh detector emitted \(freshEvents.count) events for the canonical swing")
        }
        t = swing.last!.timestampMs
      }
      return violations
    }
  }

  // MARK: - Campaign 5: two people, identity swap

  /// Two still people; the pose stream flips from A to B on one frame (what a
  /// primary-person selection flip upstream looks like to the detector). The
  /// hip anchor removes the body translation, so a flip to a person holding
  /// the SAME arm pose must never read as a stroke.
  func testIdentitySwapBetweenTwoStillPeopleWithSameArmPoseNeverTriggers() {
    StressCampaign.run("detector.identity-swap-same-arms", campaignIndex: 5) { rng, seed in
      let detector = TemporalStrokeDetector()
      let offsetB = rng.double(in: -0.30 ... 0.30)
      let frameMs = rng.pick([16, 33, 40])
      var t = 0
      var events: [StrokeEvent] = []
      let quietFrames = rng.int(in: 12 ... 60)
      for _ in 0 ..< quietFrames {
        if let e = detector.ingest(pose: PoseFixture.frame(at: t, bodyOffsetX: 0, rightWristX: 0.30), paddle: nil) { events.append(e) }
        t += frameMs
      }
      let swaps = rng.int(in: 1 ... 8)
      var onB = false
      for _ in 0 ..< swaps {
        onB.toggle()
        for _ in 0 ..< rng.int(in: 1 ... 30) {
          let offset = onB ? offsetB : 0
          if let e = detector.ingest(pose: PoseFixture.frame(at: t, bodyOffsetX: offset, rightWristX: 0.30 + offset), paddle: nil) {
            events.append(e)
          }
          t += frameMs
        }
      }
      return events.isEmpty ? [] : ["identity swap of still people emitted \(events.count) event(s): \(events.map(\.stressSignature))"]
    }
  }

  /// Characterization: a flip to a person whose ARM is in a different place
  /// is indistinguishable from a wrist moving that far. Records how often such
  /// a single-frame flip produces an event (the upstream primary-person
  /// hysteresis is what exists to prevent the flip). Any emitted event must
  /// still satisfy the structural invariants; the outcome is recorded in the
  /// results table for the report, not asserted as a requirement.
  func testIdentitySwapWithDifferentArmPoseHoldsStructuralInvariants() {
    var triggered = 0
    var total = 0
    StressCampaign.run("detector.identity-swap-different-arms", campaignIndex: 6) { rng, seed in
      let detector = TemporalStrokeDetector()
      let offsetB = rng.double(in: -0.30 ... 0.30)
      let armDeltaB = rng.double(in: -0.30 ... 0.30)
      var t = 0
      var frames: [PoseFrame] = []
      for _ in 0 ..< rng.int(in: 15 ... 40) {
        frames.append(PoseFixture.frame(at: t, rightWristX: 0.30))
        t += 33
      }
      for _ in 0 ..< 30 {
        frames.append(PoseFixture.frame(at: t, bodyOffsetX: offsetB, rightWristX: 0.30 + offsetB + armDeltaB))
        t += 33
      }
      let events = frames.compactMap { f -> (tMs: Int, event: StrokeEvent)? in
        detector.ingest(pose: f, paddle: nil).map { (f.timestampMs, $0) }
      }
      total += 1
      if !events.isEmpty { triggered += 1 }
      StressResults.record(
        campaign: "detector.identity-swap-different-arms.outcome",
        seed: seed,
        violations: events.isEmpty ? [] : ["stroke emitted on identity flip (armDelta=\(armDeltaB), bodyOffset=\(offsetB))"],
        outcome: events.isEmpty ? "no-stroke" : "stroke-emitted"
      )
      return Self.checkEventInvariants(events, frames: frames)
    }
    // Reported, not asserted: the rate is evidence for the report.
    print("[stress] identity-swap-different-arms: \(triggered)/\(total) seeds produced a stroke event")
  }

  // MARK: - Campaign 7: huge session / memory pressure

  func testHugeSessionRandomWalkHoldsInvariants() {
    StressCampaign.run("detector.huge-session", campaignIndex: 7) { rng, seed in
      let detector = TemporalStrokeDetector()
      let frameCount = 2_000 + rng.int(in: 0 ... 2_000)
      var t = 0
      var wristX = 0.30
      var events: [(tMs: Int, event: StrokeEvent)] = []
      var lastEventEnd = Int.min
      var violations: [String] = []
      let started = Date()
      for _ in 0 ..< frameCount {
        t += rng.pick([16, 33, 33, 33, 40, 300])
        wristX = min(0.95, max(0.05, wristX + rng.double(in: -0.08 ... 0.08)))
        if let event = detector.ingest(pose: PoseFixture.frame(at: t, rightWristX: wristX), paddle: nil) {
          events.append((t, event))
          if event.endMs != t { violations.append("event endMs \(event.endMs) != ingest time \(t)") }
          if event.startMs < lastEventEnd { violations.append("event \(event.stressSignature) starts before previous event ended (\(lastEventEnd))") }
          lastEventEnd = event.endMs
        }
      }
      let elapsed = Date().timeIntervalSince(started)
      if elapsed > 5 { violations.append("\(frameCount) frames took \(elapsed)s") }
      return violations
    }
  }

  // MARK: - Campaign 8: timestamp regressions

  func testTimestampRegressionsNeverManufactureEvents() {
    StressCampaign.run("detector.timestamp-regressions", campaignIndex: 8) { rng, seed in
      // A canonical swing whose frame timestamps are shuffled backwards at
      // random points: a regressed frame must never be measured against a
      // later one (speed from a negative dt) and every event must end at the
      // frame that produced it.
      let detector = TemporalStrokeDetector()
      var frames = PoseFixture.swing(startMs: 1_000)
      for index in frames.indices where rng.chance(0.15) {
        let f = frames[index]
        frames[index] = PoseFrame(
          timestampMs: f.timestampMs - rng.int(in: 1 ... 2_000),
          landmarks: f.landmarks,
          confidence: f.confidence
        )
      }
      let events = frames.compactMap { f -> (tMs: Int, event: StrokeEvent)? in
        detector.ingest(pose: f, paddle: nil).map { (f.timestampMs, $0) }
      }
      return Self.checkEventInvariants(events, frames: frames)
    }
  }

  // MARK: - Helpers

  private static func replay(_ frames: [PoseFrame]) -> [(tMs: Int, event: StrokeEvent)] {
    let detector = TemporalStrokeDetector()
    return frames.compactMap { frame in
      detector.ingest(pose: frame, paddle: nil).map { (frame.timestampMs, $0) }
    }
  }

  /// Structural invariants every emitted event must satisfy regardless of
  /// input: finite confidence in (0, 0.95], start ≤ peak ≤ end, end == the
  /// ingest timestamp that produced it, start no earlier than the earliest
  /// frame seen so far, refractory respected between consecutive events.
  static func checkEventInvariants(
    _ events: [(tMs: Int, event: StrokeEvent)],
    frames: [PoseFrame],
    config: TemporalStrokeDetector.Config = .init()
  ) -> [String] {
    var violations: [String] = []
    let earliest = frames.map(\.timestampMs).min() ?? 0
    var previousEnd: Int?
    for (tMs, event) in events {
      let sig = event.stressSignature
      if !event.confidence.isFinite || event.confidence <= 0 || event.confidence > 0.95 {
        violations.append("confidence out of (0,0.95]: \(sig)")
      }
      if event.startMs > event.endMs { violations.append("start>end: \(sig)") }
      if event.endMs != tMs { violations.append("endMs != ingest timestamp \(tMs): \(sig)") }
      if event.startMs < earliest { violations.append("start before first frame \(earliest): \(sig)") }
      if let peak = event.peakMotionMs, peak < event.startMs || peak > event.endMs {
        violations.append("peak outside window: \(sig)")
      }
      if event.endMs - event.startMs > config.maxStrokeMs + config.maxOnsetToTriggerMs + TemporalStrokeDetector.maximumSampleGapMs {
        violations.append("window longer than max onset+stroke: \(sig)")
      }
      if let previousEnd, event.startMs < previousEnd {
        violations.append("overlaps previous event (ended \(previousEnd)): \(sig)")
      }
      if let previousEnd, event.endMs < previousEnd + config.refractoryMs {
        violations.append("closed inside refractory of previous (ended \(previousEnd)): \(sig)")
      }
      previousEnd = event.endMs
    }
    return violations
  }
}
