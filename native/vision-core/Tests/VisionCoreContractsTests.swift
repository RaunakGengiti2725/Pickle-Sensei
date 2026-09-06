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
    let sample = stream.ingest(pose: corrupt)
    XCTAssertTrue(sample?.value.isFinite ?? true, "non-finite speed \(String(describing: sample?.value))")

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

  func testFirstCompleteSwingDoesNotWaitForAnArbitraryRecordingWarmup() {
    let event = StrokeEvent(startMs: 350, endMs: 850, peakMotionMs: 550, confidence: 0.85)
    XCTAssertTrue(event.isContainedInRecording(firstFrameMs: 0, lastFrameMs: 850))
    XCTAssertTrue(event.isContainedInRecording(firstFrameMs: 350, lastFrameMs: 850))
  }

  func testLaterRecordingCannotAcceptAStrokeThatStartedInThePreviousSpool() {
    let event = StrokeEvent(startMs: 49_850, endMs: 50_800, peakMotionMs: 50_150, confidence: 0.85)
    XCTAssertFalse(event.isContainedInRecording(firstFrameMs: 50_000, lastFrameMs: 52_000))
  }

  func testCaptureRequiresTheEntireEventToExistInTheRecording() {
    let event = StrokeEvent(startMs: 350, endMs: 850, peakMotionMs: 550, confidence: 0.85)
    XCTAssertFalse(event.isContainedInRecording(firstFrameMs: nil, lastFrameMs: 850))
    XCTAssertFalse(event.isContainedInRecording(firstFrameMs: 0, lastFrameMs: nil))
    XCTAssertFalse(event.isContainedInRecording(firstFrameMs: 0, lastFrameMs: 849))
    XCTAssertFalse(event.isContainedInRecording(firstFrameMs: 351, lastFrameMs: 1_500))
    XCTAssertTrue(event.isContainedInRecording(firstFrameMs: 0, lastFrameMs: 1_500))
  }

  func testInvalidCaptureWindowsCannotPassTheRecordingGate() {
    for (start, end, peak) in [(-1, 850, 550), (350, 350, 350), (850, 350, 550), (350, 850, 900)] {
      let event = StrokeEvent(startMs: start, endMs: end, peakMotionMs: peak, confidence: 0.85)
      XCTAssertFalse(event.isContainedInRecording(firstFrameMs: 0, lastFrameMs: 2_000))
    }
    let event = StrokeEvent(startMs: 350, endMs: 850, peakMotionMs: 550, confidence: 0.85)
    XCTAssertFalse(event.isContainedInRecording(firstFrameMs: -1, lastFrameMs: 2_000))
    XCTAssertFalse(event.isContainedInRecording(firstFrameMs: 2_000, lastFrameMs: 1_000))
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
