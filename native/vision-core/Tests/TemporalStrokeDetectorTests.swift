import XCTest
@testable import PickleVisionCore

final class TemporalStrokeDetectorTests: XCTestCase {
  func testDetectsDiscreteWristMotionButDoesNotClaimAStrokeClass() {
    let detector = TemporalStrokeDetector()
    XCTAssertNil(detector.ingest(pose: pose(at: 0, rightWristX: 0.25), paddle: nil))
    XCTAssertNil(detector.ingest(pose: pose(at: 100, rightWristX: 0.40), paddle: nil))
    XCTAssertNil(detector.ingest(pose: pose(at: 220, rightWristX: 0.58), paddle: nil))
    let event = detector.ingest(pose: pose(at: 420, rightWristX: 0.59), paddle: nil)

    XCTAssertNotNil(event)
    XCTAssertEqual(event?.recognition.status, .unknown)
    XCTAssertEqual(event?.recognition.reason, "validated_classifier_unavailable")
    XCTAssertNil(event?.recognition.shotType)
    XCTAssertEqual(event?.peakMotionMs, 100)
  }

  func testSustainedMotionDoesNotCompleteAsDiscreteEvent() {
    let detector = TemporalStrokeDetector(config: .init(maxStrokeMs: 500))
    XCTAssertNil(detector.ingest(pose: pose(at: 0, rightWristX: 0.10), paddle: nil))
    XCTAssertNil(detector.ingest(pose: pose(at: 100, rightWristX: 0.25), paddle: nil))
    XCTAssertNil(detector.ingest(pose: pose(at: 350, rightWristX: 0.55), paddle: nil))
    XCTAssertNil(detector.ingest(pose: pose(at: 650, rightWristX: 0.85), paddle: nil))
  }

  private func pose(at timestampMs: Int, rightWristX: Double) -> PoseFrame {
    PoseFrame(
      timestampMs: timestampMs,
      landmarks: [
        PoseLandmark(name: "left_wrist", x: 0.35, y: 0.5, visibility: 0.95),
        PoseLandmark(name: "right_wrist", x: rightWristX, y: 0.5, visibility: 0.95),
      ],
      confidence: 0.95
    )
  }
}
