# IMPLEMENTATION STATUS

Statuses: NOT_STARTED | IN_PROGRESS | BLOCKED | IMPLEMENTED | TESTED
Rule: IMPLEMENTED only if it exists; TESTED only if tests actually pass.

Last updated: 2026-08-26 (session 1)

## Stage 0 — Understand

| Item                        | Status                   |
| --------------------------- | ------------------------ |
| Read Deep Research (62pp)   | TESTED (n/a — completed) |
| docs/SPEC_DIGEST.md         | IMPLEMENTED              |
| docs/IMPLEMENTATION_PLAN.md | IMPLEMENTED              |
| docs/ARCHITECTURE.md        | IMPLEMENTED              |
| docs/DECISIONS.md           | IMPLEMENTED              |

## Stage 1 — Foundation

| Item                                                         | Status                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| pnpm monorepo + strict TS + ESLint + Prettier + Vitest       | TESTED (lint/typecheck/test/format all green)                                              |
| packages/shared-types (domain, errors, states)               | IMPLEMENTED (types only; exercised by every other suite)                                   |
| packages/api-contracts (Zod /v1 schemas + OpenAPI)           | TESTED (6 tests)                                                                           |
| packages/database (migrations + runner + seeds)              | TESTED (unit + integration vs real Postgres 16: 6 migrations, seeds idempotent)            |
| packages/scoring (engine + priority engine + config v1)      | TESTED (19 tests incl. spec math + spec priority example)                                  |
| packages/audio-coach-core (cue engine)                       | TESTED (9 tests incl. spec Live Court dialogue)                                            |
| packages/vision-contracts (+FixtureVisionProvider)           | TESTED (5 tests incl. production guard)                                                    |
| packages/analysis-pipeline (clip → ShotAnalysis)             | TESTED (3 tests, end-to-end over fixture provider + real scoring)                          |
| services/api skeleton (health, catalog, OpenAPI, typed 501s) | TESTED (5 tests; also smoke-tested live against seeded Postgres)                           |
| docker-compose local infra                                   | IMPLEMENTED (Docker absent on this machine; validated via local homebrew Postgres instead) |
| .env.example                                                 | IMPLEMENTED                                                                                |
| CI PR workflow (.github/workflows/ci.yml)                    | IMPLEMENTED (will run on first push; steps mirror local loop)                              |
| docs: LOCAL_DEVELOPMENT, DATABASE, SCORING, TESTING, API     | IMPLEMENTED                                                                                |

## Stage 2 — Core product (mobile)

All items NOT_STARTED (RN app shell, design system, onboarding, home, catalog, camera UI, local sessions, library, progress foundations, vertical slice 1).

## Stage 3 — Vision infrastructure

All items NOT_STARTED (camera-engine, vision-core, pose baseline, paddle arch, stroke detection, phase segmentation, feature schema, ml/ scaffolding, annotation schema).

## Stage 4 — Single-shot analyzer

NOT_STARTED.

## Stage 5 — Live Court

NOT_STARTED (core cue engine logic lands in Stage 1 as portable package).

## Stage 6 — Backend completeness

NOT_STARTED (media uploads, cloud sync, billing, privacy workflows, flags, notifications).

## Stage 7 — Product depth

NOT_STARTED.

## Stage 8 — Advanced CV

NOT_STARTED.

## Known issues

- Docker absent on this dev machine; DB integration tests skip (visibly) without `DATABASE_URL_TEST` and were validated this session against a throwaway homebrew Postgres 16 cluster instead (DECISIONS D-009). CI runs them against a service container.
- Scoring metric target ranges are starting hypotheses pending coach-panel calibration (labeled as such in code, seeds, docs/SCORING.md).
- `pnpm build` = typecheck for now (packages consumed from source; see DECISIONS D-011 area) — bundling for deploy lands with the infra stage.

## Tests run this session (2026-08-26)

- `pnpm format:check` — pass
- `pnpm lint` — pass
- `pnpm typecheck` — pass (8 packages, strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes)
- `pnpm test` — 50 passed, 0 failed (1 DB integration skipped locally by design)
- `pnpm --filter @pickle/database test` with `DATABASE_URL_TEST` vs real Postgres 16 — 4 passed incl. fresh migrate ×2 + seed ×2 idempotency
- `pnpm --filter @pickle/database migrate && seed` vs real Postgres 16 — 6 migrations applied, seeds complete
- Live API smoke test vs seeded DB — /v1/health 200, /v1/catalog/shot-types serves 8 seeded strokes, pending routes honest 501

## Next highest-priority tasks

1. Stage 2: React Native app shell (New Architecture), design tokens + core components (§46), navigation, SQLite persistence + outbox.
2. Vertical slice 1: launch → onboarding → Home → Forehand Drive → dev capture (fixture provider, labeled) → persisted analysis → result → checkpoints → drill → library.
3. services/api: OIDC auth abstraction + account/bootstrap + shots:sync + sessions against DB (idempotent upserts).
4. ml/ scaffolding: annotation JSON Schema, dataset manifest format, golden-set layout.
