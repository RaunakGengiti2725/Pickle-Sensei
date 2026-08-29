/**
 * Desktop-lab entry point for the hierarchical stroke classifier.
 *
 * The implementation lives in
 * packages/vision-geometry/src/strokeHeuristicLite.ts — the single source of
 * truth shared with the mobile AUTO DETECT path. This module re-exports it
 * under the lab's historical names; the parity suite
 * (test/strokeHeuristicParity.test.ts) locks this re-export in place of the
 * former hand-synced byte-equivalent copy.
 *
 * swing-lab's TrackedPaddleObservation is structurally assignable to the
 * classifier's HeuristicPaddleObservation, so lab callers pass their paddle
 * tracks through unchanged.
 */
export {
  classifyStroke,
  STROKE_HEURISTIC_VERSION,
  STROKE_TAXONOMY_V3,
  type HeuristicStrokePrediction as StrokePrediction,
  type StrokeV3,
} from "@pickle/vision-geometry";
