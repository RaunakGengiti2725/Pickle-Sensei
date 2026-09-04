// Structural-audit probe: PoseReadinessEvaluator.ingest builds
// `Dictionary(uniqueKeysWithValues:)` from the visible landmarks
// (PoseReadinessEvaluator.swift:117-121). Two landmarks sharing a name is
// legal for `PoseFrame` (public init, plain array) and is tolerated by
// CaptureEvidenceAccumulator and PoseMotionTrailBuffer, but here it is a
// Swift runtime trap (process abort), not a rejected frame.
//
// Run: audit/probes/run_readiness_duplicate_landmark_trap.sh (swiftc against the
// canonical PoseReadinessEvaluator.swift + the harness contracts shim).
// Expected on 4d812e1a: "Fatal error: Duplicate values for key: 'right_wrist'",
// non-zero exit (SIGILL/SIGTRAP). A fixed evaluator would print "no trap".
import Foundation

var landmarks: [PoseLandmark] = [
  ("left_shoulder", 0.43, 0.25), ("right_shoulder", 0.57, 0.25),
  ("left_elbow", 0.39, 0.38), ("right_elbow", 0.61, 0.38),
  ("left_wrist", 0.36, 0.50), ("right_wrist", 0.64, 0.50),
  ("left_hip", 0.45, 0.52), ("right_hip", 0.55, 0.52),
  ("left_knee", 0.45, 0.70), ("right_knee", 0.55, 0.70),
  ("left_ankle", 0.44, 0.90), ("right_ankle", 0.56, 0.90),
].map { PoseLandmark(name: $0.0, x: $0.1, y: $0.2, visibility: 0.95) }
landmarks.append(PoseLandmark(name: "right_wrist", x: 0.60, y: 0.51, visibility: 0.90))

let evaluator = PoseReadinessEvaluator()
let snapshot = evaluator.ingest(pose: PoseFrame(timestampMs: 0, landmarks: landmarks, confidence: 0.95))
print("no trap: state=\(snapshot.state.rawValue)")
