# TESTING

Runner: Vitest per package; `pnpm test` runs everything. CI runs format, lint, typecheck, tests, and a fresh-database migration+seed check on every PR.

## Current suites (all passing)

| Package                   | Coverage                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| @pickle/scoring           | Metric math vs spec formulas (σ decay, full credit in range), presentation bands, abstention below 0.65, lower-confidence band, missing-subsystem abstention, no-config abstention (non-MVP shots), weight-matrix column sums, version identifiers; priority engine: spec example (Preparation over Contact), root-cause promotion, symptom fallback, null when healthy, unobserved exclusion, focus stickiness, goal relevance |
| @pickle/audio-coach-core  | Spec Live Court dialogue (correction → improvement → personal best), low-confidence silence → setup guidance, REPEAT wording, forced quiet rep after consecutive corrections, sparse STABLE praise with cooldown, no rep-1 personal bests, text/SILENCE invariants, determinism                                                                                                                                                 |
| @pickle/vision-contracts  | Fixture provider refuses production construction, fixture tagging end-to-end, typed failures for unsupported shots and corrupt clips, determinism                                                                                                                                                                                                                                                                               |
| @pickle/analysis-pipeline | End-to-end fixture clip → versioned fixture-tagged ShotAnalysis with real scoring (late-contact fault surfaces), typed failure propagation, per-shot config selection                                                                                                                                                                                                                                                           |
| @pickle/api-contracts     | Canonical shot-sync payload validation (version vector mandatory, ranges, batch cap, low-confidence representability), OpenAPI 3.1 generation                                                                                                                                                                                                                                                                                   |
| @pickle/database          | Migration ordering/checksum units; DB integration (fresh migrate ×2 idempotent, seed ×2 idempotent, catalog counts) — **skipped without DATABASE_URL_TEST, run in CI**                                                                                                                                                                                                                                                          |
| @pickle/api               | Health, OpenAPI serving, typed 503 when DB absent, typed 501 for specified-but-pending routes, request-id propagation                                                                                                                                                                                                                                                                                                           |

## Policy

- Skipped ≠ passed: DB tests report skipped locally without a database; CI always runs them.
- No disabled tests to get green CI (directive §5).
- Every bug fix lands with a regression test.

## Planned (per stage)

- Stage 2 mobile: unit/store/navigation/persistence/sync suites; E2E critical paths (§47).
- Stage 3 native: coordinate transforms, rotation, mirroring, memory, thermal, lifecycle.
- Stage 4+: golden-video regression sets (`golden/*`, spec p. 50) gating every model release; camera-perturbation and left-handed parity suites.
