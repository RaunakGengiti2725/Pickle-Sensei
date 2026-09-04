import Foundation
import XCTest

#if canImport(PickleVisionCoreLinux)
@testable import PickleVisionCoreLinux
#else
@testable import PickleVisionCore
#endif

/// Long-stream and hostile-input pins for the Foundation-only pose consumers.
///
/// Every class under test is a mutable, queue-confined accumulator that the
/// capture pipeline feeds at camera rate for minutes. These tests pin that the
/// retained state stays bounded, that non-finite landmarks cannot poison the
/// outputs, and that stroke events stay well-formed under a seeded scripted
/// athlete. They are deterministic (SplitMix64) so a failing seed replays.
final class PoseStreamHardeningTests: XCTestCase {
  // MARK: - Retained state stays bounded

  func testEvidenceAccumulatorRetainsOnlyTheRetentionWindow() {
    let retentionMs = 4_000
    let accumulator = CaptureEvidenceAccumulator(retentionMs: retentionMs)
    var rng = SplitMix64(seed: 11)
    var timestampMs = 1_000
    var peakRetained = 0
    for index in 0 ..< 60_000 {
      timestampMs += 16
      if index % 7 == 0 {
        accumulator.ingestMissing(timestampMs: timestampMs)
      } else {
        accumulator.ingest(pose: Self.standingPose(at: timestampMs, rng: &rng))
      }
      peakRetained = max(peakRetained, storedCount(accumulator, "attempts") ?? .max)
    }
    // Inclusive window: retention / frame interval, plus the frame on the edge.
    XCTAssertLessThanOrEqual(peakRetained, retentionMs / 16 + 2)
    XCTAssertGreaterThan(peakRetained, retentionMs / 16 - 8, "window should actually fill")
  }

  func testReadinessStableWindowIsBoundedByStableDuration() {
    let evaluator = PoseReadinessEvaluator()
    var rng = SplitMix64(seed: 12)
    var timestampMs = 1_000
    var peakRetained = 0
    var readyFrames = 0
    for _ in 0 ..< 20_000 {
      timestampMs += 15
      let snapshot = evaluator.ingest(pose: Self.standingPose(at: timestampMs, rng: &rng, jitter: 0.001))
      if snapshot.isReady { readyFrames += 1 }
      XCTAssertGreaterThanOrEqual(snapshot.stableForMs, 0)
      peakRetained = max(peakRetained, storedCount(evaluator, "stableSamples") ?? .max)
    }
    XCTAssertLessThanOrEqual(peakRetained, 450 / 15 + 2)
    XCTAssertGreaterThan(readyFrames, 19_000, "a still, well-framed body must read as ready")
  }

  func testMotionTrailNeverExceedsPerJointCapUnderJitteryStream() {
    var trail = PoseMotionTrailBuffer()
    let cap = PoseMotionTrailBuffer.Config().maximumSamplesPerJoint
    let joints = PoseMotionTrailBuffer.Config().trackedJoints.count
    var rng = SplitMix64(seed: 13)
    var timestampMs = 1_000
    for _ in 0 ..< 20_000 {
      timestampMs += rng.chance(0.05) ? rng.int(300 ... 900) : rng.int(15 ... 18)
      trail.ingest(landmarks: Self.standingPose(at: timestampMs, rng: &rng).landmarks, timestampMs: timestampMs)
      XCTAssertLessThanOrEqual(trail.storedSampleCount, cap * joints)
      for segment in trail.segments(at: timestampMs) {
        XCTAssertTrue(segment.normalizedSpeedPerSecond.isFinite)
        XCTAssertGreaterThanOrEqual(segment.normalizedSpeedPerSecond, 0)
        XCTAssertTrue((0 ... 1).contains(segment.ageFraction))
      }
    }
  }

  // MARK: - Hostile landmark values

  func testEvidenceAccumulatorKeepsHighestVisibilityDuplicateAndIgnoresNonFinite() throws {
    let accumulator = CaptureEvidenceAccumulator()
    var rng = SplitMix64(seed: 14)
    let base = Self.standingPose(at: 1_000, rng: &rng)
    let duplicated = PoseFrame(
      timestampMs: 1_000,
      landmarks: base.landmarks + [
        PoseLandmark(name: "left_wrist", x: 0.5, y: 0.5, visibility: 0.05),
        PoseLandmark(name: "right_wrist", x: .nan, y: .infinity, visibility: 0.99),
      ],
      confidence: 0.9
    )
    accumulator.ingest(pose: duplicated)
    accumulator.ingest(pose: Self.standingPose(at: 1_016, rng: &rng))
    accumulator.ingest(pose: Self.standingPose(at: 1_032, rng: &rng))
    let summary = try XCTUnwrap(
      accumulator.summary(
        startMs: 1_000, endMs: 1_032,
        poseSource: "test", poseModelVersion: "test", triggerAlgorithmVersion: "test"
      ))
    XCTAssertEqual(summary.poseFrameCount, 3)
    XCTAssertTrue(summary.meanCanonicalJointVisibility.isFinite)
    XCTAssertTrue((0 ... 1).contains(summary.meanJointCoverage))
    for motion in summary.jointMotion {
      XCTAssertTrue(motion.meanNormalizedPerSecond.isFinite, motion.joint)
      XCTAssertTrue(motion.peakNormalizedPerSecond.isFinite, motion.joint)
    }
  }

