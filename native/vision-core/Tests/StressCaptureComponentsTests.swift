import Foundation
import XCTest

@testable import PickleVisionCore

/// Seeded stress campaigns for the stateful capture components that surround
/// the detector: PoseReadinessEvaluator, CaptureEvidenceAccumulator,
/// PoseMotionTrailBuffer and SessionMotionStream. Each campaign checks the
/// structural invariants the component's own documentation promises (bounded
/// memory, no fabricated speeds, reset ≡ fresh instance, replayable output).
final class StressCaptureComponentsTests: XCTestCase {
  // MARK: - PoseReadinessEvaluator

  func testReadinessEmptyLandmarksIsFullBodyRequired() {
    let evaluator = PoseReadinessEvaluator()
    let snapshot = evaluator.ingest(pose: PoseFrame(timestampMs: 0, landmarks: [], confidence: 0.99))
    XCTAssertEqual(snapshot.state, .fullBodyRequired)
    XCTAssertEqual(snapshot.jointCoverage, 0)
    XCTAssertEqual(snapshot.missingJoints.count, 12)
    XCTAssertEqual(snapshot.stableForMs, 0)
    XCTAssertFalse(snapshot.isReady)
  }

  func testReadinessRandomStormHoldsSnapshotInvariants() {
    StressCampaign.run("readiness.random-storm", campaignIndex: 11) { rng, seed in
      let evaluator = PoseReadinessEvaluator()
      let config = PoseReadinessEvaluator.Config()
      var violations: [String] = []
      var t = rng.int(in: 0 ... 10_000)
      var frames: [PoseFrame] = []
      for _ in 0 ..< rng.int(in: 1 ... 300) {
        t += rng.pick([0, 16, 33, 33, 40, 400, -100])
        let frame: PoseFrame
        switch rng.int(in: 0 ... 9) {
        case 0 ... 5: frame = PoseFixture.random(at: t, rng: &rng)
        case 6 ... 8:
          // Nearly framed: canonical body, small sway, sometimes a hidden joint.
          frame = PoseFixture.frame(
            at: t,
            bodyOffsetX: rng.double(in: -0.02 ... 0.02),
            visibility: rng.double(in: 0.3 ... 1),
            confidence: rng.double(in: 0.4 ... 1),
            removing: rng.chance(0.2) ? [rng.pick(PoseFixture.names)] : []
          )
        default: frame = PoseFrame(timestampMs: t, landmarks: [], confidence: rng.double(in: 0 ... 1))
        }
        frames.append(frame)
      }
      var previous: PoseReadinessEvaluator.Snapshot?
      for frame in frames {
        let snapshot = evaluator.ingest(pose: frame)
        violations += Self.checkSnapshot(snapshot, frame: frame, config: config)
        if let previous, snapshot.isReady, previous.isReady,
           snapshot.timestampMs > previous.timestampMs,
           snapshot.stableForMs < previous.stableForMs, snapshot.stableForMs < config.stableDurationMs {
          violations.append("ready with shrinking stableForMs \(previous.stableForMs)->\(snapshot.stableForMs)")
        }
        previous = snapshot
      }
      // Replay determinism.
      let replayA = PoseReadinessEvaluator()
      let replayB = PoseReadinessEvaluator()
      let a = frames.map { replayA.ingest(pose: $0).state }
      let b = frames.map { replayB.ingest(pose: $0).state }
      if a != b { violations.append("non-deterministic replay") }
      return violations
    }
  }

  func testReadinessNonFiniteCoordinatesNeverReachReady() {
    StressCampaign.run("readiness.non-finite", campaignIndex: 12) { rng, seed in
      let evaluator = PoseReadinessEvaluator()
      var violations: [String] = []
      var t = 0
      // Build up genuine readiness first, then poison one required joint.
      for _ in 0 ..< 20 {
        _ = evaluator.ingest(pose: PoseFixture.frame(at: t))
        t += 33
      }
      let poisoned = rng.pick(PoseFixture.names.filter { $0 != "head" })
      let poison: Double = rng.pick([.nan, .infinity, -.infinity])
      for _ in 0 ..< rng.int(in: 1 ... 30) {
        var landmarks = PoseFixture.frame(at: t).landmarks
        landmarks = landmarks.map { l in
          l.name == poisoned ? PoseLandmark(name: l.name, x: poison, y: rng.chance(0.5) ? poison : l.y, visibility: l.visibility) : l
        }
        let snapshot = evaluator.ingest(pose: PoseFrame(timestampMs: t, landmarks: landmarks, confidence: 0.95))
        if snapshot.isReady {
          violations.append("ready at t=\(t) with non-finite \(poisoned) (\(poison))")
          break
        }
        t += 33
      }
      return violations
    }
  }

