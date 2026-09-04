import XCTest
@testable import PickleVisionCore

/// Adversarial pass 3, tester #2 — EXPECTED-RED twins of the gaps pinned in
/// `AdversarialPass3Tester2Tests`. Each test asserts the behaviour the
/// scenario asked for; on 4d812e1a every one of them fails, and the failure
/// message carries the observed value. They are the executable form of the
/// findings and turn green when (if) the gap is closed. This file lives under
/// tools/attack (NOT native/vision-core/Tests) on purpose: it must never make
/// the package's Mac gate red. The Linux proxy copies it into its throwaway
/// package:
///
///   tools/attack/native-vision-core-linux-proxy-2/run.sh --release --filter AdversarialPass3Tester2GapTests
final class AdversarialPass3Tester2GapTests: XCTestCase {
  private let cadenceMs = 40
  private let readyFrames = 11
  private let driveDeltas: [Double] = [0.06, 0.08, 0.07, 0.06, 0.05, 0.04, 0.03, 0.016, 0.008, 0.004, 0.004]

  /// S10: a candidate whose clock runs backwards should be dropped (or the
  /// sample rejected), never completed with `startMs` on one clock and
  /// `endMs` on another.
  func testGapS10_clockRegressionMidCandidateDropsTheCandidate() {
    let detector = TemporalStrokeDetector()
    let drive = poses(bodySpan: 0.5, path: ready(then: driveDeltas))
    for frame in drive.prefix(readyFrames + 3) { _ = detector.ingest(pose: frame, paddle: nil) }
    var emitted: [(atMs: Int, event: StrokeEvent)] = []
    let regressed = drive.map { shift($0, by: -2_000) }
    for frame in regressed {
      if let event = detector.ingest(pose: frame, paddle: nil) { emitted.append((frame.timestampMs, event)) }
    }
    let restX = regressed.last!.landmarks.first { $0.name == "right_wrist" }!.x
    var t = regressed.last!.timestampMs
    for _ in 0..<120 {
      t += cadenceMs
      if let event = detector.ingest(pose: fullBody(at: t, bodySpan: 0.5, wristImageX: restX), paddle: nil) {
        emitted.append((t, event))
      }
    }
    XCTAssertTrue(
      emitted.isEmpty,
      "candidate opened at 440 on the old clock completed after a −2000 ms regression: "
        + emitted.map { "at \($0.atMs): start \($0.event.startMs) end \($0.event.endMs) peak \($0.event.peakMotionMs ?? -1)" }.joined(separator: "; ")
    )
  }

  /// S10 (reset path): after `reset()` a detector should detect a drive on ANY
  /// clock, including a negative one; today `refractoryUntilMs = 0` blocks it.
  func testGapS10_resetThenNegativeClockStillDetectsTheDrive() {
    let detector = TemporalStrokeDetector()
    let drive = poses(bodySpan: 0.5, path: ready(then: driveDeltas))
    for frame in drive.prefix(readyFrames + 3) { _ = detector.ingest(pose: frame, paddle: nil) }
    detector.reset()
    let events = drive.map { shift($0, by: -2_000) }.compactMap { detector.ingest(pose: $0, paddle: nil) }
    XCTAssertEqual(events.map(\.startMs), [-1_600], "no event: refractoryUntilMs = 0 after reset blocks triggers at t < 0")
  }

  /// S11: 100 000 attempts that never advance the clock should still be
  /// bounded by something (the advancing-clock bound is retention + 1 =
  /// 4 001 attempts). Wall-clock budget 120 s so an -Onone run cannot hang
  /// the suite; running out of budget is itself a failure (O(n²) append).
  func testGapS11_sameTimestampIngestMissingIsBounded() {
    let accumulator = CaptureEvidenceAccumulator(retentionMs: 4_000)
    let budget: TimeInterval = 120
    let start = Date()
    var calls = 0
    while calls < 100_000 {
      accumulator.ingestMissing(timestampMs: 1_000)
      calls += 1
      if calls % 1_000 == 0, Date().timeIntervalSince(start) > budget { break }
    }
    let seconds = Date().timeIntervalSince(start)
    let count = attemptCount(accumulator)
    print("S11 gap: \(calls) ingestMissing calls at one timestamp in \(seconds)s → attempts.count = \(count)")
    XCTAssertEqual(calls, 100_000, "ran out of the \(budget)s budget after \(calls) calls (\(seconds)s)")
    XCTAssertLessThanOrEqual(count, 4_001, "attempts.count = \(count) after \(calls) same-timestamp calls")
  }

  /// S12: 5 000 full-body frames inside one 450 ms window should ingest in
  /// bounded time. Budget 10 s (the same 5 000 frames at 240 fps take well
  /// under a second in the green suite). Frames are spaced 0.09 ms apart, i.e.
  /// ≈ 11 share each integer millisecond.
  func testGapS12_fiveThousandFramesInOneWindowIngestWithinBudget() {
    let evaluator = PoseReadinessEvaluator()
    let budget: TimeInterval = 10
    let start = Date()
    var ingested = 0
    for step in 0..<5_000 {
      _ = evaluator.ingest(pose: realBody(at: (step * 450) / 5_000))
      ingested += 1
      if ingested % 100 == 0, Date().timeIntervalSince(start) > budget { break }
    }
    let seconds = Date().timeIntervalSince(start)
    print("S12 gap: ingested \(ingested) of 5 000 frames within one 450 ms window in \(seconds)s")
    XCTAssertEqual(ingested, 5_000, "stopped after \(ingested) frames at the \(budget)s budget (\(seconds)s)")
    XCTAssertLessThan(seconds, budget)
  }

