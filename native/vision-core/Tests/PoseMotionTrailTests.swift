import XCTest
@testable import PickleVisionCore

final class PoseMotionTrailTests: XCTestCase {
  func testSegmentsComeOnlyFromObservedVisibleSamples() {
    var trails = PoseMotionTrailBuffer()
    trails.ingest(
      landmarks: [
        landmark("left_wrist", x: 0.20, y: 0.40),
        landmark("right_wrist", x: 0.80, y: 0.40, visibility: 0.20),
      ],
      timestampMs: 1_000
    )
    trails.ingest(
      landmarks: [
        landmark("left_wrist", x: 0.30, y: 0.40),
        landmark("right_wrist", x: 0.70, y: 0.40, visibility: 0.20),
      ],
      timestampMs: 1_100
    )

    let segments = trails.segments(at: 1_100)
    XCTAssertEqual(segments.count, 1)
    XCTAssertEqual(segments.first?.joint, "left_wrist")
    XCTAssertEqual(segments.first?.normalizedSpeedPerSecond ?? 0, 1, accuracy: 0.000_1)
  }

  func testSegmentsExpireFromTimestampWindow() {
    var trails = PoseMotionTrailBuffer(
      config: .init(maximumAgeMs: 250, maximumSamplesPerJoint: 4)
    )
    trails.ingest(landmarks: [landmark("left_wrist", x: 0.2, y: 0.4)], timestampMs: 0)
    trails.ingest(landmarks: [landmark("left_wrist", x: 0.3, y: 0.4)], timestampMs: 100)

    XCTAssertEqual(trails.segments(at: 350).count, 1)
    XCTAssertTrue(trails.segments(at: 351).isEmpty)
  }

  func testBufferIsBoundedPerTrackedJoint() {
    var trails = PoseMotionTrailBuffer(
      config: .init(
        trackedJoints: ["left_wrist"],
        maximumAgeMs: 10_000,
        maximumSamplesPerJoint: 4
      )
    )
    for index in 0 ..< 20 {
      trails.ingest(
        landmarks: [landmark("left_wrist", x: Double(index) / 20, y: 0.4)],
        timestampMs: index * 10
      )
    }

    XCTAssertEqual(trails.storedSampleCount, 4)
    XCTAssertEqual(trails.segments(at: 190).count, 3)
  }

  func testMissingFramesAreNeverInterpolated() {
    var trails = PoseMotionTrailBuffer(
      config: .init(trackedJoints: ["left_wrist", "right_wrist"])
    )
    trails.ingest(
      landmarks: [
        landmark("left_wrist", x: 0.2, y: 0.4),
        landmark("right_wrist", x: 0.8, y: 0.4),
      ],
      timestampMs: 0
    )
    trails.ingest(
      landmarks: [
        landmark("left_wrist", x: 0.3, y: 0.4),
        landmark("right_wrist", x: 0.7, y: 0.4),
      ],
      timestampMs: 50
    )
    XCTAssertEqual(trails.segments(at: 50).count, 2)

    // The frame is valid and still contains the right wrist, but the missing
    // left wrist must break only the left trail.
    trails.ingest(
      landmarks: [landmark("right_wrist", x: 0.65, y: 0.4)],
      timestampMs: 100
    )
    trails.ingest(
      landmarks: [
        landmark("left_wrist", x: 0.8, y: 0.4),
        landmark("right_wrist", x: 0.6, y: 0.4),
      ],
      timestampMs: 150
    )

    XCTAssertTrue(trails.segments(at: 150).filter { $0.joint == "left_wrist" }.isEmpty)
    XCTAssertFalse(trails.segments(at: 150).filter { $0.joint == "right_wrist" }.isEmpty)
  }

  func testLongInferenceGapStartsANewTrail() {
    var trails = PoseMotionTrailBuffer(
      config: .init(maximumAgeMs: 1_000, maximumSampleGapMs: 250)
    )
    trails.ingest(landmarks: [landmark("left_wrist", x: 0.2, y: 0.4)], timestampMs: 0)
    trails.ingest(landmarks: [landmark("left_wrist", x: 0.8, y: 0.4)], timestampMs: 251)

    XCTAssertTrue(trails.segments(at: 251).isEmpty)
    XCTAssertEqual(trails.storedSampleCount, 1)
  }

  func testRegressedTimestampCannotCreateSpeed() {
    var trails = PoseMotionTrailBuffer()
    trails.ingest(landmarks: [landmark("left_wrist", x: 0.2, y: 0.4)], timestampMs: 100)
    trails.ingest(landmarks: [landmark("left_wrist", x: 0.8, y: 0.4)], timestampMs: 100)
    trails.ingest(landmarks: [landmark("left_wrist", x: 0.9, y: 0.4)], timestampMs: 90)

    XCTAssertTrue(trails.segments(at: 100).isEmpty)
  }

  private func landmark(
    _ name: String,
    x: Double,
    y: Double,
    visibility: Double = 0.95
  ) -> PoseLandmark {
    PoseLandmark(name: name, x: x, y: y, visibility: visibility)
  }
}