  func testReadinessResetIsEquivalentToFreshEvaluator() {
    StressCampaign.run("readiness.rapid-start-stop", campaignIndex: 13) { rng, seed in
      let reused = PoseReadinessEvaluator()
      var t = 0
      for _ in 0 ..< rng.int(in: 0 ... 80) {
        t += rng.int(in: 1 ... 60)
        _ = reused.ingest(pose: rng.chance(0.5) ? PoseFixture.random(at: t, rng: &rng) : PoseFixture.frame(at: t))
      }
      reused.reset()
      let fresh = PoseReadinessEvaluator()
      var violations: [String] = []
      let start = t + rng.int(in: 1 ... 40)
      // 25 ms cadence: 450 ms is a whole number of frames, so `ready` is
      // reachable (see StressFindingsReproTests.F1 for real camera cadence).
      var sawReady = false
      for step in 0 ..< 30 {
        let frame = PoseFixture.frame(at: start + step * 25, bodyOffsetX: rng.double(in: -0.01 ... 0.01))
        let a = reused.ingest(pose: frame)
        let b = fresh.ingest(pose: frame)
        sawReady = sawReady || b.isReady
        if a.state != b.state || a.stableForMs != b.stableForMs {
          violations.append("step \(step): reused \(a.state)/\(a.stableForMs) != fresh \(b.state)/\(b.stableForMs)")
          break
        }
      }
      if !sawReady {
        violations.append("fresh evaluator never became ready on a still canonical body at 25 ms cadence")
      }
      return violations
    }
  }

  private static func checkSnapshot(
    _ snapshot: PoseReadinessEvaluator.Snapshot,
    frame: PoseFrame,
    config: PoseReadinessEvaluator.Config
  ) -> [String] {
    var violations: [String] = []
    if snapshot.timestampMs != frame.timestampMs { violations.append("snapshot timestamp mismatch") }
    if !(0 ... 1).contains(snapshot.jointCoverage) { violations.append("coverage \(snapshot.jointCoverage) outside [0,1]") }
    if snapshot.stableForMs < 0 { violations.append("negative stableForMs") }
    if snapshot.isReady {
      if snapshot.stableForMs < config.stableDurationMs {
        violations.append("ready with stableForMs \(snapshot.stableForMs) < \(config.stableDurationMs)")
      }
      if !snapshot.missingJoints.isEmpty, snapshot.jointCoverage < 0.83 {
        violations.append("ready with coverage \(snapshot.jointCoverage)")
      }
      if frame.confidence < config.minimumPoseConfidence { violations.append("ready below pose confidence") }
    } else if snapshot.stableForMs != 0 {
      violations.append("not ready but stableForMs=\(snapshot.stableForMs)")
    }
    if snapshot.state == .noPerson, !snapshot.landmarks.isEmpty { violations.append("noPerson echoes landmarks") }
    if snapshot.state != .noPerson, snapshot.landmarks.count != frame.landmarks.count { violations.append("landmark echo count mismatch") }
    return violations
  }

  // MARK: - CaptureEvidenceAccumulator

  func testAccumulatorEmptyAndInvertedWindowsAreNil() {
    let accumulator = CaptureEvidenceAccumulator()
    XCTAssertNil(accumulator.summary(startMs: 0, endMs: 1_000, poseSource: "s", poseModelVersion: "m", triggerAlgorithmVersion: "t"))
    accumulator.ingestMissing(timestampMs: 10)
    XCTAssertNil(accumulator.summary(startMs: 0, endMs: 1_000, poseSource: "s", poseModelVersion: "m", triggerAlgorithmVersion: "t"), "missing-only window has no usable pose")
    accumulator.ingest(pose: PoseFixture.frame(at: 20))
    XCTAssertNil(accumulator.summary(startMs: 30, endMs: 20, poseSource: "s", poseModelVersion: "m", triggerAlgorithmVersion: "t"), "inverted window")
    XCTAssertNotNil(accumulator.summary(startMs: 20, endMs: 20, poseSource: "s", poseModelVersion: "m", triggerAlgorithmVersion: "t"), "single-instant window is inclusive")
  }

