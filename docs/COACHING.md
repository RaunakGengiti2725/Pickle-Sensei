# COACHING — the expert review program

How a real, qualified pickleball coach plugs into Pickle Sensei, and what
their labels unlock. Status today: **0 reviews exist, 0 coaches are
provisioned** — technique scoring is BLOCKED_ON_VALIDATION (D-031/D-032,
docs/CLAIM_REVIEW.md gate H) and stays that way until the process below
produces real, agreeing labels. Everything in this document is built and
runnable now; recruitment is the only missing (human, BLOCKED_EXTERNAL) step.

Authoritative code: `packages/swing-lab/src/coachReview.ts` (schema v2 +
validator + CLI). Derived artifacts: `datasets/coach-review/` (regenerate
with `pnpm lab:coach-queue`). Review console: `apps/admin-web`.

## 1. What a coach reviews

`datasets/coach-review/queue.json` lists the gold StrokeEvents (today: 5,
one per bench case, ≥2 independent reviews wanted each). Each item carries
the source video path, event bounds (`windowMs`), labeled contact, the
engineering stroke annotation to confirm/correct, and the bundle's honesty
metadata (annotator confidence, analyzability, phase labels).

The review console renders all of it:

```
pnpm --filter @pickle/admin-web dev     # http://localhost:5173/#/coach
```

- **Queue** — the items with bundle metadata and real review counts.
- **Item page** — the event clip with an event-bounds scrubber (start /
  contact / end / phase markers), loop-the-event, 0.25×–1× speed, frame
  stepping; plus the structured review form. Evidence timestamps are marked
  directly off the video's current time.
- **Agreement** — inter-coach agreement per item (implemented + unit-tested;
  truthfully "awaiting reviews" while the count is 0).
- **Program** — the schema, fault-taxonomy draft, drill library and this doc.

## 2. Identity provisioning (human step, reviewed commit)

Coaches get an **opaque pseudonymous id**; PII and credential documents stay
OFF-REPO.

1. Verify qualification off-repo (e.g. certification, teaching résumé) and
   file it in the private credential store; that record's id is the
   `credentialRef` (e.g. `cred-2026-001`).
2. Append an entry to `datasets/coach-review/coaches.json` in a reviewed PR:

```json
{
  "coachId": "coach-01",
  "credentialRef": "cred-2026-001",
  "status": "active",
  "provisionedAtIso": "2026-…",
  "provisionedBy": "<admin identity>"
}
```

3. That's it — the console's submit path unlocks for that coachId.

Rules enforced by tooling: the registry is scaffolded once and never
overwritten by the CLI; `SYNTHETIC*` ids are rejected by the validator and
the persistence endpoint (dev fixtures can never masquerade as reviews);
with zero active registry entries every write attempt is refused with
"no coach identity provisioned".

## 3. The review record (schema v2)

One JSON file per review — `datasets/coach-review/reviews/<reviewId>.json`,
`reviewId = <queueItemId>.<coachId>` (one review per coach per item).
Storage is **append-only**: files are never edited or overwritten;
corrections happen in adjudication records (§6), so history is preserved.

Fields (see `CoachReview` in coachReview.ts / `schema.json`):

- identity: `coachId`, `coachCredentialRef` (both opaque);
- target: `queueItemId`, `eventRef {caseId, eventIndex}`, pinned
  `strokeTaxonomyVersion` / `faultTaxonomyVersion` / `drillLibraryVersion`;
- `strokeConfirmation`: confirm / correct (with note) / cannot_judge;
- `overallQuality`: anchored 1–5 (`technique-quality-5pt-v1`, anchors shown
  in the form; the anchors themselves are draft pending coach revision) or
  null when not assessable;
- `faults[]`: `{faultId, severity 1–3, evidence {timestampsMs[], region?},
  rationale}` — evidence timestamps are mandatory, prose is mandatory;
- `drillSuggestions[]`: optional drill-library id + free text (seeds for the
  future curated library — never user-facing recommendations);
