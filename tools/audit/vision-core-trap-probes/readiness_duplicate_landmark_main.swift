// Trap probe: PoseReadinessEvaluator.ingest(pose:) builds its visible-joint
// map with Dictionary(uniqueKeysWithValues:) (PoseReadinessEvaluator.swift:117).
// That initializer has a precondition — duplicate keys are a fatal error, not
// a merge — so a PoseFrame carrying the same landmark name twice (a contract
// the PoseFrame type does not forbid; the detector, trail buffer, accumulator
// and motion stream all tolerate it) crashes the process.
//
// Run through tools/audit/vision-core-trap-probes/run.sh. Exit 0 here means
// the evaluator survived (no defect); a trap (SIGILL/SIGTRAP, "Fatal error:
// Duplicate values for key") is the reproduced failure.

import Foundation
import PickleVisionCore

@main
struct ReadinessDuplicateLandmarkProbe {
  static func main() {
    let points: [(String, Double, Double)] = [
      ("left_shoulder", 0.43, 0.25), ("right_shoulder", 0.57, 0.25),
      ("left_elbow", 0.39, 0.38), ("right_elbow", 0.61, 0.38),
      ("left_wrist", 0.36, 0.50), ("right_wrist", 0.64, 0.50),
      ("left_hip", 0.45, 0.52), ("right_hip", 0.55, 0.52),
      ("left_knee", 0.45, 0.70), ("right_knee", 0.55, 0.70),
      ("left_ankle", 0.44, 0.90), ("right_ankle", 0.56, 0.90),
      // The duplicate: a second visible right_wrist.
      ("right_wrist", 0.62, 0.51),
    ]
    let pose = PoseFrame(
      timestampMs: 0,
      landmarks: points.map { PoseLandmark(name: $0.0, x: $0.1, y: $0.2, visibility: 0.95) },
      confidence: 0.95
    )
    let evaluator = PoseReadinessEvaluator()
    print("probe: ingesting a PoseFrame with a duplicated right_wrist landmark")
    let snapshot = evaluator.ingest(pose: pose)
    print("probe: survived; state=\(snapshot.state.rawValue) coverage=\(snapshot.jointCoverage)")
  }
}
