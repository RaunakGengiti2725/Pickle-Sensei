import XCTest

@testable import PickleVisionCore

final class SessionMotionStreamTests: XCTestCase {
  func testEmitsFastestWristSpeedPerMeasurableFrame() throws {
    let stream = SessionMotionStream()
    XCTAssertNil(stream.ingest(pose: pose(at: 0, rightWristX: 0.50, leftWristX: 0.30)))

    let sample = try XCTUnwrap(
      stream.ingest(pose: pose(at: 100, rightWristX: 0.60, leftWristX: 0.31))
    )
    XCTAssertEqual(sample.timestampMs, 100)
    // right wrist moved 0.10 over 0.1s = 1.0; left moved 0.01 over 0.1s = 0.1.
    XCTAssertEqual(sample.value, 1.0, accuracy: 0.000_001)
  }

  func testLowConfidenceLowVisibilityAndLongGapsYieldNothing() {
    let stream = SessionMotionStream()
    XCTAssertNil(stream.ingest(pose: pose(at: 0, rightWristX: 0.50, leftWristX: 0.30)))

    XCTAssertNil(
      stream.ingest(
        pose: pose(at: 50, rightWristX: 0.60, leftWristX: 0.31, confidence: 0.49)
      )
    )
    XCTAssertNil(
      stream.ingest(
        pose: pose(at: 100, rightWristX: 0.70, leftWristX: 0.32, wristVisibility: 0.34)
      )
    )
    // 300ms since the last RETAINED points (t=0) exceeds the 250ms gap limit.
    XCTAssertNil(stream.ingest(pose: pose(at: 300, rightWristX: 0.80, leftWristX: 0.33)))
  }

  func testResetForgetsPriorWristPoints() throws {
    let stream = SessionMotionStream()
    XCTAssertNil(stream.ingest(pose: pose(at: 0, rightWristX: 0.50, leftWristX: 0.30)))
    stream.reset()
    XCTAssertNil(stream.ingest(pose: pose(at: 100, rightWristX: 0.60, leftWristX: 0.31)))
    let sample = try XCTUnwrap(
      stream.ingest(pose: pose(at: 200, rightWristX: 0.70, leftWristX: 0.32))
    )
    XCTAssertEqual(sample.timestampMs, 200)
    XCTAssertEqual(sample.value, 1.0, accuracy: 0.000_001)
  }

  private func pose(
    at timestampMs: Int,
    rightWristX: Double,
    leftWristX: Double,
    confidence: Double = 0.9,
    wristVisibility: Double = 0.9
  ) -> PoseFrame {
    PoseFrame(
      timestampMs: timestampMs,
      landmarks: [
        PoseLandmark(name: "right_wrist", x: rightWristX, y: 0.50, visibility: wristVisibility),
        PoseLandmark(name: "left_wrist", x: leftWristX, y: 0.50, visibility: wristVisibility),
      ],
      confidence: confidence
    )
  }
}
