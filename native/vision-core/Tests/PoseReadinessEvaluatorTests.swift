import XCTest
@testable import PickleVisionCore

final class PoseReadinessEvaluatorTests: XCTestCase {
  func testMissingPoseCanNeverBecomeReady() {
    let evaluator = PoseReadinessEvaluator()
    XCTAssertEqual(evaluator.ingestMissing(timestampMs: 0).state, .noPerson)
    XCTAssertEqual(evaluator.ingestMissing(timestampMs: 5_000).state, .noPerson)
  }

  func testIncompleteBodyFailsCoverageGate() {
    let evaluator = PoseReadinessEvaluator()
    let incomplete = pose(timestampMs: 0, removing: ["left_ankle", "right_ankle"])
    let snapshot = evaluator.ingest(pose: incomplete)
    XCTAssertEqual(snapshot.state, .fullBodyRequired)
    XCTAssertTrue(snapshot.missingJoints.contains("left_ankle"))
  }

  func testRealStablePoseMustPersistBeforeReady() {
    let evaluator = PoseReadinessEvaluator()
    XCTAssertEqual(evaluator.ingest(pose: pose(timestampMs: 0)).state, .holdStill)
    XCTAssertEqual(evaluator.ingest(pose: pose(timestampMs: 350)).state, .holdStill)
    let ready = evaluator.ingest(pose: pose(timestampMs: 700))
    XCTAssertEqual(ready.state, .ready)
    XCTAssertGreaterThanOrEqual(ready.stableForMs, 700)
  }

  func testMotionRestartsStabilityEvidence() {
    let evaluator = PoseReadinessEvaluator()
    _ = evaluator.ingest(pose: pose(timestampMs: 0))
    _ = evaluator.ingest(pose: pose(timestampMs: 350))
    XCTAssertEqual(evaluator.ingest(pose: pose(timestampMs: 700)).state, .ready)

    let moved = evaluator.ingest(pose: pose(timestampMs: 800, xOffset: 0.14))
    XCTAssertEqual(moved.state, .holdStill)
    XCTAssertEqual(moved.stableForMs, 0)
  }

  private func pose(
    timestampMs: Int,
    xOffset: Double = 0,
    removing names: Set<String> = []
  ) -> PoseFrame {
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
      landmarks: points.compactMap { name, x, y in
        guard !names.contains(name) else { return nil }
        return PoseLandmark(name: name, x: x + xOffset, y: y, visibility: 0.95)
      },
      confidence: 0.95
    )
  }
}
