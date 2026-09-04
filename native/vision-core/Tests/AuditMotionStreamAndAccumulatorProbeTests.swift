import XCTest

@testable import PickleVisionCore

/// Structural-audit probes (pass 1, native-vision-core) for the two smaller
/// single-queue ingesters. New file only; the shipped suite is untouched.
final class AuditMotionStreamAndAccumulatorProbeTests: XCTestCase {
  // MARK: - SessionMotionStream (SessionMotionStream.swift:55-65)

  /// PoseMotionTrail (:105-112) documents the contract: a repeated or
  /// regressed timestamp must be IGNORED so it cannot become a fabricated
  /// speed. The stream skips the sample but still overwrites the prior point
  /// (:65), so the next frame is measured over a wrong interval.
  func testRegressedTimestampFrameIsIgnoredNotRetained() throws {
    let stream = SessionMotionStream()
    XCTAssertNil(stream.ingest(pose: pose(at: 1_000, rightWristX: 0.50)))
    // Regressed frame (t = 900 after t = 1 000): correctly yields no sample…
    XCTAssertNil(stream.ingest(pose: pose(at: 900, rightWristX: 0.50)))
    // …but the next frame must be measured against t = 1 000, not t = 900:
    // 0.10 over 20 ms = 5.0 units/s.
    let sample = try XCTUnwrap(stream.ingest(pose: pose(at: 1_020, rightWristX: 0.60)))
    XCTAssertEqual(sample.value, 5.0, accuracy: 1e-6, "speed measured over the regressed interval")
  }

  /// Same contract for an EQUAL timestamp with a different position.
  func testRepeatedTimestampFrameIsIgnoredNotRetained() throws {
    let stream = SessionMotionStream()
    XCTAssertNil(stream.ingest(pose: pose(at: 1_000, rightWristX: 0.50)))
    XCTAssertNil(stream.ingest(pose: pose(at: 1_000, rightWristX: 0.90)))
    // The wrist is at 0.90 at t = 1 020: 0.40 over 20 ms = 20 units/s.
    let sample = try XCTUnwrap(stream.ingest(pose: pose(at: 1_020, rightWristX: 0.90)))
    XCTAssertEqual(sample.value, 20.0, accuracy: 1e-6, "repeated-timestamp position replaced the prior point")
  }

  /// Non-finite wrist coordinates never crash the stream and never surface as
  /// a non-finite sample value (the NaN speed loses `max(_:_:)` against the
  /// other wrist's finite speed).
  func testNonFiniteCoordinatesNeverCrashOrSurfaceAsNonFiniteSamples() {
    let stream = SessionMotionStream()
    _ = stream.ingest(pose: pose(at: 0, rightWristX: 0.5))
    let samples = [
      stream.ingest(pose: pose(at: 40, rightWristX: .nan)),
      stream.ingest(pose: pose(at: 80, rightWristX: .infinity)),
      stream.ingest(pose: pose(at: 120, rightWristX: 0.5)),
    ]
    for sample in samples.compactMap({ $0 }) {
      XCTAssertTrue(sample.value.isFinite, "non-finite sample \(sample)")
    }
  }

  // MARK: - CaptureEvidenceAccumulator (CaptureEvidenceAccumulator.swift:220-226)

  /// Retention is a time window behind the latest timestamp; attempts that
  /// share one timestamp are all retained (documented growth mode — CameraEngine
  /// stamps ms from CMTime so real frames never collide).
  func testAttemptsSharingOneTimestampAreAllRetained() throws {
    let accumulator = CaptureEvidenceAccumulator(retentionMs: 1_000)
    for _ in 0..<5_000 { accumulator.ingestMissing(timestampMs: 10_000) }
    accumulator.ingest(pose: fullBody(at: 10_000))
    let summary = try XCTUnwrap(accumulator.summary(
      startMs: 10_000, endMs: 10_000,
      poseSource: "p", poseModelVersion: "m", triggerAlgorithmVersion: "t"
    ))
    XCTAssertEqual(summary.analysisInputFrameCount, 5_001)
    XCTAssertEqual(summary.poseMissingFrameCount, 5_000)
  }

