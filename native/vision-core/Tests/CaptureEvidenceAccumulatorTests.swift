import XCTest

@testable import PickleVisionCore

final class CaptureEvidenceAccumulatorTests: XCTestCase {
  func testInclusiveWindowSummarizesCountsMeansMissingAndSparseMotion() throws {
    let accumulator = CaptureEvidenceAccumulator()
    accumulator.ingest(pose: pose(at: 50))
    accumulator.ingest(pose: pose(at: 100))
    accumulator.ingest(
      pose: pose(
        at: 200,
        xOffsets: ["right_wrist": 0.10],
        visibilities: ["left_ankle": 0.20]
      )
    )
    accumulator.ingestMissing(timestampMs: 250)
    accumulator.ingest(pose: pose(at: 300, defaultVisibility: 0.50))
    accumulator.ingestMissing(timestampMs: 350)

    let summary = try XCTUnwrap(
      accumulator.summary(
        startMs: 100,
        endMs: 300,
        poseSource: "apple_vision_body_pose",
        poseModelVersion: "pose-1",
        triggerAlgorithmVersion: "trigger-1"
      ))

    XCTAssertEqual(summary.schemaVersion, 1)
    XCTAssertEqual(summary.window, "detected_motion")
    XCTAssertEqual(summary.motionUnit, "normalized_image_units_per_second")
    XCTAssertEqual(summary.analysisInputFrameCount, 4)
    XCTAssertEqual(summary.poseFrameCount, 3)
    XCTAssertEqual(summary.poseMissingFrameCount, 1)
    XCTAssertEqual(summary.trackedDurationMs, 200)
    XCTAssertEqual(summary.meanCanonicalJointVisibility, 29.2 / 36.0, accuracy: 0.000_001)
    XCTAssertEqual(summary.meanJointCoverage, 35.0 / 36.0, accuracy: 0.000_001)
    XCTAssertEqual(summary.minimumJointCoverage, 11.0 / 12.0, accuracy: 0.000_001)
    XCTAssertEqual(summary.fullBodyVisibleFrameCount, 2)

    XCTAssertEqual(
      summary.jointMotion.map(\.joint),
      CaptureEvidenceAccumulator.canonicalJoints.filter { $0 != "left_ankle" }
    )
    let rightWrist = try XCTUnwrap(summary.jointMotion.first { $0.joint == "right_wrist" })
    XCTAssertEqual(rightWrist.sampleCount, 1)
    XCTAssertEqual(rightWrist.meanNormalizedPerSecond, 1, accuracy: 0.000_001)
    XCTAssertEqual(rightWrist.peakNormalizedPerSecond, 1, accuracy: 0.000_001)
    XCTAssertNil(summary.jointMotion.first { $0.joint == "left_ankle" })
  }

  func testVisibilityAndLongGapsDoNotProduceUnsupportedMotionPairs() throws {
    let accumulator = CaptureEvidenceAccumulator()
    accumulator.ingest(pose: pose(at: 0))
    accumulator.ingest(
      pose: pose(
        at: 100,
        xOffsets: ["right_wrist": 0.10, "left_wrist": 0.10],
        visibilities: ["left_wrist": 0.34]
      )
    )
    accumulator.ingest(pose: pose(at: 400, xOffsets: ["right_wrist": 0.20]))
    accumulator.ingest(pose: pose(at: 500, xOffsets: ["right_wrist": 0.30]))

    let summary = try XCTUnwrap(
      accumulator.summary(
        startMs: 0,
        endMs: 500,
        poseSource: "apple_vision_body_pose",
        poseModelVersion: "pose-1",
        triggerAlgorithmVersion: "trigger-1"
      ))
    let rightWrist = try XCTUnwrap(summary.jointMotion.first { $0.joint == "right_wrist" })
    XCTAssertEqual(rightWrist.sampleCount, 2)
    XCTAssertEqual(rightWrist.meanNormalizedPerSecond, 1, accuracy: 0.000_001)
    XCTAssertEqual(rightWrist.peakNormalizedPerSecond, 1, accuracy: 0.000_001)

    let leftWrist = try XCTUnwrap(summary.jointMotion.first { $0.joint == "left_wrist" })
    XCTAssertEqual(leftWrist.sampleCount, 1)
    XCTAssertEqual(leftWrist.peakNormalizedPerSecond, 0, accuracy: 0.000_001)
  }

  func testMissingAttemptBreaksMotionContinuity() throws {
    let accumulator = CaptureEvidenceAccumulator()
    accumulator.ingest(pose: pose(at: 0))
    accumulator.ingestMissing(timestampMs: 50)
    accumulator.ingest(pose: pose(at: 100, xOffsets: ["right_wrist": 0.20]))

    let summary = try XCTUnwrap(
      accumulator.summary(
        startMs: 0,
        endMs: 100,
        poseSource: "apple_vision_body_pose",
        poseModelVersion: "pose-1",
        triggerAlgorithmVersion: "trigger-1"
      ))
    XCTAssertEqual(summary.analysisInputFrameCount, 3)
    XCTAssertEqual(summary.poseMissingFrameCount, 1)
    XCTAssertTrue(summary.jointMotion.isEmpty)
  }

  func testResetRemovesPriorAttempts() throws {
    let accumulator = CaptureEvidenceAccumulator()
    accumulator.ingest(pose: pose(at: 0))
    accumulator.ingestMissing(timestampMs: 25)
    accumulator.reset()
    XCTAssertNil(
      accumulator.summary(
        startMs: 0,
        endMs: 25,
        poseSource: "apple_vision_body_pose",
        poseModelVersion: "pose-1",
        triggerAlgorithmVersion: "trigger-1"
      ))

    accumulator.ingest(pose: pose(at: 1_000))
    let summary = try XCTUnwrap(
      accumulator.summary(
        startMs: 900,
        endMs: 1_100,
        poseSource: "apple_vision_body_pose",
        poseModelVersion: "pose-1",
        triggerAlgorithmVersion: "trigger-1"
      ))
    XCTAssertEqual(summary.analysisInputFrameCount, 1)
    XCTAssertEqual(summary.poseFrameCount, 1)
    XCTAssertEqual(summary.poseMissingFrameCount, 0)
    XCTAssertEqual(summary.trackedDurationMs, 0)
    XCTAssertTrue(summary.jointMotion.isEmpty)
  }

  private func pose(
    at timestampMs: Int,
    defaultVisibility: Double = 1,
    xOffsets: [String: Double] = [:],
    visibilities: [String: Double] = [:]
  ) -> PoseFrame {
    let landmarks = CaptureEvidenceAccumulator.canonicalJoints.enumerated().map { index, name in
      let column = index % 4
      let row = index / 4
      return PoseLandmark(
        name: name,
        x: 0.20 + Double(column) * 0.15 + (xOffsets[name] ?? 0),
        y: 0.20 + Double(row) * 0.25,
        visibility: visibilities[name] ?? defaultVisibility
      )
    }
    return PoseFrame(timestampMs: timestampMs, landmarks: landmarks, confidence: 0.95)
  }
}
