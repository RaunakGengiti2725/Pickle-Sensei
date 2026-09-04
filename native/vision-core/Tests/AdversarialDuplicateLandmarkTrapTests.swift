import XCTest
@testable import PickleVisionCore

/// Adversarial pass 3, scenario S01 — kept in its OWN file and class because
/// on the commit under test it does not fail an assertion, it TRAPS:
///
///   PoseReadinessEvaluator.swift:117
///     let visible = Dictionary(uniqueKeysWithValues: pose.landmarks
///       .filter { $0.visibility >= config.minimumJointVisibility }
///       .map { ($0.name, $0) })
///
/// `Dictionary(uniqueKeysWithValues:)` is documented to trap on a duplicate
/// key, so a `PoseFrame` carrying two visible landmarks named "left_wrist"
/// ends the process — in production that is the vision queue of
/// `GuidedCaptureViewController`, i.e. the app. A trapping test takes the whole
/// XCTest process with it and hides every other result, so run this class in
/// isolation (`swift test --filter AdversarialDuplicateLandmarkTrapTests`) and
/// read the process exit code; do NOT fold it into the default suite until
/// the evaluator tolerates duplicate names (e.g. `Dictionary(_:uniquingKeysWith:)`
/// keeping the more visible landmark, as `CaptureEvidenceAccumulator` does).
///
/// Reachability today: `ApplePoseProvider.jointMap` is a fixed list of 13
/// distinct names, so Apple Vision never produces the duplicate; any other
/// `PoseProviding` implementation, replayed/imported pose JSON, or a future
/// model adapter can. The contract type (`PoseFrame`) does not forbid it.
final class AdversarialDuplicateLandmarkTrapTests: XCTestCase {
  /// Two visible "left_wrist" landmarks (visibility 0.9) inside an otherwise
  /// complete, well-framed body. Expected: a Snapshot, not a trap.
  func testS01DuplicateVisibleLandmarkNamesDoNotTrapTheReadinessEvaluator() {
    let evaluator = PoseReadinessEvaluator()
    var landmarks = fullBody()
    landmarks.append(PoseLandmark(name: "left_wrist", x: 0.40, y: 0.55, visibility: 0.9))
    landmarks.append(PoseLandmark(name: "left_wrist", x: 0.41, y: 0.56, visibility: 0.9))
    XCTAssertEqual(landmarks.filter { $0.name == "left_wrist" && $0.visibility >= 0.35 }.count, 2)

    let snapshot = evaluator.ingest(pose: PoseFrame(timestampMs: 1_000, landmarks: landmarks, confidence: 0.95))

    XCTAssertEqual(snapshot.timestampMs, 1_000)
    XCTAssertEqual(snapshot.jointCoverage, 1, accuracy: 1e-12)
    XCTAssertTrue(snapshot.missingJoints.isEmpty)
    XCTAssertTrue([.holdStill, .ready].contains(snapshot.state))
  }

  /// The same duplicate arriving from a provider that lists every joint twice
  /// (e.g. a merged two-model frame) — still a Snapshot, never a trap.
  func testS01EveryJointDuplicatedDoesNotTrapTheReadinessEvaluator() {
    let evaluator = PoseReadinessEvaluator()
    let body = fullBody()
    let snapshot = evaluator.ingest(pose: PoseFrame(timestampMs: 0, landmarks: body + body, confidence: 0.95))
    XCTAssertEqual(snapshot.jointCoverage, 1, accuracy: 1e-12)
  }

  /// Complete body without the left wrist, framed inside the readiness gate
  /// (height ≈ 0.6 of the frame, centred, margins clear).
  private func fullBody() -> [PoseLandmark] {
    let template: [(name: String, x: Double, y: Double)] = [
      ("left_shoulder", 0.43, 0.20), ("right_shoulder", 0.57, 0.20),
      ("left_elbow", 0.40, 0.33), ("right_elbow", 0.60, 0.33),
      ("right_wrist", 0.62, 0.45),
      ("left_hip", 0.45, 0.45), ("right_hip", 0.55, 0.45),
      ("left_knee", 0.45, 0.63), ("right_knee", 0.55, 0.63),
      ("left_ankle", 0.44, 0.80), ("right_ankle", 0.56, 0.80),
    ]
    return template.map { PoseLandmark(name: $0.name, x: $0.x, y: $0.y, visibility: 0.9) }
  }
}
