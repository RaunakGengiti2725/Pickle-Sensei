# DATA_CARD — datasets/ta-bench (schema data-card-v1)

## Identity

- Dataset: target-acquisition benchmark cases and run results
- Path: `datasets/ta-bench/`
- Card produced by: wave-d2/d2-09 (devin-visual-v4-waveD2), 2026-08-29

## Contents (recounted programmatically 2026-08-29)

- `cases.json`: 301 replay cases (schemaVersion + replayVersion recorded; each
  case carries caseId, recordingId, sessionKey, split, windowMs, regionNorm,
  trueTrackId, situation, verification). The HANDOFF "verified TA 59" figure
  counts verified labels, a subset of these replay cases — different units, not
  a drift.
- `results/`: 35 run result files.

## Provenance & rights

- Cases reference corpus recordings by recordingId/sessionKey; rights live in
  `datasets/corpus/sources.json`.

## Roles / splits

- Each case records its split; assignments inherit from
  `datasets/corpus/splits.json` at the session level.

## Integrity (d2-09 audit, 2026-08-29)

- Counts recorded in `datasets/experiments/wave-d2/d2-09-integrity-report.json`
  (`misc.taBenchCases`, `misc.taBenchResultFiles`).
