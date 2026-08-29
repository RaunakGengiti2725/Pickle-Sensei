# DATA_CARD — datasets/coach-review (schema data-card-v1)

## Identity

- Dataset: coach review program artifacts (queue, taxonomy, drills, schema)
- Path: `datasets/coach-review/`
- Card produced by: wave-d2/d2-09 (devin-visual-v4-waveD2), 2026-08-29

## Contents (recounted programmatically 2026-08-29)

- `queue.json`: 5 queued review items.
- `coaches.json`: 0 coaches — real coach reviews remain 0; recruitment is
  BLOCKED_EXTERNAL (human), per docs/COACHING.md.
- `taxonomy/fault-taxonomy.v0-draft.json`: 9 families / 46 faults, DRAFT
  (engineering draft pending expert validation).
- `drills/drill-library.v0.json`: 2 UNVALIDATED placeholder drills;
  validatedFaultMappings empty by design. Plus `schema.json`.

## Provenance & rights

- Queue items reference corpus recordings; no coach-generated labels exist yet.

## Integrity (d2-09 audit, 2026-08-29)

- Counts recorded in `datasets/experiments/wave-d2/d2-09-integrity-report.json`
  (`misc.coachReviewQueue`, `misc.coaches`). The zero-coach state is by design
  (honest), not drift.