  func testAccumulatorRandomAttemptsHoldSummaryInvariants() {
    StressCampaign.run("accumulator.random-attempts", campaignIndex: 21) { rng, seed in
      let retention = rng.pick([1, 250, 4_000, 60_000])
      let accumulator = CaptureEvidenceAccumulator(retentionMs: retention)
      var t = rng.int(in: 0 ... 10_000)
      var minT = Int.max, maxT = Int.min
      let count = rng.int(in: 1 ... 400)
      for _ in 0 ..< count {
        t += rng.pick([0, 0, 16, 33, 33, 40, 260, 5_000, -50])
        minT = min(minT, t); maxT = max(maxT, t)
        switch rng.int(in: 0 ... 9) {
        case 0 ... 1: accumulator.ingestMissing(timestampMs: t)
        case 2: accumulator.ingest(pose: PoseFixture.corrupt(at: t, rng: &rng))
        case 3 ... 5: accumulator.ingest(pose: PoseFixture.random(at: t, rng: &rng))
        default: accumulator.ingest(pose: PoseFixture.frame(at: t, bodyOffsetX: rng.double(in: -0.05 ... 0.05), visibility: rng.double(in: 0 ... 1)))
        }
      }
      var violations: [String] = []
      let windows: [(Int, Int)] = [(minT, maxT), (maxT - retention, maxT), (minT, minT), (maxT - rng.int(in: 0 ... 1_000), maxT)]
      for (startMs, endMs) in windows {
        guard let summary = accumulator.summary(startMs: startMs, endMs: endMs, poseSource: "s", poseModelVersion: "m", triggerAlgorithmVersion: "t") else { continue }
        violations += Self.checkSummary(summary, startMs: startMs, endMs: endMs, retention: retention)
      }
      // Bounded memory: nothing older than the retention window survives.
      if let whole = accumulator.summary(startMs: Int.min / 2, endMs: Int.max / 2, poseSource: "s", poseModelVersion: "m", triggerAlgorithmVersion: "t"),
         whole.analysisInputFrameCount > count {
        violations.append("more attempts (\(whole.analysisInputFrameCount)) than ingested (\(count))")
      }
      return violations
    }
  }

  func testAccumulatorRetentionBoundsMemoryUnderLongSession() {
    StressCampaign.run("accumulator.retention-bound", campaignIndex: 22) { rng, seed in
      let retention = rng.pick([500, 4_000])
      let frameMs = rng.pick([16, 33])
      let accumulator = CaptureEvidenceAccumulator(retentionMs: retention)
      let frames = 3_000 + rng.int(in: 0 ... 3_000)
      var t = 0
      for _ in 0 ..< frames {
        t += frameMs
        if rng.chance(0.1) { accumulator.ingestMissing(timestampMs: t) } else { accumulator.ingest(pose: PoseFixture.frame(at: t)) }
      }
      guard let whole = accumulator.summary(startMs: 0, endMs: t, poseSource: "s", poseModelVersion: "m", triggerAlgorithmVersion: "t") else {
        return ["no summary after \(frames) frames"]
      }
      let bound = retention / frameMs + 2
      return whole.analysisInputFrameCount <= bound
        ? []
        : ["retained \(whole.analysisInputFrameCount) attempts > bound \(bound) (retention \(retention) ms @ \(frameMs) ms)"]
    }
  }

