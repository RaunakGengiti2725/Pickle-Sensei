# DATA_CARD — datasets/releases (schema data-card-v1)

## Identity

- Dataset: immutable release manifests for pickle-real snapshots
- Path: `datasets/releases/`
- Card produced by: wave-d2/d2-09 (devin-visual-v4-waveD2), 2026-08-29

## Contents (recounted programmatically 2026-08-29)

- `pickle-real-v0.1/`: manifest.json + manifest.sha256 + training-justification.json
- `pickle-real-v0.2/`: manifest.json + manifest.sha256
- `pickle-real-v0.3/`: manifest.json + manifest.sha256 + annotations/
  (schemaVersion 2, immutable; counts: 8 unique sources, 13 registered files,
  7 sessions, 5 annotated cases, 5 target events, 1 annotator, 0 expert coaches)

## Integrity (d2-09 audit, 2026-08-29)

- manifest.sha256 verified against manifest.json for all three releases: 3/3 match.
- v0.3 corpus-section claims (20 sources / 26 recordings / 17 root recordings /
  12 sessions) match the live corpus recount exactly — no drift since freeze.

## Caveats

- Releases are immutable snapshots; future corpus movement is expected to drift
  from these manifests and is not an error.
