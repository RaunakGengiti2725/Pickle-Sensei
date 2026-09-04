import XCTest
@testable import PickleVisionCore

/// S01: two visible landmarks with the same name reach
/// `Dictionary(uniqueKeysWithValues:)` in PoseReadinessEvaluator.ingest and
/// abort the process. Kept in its own file so it can be run in isolation
/// (`--filter AdjudicationTrapReproTests`); a trap kills the xctest runner.
final class AdjudicationTrapReproTests: XCTestCase {
  func testS01_duplicateVisibleLandmarkNameDoesNotTrapReadiness() {
    let evaluator = PoseReadinessEvaluator()
    var landmarks = [
      ("left_shoulder", 0.43, 0.25), ("right_shoulder", 0.57, 0.25),
      ("left_elbow", 0.39, 0.38), ("right_elbow", 0.61, 0.38),
      ("left_wrist", 0.36, 0.50), ("right_wrist", 0.64, 0.50),
      ("left_hip", 0.45, 0.52), ("right_hip", 0.55, 0.52),
      ("left_knee", 0.45, 0.70), ("right_knee", 0.55, 0.70),
      ("left_ankle", 0.44, 0.90), ("right_ankle", 0.56, 0.90),
    ].map { PoseLandmark(name: $0.0, x: $0.1, y: $0.2, visibility: 0.95) }
    landmarks.append(PoseLandmark(name: "left_wrist", x: 0.37, y: 0.51, visibility: 0.9))
    let snapshot = evaluator.ingest(pose: PoseFrame(timestampMs: 0, landmarks: landmarks, confidence: 0.95))
    XCTAssertNotEqual(snapshot.state, .noPerson)
  }
}
