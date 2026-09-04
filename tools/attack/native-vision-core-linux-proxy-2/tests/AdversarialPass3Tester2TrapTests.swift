import XCTest
@testable import PickleVisionCore

/// Adversarial pass 3, tester #2 — S09 family: Int arithmetic on timestamps at
/// the edges of the representable range. Each test here is EXPECTED TO TRAP
/// (Swift overflow check → SIGILL/SIGTRAP), which kills the xctest process, so
/// run exactly ONE per invocation and read the exit code. This file lives
/// under tools/attack (NOT native/vision-core/Tests) on purpose: it must never
/// kill the package's Mac gate. The Linux proxy copies it into its throwaway
/// package; run-traps.sh runs each test in its own process:
///
///   OUT=/tmp/vision-core-linux-proxy-2 tools/attack/native-vision-core-linux-proxy-2/run.sh --filter NoSuchTest
///   OUT=/tmp/vision-core-linux-proxy-2 tools/attack/native-vision-core-linux-proxy-2/run-traps.sh
///
/// A test that returns normally is a HELD result for that site; the harness
/// records both outcomes in $OUT/traps.tsv. Camera timestamps are host-clock milliseconds since boot
/// (`CMSampleBufferGetPresentationTimeStamp`), so none of these values is
/// reachable from a device — they are robustness probes, not core-flow
/// crashes.
final class AdversarialPass3Tester2TrapTests: XCTestCase {
  private let cadenceMs = 40
  private let readyFrames = 11
  private let driveDeltas: [Double] = [0.06, 0.08, 0.07, 0.06, 0.05, 0.04, 0.03, 0.016, 0.008, 0.004, 0.004]

  /// TemporalStrokeDetector.swift:354 `refractoryUntilMs = endMs +
  /// config.refractoryMs` with endMs = Int.max − 699.
  func testTrapS09_refractoryUntilMsOverflows() {
    let start = Int.max - 699 - 840
    let frames = poses(bodySpan: 0.5, path: ready(then: driveDeltas), startMs: start)
    XCTAssertEqual(frames.last?.timestampMs, Int.max - 699)
    let detector = TemporalStrokeDetector()
    var events: [StrokeEvent] = []
    for frame in frames {
      if let event = detector.ingest(pose: frame, paddle: nil) { events.append(event) }
    }
    XCTAssertEqual(events.map(\.endMs), [Int.max - 699], "reached only if :354 did not trap")
  }

  /// TemporalStrokeDetector.swift:257 `pose.timestampMs - previous.tMs` with
  /// the previous observation at Int.min + 10 and this one at Int.max − 10.
  func testTrapS09_sampleIntervalOverflows() {
    let detector = TemporalStrokeDetector()
    XCTAssertNil(detector.ingest(pose: fullBody(at: Int.min + 10, bodySpan: 0.5, wristImageX: 0.59), paddle: nil))
    XCTAssertNil(detector.ingest(pose: fullBody(at: Int.max - 10, bodySpan: 0.5, wristImageX: 0.59), paddle: nil))
  }

  /// PoseReadinessEvaluator.swift:173 `pose.timestampMs -
  /// config.stableDurationMs` with timestampMs = Int.min + 100.
  func testTrapS09_readinessCutoffOverflows() {
    let evaluator = PoseReadinessEvaluator()
    let snapshot = evaluator.ingest(pose: realBody(at: Int.min + 100))
    XCTAssertEqual(snapshot.state, .holdStill, "reached only if :173 did not trap")
  }

  /// CaptureEvidenceAccumulator.swift:224 `latestTimestampMs - retentionMs`
  /// with timestampMs = Int.min + 100.
  func testTrapS09_evidenceRetentionCutoffOverflows() {
    let accumulator = CaptureEvidenceAccumulator()
    accumulator.ingestMissing(timestampMs: Int.min + 100)
    XCTAssertNil(
      accumulator.summary(startMs: Int.min, endMs: Int.min + 200, poseSource: "t", poseModelVersion: "t", triggerAlgorithmVersion: "t"),
      "reached only if :224 did not trap"
    )
  }

  // MARK: - Helpers

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

  private func poses(bodySpan: Double, path: [Double], startMs: Int) -> [PoseFrame] {
    path.enumerated().map { index, offset in
      fullBody(at: startMs + index * cadenceMs, bodySpan: bodySpan, wristImageX: 0.5 + (0.18 - offset) * bodySpan)
    }
  }

  private func ready(then deltas: [Double]) -> [Double] {
    var offset = 0.0
    return Array(repeating: 0.0, count: readyFrames) + deltas.map { delta in
      offset += delta
      return offset
    }
  }
}