  func testReadinessRejectsNonFiniteAndEmptyPosesWithoutTrapping() {
    let evaluator = PoseReadinessEvaluator()
    let names = CaptureEvidenceAccumulator.canonicalJoints
    let nan = PoseFrame(
      timestampMs: 1_000,
      landmarks: names.map { PoseLandmark(name: $0, x: .nan, y: .nan, visibility: .nan) },
      confidence: .nan
    )
    let infinite = PoseFrame(
      timestampMs: 1_016,
      landmarks: names.map { PoseLandmark(name: $0, x: .infinity, y: -.infinity, visibility: 1) },
      confidence: 1
    )
    let empty = PoseFrame(timestampMs: 1_032, landmarks: [], confidence: 1)
    for pose in [nan, infinite, empty] {
      let snapshot = evaluator.ingest(pose: pose)
      XCTAssertFalse(snapshot.isReady, pose.timestampMs.description)
      XCTAssertEqual(snapshot.stableForMs, 0)
    }
  }

  func testTemporalDetectorEmitsNothingForNonFiniteStreams() {
    let detector = TemporalStrokeDetector()
    let names = CaptureEvidenceAccumulator.canonicalJoints
    var timestampMs = 1_000
    for index in 0 ..< 2_000 {
      timestampMs += 16
      let value: Double = index % 3 == 0 ? .nan : (index % 3 == 1 ? .infinity : -.infinity)
      let pose = PoseFrame(
        timestampMs: timestampMs,
        landmarks: names.map { PoseLandmark(name: $0, x: value, y: value, visibility: 0.9) },
        confidence: 0.9
      )
      XCTAssertNil(detector.ingest(pose: pose, paddle: nil))
    }
    if let scale = detector.lastBodyScale {
      XCTAssertTrue(scale.isFinite)
    }
  }

  func testSessionMotionStreamIgnoresRepeatedRegressedAndGappedTimestamps() {
    let stream = SessionMotionStream()
    var rng = SplitMix64(seed: 15)
    XCTAssertNil(stream.ingest(pose: Self.standingPose(at: 1_000, rng: &rng)))
    // Repeated timestamp: no interval, no sample.
    XCTAssertNil(stream.ingest(pose: Self.standingPose(at: 1_000, rng: &rng, wristOffset: 0.2)))
    // Regressed timestamp: never a negative interval.
    XCTAssertNil(stream.ingest(pose: Self.standingPose(at: 900, rng: &rng, wristOffset: 0.4)))
    // Gap beyond maximumSampleGapMs: the dropped interval must not become speed.
    XCTAssertNil(
      stream.ingest(
        pose: Self.standingPose(at: 1_000 + SessionMotionStream.maximumSampleGapMs + 1, rng: &rng, wristOffset: 0.6)
      ))
    let sample = stream.ingest(pose: Self.standingPose(at: 1_000 + SessionMotionStream.maximumSampleGapMs + 17, rng: &rng))
    XCTAssertNotNil(sample)
    if let sample {
      XCTAssertTrue(sample.value.isFinite)
      XCTAssertGreaterThanOrEqual(sample.value, 0)
    }
  }

  // MARK: - Stroke events under a scripted athlete

  func testTemporalDetectorEventsAreOrderedNonOverlappingAndInRange() {
    for seed: UInt64 in 1 ... 8 {
      let detector = TemporalStrokeDetector()
      var athlete = ScriptedAthlete(seed: seed)
      var events: [StrokeEvent] = []
      for _ in 0 ..< 30_000 {
        let pose = athlete.next()
        if let event = detector.ingest(pose: pose, paddle: nil) {
          XCTAssertLessThan(event.startMs, event.endMs, "seed \(seed)")
          XCTAssertLessThanOrEqual(event.endMs, pose.timestampMs, "seed \(seed)")
          XCTAssertTrue((0 ... 1).contains(event.confidence), "seed \(seed) confidence \(event.confidence)")
          if let peak = event.peakMotionMs {
            XCTAssertTrue((event.startMs ... event.endMs).contains(peak), "seed \(seed)")
          }
          if let previous = events.last {
            XCTAssertGreaterThanOrEqual(event.startMs, previous.endMs, "seed \(seed): overlapping events")
          }
          events.append(event)
        }
      }
      XCTAssertGreaterThan(events.count, 50, "seed \(seed): the scripted swings must be detected")
      XCTAssertLessThanOrEqual(storedCount(detector, "lastPoints") ?? .max, 2, "seed \(seed)")
      XCTAssertLessThanOrEqual(storedCount(detector, "wristPaths") ?? .max, 2, "seed \(seed)")
    }
  }