  func testAccumulatorTwoPeopleMergedIntoOneFrameKeepsMostVisibleJoint() {
    StressCampaign.run("accumulator.two-people-duplicates", campaignIndex: 23) { rng, seed in
      // Two people's landmarks flattened into one PoseFrame: duplicate names.
      let accumulator = CaptureEvidenceAccumulator()
      let a = PoseFixture.frame(at: 100, bodyOffsetX: -0.10, visibility: 0.9)
      let visB = rng.double(in: 0.35 ... 0.89)
      let b = PoseFixture.frame(at: 100, bodyOffsetX: 0.20, visibility: visB)
      let merged = PoseFrame(timestampMs: 100, landmarks: rng.chance(0.5) ? a.landmarks + b.landmarks : b.landmarks + a.landmarks, confidence: 0.9)
      accumulator.ingest(pose: merged)
      guard let summary = accumulator.summary(startMs: 100, endMs: 100, poseSource: "s", poseModelVersion: "m", triggerAlgorithmVersion: "t") else {
        return ["no summary"]
      }
      var violations: [String] = []
      if abs(summary.meanCanonicalJointVisibility - 0.9) > 1e-9 {
        violations.append("mean visibility \(summary.meanCanonicalJointVisibility): lower-visibility duplicate leaked in")
      }
      if summary.poseFrameCount != 1 { violations.append("poseFrameCount \(summary.poseFrameCount)") }
      return violations
    }
  }

  func testAccumulatorResetIsEquivalentToFreshAccumulator() {
    StressCampaign.run("accumulator.rapid-start-stop", campaignIndex: 24) { rng, seed in
      let reused = CaptureEvidenceAccumulator()
      var t = 0
      for _ in 0 ..< rng.int(in: 0 ... 100) {
        t += rng.int(in: 0 ... 60)
        if rng.chance(0.3) { reused.ingestMissing(timestampMs: t) } else { reused.ingest(pose: PoseFixture.random(at: t, rng: &rng)) }
      }
      reused.reset()
      let fresh = CaptureEvidenceAccumulator()
      let start = t + rng.int(in: 0 ... 40)
      var frames: [PoseFrame] = []
      for step in 0 ..< 20 {
        frames.append(PoseFixture.frame(at: start + step * 33, rightWristX: 0.3 + Double(step) * 0.01))
      }
      frames.forEach { reused.ingest(pose: $0); fresh.ingest(pose: $0) }
      let a = reused.summary(startMs: start, endMs: start + 19 * 33, poseSource: "s", poseModelVersion: "m", triggerAlgorithmVersion: "t")
      let b = fresh.summary(startMs: start, endMs: start + 19 * 33, poseSource: "s", poseModelVersion: "m", triggerAlgorithmVersion: "t")
      return a == b ? [] : ["reused summary != fresh summary after reset"]
    }
  }

  private static func checkSummary(
    _ summary: CaptureEvidenceAccumulator.Summary,
    startMs: Int,
    endMs: Int,
    retention: Int
  ) -> [String] {
    var violations: [String] = []
    if summary.analysisInputFrameCount != summary.poseFrameCount + summary.poseMissingFrameCount {
      violations.append("frame counts do not add up")
    }
    if summary.poseFrameCount < 1 { violations.append("summary without a pose frame") }
    if summary.trackedDurationMs < 0 || summary.trackedDurationMs > endMs - startMs {
      violations.append("trackedDuration \(summary.trackedDurationMs) outside window \(endMs - startMs)")
    }
    for value in [summary.meanCanonicalJointVisibility, summary.meanJointCoverage, summary.minimumJointCoverage] {
      if !value.isFinite || value < 0 || value > 1 + 1e-12 { violations.append("statistic \(value) outside [0,1]") }
    }
    if summary.minimumJointCoverage > summary.meanJointCoverage + 1e-12 { violations.append("min coverage > mean coverage") }
    if summary.fullBodyVisibleFrameCount > summary.poseFrameCount { violations.append("fullBody frames > pose frames") }
    for motion in summary.jointMotion {
      if motion.sampleCount < 1 { violations.append("motion row without samples") }
      if !motion.meanNormalizedPerSecond.isFinite || motion.meanNormalizedPerSecond < 0 { violations.append("mean speed \(motion.meanNormalizedPerSecond)") }
      if !motion.peakNormalizedPerSecond.isFinite || motion.peakNormalizedPerSecond < motion.meanNormalizedPerSecond - 1e-9 {
        violations.append("peak \(motion.peakNormalizedPerSecond) < mean \(motion.meanNormalizedPerSecond)")
      }
      // Coordinates are clamped to [0,1] on ingest and pairs are ≤ 250 ms
      // apart with elapsed ≥ 1 ms: the diagonal over 1 ms bounds the speed.
      if motion.peakNormalizedPerSecond > 2.0.squareRoot() * 1_000 + 1e-9 { violations.append("impossible speed \(motion.peakNormalizedPerSecond)") }
    }
    return violations
  }

