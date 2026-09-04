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

  // MARK: - Non-finite landmarks

  func testNonFiniteWristCoordinatesNeverReachTheSeries() throws {
    // A wrist whose x reads +inf is ignored for that frame — not measured and
    // not remembered — while the other wrist still yields a finite sample.
    // The next clean frame measures the recovered wrist against its last
    // FINITE observation, never against the corrupt one.
    let stream = SessionMotionStream()
    XCTAssertNil(stream.ingest(pose: pose(at: 0, rightWristX: 0.50, leftWristX: 0.30)))

    let corrupt = try XCTUnwrap(stream.ingest(pose: pose(at: 40, rightWristX: .infinity, leftWristX: 0.31)))
    XCTAssertTrue(corrupt.value.isFinite, "emitted value=\(corrupt.value)")
    // Only the left wrist counted: 0.01 over 0.04 s.
    XCTAssertEqual(corrupt.value, 0.25, accuracy: 0.000_001)

    let clean = try XCTUnwrap(stream.ingest(pose: pose(at: 80, rightWristX: 0.58, leftWristX: 0.32)))
    XCTAssertTrue(clean.value.isFinite, "post-corrupt value=\(clean.value)")
    // Right wrist: 0.08 over the 80 ms since t = 0 (its last finite point).
    XCTAssertEqual(clean.value, 1.0, accuracy: 0.000_001)
  }

  func testEveryNonFiniteCoordinateShapeYieldsOnlyFiniteSamples() {
    // ±inf / NaN in x, in y, or in visibility, on either wrist, at any point
    // of a run: no emitted sample may ever be non-finite, and a frame whose
    // wrists are ALL corrupt yields nothing.
    let corruptValues: [Double] = [.infinity, -.infinity, .nan]
    for corrupt in corruptValues {
      let variants: [(String, PoseFrame)] = [
        ("right x", pose(at: 40, rightWristX: corrupt, leftWristX: 0.31)),
        ("left x", pose(at: 40, rightWristX: 0.51, leftWristX: corrupt)),
        ("right y", pose(at: 40, rightWristX: 0.51, leftWristX: 0.31, rightWristY: corrupt)),
        ("visibility", pose(at: 40, rightWristX: 0.51, leftWristX: 0.31, wristVisibility: corrupt)),
        ("both x", pose(at: 40, rightWristX: corrupt, leftWristX: corrupt)),
      ]
      for (label, frame) in variants {
        let stream = SessionMotionStream()
        XCTAssertNil(stream.ingest(pose: pose(at: 0, rightWristX: 0.50, leftWristX: 0.30)))
        if let sample = stream.ingest(pose: frame) {
          XCTAssertTrue(sample.value.isFinite, "\(label)=\(corrupt) emitted \(sample.value)")
          XCTAssertFalse(label == "both x" || label == "visibility", "\(label)=\(corrupt) had no finite wrist but emitted \(sample)")
        }
        for t in stride(from: 80, through: 240, by: 40) {
          let x = 0.50 + Double(t) / 1_000
          if let sample = stream.ingest(pose: pose(at: t, rightWristX: x, leftWristX: 0.30)) {
            XCTAssertTrue(sample.value.isFinite, "\(label)=\(corrupt) then t=\(t) emitted \(sample.value)")
          }
        }
      }
    }
  }

  private func pose(
    at timestampMs: Int,
    rightWristX: Double,
    leftWristX: Double,
    confidence: Double = 0.9,
    wristVisibility: Double = 0.9,
    rightWristY: Double = 0.50
  ) -> PoseFrame {
    PoseFrame(
      timestampMs: timestampMs,
      landmarks: [
        PoseLandmark(name: "right_wrist", x: rightWristX, y: rightWristY, visibility: wristVisibility),
        PoseLandmark(name: "left_wrist", x: leftWristX, y: 0.50, visibility: wristVisibility),
      ],
      confidence: confidence
    )
  }
}
