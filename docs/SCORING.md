# SCORING

Implementation: `packages/scoring` (pure TypeScript, deterministic, unit-tested). The shipping mobile app invokes this engine through `apps/mobile/src/vision/providers.ts` and `packages/analysis-pipeline/src/analyzeCapture.ts`, after loading a hash-verified recorded pose sequence. Both guided captures and analyzed imports can produce a technique score. Software tests verify calculations and failure handling, not input validity, coaching accuracy, or calibration.

The current path uses 2D body geometry. The phase named `contact` comes from a wrist-speed peak unless a supported estimate is available; it is not verified ball contact. Paddle-side measurements may use the hitting wrist as a disclosed proxy. No ball speed, paddle-face angle, force, injury-risk estimate, or measured 3D rotation follows from those observations.

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

`A < 0.65` ⇒ `LOW_CONFIDENCE`: no numeric grade, checkpoint grades withheld, and recovery guidance returned. Unobserved-but-applicable checkpoints contribute zero confidence to A. Missing paddle observations do not categorically prevent the shipping geometry scorer from grading a stroke: it can use disclosed wrist-based proxies. Missing required providers, insufficient pose evidence, unresolved stroke identity, or an unavailable per-stroke configuration can still withhold the score. Abstentions release the reservation rather than spend a free rating.

The confidence value aggregates observation quality; it is a heuristic, not a calibrated probability. Passing a confidence threshold does not establish that a coaching cue is correct.

## Bands

80–100 green/strong · 65–79 yellow/improve · <65 red/priority. Thresholds move only after coach calibration → new scoring model version.

## Priority engine (spec p. 35)

Not simply the lowest checkpoint. Base priority multiplies severity, confidence, coach priority, changeability, goal relevance; session focus gets stickiness (×1.25). Dependency edges (preparation → paddle_path → contact_position, etc.) transfer 0.6× of a faulty effect's priority to a materially faulty cause (severity ≥ 0.25), iterated to a fixed point — so "Primary fix = Preparation, not Contact" exactly as the blueprint's example. The spec example is a unit test.

## Versioning (directive §22)

Config v1 (`sm-v1`, per-shot `<slug>@1`) lives in `packages/scoring/src/config/v1.ts`. The mobile provider registry composes the on-device scorer from that code. Analyses record their model/config version vector; recalibration requires a new version, not rewriting historical scores.

The separate legacy `packages/database` seeds place these configurations in `validating` state and activate none. Its Fastify endpoint `PUT /v1/admin/scoring-models/:shotType/:version/release` requires a SHA-256-verified bundle, dataset snapshot, locked evaluation-report hash, coach-validation reference, releasing admin, and matching shot-config version. That endpoint does not exist in the production Supabase Edge Function. Do not attribute the legacy release workflow to the shipping sync path, or describe a checksum as an authenticated signature.

## Status of the numbers

Weights come from the blueprint's matrix (spec p. 32, column sums = 100, enforced by test). Metric target ranges/σ remain engineering hypotheses awaiting coach calibration. The app currently displays their outputs; this does not establish validated pickleball ratings. Repository coach-gate reports with no real reviews are evidence of a validation gap, not evidence that the current app withholds all scores.

Practice Set and Progress compare scores only within compatible scoring/config versions. Those deltas describe score arithmetic, not proof that a player's movement improved. The DUPR-style figure is a linear familiarity aid, not a verified match rating or a validated conversion. Serve legality remains separate from technique scoring.

New form-comparison research must remain offline until it has consented, rights-cleared recordings, independent annotations and coach adjudication, athlete/session-separated evaluation, measured repeatability, and camera-perturbation results. Synthetic fixtures can establish software invariants only. Preserve original timing when aligning attempts, and disclose non-comparable views or insufficient evidence rather than infer improvement.
