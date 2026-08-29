# DATA_CARD — datasets/ball-bench (schema data-card-v1)

## Identity

- Dataset: ball-detection/tracking benchmark cases + failure taxonomy
- Path: `datasets/ball-bench/`
- Card produced by: wave-d2/d2-09 (devin-visual-v4-waveD2), 2026-08-29

## Contents (recounted programmatically 2026-08-29)

- `ball-bench.json`: 10 cases (with provenance, cameraType, coverageGaps,
  splitNote fields).
- `failures/`: 5 named failure-family dirs (BALL_BODY_OVERLAP-afn-sasebo-rally1,
  BALL_FALSE_POSITIVE_BACKGROUND-wm-dink-01,
  PADDLE_WRONG_RACKET_LIKE_OBJECT-afn-sasebo-rally1,
  PLAYER_ASSOCIATION_FAILURE-wm-far-03, SCENE_CUT_UNDETECTED-afn-vic-rally1).
- `results/`: 11 run result files. `baselines.json`, `failure-review.json`.

## Provenance & rights

- Cases reference paddle-bench/corpus recordings; source rights live in
  `datasets/corpus/sources.json` and `datasets/paddle-bench/registry.json`.

## Roles / splits

- Failure dirs referencing held-out cases (wm-dink-01, afn-vic-rally1) were not
  viewed by this audit; only directory listings were counted.

## Integrity (d2-09 audit, 2026-08-29)

- Counts above recorded in `datasets/experiments/wave-d2/d2-09-integrity-report.json`
  (`ballBench`). No README count claims exist to drift against.
