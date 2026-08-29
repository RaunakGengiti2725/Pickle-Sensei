# COACH GATES — frozen release criteria for score / fault / drill

**Spec: `datasets/coach-review/gates/coach-gates.v1.json` (`coach-gates-frozen-v1`).**
Checker: `packages/swing-lab/src/coachGates.ts` · `pnpm lab:coach-gates`.

## Why frozen now

Zero coach reviews exist (docs/COACHING.md), so this is the last moment the
release criteria can be written **without** the possibility of tuning them to
data. The spec above is that pre-registration: every threshold for shipping a
technique score, a fault call-out, or a drill recommendation is fixed before
the first coach label. When real coaches arrive, the only remaining work is
producing the evidence — the bar itself is already set and machine-checked.

## Freeze discipline

- The spec file is never edited. A change is a NEW file
  (`coach-gates.v2.json`, …) with a recorded rationale; thresholds may only be
  tightened without a coach-panel decision record.
- The checker pins the spec's SHA-256 (`COACH_GATES_V1_SHA256`) and refuses a
  tampered file — silently weakening a threshold breaks the build.
- Held-out cases `wm-dink-01` and `afn-vic-rally1` count toward **no** gate
  denominator, ever.
- `NOT_EVALUABLE` (insufficient real evidence) blocks release exactly like
  `FAIL`. Today every validation gate is `NOT_EVALUABLE` and the overall
  verdict is `RELEASE_BLOCKED` — that is the honest current state.

## The gate sets (summary; the JSON is authoritative)

| Surface              | Gates                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| technique score      | L1 L2 L4 · S1 correlation · S2 ranking · S3 calibration · S4 test-retest · S5 new-player/camera/court generalization · S6 perturbation insensitivity (HARD: unstable score does not ship) · S7 silent-failure rate |
| fault diagnosis      | L1 L2 L4 · F1 coach-owned stroke-specific taxonomy · F2 per-fault precision/recall · F3 primary-fault agreement · F4 false-confident-fault rate (silent failure)                                                   |
| drill recommendation | L1 L2 L4 · D1 coach-evidenced mappings only · D2 no drill for an unvalidated fault · D3 coach-curated library v1                                                                                                   |

Lock gates (L1/L2/L4) are evaluable **now** and must stay green until the
validation gates flip them: production `TechniqueAnalysisProfile`s stay
`BLOCKED_ON_VALIDATION`, the coach registry stays synthetic-free, and the
drill library stays `UNVALIDATED` with empty `validatedFaultMappings`.

## Evidence rules

- Coach evidence = reviews by coaches provisioned in
  `datasets/coach-review/coaches.json` (active, non-synthetic, off-repo
  credential). Engineer self-labels and LLM output satisfy nothing;
  machine-proposed content is Tier-C, never Gold.
- S4/S6 need real re-captures / re-encodes of the same physical stroke run
  through the full pipeline (pose extraction is Mac/Apple-Vision-gated;
  re-capture pairs need a physical iPhone). The Linux formula-level probe
  (`pnpm lab:score-stability`, report under `datasets/experiments/wave-g2/`)
  is diagnostic evidence about the score formula only and satisfies no
  video-level gate.

## Relationship to existing docs

This freezes, as machine-checkable predicates, what docs/COACHING.md §7,
docs/SCORING.md ("Status of the numbers"), and docs/CLAIM_REVIEW.md already
state in prose: no score, fault, or drill ships until coach validation. The
sm-v1 scoring engine remains an engineering hypothesis; its release path
(`PUT /v1/admin/scoring-models/...`) already demands a coach-validation
reference, and this spec defines what that reference must contain.
