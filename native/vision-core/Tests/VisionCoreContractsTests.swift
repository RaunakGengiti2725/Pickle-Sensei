import XCTest
@testable import PickleVisionCore

/// `PoseFrame` is the one boundary every consumer (readiness, temporal
/// detector, motion stream, evidence accumulator, the iOS capture monitors)
/// ingests through; a degenerate landmark must be stopped there.
final class VisionCoreContractsTests: XCTestCase {
  func testPoseFrameDropsNonFiniteLandmarksAndConfidence() {
    let frame = PoseFrame(
      timestampMs: 33,
      landmarks: [
        PoseLandmark(name: "left_wrist", x: 0.3, y: 0.5, visibility: 0.9),
        PoseLandmark(name: "right_wrist", x: .infinity, y: 0.5, visibility: 0.9),
        PoseLandmark(name: "left_hip", x: 0.45, y: .nan, visibility: 0.9),
        PoseLandmark(name: "right_hip", x: 0.55, y: 0.52, visibility: -.infinity),
        PoseLandmark(name: "left_ankle", x: 0.44, y: 0.9, visibility: 0.9),
      ],
      confidence: .nan
    )
    XCTAssertEqual(frame.landmarks.map(\.name), ["left_wrist", "left_ankle"])
    XCTAssertEqual(frame.confidence, 0)
    XCTAssertEqual(frame.timestampMs, 33)
  }

  func testPoseFrameKeepsFiniteLandmarksVerbatim() {
    let landmarks = [
      PoseLandmark(name: "left_wrist", x: -0.01, y: 1.02, visibility: 0),
      PoseLandmark(name: "right_wrist", x: 0.64, y: 0.5, visibility: 1),
    ]
    let frame = PoseFrame(timestampMs: 0, landmarks: landmarks, confidence: 0.95)
    XCTAssertEqual(frame.landmarks.count, 2)
    XCTAssertEqual(frame.landmarks[0].x, -0.01)
    XCTAssertEqual(frame.landmarks[0].y, 1.02)
    XCTAssertEqual(frame.confidence, 0.95)
  }

  /// Finite values far outside normalized-image space are corrupt data, not
  /// joints: they overflow downstream squares exactly like ∞ and are dropped
  /// at the same boundary. One frame of slack around the image is kept.
  func testPoseFrameDropsCoordinatesOutsideTheNormalizedDomain() {
    let frame = PoseFrame(
      timestampMs: 0,
      landmarks: [
        PoseLandmark(name: "left_shoulder", x: 0.43, y: -1e308, visibility: 0.95),
        PoseLandmark(name: "right_shoulder", x: 1e308, y: 0.25, visibility: 0.95),
        PoseLandmark(name: "left_hip", x: -1, y: 2, visibility: 0.95),
        PoseLandmark(name: "right_hip", x: -1.0001, y: 0.52, visibility: 0.95),
        PoseLandmark(name: "left_knee", x: 0.45, y: 2.0001, visibility: 0.95),
        PoseLandmark(name: "right_knee", x: 0.55, y: 0.70, visibility: 1.0001),
        PoseLandmark(name: "left_ankle", x: 0.44, y: 0.90, visibility: -0.0001),
        PoseLandmark(name: "right_ankle", x: 0.56, y: 0.90, visibility: 0),
      ],
      confidence: 0.95
    )
    XCTAssertEqual(frame.landmarks.map(\.name), ["left_hip", "right_ankle"])
  }

  /// A joint reported twice collapses to its most visible sample (first wins
  /// on a tie) in provider order, so the readiness gate, the detector's hip
  /// anchor / body scale and the motion stream all see the same point.
  func testPoseFrameKeepsOneMostVisibleSamplePerJoint() {
    let frame = PoseFrame(
      timestampMs: 0,
      landmarks: [
        PoseLandmark(name: "left_wrist", x: 0.36, y: 0.50, visibility: 0.9),
        PoseLandmark(name: "right_wrist", x: 0.64, y: 0.50, visibility: 0.9),
        PoseLandmark(name: "left_wrist", x: 0.02, y: 0.02, visibility: 0.4),
        PoseLandmark(name: "right_wrist", x: 0.98, y: 0.98, visibility: 0.95),
        PoseLandmark(name: "left_hip", x: 0.45, y: 0.52, visibility: 0.9),
        PoseLandmark(name: "left_hip", x: 0.10, y: 0.10, visibility: 0.9),
      ],
      confidence: 0.95
    )
    XCTAssertEqual(frame.landmarks.map(\.name), ["left_wrist", "right_wrist", "left_hip"])
    XCTAssertEqual(frame.landmarks[0].x, 0.36)
    XCTAssertEqual(frame.landmarks[1].x, 0.98)
    XCTAssertEqual(frame.landmarks[2].x, 0.45)

    let stream = SessionMotionStream()
    _ = stream.ingest(pose: stillBody(at: 0))
    let ghost = PoseFrame(
      timestampMs: 33,
      landmarks: stillBody(at: 33).landmarks
        + [PoseLandmark(name: "left_wrist", x: 0.02, y: 0.02, visibility: 0.36)],
      confidence: 0.95
    )
    XCTAssertEqual(stream.ingest(pose: ghost)?.value ?? -1, 0, accuracy: 1e-9)
  }

  /// One infinite wrist/ankle in a single frame must not leave the detector's
  /// body-scale EMA NaN for the rest of the session, nor make the motion
  /// stream emit a non-finite speed.
  func testOneInfiniteLandmarkDoesNotPoisonDetectorOrMotionStream() {
    let detector = TemporalStrokeDetector()
    let stream = SessionMotionStream()
    _ = detector.ingest(pose: stillBody(at: 0), paddle: nil)
    _ = stream.ingest(pose: stillBody(at: 0))

    let corrupt = PoseFrame(
      timestampMs: 33,
      landmarks: stillBody(at: 33).landmarks.map {
        PoseLandmark(
          name: $0.name,
          x: $0.name == "right_wrist" ? .infinity : $0.x,
          y: $0.name == "right_ankle" ? .infinity : $0.y,
          visibility: $0.visibility
        )
      },
      confidence: 0.95
    )
    _ = detector.ingest(pose: corrupt, paddle: nil)
    // The left wrist is intact and still, so the stream measures 0 — never ∞.
    let sample = stream.ingest(pose: corrupt)
    XCTAssertNotNil(sample)
    XCTAssertEqual(sample?.value ?? -1, 0, accuracy: 1e-9, "speed \(String(describing: sample?.value))")

    for index in 2 ..< 300 {
      _ = detector.ingest(pose: stillBody(at: index * 33), paddle: nil)
      if let emitted = stream.ingest(pose: stillBody(at: index * 33)) {
        XCTAssertTrue(emitted.value.isFinite)
      }
    }
    let scale = detector.lastBodyScale
    XCTAssertNotNil(scale)
    XCTAssertTrue(scale?.isFinite ?? false, "lastBodyScale=\(String(describing: scale))")
    XCTAssertEqual(scale ?? 0, 0.65, accuracy: 1e-9)
  }

  private func stillBody(at timestampMs: Int) -> PoseFrame {
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
