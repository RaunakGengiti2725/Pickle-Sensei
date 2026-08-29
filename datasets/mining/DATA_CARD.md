# DATA_CARD — datasets/mining (schema data-card-v1)

## Identity

- Dataset: scene/candidate mining outputs from DVIDS footage
- Path: `datasets/mining/`
- Card produced by: wave-d2/d2-09 (devin-visual-v4-waveD2), 2026-08-29

## Contents (recounted programmatically 2026-08-29)

- `dvids-marne-outdoor/`: mining.json 8 candidates · scenes.json 6 cuts /
  7 segments / 4049 scores · extract-meta.json (pose extraction metadata).
- `dvids-warriorgames-match/`: mining.json 6 candidates · scenes.json 9 cuts /
  10 segments / 9224 scores · extract-meta.json.

## Provenance & rights

- Source footage is DVIDS (PD-USGov); rights recorded per source in
  `datasets/corpus/sources.json`.

## Roles / splits

- Both mined sessions are pinned dev in `datasets/corpus/splits.json`
  (candidate lists were inspected).

## Integrity (d2-09 audit, 2026-08-29)

- Counts recorded in `datasets/experiments/wave-d2/d2-09-integrity-report.json`
  (`misc.mining`). Miner outputs are machine-generated candidates, never
  presented as human ground truth.
