# SCORING

Implementation: `packages/scoring` (pure TypeScript, deterministic, unit-tested). This verifies the math, not the validity of its inputs or calibration. The shipping native camera currently returns `unknown`/`awaiting_model` and does not invoke this engine for a product score. Future native mirrors for the live loop must pass the same golden vectors plus coach/model release gates.

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

Config v1 (`sm-v1`, per-shot `<slug>@1`) lives in `packages/scoring/src/config/v1.ts` and is seeded into `scoring_model*` tables from the same source (no drift) in `validating` state. Seeds never activate it; a fresh database has zero active scoring models. Every analysis records the full eight-field version vector. Recalibration = new version; history is never silently rescored.

A scoring model becomes eligible for canonical sync only through `PUT /v1/admin/scoring-models/:shotType/:version/release`. Release requires a 100%-active SHA-256-verified model bundle, dataset snapshot, locked evaluation-report hash, coach-validation reference, releasing admin identity, and exact agreement between the released shot-config version and the submitted analysis. The sync path enforces these facts; a known-but-unreleased version is rejected.

## Status of the numbers

Weights are the blueprint's matrix verbatim (spec p. 32, column sums = 100, enforced by test). Metric target ranges/σ are engineering starting hypotheses awaiting coach calibration and must not be described as validated pickleball ratings. No successful product rating exists until a signed model bundle supplies trustworthy observations and passes coach-agreement, stability, fairness, and camera-perturbation gates. Serve legality is a separate concept (Serve Check) and is intentionally absent from technique scoring.
