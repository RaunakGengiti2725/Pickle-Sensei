# ML SYSTEM

Decomposed pipeline (spec pp. 25–31) — never one black-box "good/bad stroke" model:

```
frame → pose → paddle → optional ball → court calibration → stroke detection
→ phase segmentation → feature extraction → checkpoint scoring → priority → feedback
```

## Subsystem status

| Subsystem        | Interface                                                                                     | Implementation today                                                                                                                                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pose             | `IPoseProvider` (TS) / `PoseProviding` (Swift)                                                | **ApplePoseProvider** — real Apple Vision body-pose baseline (13 MVP landmarks, normalized-image space, lower-left→top-left conversion). Accuracy per coaching metric must be validated before metrics rely on it (spec p. 26). |
| Paddle           | `IPaddleDetector` / `PaddleDetecting`                                                         | Interface + training infrastructure defined; dedicated detector+keypoint model is a core day-one ML workstream (not optional). No model yet — providers abstain, they never guess.                                              |
| Ball             | `IBallTracker` (confidence-gated types: BallDetection/BallTrack/ContactHypothesis/Trajectory) | Architected, gated off (`ball_tracking` flag = 0%). Mechanics mode works without it.                                                                                                                                            |
| Court            | —                                                                                             | Year-two homography plan documented; schema fields reserved.                                                                                                                                                                    |
| Stroke detection | `IStrokeDetector` / `StrokeDetecting`                                                         | **TemporalStrokeDetector** heuristic v0 (velocity state machine + refractory) parse-verified; learned temporal classifier replaces it behind the same protocol.                                                                 |
| Phases           | `IPhaseSegmenter`                                                                             | Interface defined; TCN/transformer model pending labeled data. Contact is a probabilistic window everywhere.                                                                                                                    |
| Features         | `IFeatureExtractor`                                                                           | Metric vocabulary defined in scoring config v1; native extraction lands with pose/paddle wiring.                                                                                                                                |
| Scoring          | `@pickle/scoring`                                                                             | Production math, fully tested (see docs/SCORING.md).                                                                                                                                                                            |

## Data + annotation

- `ml/annotations/annotation.schema.json` — formal ontology v1 (shot/subtype, handedness, camera view, stroke window, ordered phases, contact range, boxes/keypoints, checkpoint labels w/ fault direction+severity, primary priority, **acceptable_alternative_mechanics**, quality/occlusion flags, annotator/revision/adjudication).
- `ml/scripts/validate_annotations.py` — validator incl. cross-field rules (phase ordering/non-overlap); 7 unit tests passing.
- `ml/datasets/manifest.schema.json` — versioned datasets with per-item sha256, split, consent version, provenance source, removal timestamps (consent revocation flows through to datasets via `ml_dataset_item` + deletion worker).
- Targets and recruitment plan: ml/README.md (from spec p. 30).

## Evaluation + release

Per-subsystem metrics table (spec p. 31) is the release rubric; the headline metric is **coach agreement**: when experts agree a stroke improved, the app scores it better, across reasonable camera changes. Golden regression layout in `ml/README.md`; release gates (spec p. 49) frozen before holdout. Model bundles: signed SHA-256 manifests in `model_bundle` table, staged rollout draft→canary→active with rollback and per-model kill switch, delivered via `/v1/catalog/model-bundle`, managed via audited admin routes + admin-web.

## LLM boundary (directive §26)

Vision measures → scoring decides → (later) LLM explains from structured diagnoses only. No LLM in the real-time loop; no LLM ever invents what happened in video.