  // MARK: - Fixtures

  static let body: [String: (x: Double, y: Double)] = [
    "head": (0.50, 0.18),
    "left_shoulder": (0.42, 0.30), "right_shoulder": (0.58, 0.30),
    "left_elbow": (0.38, 0.42), "right_elbow": (0.62, 0.42),
    "left_wrist": (0.35, 0.53), "right_wrist": (0.65, 0.53),
    "left_hip": (0.45, 0.55), "right_hip": (0.55, 0.55),
    "left_knee": (0.45, 0.72), "right_knee": (0.55, 0.72),
    "left_ankle": (0.45, 0.88), "right_ankle": (0.55, 0.88),
  ]

  static func standingPose(
    at timestampMs: Int, rng: inout SplitMix64, jitter: Double = 0.004, wristOffset: Double = 0
  ) -> PoseFrame {
    let landmarks = body.map { name, point in
      var x = point.x + (rng.unit() - 0.5) * jitter
      if name == "right_wrist" { x += wristOffset }
      return PoseLandmark(name: name, x: x, y: point.y + (rng.unit() - 0.5) * jitter, visibility: 0.9 + rng.unit() * 0.1)
    }
    return PoseFrame(timestampMs: timestampMs, landmarks: landmarks, confidence: 0.95)
  }

  /// Rests with quiet wrists, then sweeps the paddle wrist along an arc for
  /// 220-420 ms, then rests again; the same script the Linux ReviewHarness
  /// fuzzes with, so a failing seed here replays there.
  struct ScriptedAthlete {
    var rng: SplitMix64
    var timestampMs = 1_000
    var restUntilMs = 1_600
    var swingStartMs: Int?
    var swingHand = "right_wrist"
    var swingDurationMs = 300
    var swingAmplitude = 0.4

    init(seed: UInt64) { rng = SplitMix64(seed: seed) }

    mutating func next() -> PoseFrame {
      timestampMs += rng.chance(0.03) ? rng.int(34 ... 120) : rng.int(15 ... 18)
      let t = timestampMs
      var progress: Double?
      if let start = swingStartMs {
        let elapsed = t - start
        if elapsed > swingDurationMs {
          swingStartMs = nil
          restUntilMs = t + rng.int(600 ... 2_200)
        } else {
          progress = Double(elapsed) / Double(swingDurationMs)
        }
      } else if t >= restUntilMs {
        swingStartMs = t
        swingHand = rng.chance(0.5) ? "right_wrist" : "left_wrist"
        swingDurationMs = rng.int(220 ... 420)
        swingAmplitude = 0.25 + rng.unit() * 0.3
        progress = 0
      }
      let landmarks = PoseStreamHardeningTests.body.map { name, point in
        var x = point.x + (rng.unit() - 0.5) * 0.0015
        var y = point.y + (rng.unit() - 0.5) * 0.0015
        if let progress, name == swingHand {
          let sweep = sin(progress * .pi)
          x += (name == "right_wrist" ? 1 : -1) * swingAmplitude * sweep
          y -= swingAmplitude * 0.6 * sweep
        }
        return PoseLandmark(name: name, x: x, y: y, visibility: 0.6 + rng.unit() * 0.4)
      }
      return PoseFrame(timestampMs: t, landmarks: landmarks, confidence: 0.6 + rng.unit() * 0.4)
    }
  }
}

/// Deterministic generator shared by the tests above (Swift's SystemRandom is
/// not seedable).
struct SplitMix64 {
  private var state: UInt64
  init(seed: UInt64) { state = seed &+ 0x9E37_79B9_7F4A_7C15 }

  mutating func nextRaw() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }

  mutating func unit() -> Double { Double(nextRaw() >> 11) / Double(1 << 53) }
  mutating func chance(_ probability: Double) -> Bool { unit() < probability }
  mutating func int(_ range: ClosedRange<Int>) -> Int {
    range.lowerBound + Int(nextRaw() % UInt64(range.count))
  }
}

/// Reads a private stored array/dictionary's element count by reflection so
/// the tests can pin bounded retention without widening production API.
func storedCount(_ subject: Any, _ label: String) -> Int? {
  for child in Mirror(reflecting: subject).children where child.label == label {
    if let array = child.value as? [Any] { return array.count }
    let mirror = Mirror(reflecting: child.value)
    if mirror.displayStyle == .dictionary || mirror.displayStyle == .collection {
      return mirror.children.count
    }
  }
  return nil
}