- `confidence` 0–1 (the coach's own), `cannotEvaluate {reason}` as a
  first-class honest outcome, review-level `rationale`, timestamps.

The **fault taxonomy** (`datasets/coach-review/taxonomy/
fault-taxonomy.v0-draft.json`) is stroke-family-specific
(dink/volley/drive/overhead/serve/return/drop_reset/speedup + global) and is
an *engineering draft — pending expert validation, will be revised by
coaches*. `global.other_see_rationale` + mandatory prose exist precisely so
the real taxonomy grows from coach language, not our guesses. The **drill
library** (`datasets/coach-review/drills/drill-library.v0.json`) is schema
plus two well-known public drills marked UNVALIDATED with
`validatedFaultMappings: []` — fault→drill mappings require coach evidence.

## 4. How reviews persist

Two equivalent paths, both requiring a provisioned identity:

- **Console submit** — the form validates live against schema v2 and POSTs
  to the dev server, which re-validates, checks the registry, refuses
  synthetic ids, and writes the append-only file (409 on any existing
  reviewId).
- **File drop** — a coach (or a facilitator) writes the exported JSON to
  `datasets/coach-review/reviews/` in a reviewed commit; `pnpm
  lab:coach-queue` picks real files up into `existingReviews` on
  regeneration. The validator can be run in code against any record.

Either way the repo, not a database, is the system of record; reviews are
data with git provenance.

## 5. Agreement

Implemented in `apps/admin-web/src/coachReview/agreement.ts` (unit tests on
clearly-flagged synthetic fixtures). Once an item has ≥2 evaluable reviews
it computes, pairwise: stroke confirmation agreement, rating exact-match and
mean |Δ| on the anchored scale, primary-fault agreement (highest-severity
fault; "clean" counts as a position), per-shared-fault severity agreement,
and fault-set Jaccard overlap. `cannotEvaluate` reviews are counted, never
imputed. Disagreement is **preserved as data — never averaged away**.

## 6. Adjudication (flow stub — cannot precede reviews)

Triggers (computed and displayed per item): stroke mismatch · rating gap ≥2
· primary-fault mismatch. When tripped:

1. The item is flagged in the Agreement view; original reviews stay frozen.
2. A third qualified coach — not one of the original reviewers — reviews the
   clip blind, then with the disagreeing reviews visible, and records
   `datasets/coach-review/adjudications/<queueItemId>.json`:
   `{adjudicatorId, credentialRef, outcome (uphold-A / uphold-B / new
   verdict / unresolvable), rationale, createdAtIso}` — same identity rules,
   same append-only discipline.
3. Downstream consumers use adjudicated truth where it exists and keep the
   disagreement record alongside it (calibration needs the variance, not
   just the verdict).

The directory is intentionally absent today: no reviews → no disagreements →
no adjudications.

## 7. What unlocks TECHNIQUE SCORING (claim gates)

Per docs/CLAIM_REVIEW.md (gate H), docs/SCORING.md and D-031: no technique
score, fault call-out, or drill recommendation ships until, in order:

1. **Coach labels exist** — provisioned coaches complete the queue (≥2 per
   item) and the count is meaningfully larger than today's 5 gold events.
2. **Coaches agree** — agreement metrics clear thresholds set with the
   coaches themselves; residual disagreements adjudicated (§6).
3. **The taxonomy is theirs** — fault-taxonomy v1 issued from coach
   corrections of the v0 draft, with a recorded v0→v1 mapping.
4. **Calibration** — scoring config ranges/σ (docs/SCORING.md "engineering
   starting hypotheses") recalibrated against coach labels → new scoring
   model version; drill mappings become validatedFaultMappings only with
   coach evidence.
5. **Release gates** — the recalibrated model passes the full release path
   (signed bundle, dataset snapshot, locked eval report, coach-validation
   reference — docs/SCORING.md §Versioning) plus stability/fairness/
   camera-perturbation gates.

Until every step lands, the product says: technique scoring is still being
validated — and the Result screen keeps withholding scores, faults, and
drills by design.