  /// Duplicate landmark names are tolerated by the accumulator (keeps the more
  /// visible entry) and by the trail buffer (last write wins per joint) — the
  /// readiness evaluator is the only ingester that traps.
  func testDuplicateLandmarkNamesAreToleratedByAccumulatorAndTrail() throws {
    let accumulator = CaptureEvidenceAccumulator(retentionMs: 1_000)
    var frame = fullBody(at: 0)
    frame = PoseFrame(
      timestampMs: 0,
      landmarks: frame.landmarks + [PoseLandmark(name: "right_wrist", x: 0.2, y: 0.2, visibility: 0.99)],
      confidence: 0.95
    )
    accumulator.ingest(pose: frame)
    let summary = try XCTUnwrap(accumulator.summary(
      startMs: 0, endMs: 0, poseSource: "p", poseModelVersion: "m", triggerAlgorithmVersion: "t"
    ))
    XCTAssertEqual(summary.poseFrameCount, 1)

    var trail = PoseMotionTrailBuffer()
    trail.ingest(landmarks: frame.landmarks, timestampMs: 0)
    trail.ingest(landmarks: frame.landmarks, timestampMs: 40)
    XCTAssertFalse(trail.segments(at: 40).isEmpty)
  }

  /// An out-of-range but finite coordinate (Vision can extrapolate slightly
  /// outside the image for occluded joints) is dropped as a joint, never
  /// crashes, and the frame still counts as a pose attempt.
  func testOutOfRangeCoordinateIsDroppedAsAJointNotAsAFrame() throws {
    let accumulator = CaptureEvidenceAccumulator(retentionMs: 1_000)
    var frame = fullBody(at: 0)
    frame = PoseFrame(
      timestampMs: 0,
      landmarks: frame.landmarks.map {
        $0.name == "right_ankle" ? PoseLandmark(name: $0.name, x: $0.x, y: 1.02, visibility: 0.9) : $0
      },
      confidence: 0.95
    )
    accumulator.ingest(pose: frame)
    let summary = try XCTUnwrap(accumulator.summary(
      startMs: 0, endMs: 0, poseSource: "p", poseModelVersion: "m", triggerAlgorithmVersion: "t"
    ))
    XCTAssertEqual(summary.poseFrameCount, 1)
    XCTAssertEqual(summary.fullBodyVisibleFrameCount, 0)
  }

  // MARK: - Fixtures

  private func pose(at timestampMs: Int, rightWristX: Double) -> PoseFrame {
    PoseFrame(
      timestampMs: timestampMs,
      landmarks: [
        PoseLandmark(name: "right_wrist", x: rightWristX, y: 0.5, visibility: 0.9),
        PoseLandmark(name: "left_wrist", x: 0.30, y: 0.5, visibility: 0.9),
      ],
      confidence: 0.9
    )
  }

  private func fullBody(at timestampMs: Int) -> PoseFrame {
    let points: [(String, Double, Double)] = [
      ("left_shoulder", 0.43, 0.25), ("right_shoulder", 0.57, 0.25),
      ("left_elbow", 0.39, 0.38), ("right_elbow", 0.61, 0.38),
      ("left_wrist", 0.36, 0.50), ("right_wrist", 0.64, 0.50),
      ("left_hip", 0.45, 0.52), ("right_hip", 0.55, 0.52),
      ("left_knee", 0.45, 0.70), ("right_knee", 0.55, 0.70),
      ("left_ankle", 0.44, 0.90), ("right_ankle", 0.56, 0.90),
    ]
    return PoseFrame(
      timestampMs: timestampMs,
      landmarks: points.map { PoseLandmark(name: $0.0, x: $0.1, y: $0.2, visibility: 0.95) },
      confidence: 0.95
    )
  }
}