  // MARK: - PoseMotionTrailBuffer

  func testTrailRandomFloodStaysBoundedAndSegmentsAreMeasured() {
    StressCampaign.run("trail.random-flood", campaignIndex: 31) { rng, seed in
      let config = PoseMotionTrailBuffer.Config(
        maximumAgeMs: rng.pick([100, 320, 5_000]),
        maximumSampleGapMs: rng.pick([50, 250]),
        maximumSamplesPerJoint: rng.pick([2, 8, 32])
      )
      var trails = PoseMotionTrailBuffer(config: config)
      let bound = config.trackedJoints.count * config.maximumSamplesPerJoint
      var t = 0
      var violations: [String] = []
      for _ in 0 ..< rng.int(in: 1 ... 500) {
        t += rng.pick([0, 16, 33, 33, 40, 300, -20])
        let frame = rng.chance(0.2) ? PoseFixture.corrupt(at: t, rng: &rng) : PoseFixture.random(at: t, rng: &rng)
        trails.ingest(landmarks: frame.landmarks, timestampMs: t)
        if trails.storedSampleCount > bound {
          violations.append("stored \(trails.storedSampleCount) > bound \(bound)")
          break
        }
        for segment in trails.segments(at: t + rng.pick([0, 10, 1_000])) {
          if !segment.normalizedSpeedPerSecond.isFinite || segment.normalizedSpeedPerSecond < 0 { violations.append("speed \(segment.normalizedSpeedPerSecond)") }
          if !(0 ... 1).contains(segment.ageFraction) { violations.append("ageFraction \(segment.ageFraction)") }
          for v in [segment.startX, segment.startY, segment.endX, segment.endY] where !(0 ... 1).contains(v) {
            violations.append("segment coordinate \(v) outside [0,1]")
          }
          // Two samples ≥ 1 ms apart inside the unit square: bounded speed.
          if segment.normalizedSpeedPerSecond > 2.0.squareRoot() * 1_000 + 1e-9 { violations.append("impossible speed \(segment.normalizedSpeedPerSecond)") }
        }
        if violations.count > 5 { break }
      }
      return violations
    }
  }

  /// The corrupt fixture's "moderately out-of-range" mode draws |v| ≤ 50, so
  /// ~1 % of those landmarks land inside the unit square by chance and ARE
  /// legitimate input; the buffer may keep at most that many samples.
  func testTrailCorruptLandmarksAreNeverStored() {
    StressCampaign.run("trail.corrupt-rejected", campaignIndex: 32) { rng, seed in
      var trails = PoseMotionTrailBuffer()
      let config = PoseMotionTrailBuffer.Config()
      var t = 0
      var legitimate = 0
      for _ in 0 ..< rng.int(in: 1 ... 100) {
        t += 33
        let landmarks = PoseFixture.corrupt(at: t, rng: &rng).landmarks
        legitimate += landmarks.filter {
          config.trackedJoints.contains($0.name)
            && $0.visibility >= config.minimumVisibility
            && (0 ... 1).contains($0.x) && (0 ... 1).contains($0.y)
        }.count
        trails.ingest(landmarks: landmarks, timestampMs: t)
      }
      return trails.storedSampleCount <= legitimate
        ? []
        : ["stored \(trails.storedSampleCount) samples but only \(legitimate) landmarks were in-range"]
    }
  }

  func testTrailClearIsEquivalentToFreshBuffer() {
    StressCampaign.run("trail.rapid-start-stop", campaignIndex: 33) { rng, seed in
      var reused = PoseMotionTrailBuffer()
      var t = 0
      for _ in 0 ..< rng.int(in: 0 ... 60) {
        t += rng.int(in: 1 ... 60)
        reused.ingest(landmarks: PoseFixture.random(at: t, rng: &rng).landmarks, timestampMs: t)
      }
      reused.clear()
      var fresh = PoseMotionTrailBuffer()
      let start = t + rng.int(in: 1 ... 40)
      for step in 0 ..< 12 {
        let frame = PoseFixture.frame(at: start + step * 33, rightWristX: 0.3 + Double(step) * 0.02)
        reused.ingest(landmarks: frame.landmarks, timestampMs: frame.timestampMs)
        fresh.ingest(landmarks: frame.landmarks, timestampMs: frame.timestampMs)
      }
      let at = start + 11 * 33
      return reused.segments(at: at) == fresh.segments(at: at) && reused.storedSampleCount == fresh.storedSampleCount
        ? [] : ["cleared buffer diverges from fresh buffer"]
    }
  }

