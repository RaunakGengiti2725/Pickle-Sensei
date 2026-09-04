import Foundation
import PickleVisionCore
import StressSupport
import XCTest

/// Two people in frame is the worst case for everything downstream of pose
/// extraction: when the primary-person selection flips between subjects the
/// motion stream sees teleporting wrists, the evidence accumulator sees
/// discontinuous joints and the stroke detector sees fake bursts. These tests
/// drive the pure PickleVisionCore stages with seeded two-person schedules and
/// pin the invariants the coordinator relies on (finite, bounded, ordered).
final class TwoPersonStreamStressTests: XCTestCase {
  private static let table = StressResultTable(suite: "TwoPersonStreamStress")

  override class func tearDown() {
    if let url = table.flush() { print("STRESS_RESULTS \(url.path)") }
    super.tearDown()
  }

  /// Wrist displacement is at most √2 (normalized) over ≥ 1 ms, so any speed
  /// the stream reports must sit below this bound.
  private static let maxPossibleSpeed = 2.0.squareRoot() * 1_000 + 1

  private struct Scenario {
    let seed: UInt64
    let frames: [PoseFrame]
    let frameGapMs: Int
    let switches: Int
    let resetAt: Set<Int>
  }

  private static func poseFrame(_ landmarks: [SyntheticPose.Landmark], timestampMs: Int, confidence: Double) -> PoseFrame {
    PoseFrame(
      timestampMs: timestampMs,
      landmarks: landmarks.map { PoseLandmark(name: $0.name, x: $0.x, y: $0.y, visibility: $0.visibility) },
      confidence: confidence
    )
  }

  /// Builds a stream where person A (large, left) and person B (small, right)
  /// alternate as the reported "primary" subject at seeded switch points.
  /// Person A swings; person B stands still. Random frames are dropped to
  /// mimic `poseInFlight` frame skipping in SessionCaptureCoordinator.
  private static func makeScenario(seed: UInt64) -> Scenario {
    var rng = SeededRNG(seed: seed)
    let frameGapMs = [8, 16, 33, 41, 83][rng.int(in: 0...4)]
    let frameCount = rng.int(in: 40...400)
    let switchProbability = rng.double(in: 0.0...0.3)
    let dropProbability = rng.double(in: 0.0...0.4)
    let resetProbability = rng.double(in: 0.0...0.05)
    var frames: [PoseFrame] = []
    var switches = 0
    var resetAt: Set<Int> = []
    var showingA = true
    var timestamp = rng.int(in: 0...5_000)
    for index in 0..<frameCount {
      timestamp += frameGapMs + (rng.bool(probability: 0.1) ? rng.int(in: 1...300) : 0)
      if rng.bool(probability: switchProbability) {
        showingA.toggle()
        switches += 1
      }
      if rng.bool(probability: dropProbability) { continue }
      if rng.bool(probability: resetProbability) { resetAt.insert(frames.count) }
      let landmarks: [SyntheticPose.Landmark]
      let confidence: Double
      if showingA {
        let swing = sin(Double(index) / 6.0)
        landmarks = SyntheticPose.person(centerX: 0.35, centerY: 0.55, scale: 0.7, visibility: rng.double(in: 0.3...1.0), armSwing: swing)
        confidence = rng.double(in: 0.4...1.0)
      } else {
        landmarks = SyntheticPose.person(centerX: 0.78, centerY: 0.5, scale: 0.3, visibility: rng.double(in: 0.2...0.9))
        confidence = rng.double(in: 0.2...0.9)
      }
      frames.append(poseFrame(landmarks, timestampMs: timestamp, confidence: confidence))
    }
    return Scenario(seed: seed, frames: frames, frameGapMs: frameGapMs, switches: switches, resetAt: resetAt)
  }

  func testMotionStreamStaysBoundedAcrossPersonSwitchesAndResets() {
    for seed in StressCampaign.seeds() {
      let scenario = Self.makeScenario(seed: seed)
      let stream = SessionMotionStream()
      var samples = 0
      var lastSampleMs = Int.min
      var violations: [String] = []
      for (index, frame) in scenario.frames.enumerated() {
        if scenario.resetAt.contains(index) {
          stream.reset()
          // Cancellation semantics: the first ingest after a reset must not
          // produce a sample that spans the reset boundary.
          if let sample = stream.ingest(pose: frame) {
            violations.append("sample \(sample) emitted immediately after reset at frame \(index)")
          }
          continue
        }
        guard let sample = stream.ingest(pose: frame) else { continue }
        samples += 1
        if !sample.value.isFinite || sample.value < 0 || sample.value > Self.maxPossibleSpeed {
          violations.append("frame \(index) speed \(sample.value) out of bounds")
        }
        if sample.timestampMs != frame.timestampMs {
          violations.append("frame \(index) sample timestamp \(sample.timestampMs) != \(frame.timestampMs)")
        }
        if sample.timestampMs <= lastSampleMs {
          violations.append("frame \(index) non-increasing sample timestamps")
        }
        lastSampleMs = sample.timestampMs
      }
      XCTAssertTrue(violations.isEmpty, "seed \(seed): \(violations.prefix(3))")
      Self.table.record(
        test: #function, seed: seed,
        outcome: violations.isEmpty ? "HELD" : "BROKEN",
        detail: "frames=\(scenario.frames.count) gap=\(scenario.frameGapMs)ms switches=\(scenario.switches) resets=\(scenario.resetAt.count) samples=\(samples) \(violations.first ?? "")"
      )
    }
  }

