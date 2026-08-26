# DECISIONS

Format: date, decision, why, alternatives considered. Ambiguity hierarchy (directive §69): Deep Research spec → existing repo architecture → platform docs → simplest reversible professional choice.

## 2026-08-26 — D-001: pnpm workspaces monorepo

Spec/directive require monorepo. pnpm chosen over yarn/npm workspaces: installed locally (10.15.1), strict node_modules isolation, fast, standard for RN+backend monorepos. Turborepo deferred — plain pnpm scripts suffice until build graph grows; reversible.

## 2026-08-26 — D-002: Fastify over NestJS for services/api

Spec allows either. Fastify: lighter, faster cold start, first-class JSON-schema validation pairs directly with Zod-generated schemas, fewer decorator abstractions. Modular monolith boundaries enforced by folder/module convention + lint rules instead of Nest DI. Reversible; contracts live in packages/api-contracts either way.

## 2026-08-26 — D-003: Zod as single schema source

Directive §29 forbids duplicate drifting types. Zod schemas in `packages/api-contracts` produce (a) static TS types for mobile+backend, (b) JSON Schema for Fastify validation, (c) OpenAPI document. zod v4 with native JSON Schema conversion (no external converter dep).

## 2026-08-26 — D-004: Scoring engine as pure TypeScript package first

The scoring math (spec pp. 33–35) is deterministic and model-independent: it consumes measurements, applies data-driven config. Implementing it as a pure package makes it testable now, shared by backend validation + mobile JS orchestration, and portable to native (C++) for the live loop later. The native mirror must pass the same golden test vectors.

## 2026-08-26 — D-005: FixtureVisionProvider guard

Directive §5. Fixture provider constructor throws if `PICKLE_ENV === 'production'`; every emitted artifact tagged `source: 'fixture'`; scoring engine preserves the tag into persisted analyses so UI/DB can never present fixture data as real inference. Test asserts the guard.

## 2026-08-26 — D-006: SQL-file migrations with tiny in-repo runner

Full control over DDL from spec pp. 13–17 (checks, FKs, partial indexes) argued against ORM-generated migrations. Runner: ordered `NNNN_name.sql` files + `schema_migrations` table, transactional per file, checksum verification. Drizzle/Prisma can be layered later for query ergonomics; schema source of truth stays SQL.

## 2026-08-26 — D-007: Version vector embedded as one JSONB + typed columns

Spec §22 requires eight version fields per analysis. Hot query fields (`scoring_model_id`, `model_bundle_version`) are real columns; the complete vector is also stored as validated `version_vector` JSONB on `shot` for forward-compatible additions. Never rescored in place.

## 2026-08-26 — D-008: Node 20 LTS baseline

Installed runtime v20.20.0. `engines` pinned `>=20 <21` for now; bump deliberately.

## 2026-08-26 — D-009: Docker not present on dev machine

docker-compose file provided for Postgres/Redis/MinIO/ElasticMQ; documented as prerequisite in LOCAL_DEVELOPMENT.md. DB-integration tests are skipped (not faked) when `DATABASE_URL` is absent — they report SKIPPED, never green-washed.

## 2026-08-26 — D-010: Scoring config v1 shipped as seed data + bundled JSON

The eleven-checkpoint weighting matrix (spec p. 32) and per-shot metric targets ship as `scoring_model` seeds (DB) and as a versioned JSON bundle consumed by mobile offline. Both generated from one source module in `packages/scoring/src/config/v1.ts` to prevent drift. Explicitly labeled "starting hypothesis for expert validation" per spec.

## 2026-08-26 — D-011: Mobile app deferred to Stage 2 with RN New Architecture

Directive §12. Creating the RN project requires iOS toolchain steps done interactively; Stage 1 of this build focuses on foundation packages + backend so mobile lands on stable contracts. Not a scope cut — sequencing per §59. (Superseded same day by the all-at-once build session: RN 0.87 app created, built, and running — see D-013.)

## 2026-08-26 — D-012: Migration 0007 additions beyond the spec table list

`shot_rating` (user feedback per analysis), `billing_offering` (remote-configurable pricing the spec demands but did not table), `feature_flag`, `user_profile.handle` (friend discovery without phone/email), `deletion_task` (the §58 deletion workflow needs a resumable queue). Each maps to an explicit spec requirement; documented here because they extend the p. 13–17 table inventory.

## 2026-08-26 — D-013: apps/mobile is npm-managed, excluded from the pnpm workspace

Metro + pnpm's symlinked node_modules is a known friction source; the RN app uses npm (its lockfile committed) and consumes shared packages from TypeScript source via a metro `resolveRequest` that maps the packages' ESM ".js" specifiers to ".ts" files, plus `nodeModulesPaths` for helper resolution. Jest mirrors this with moduleNameMapper. tsconfig paths mirror it for typecheck. One convention, three configs, all committed.

## 2026-08-26 — D-014: Native modules via local CocoaPod, not pbxproj editing

`ios/LocalPods/PickleNative` (podspec + Swift/ObjC sources) is added by one Podfile line; `pod install` wires it into the Xcode project. Hand-editing project.pbxproj is fragile and unreviewable. First module: PickleAudioCoach (AVSpeechSynthesizer TTS). VisionCore/CameraEngine follow the same pattern when wired.

## 2026-08-26 — D-015: Apple Vision body-pose as the real pose baseline

Spec p. 26 allows a proven on-device baseline. `ApplePoseProvider` (VNDetectHumanBodyPoseRequest) needs no model download, runs on-device, and covers the MVP landmark set. MediaPipe/LiteRT remains the alternative if per-checkpoint validation shows Vision accuracy gaps. Not yet wired into the app loop; parse-verified source in native/vision-core.

## 2026-08-26 — D-016: Store receipt validation is typed-501 until credentials exist

Directive §5 forbids fake subscription validation. Offerings, entitlements (grant/check/expiry), quota gating, and audited admin grants are fully implemented and tested; the Apple/Google verification calls activate only when `APPLE_IAP_PRIVATE_KEY`/`GOOGLE_PLAY_SERVICE_ACCOUNT` are configured, and say so in their error envelopes.

## 2026-08-26 — D-017: Test databases are per-suite sequential, not parallel

The DB-backed suites (database, api, media-worker) each reset the schema of the test database; root `pnpm test` pins `--workspace-concurrency=1` so they serialize. CI uses one Postgres service container. Parallelization later = per-suite database names.
