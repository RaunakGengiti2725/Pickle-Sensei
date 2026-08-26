# ml/

ML system workspace (directive §14–§17, §39–§43). Not a notebook dump: production training/evaluation is scriptable; notebooks live in `experiments/` only.

```
annotations/   annotation.schema.json (formal ontology v1)
datasets/      manifest.schema.json — versioned datasets w/ provenance + consent
scripts/       validate_annotations.py (+ unit tests)
evaluation/    golden-set regression harness (per-release reports)
golden/        immutable benchmark sets (see layout below)
pose/ paddle/ ball/ stroke-detection/ phase-segmentation/ biomechanics/ scoring/
               per-subsystem training + export code as models are developed
training/ export/ experiments/
```

## Golden regression layout (spec p. 50)

```
golden/forehand/side/          golden/forehand/rear_oblique/
golden/dink/                   golden/drop/
golden/serve/                  golden/left_handed/
golden/low_light/              golden/indoor/
golden/body_diversity/         golden/camera_perturbation/
golden/paddle_variants/
```

Each directory: clips + annotations (schema v1) + `expected/` outputs from the current production model. Every model release compares shot F1, phase error, checkpoint metrics, score delta, coach disagreement, subgroup deltas, runtime by device — a release cannot ship on aggregate gains with subgroup regressions (left-handed, camera robustness).

## Data targets (spec p. 30)

2–5k reviewed clips (feasibility) → 20–50k labeled strokes (4-stroke MVP) → 80–150k (8-stroke production); 0.5–2M paddle/ball frames auto-labeled + human-QC'd; 1–5k multiview sequences; 2k+ expert holdout never used in training. 200–500 athletes across skill/handedness/body/conditions/devices. 6–10 coaches for rubric ground truth; ≥2 raters per validation clip with adjudication.

## Model registry

Model bundles are registered in the product DB (`model_bundle`: version, SHA-256 manifest, status draft→canary→active→retired, rollout %) and served to devices via `GET /v1/catalog/model-bundle`. Staged rollout + rollback are admin operations (`PUT /v1/admin/model-bundles/:version`), never silent.

## Current status

Real on-device baselines implemented in native/: ApplePoseProvider (Vision body pose) and TemporalStrokeDetector (heuristic v0 behind the learned-model interface). Paddle/ball/phase learned models: data collection prerequisites above. No fabricated benchmarks — evaluation reports exist only once real models run against real golden sets.