  func testEvidenceSummaryInvariantsHoldForTwoPersonStreams() {
    for seed in StressCampaign.seeds() {
      let scenario = Self.makeScenario(seed: seed)
      var rng = SeededRNG(seed: seed ^ 0xABCD)
      let accumulator = CaptureEvidenceAccumulator(retentionMs: 15_000)
      var attempts = 0
      for frame in scenario.frames {
        if rng.bool(probability: 0.15) {
          accumulator.ingestMissing(timestampMs: frame.timestampMs)
        } else {
          accumulator.ingest(pose: frame)
        }
        attempts += 1
      }
      guard let first = scenario.frames.first?.timestampMs, let last = scenario.frames.last?.timestampMs else {
        Self.table.record(test: #function, seed: seed, outcome: "SKIPPED", detail: "scenario produced no frames")
        continue
      }
      let windowStart = rng.int(in: first...last)
      let windowEnd = rng.int(in: windowStart...last)
      let summary = accumulator.summary(
        startMs: windowStart, endMs: windowEnd,
        poseSource: "stress", poseModelVersion: "stress-1", triggerAlgorithmVersion: "stress-1"
      )
      var violations: [String] = []
      if let summary {
        if summary.poseFrameCount > summary.analysisInputFrameCount { violations.append("poseFrameCount > inputs") }
        if summary.poseFrameCount < 1 { violations.append("summary without a pose") }
        if !(0...1).contains(summary.meanCanonicalJointVisibility) { violations.append("meanVisibility out of range") }
        if !(0...1).contains(summary.meanJointCoverage) { violations.append("meanCoverage out of range") }
        if !(0...1).contains(summary.minimumJointCoverage) { violations.append("minCoverage out of range") }
        if summary.minimumJointCoverage > summary.meanJointCoverage + 1e-9 { violations.append("minCoverage > meanCoverage") }
        if summary.fullBodyVisibleFrameCount > summary.poseFrameCount { violations.append("fullBody > poses") }
        if summary.trackedDurationMs < 0 || summary.trackedDurationMs > windowEnd - windowStart { violations.append("trackedDuration outside window") }
        for motion in summary.jointMotion {
          if !motion.meanNormalizedPerSecond.isFinite || !motion.peakNormalizedPerSecond.isFinite { violations.append("non-finite motion \(motion.joint)") }
          if motion.meanNormalizedPerSecond < 0 || motion.peakNormalizedPerSecond < motion.meanNormalizedPerSecond - 1e-9 { violations.append("peak < mean \(motion.joint)") }
          if motion.peakNormalizedPerSecond > Self.maxPossibleSpeed { violations.append("impossible speed \(motion.joint)") }
          if motion.sampleCount < 0 || motion.sampleCount > summary.poseFrameCount { violations.append("sampleCount out of range \(motion.joint)") }
        }
      }
      // Reverse window must never yield evidence.
      if accumulator.summary(startMs: windowEnd + 1, endMs: windowStart, poseSource: "s", poseModelVersion: "s", triggerAlgorithmVersion: "s") != nil {
        violations.append("reverse window produced a summary")
      }
      XCTAssertTrue(violations.isEmpty, "seed \(seed): \(violations.prefix(3))")
      Self.table.record(
        test: #function, seed: seed,
        outcome: violations.isEmpty ? "HELD" : "BROKEN",
        detail: "attempts=\(attempts) window=[\(windowStart),\(windowEnd)] summary=\(summary == nil ? "nil" : "poses=\(summary!.poseFrameCount)") \(violations.first ?? "")"
      )
    }
  }

  func testStrokeDetectorEventsStayOrderedAndBoundedUnderPersonFlipFlop() {
    for seed in StressCampaign.seeds() {
      let scenario = Self.makeScenario(seed: seed)
      let config = TemporalStrokeDetector.Config()
      let detector = TemporalStrokeDetector(config: config)
      var events: [StrokeEvent] = []
      var violations: [String] = []
      for (index, frame) in scenario.frames.enumerated() {
        if scenario.resetAt.contains(index) { detector.reset() }
        guard let event = detector.ingest(pose: frame, paddle: nil) else { continue }
        if event.endMs <= event.startMs { violations.append("event \(events.count) end<=start") }
        // startMs is the quiet-run onset, which may precede the trigger sample
        // by up to maxOnsetToTriggerMs; the trigger→end span is what the
        // detector bounds by [minStrokeMs, maxStrokeMs].
        let duration = event.endMs - event.startMs
        let maxDuration = config.maxStrokeMs + config.maxOnsetToTriggerMs
        if duration < config.minStrokeMs || duration > maxDuration {
          violations.append("event \(events.count) duration \(duration) outside [\(config.minStrokeMs),\(maxDuration)]")
        }
        if let peak = event.peakMotionMs, peak < event.startMs || peak > event.endMs {
          violations.append("event \(events.count) peak outside window")
        }
        if !event.confidence.isFinite || event.confidence < 0 || event.confidence > 1 {
          violations.append("event \(events.count) confidence \(event.confidence)")
        }
        if event.endMs > frame.timestampMs { violations.append("event \(events.count) ends in the future") }
        if let previous = events.last, event.startMs < previous.endMs {
          violations.append("event \(events.count) overlaps previous")
        }
        events.append(event)
      }
      XCTAssertTrue(violations.isEmpty, "seed \(seed): \(violations.prefix(3))")
      Self.table.record(
        test: #function, seed: seed,
        outcome: violations.isEmpty ? "HELD" : "BROKEN",
        detail: "frames=\(scenario.frames.count) switches=\(scenario.switches) events=\(events.count) \(violations.first ?? "")"
      )
    }
  }

  func testDetectorHandlesDegenerateFrames() {
    // Empty landmark lists, NaN/inf coordinates, duplicated joints, reversed
    // and duplicate timestamps — all things a corrupt pose.json or a buggy
    // provider could hand the detector. Invariant: no trap, finite output.
    for seed in StressCampaign.seeds() {
      var rng = SeededRNG(seed: seed)
      let detector = TemporalStrokeDetector()
      let stream = SessionMotionStream()
      let accumulator = CaptureEvidenceAccumulator()
      var timestamp = 1_000
      var violations: [String] = []
      for _ in 0..<200 {
        let kind = rng.int(in: 0...7)
        var landmarks = SyntheticPose.person(centerX: 0.5, centerY: 0.5, scale: 0.6, visibility: 0.9, armSwing: rng.double(in: -1...1))
          .map { PoseLandmark(name: $0.name, x: $0.x, y: $0.y, visibility: $0.visibility) }
        switch kind {
        case 0: landmarks = []
        case 1: landmarks = landmarks.map { PoseLandmark(name: $0.name, x: .nan, y: $0.y, visibility: $0.visibility) }
        case 2: landmarks = landmarks.map { PoseLandmark(name: $0.name, x: $0.x, y: .infinity, visibility: -.infinity) }
        case 3: landmarks += landmarks
        case 4: landmarks = landmarks.map { PoseLandmark(name: $0.name, x: rng.double(in: -50...50), y: rng.double(in: -50...50), visibility: rng.double(in: -2...2)) }
        case 5: landmarks = landmarks.map { PoseLandmark(name: "bogus_\($0.name)", x: $0.x, y: $0.y, visibility: $0.visibility) }
        default: break
        }
        switch rng.int(in: 0...9) {
        case 0: timestamp -= rng.int(in: 1...500)
        case 1: break // duplicate timestamp
        default: timestamp += rng.int(in: 1...120)
        }
        let confidence = [Double.nan, -1, 0, 0.5, 1, 7, .infinity][rng.int(in: 0...6)]
        let frame = PoseFrame(timestampMs: timestamp, landmarks: landmarks, confidence: confidence)
        if let event = detector.ingest(pose: frame, paddle: nil) {
          if event.endMs <= event.startMs || !event.confidence.isFinite {
            violations.append("bad event from degenerate frame: start=\(event.startMs) end=\(event.endMs) peak=\(String(describing: event.peakMotionMs)) confidence=\(event.confidence)")
          }
        }
        if let sample = stream.ingest(pose: frame) {
          if !sample.value.isFinite || sample.value < 0 { violations.append("non-finite sample \(sample.value)") }
        }
        accumulator.ingest(pose: frame)
      }
      if let summary = accumulator.summary(startMs: Int.min / 2, endMs: Int.max / 2, poseSource: "s", poseModelVersion: "s", triggerAlgorithmVersion: "s") {
        if !summary.meanCanonicalJointVisibility.isFinite || !summary.meanJointCoverage.isFinite { violations.append("non-finite summary") }
        for motion in summary.jointMotion where !motion.meanNormalizedPerSecond.isFinite || !motion.peakNormalizedPerSecond.isFinite {
          violations.append("non-finite motion \(motion.joint)")
        }
      }
      XCTAssertTrue(violations.isEmpty, "seed \(seed): \(violations.prefix(3))")
      Self.table.record(test: #function, seed: seed, outcome: violations.isEmpty ? "HELD" : "BROKEN", detail: violations.first ?? "200 degenerate frames")
    }
  }
}
