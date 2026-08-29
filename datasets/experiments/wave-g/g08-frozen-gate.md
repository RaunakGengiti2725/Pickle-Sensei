# g08-f22-evidence — FROZEN PROMOTION GATE (v1.0)

Gate version: `g08-f22-evidence-gate-v1.0-frozen`
Frozen: 2026-08-29, on branch `devin/wave-g/g08-f22-evidence`, BEFORE any
human label exists (`datasets/experiments/wave-g/g08-labels.json` is empty at
freeze time and its emptiness is asserted in the committed gate report).

This document is hashed (sha256) into
`packages/capture-envelope/src/g08Gate.ts` (`G08_FROZEN_GATE_DOC_SHA256`) and
the hash is asserted by `packages/capture-envelope/test/g08Gate.test.ts`.
Editing this document after labels exist breaks the pin and is prohibited.
Any change to the metric definitions or criteria requires a NEW gate version
evaluated only against labels collected after that change.

## Scope

The six label-dependent F22 bypass families (from
`datasets/experiments/wave-f/f22-rt-envelope-bypass-summary.json`), i.e. the
gaps whose defensible fix requires labeled corpus evidence per the E15/F18
mandate:

| family              | F22 finding                       |
| ------------------- | --------------------------------- |
| blur_masked_by_noise| f22-B1 (grain defeats blur proxy) |
| bimodal_exposure    | f22-B2 (spatial mean mid-band)    |
| strobing_exposure   | f22-B3 (temporal mean mid-band)   |
| upscaled_content    | f22-B4 (metadata-only resolution) |
| tiny_subject        | f22-B5 (NOT_MEASURED pose dims)   |
| camera_shake        | f22-B7 (contrast-dependent proxy) |
| (false-reject side) | f22-FR1 (low-texture sharp scenes flagged) — measured by falseRejectRate on SAFE labels |

## Truth definition

Truth is EXCLUSIVELY human labels conforming to
`g08-f22-evidence-labels-v1` (`packages/capture-envelope/src/g08LabelSchema.ts`)
stored in `datasets/experiments/wave-g/g08-labels.json`:

- capture: SAFE / DEGRADED / UNSAFE / AMBIGUOUS (AMBIGUOUS = honest human
  abstention; counted and reported, never dropped, never folded).
- downstream: USABLE / DEGRADED_RESULT / UNUSABLE_DISCLOSED / SILENT_FAILURE
  / NOT_RUN, only when a real downstream analysis run exists for the window.
- Machine-proposed review-pack candidates are Tier-C and are never truth.
  `annotatorKind` must be `"human"`; validation rejects anything else.
- The label file is append-only; corrections are new records with
  `supersedesLabelId`.

## Metrics (all reported WITH counts; no rate without N)

For a set of labeled windows joined with the envelope verdict a given checker
configuration produces on exactly those windows ("flagged" = overall
DEGRADED or UNSUPPORTED; "passed" = overall SUPPORTED):

1. **falseSafeRate** = #(capture=UNSAFE ∧ passed) / #(capture=UNSAFE)
2. **falseRejectRate** = #(capture=SAFE ∧ flagged) / #(capture=SAFE)
3. **missedDegradationRate** = #(capture=DEGRADED ∧ passed) / #(capture=DEGRADED)
   (reported separately; never folded into falseSafeRate)
4. **usableRateGivenSupported** = #(downstream=USABLE ∧ passed) /
   #(downstream ∈ {USABLE, DEGRADED_RESULT, UNUSABLE_DISCLOSED, SILENT_FAILURE} ∧ passed)
5. **usableRateGivenFlagged** = same numerator/denominator conditioned on flagged
6. **silentFailureRateGivenSupported** = #(downstream=SILENT_FAILURE ∧ passed) /
   #(downstream known ∧ passed)

AMBIGUOUS windows are excluded from denominators 1–3 and reported as a
separate count. NOT_RUN windows are excluded from 4–6 only.

Implementation: `computeG08Metrics` in
`packages/capture-envelope/src/g08Gate.ts` (unit-tested).

## Minimum evidence (per family) — below this the gate is NOT DECIDABLE

- ≥ 10 human-labeled windows in the family (AMBIGUOUS included in the count)
- ≥ 5 windows labeled UNSAFE or DEGRADED
- ≥ 3 windows labeled SAFE
- ≥ 3 distinct sessionKeys (windows from one session are not independent)

## Promotion criteria (candidate proxy/threshold change for a family)

ALL must hold on that family's human labels:

1. Evidence sufficient (above).
2. Candidate falseSafeRate ≤ 0.20.
3. Candidate falseRejectRate ≤ 0.20.
4. Candidate falseSafeRate ≤ incumbent falseSafeRate (false-safes may never
   increase).
5. Candidate falseRejectRate ≤ incumbent falseRejectRate + 0.05.
6. Candidate silentFailureRateGivenSupported ≤ incumbent's, whenever both
   sides are measurable.
7. **ONE-SHOT RULE**: each candidate configuration is evaluated against the
   frozen label set at most once. Re-tuning against the same labels after a
   failed evaluation is prohibited; a failed candidate requires NEW labels
   (new windows or new sessions) for its next attempt.
8. Any promoted change re-versions the affected threshold/proxy ids
   (HANDOFF rule: re-version, never soften in place).

## Evaluation protocol

`pnpm --filter @pickle/capture-envelope gate:g08` runs
`packages/capture-envelope/src/g08EvalGate.ts` end-to-end:

1. Load and validate `g08-labels.json` (schema + tier rules).
2. Join every effective label with the envelope verdict recomputed from the
   committed clip at the labeled window using the CURRENT checker.
3. Emit `datasets/experiments/wave-g/g08-gate-report.json` with per-family
   and overall metrics (counts + rates), evidence sufficiency, and a
   BLOCKED_EXTERNAL statement whenever evidence is insufficient.

With zero labels the run must complete and report every family NOT DECIDABLE
with all counts 0 — proving the human label file is the only missing input.

## Held-out discipline

`wm-dink-01` and `afn-vic-rally1` are never opened, measured, mined, or
labeled under this gate. `datasets/pickleball/fresh-candidates/` clips are
label-blind holdout candidates and are excluded from mining and labeling.