  func testTrailHugeLoopStaysBounded() {
    StressCampaign.run("trail.huge-loop", campaignIndex: 34) { rng, seed in
      var trails = PoseMotionTrailBuffer()
      let bound = PoseMotionTrailBuffer.Config().trackedJoints.count * PoseMotionTrailBuffer.Config().maximumSamplesPerJoint
      var t = 0
      var x = 0.3
      let frames = 5_000 + rng.int(in: 0 ... 5_000)
      var peakStored = 0
      for _ in 0 ..< frames {
        t += rng.pick([16, 33, 33])
        x = min(0.95, max(0.05, x + rng.double(in: -0.03 ... 0.03)))
        trails.ingest(landmarks: PoseFixture.frame(at: t, rightWristX: x).landmarks, timestampMs: t)
        peakStored = max(peakStored, trails.storedSampleCount)
      }
      return peakStored <= bound ? [] : ["peak stored \(peakStored) > bound \(bound)"]
    }
  }

  // MARK: - SessionMotionStream

  func testStreamRandomStormNeverFabricatesSpeed() {
    StressCampaign.run("stream.random-storm", campaignIndex: 41) { rng, seed in
      let stream = SessionMotionStream()
      var violations: [String] = []
      var t = 0
      var lastAccepted: [String: (t: Int, x: Double, y: Double)] = [:]
      for _ in 0 ..< rng.int(in: 1 ... 400) {
        t += rng.pick([0, 16, 33, 33, 40, 260, -40])
        let frame = PoseFixture.random(at: t, rng: &rng)
        let sample = stream.ingest(pose: frame)
        // Shadow model of the documented contract.
        var expected: Double?
        let wrists = frame.landmarks.filter { ($0.name == "left_wrist" || $0.name == "right_wrist") && $0.visibility >= 0.35 }
        if frame.confidence >= 0.5, !wrists.isEmpty {
          for wrist in wrists {
            if let prev = lastAccepted[wrist.name], t > prev.t, t - prev.t <= 250 {
              let speed = ((wrist.x - prev.x) * (wrist.x - prev.x) + (wrist.y - prev.y) * (wrist.y - prev.y)).squareRoot() / (Double(t - prev.t) / 1_000)
              expected = max(expected ?? 0, speed)
            }
            lastAccepted[wrist.name] = (t, wrist.x, wrist.y)
          }
        }
        switch (sample, expected) {
        case (nil, nil): break
        case let (s?, e?):
          if s.timestampMs != t { violations.append("sample timestamp \(s.timestampMs) != \(t)") }
          if !s.value.isFinite || s.value < 0 { violations.append("value \(s.value)") }
          if abs(s.value - e) > 1e-9 { violations.append("value \(s.value) != shadow \(e) at t=\(t)") }
        case (nil, .some):
          violations.append("expected a sample at t=\(t), got nil")
        case (.some, nil):
          violations.append("unexpected sample at t=\(t)")
        }
        if violations.count > 3 { break }
      }
      return violations
    }
  }

  func testStreamResetIsEquivalentToFreshStream() {
    StressCampaign.run("stream.rapid-start-stop", campaignIndex: 42) { rng, seed in
      let reused = SessionMotionStream()
      var t = 0
      for _ in 0 ..< rng.int(in: 0 ... 60) {
        t += rng.int(in: 0 ... 60)
        _ = reused.ingest(pose: PoseFixture.random(at: t, rng: &rng))
      }
      reused.reset()
      let fresh = SessionMotionStream()
      let start = t + rng.int(in: 1 ... 40)
      for step in 0 ..< 10 {
        let frame = PoseFixture.frame(at: start + step * 33, rightWristX: 0.3 + Double(step) * 0.02)
        if reused.ingest(pose: frame) != fresh.ingest(pose: frame) { return ["step \(step) diverged after reset"] }
      }
      return []
    }
  }
}