  /// S13: with confidence saturating at 0.95 for any ordinary drive, the
  /// offline pass should prefer the MOST RECENT of tied events (the athlete
  /// stopped right after the swing they mean), or at least not lose a
  /// strictly faster later swing to the cap.
  func testGapS13_tieBreakPrefersTheMostRecentSaturatedSwing() {
    let faster = driveDeltas.map { $0 * 1.5 }
    let path = move(hold(ready(then: driveDeltas), for: 11), by: faster)
    let frames = poses(bodySpan: 0.5, path: path)
    let strongest = TemporalStrokeDetector.strongestEvent(in: frames)
    XCTAssertEqual(
      strongest?.startMs, 1_280,
      "strongestEvent returned the first drive (start \(strongest?.startMs ?? -1)) over a 1.5× faster later one; both saturate at 0.95"
    )
  }

  // MARK: - Helpers (duplicated from the green suite; XCTestCase privates are per-file)

  private func attemptCount(_ accumulator: CaptureEvidenceAccumulator) -> Int {
    guard let attempts = Mirror(reflecting: accumulator).descendant("attempts") else {
      XCTFail("CaptureEvidenceAccumulator.attempts not found via Mirror")
      return -1
    }
    return Mirror(reflecting: attempts).children.count
  }

  private static let jointNames = [
    "left_shoulder", "right_shoulder", "left_elbow", "right_elbow", "left_wrist", "right_wrist",
    "left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle",
  ]

  private func realBody(at timestampMs: Int) -> PoseFrame {
    let points: [(Double, Double)] = [
      (0.43, 0.25), (0.57, 0.25), (0.39, 0.38), (0.61, 0.38), (0.36, 0.50), (0.64, 0.50),
      (0.45, 0.52), (0.55, 0.52), (0.45, 0.70), (0.55, 0.70), (0.44, 0.90), (0.56, 0.90),
    ]
    return PoseFrame(
      timestampMs: timestampMs,
      landmarks: zip(Self.jointNames, points).map { PoseLandmark(name: $0, x: $1.0, y: $1.1, visibility: 0.95) },
      confidence: 0.95
    )
  }

  private func fullBody(at timestampMs: Int, bodySpan: Double, wristImageX: Double) -> PoseFrame {
    let template: [(name: String, x: Double, y: Double)] = [
      ("left_shoulder", -0.12, 0.0), ("right_shoulder", 0.12, 0.0),
      ("left_elbow", -0.16, 0.22), ("right_elbow", 0.16, 0.22),
      ("left_wrist", -0.18, 0.42), ("right_wrist", 0.18, 0.42),
      ("left_hip", -0.08, 0.42), ("right_hip", 0.08, 0.42),
      ("left_knee", -0.08, 0.72), ("right_knee", 0.08, 0.72),
      ("left_ankle", -0.09, 1.0), ("right_ankle", 0.09, 1.0),
    ]
    let shoulderY = 0.5 - bodySpan / 2
    return PoseFrame(
      timestampMs: timestampMs,
      landmarks: template.map { name, x, y in
        PoseLandmark(
          name: name,
          x: name == "right_wrist" ? wristImageX : 0.5 + x * bodySpan,
          y: shoulderY + y * bodySpan,
          visibility: 0.95
        )
      },
      confidence: 0.95
    )
  }

  private func shift(_ frame: PoseFrame, by deltaMs: Int) -> PoseFrame {
    PoseFrame(timestampMs: frame.timestampMs + deltaMs, landmarks: frame.landmarks, confidence: frame.confidence)
  }

  private func poses(bodySpan: Double, path: [Double], startMs: Int = 0) -> [PoseFrame] {
    path.enumerated().map { index, offset in
      fullBody(at: startMs + index * cadenceMs, bodySpan: bodySpan, wristImageX: 0.5 + (0.18 - offset) * bodySpan)
    }
  }

  private func stillPath(_ count: Int, at offset: Double = 0) -> [Double] {
    Array(repeating: offset, count: count)
  }

  private func cumulative(_ deltas: [Double], from start: Double = 0) -> [Double] {
    var offset = start
    return deltas.map { delta in
      offset += delta
      return offset
    }
  }

  private func ready(then deltas: [Double]) -> [Double] {
    move(stillPath(readyFrames), by: deltas)
  }

  private func move(_ path: [Double], by deltas: [Double]) -> [Double] {
    path + cumulative(deltas, from: path.last ?? 0)
  }

  private func hold(_ path: [Double], for count: Int) -> [Double] {
    path + stillPath(count, at: path.last ?? 0)
  }
}
