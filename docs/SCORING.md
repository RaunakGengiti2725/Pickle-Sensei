# SCORING

Implementation: `packages/scoring` (pure TypeScript, deterministic, fully tested). Native mirrors for the live loop must pass the same golden vectors.

## Pipeline

```
vision measurements (metricKey, value, confidence, source)
→ metric scores        q_m = 100·exp(−½(d_m/σ_m)²),  d_m = max(L−x, 0, x−U)
→ checkpoint scores    C_j = Σ a_m·c_m·q_m / Σ a_m·c_m
→ checkpoint confidence, severity, fault direction (from worst metric)
→ overall score        S = 10·ΣW_j·C_j / (100·ΣW_j)   (observable checkpoints only)
→ analysis confidence  A = ΣW_j·c_j / ΣW_j            (ALL applicable checkpoints)
→ presentation gate    A<0.65 abstain · 0.65–0.80 lower-confidence · ≥0.80 normal
→ coaching priority    P_j = Severity·Confidence·CoachPriority·Changeability·GoalRelevance
                       + dependency promotion of root causes
```

## Abstention (directive §72)

`A < 0.65` ⇒ `LOW_CONFIDENCE`: no numeric grade, all checkpoint scores withheld, guidance returned ("Couldn't read this stroke clearly. Reposition the phone."). Unobserved-but-applicable checkpoints contribute **zero** confidence to A — a stroke with no paddle observations cannot be graded, by construction. Shot types without metric configs (the four non-MVP strokes today) always abstain; they never get invented scores.

## Bands

80–100 green/strong · 65–79 yellow/improve · <65 red/priority. Thresholds move only after coach calibration → new scoring model version.

## Priority engine (spec p. 35)

Not simply the lowest checkpoint. Base priority multiplies severity, confidence, coach priority, changeability, goal relevance; session focus gets stickiness (×1.25). Dependency edges (preparation → paddle_path → contact_position, etc.) transfer 0.6× of a faulty effect's priority to a materially faulty cause (severity ≥ 0.25), iterated to a fixed point — so "Primary fix = Preparation, not Contact" exactly as the blueprint's example. The spec example is a unit test.

## Versioning (directive §22)

Config v1 (`sm-v1`, per-shot `<slug>@1`) lives in `packages/scoring/src/config/v1.ts` and is seeded into `scoring_model*` tables from the same source (no drift). Every analysis records the full eight-field version vector. Recalibration = new version; history is never silently rescored.

## Status of the numbers

Weights are the blueprint's matrix verbatim (spec p. 32, column sums = 100, enforced by test). Metric target ranges/σ are engineering starting hypotheses awaiting the coach advisory panel — explicitly labeled as such in code, seeds, and this doc. Serve legality is a separate concept (Serve Check) and is intentionally absent from technique scoring.
