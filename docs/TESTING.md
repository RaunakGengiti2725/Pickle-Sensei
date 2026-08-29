# TESTING

Runner: Vitest per package; `pnpm test` runs everything. CI runs format, lint, typecheck, tests, and a fresh-database migration+seed check on every PR.

## Current suites (all passing)

| Package                   | Coverage                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| @pickle/scoring           | Metric math vs spec formulas (σ decay, full credit in range), presentation bands, abstention below 0.65, lower-confidence band, missing-subsystem abstention, no-config abstention (non-MVP shots), weight-matrix column sums, version identifiers; priority engine: spec example (Preparation over Contact), root-cause promotion, symptom fallback, null when healthy, unobserved exclusion, focus stickiness, goal relevance |
| @pickle/audio-coach-core  | Spec Live Court dialogue (correction → improvement → personal best), low-confidence silence → setup guidance, REPEAT wording, forced quiet rep after consecutive corrections, sparse STABLE praise with cooldown, no rep-1 personal bests, text/SILENCE invariants, determinism                                                                                                                                                 |
| @pickle/vision-contracts  | Interface contracts, typed failures, and deterministic test-only provider behavior. Test inputs live under test support and are not exported by the runtime package.                                                                                                                                                                                                                                                            |
| @pickle/analysis-pipeline | Test-only measurements → versioned analysis math, typed failure propagation, per-shot config selection, and abstention behavior. These tests verify orchestration; they do not validate a camera model or authorize a product score.                                                                                                                                                                                            |
| @pickle/api-contracts     | Canonical shot-sync payload validation (version vector mandatory, ranges, batch cap, low-confidence representability), OpenAPI 3.1 generation                                                                                                                                                                                                                                                                                   |
| @pickle/database          | Migration ordering/checksum units through `0014`; DB integration (fresh migrate ×2 idempotent, seed ×2 idempotent, zero active scoring models, catalog counts) — **skipped without DATABASE_URL_TEST, run in CI**                                                                                                                                                                                                               |
| @pickle/api               | Health, OpenAPI serving, typed 503 when DB absent, typed 501 for specified-but-pending routes, request-id propagation                                                                                                                                                                                                                                                                                                           |
| ML v2 validator           | Exact 61-technique taxonomy and explicit outcomes; consent, rights, non-synthetic source, two-annotator, coach-adjudication, phase, and manifest integrity gates — 17 unit tests passing                                                                                                                                                                                                                                        |

## Policy

- Skipped ≠ passed: DB tests report skipped locally without a database; CI always runs them.
- No disabled tests to get green CI (directive §5).
- Every bug fix lands with a regression test.
- Deterministic test doubles may exercise pure math and state transitions only. They must remain in test code, never appear in app navigation, persistence, production seeds, screenshots, or product metrics.
- Synthetic dataset items may test validators, but cannot satisfy release eligibility.

## Planned (per stage)

- Mobile: expand unit/store/navigation/persistence/sync and E2E critical paths (§47).
- Native: physical-device coordinate, rotation, mirroring, memory, thermal, lifecycle, and capture-trigger validation.
- Models: populate rights-cleared golden-video sets only after consent/licensing review; gate every model release on camera-perturbation and left-handed parity suites.
