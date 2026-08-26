# IMPLEMENTATION PLAN

Build order follows directive §59 (Stage 0–8) with spec roadmap. Each stage lists concrete deliverables and exit criteria.

## Stage 0 — Understand ✅

- Read Deep Research (62pp), produce `SPEC_DIGEST.md`, `ARCHITECTURE.md`, `DECISIONS.md`, `IMPLEMENTATION_STATUS.md`.
- Repo was empty; no existing work to preserve.

## Stage 1 — Foundation

- pnpm monorepo: `apps/`, `services/`, `packages/`, `native/`, `ml/`, `infra/`, `fixtures/`, `.github/`.
- Strict TypeScript base config (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), ESLint flat config, Prettier, Vitest.
- `packages/shared-types`: domain model (shot types, phases, checkpoints, landmarks, coordinate systems, result types, typed error taxonomy, UI/camera states).
- `packages/api-contracts`: Zod schemas for `/v1` payloads; OpenAPI generation; single source shared mobile↔backend.
- `packages/database`: SQL migrations implementing full schema; migration runner; deterministic seeds (shot types, checkpoints, scoring config v1, drills, dev fixtures marked as fixtures).
- `packages/scoring`: production scoring engine (metric→checkpoint→technique score, confidence gating, versioning) + coaching-priority engine + dependency graph. Pure, deterministic, fully tested.
- `packages/audio-coach-core`: deterministic cue selection engine (categories, cooldowns, silence rules) as portable TS core; native TTS binding later.
- `packages/vision-contracts`: `IPoseProvider`, `IPaddleDetector`, `IBallTracker`, `IStrokeDetector`, `IPhaseSegmenter` interfaces + `FixtureVisionProvider` (explicit dev mock, excluded from production builds by env guard).
- `services/api`: Fastify modular monolith skeleton (identity, catalog, analysis, sessions, progress, billing, privacy modules), health endpoint, request-id middleware, typed config, OpenAPI route validation.
- Local infra: docker-compose (PostgreSQL, Redis, MinIO, elasticmq), `.env.example`, Makefile-equivalent pnpm scripts, `docs/LOCAL_DEVELOPMENT.md`.
- CI: GitHub Actions PR workflow (install, format, lint, typecheck, tests, build, migration check).
- Exit: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green.

## Stage 2 — Core product (mobile shell)

- `apps/mobile`: React Native New Architecture + TypeScript. Navigation, design system (tokens + components §46), auth abstraction, onboarding flow, Home, shot catalog, SQLite persistence, outbox sync scaffolding, Library, Progress foundations.
- Every screen with the §10 state matrix.
- Exit: first vertical slice runs — launch → onboarding → Home → select Forehand Drive → dev capture flow → persisted analysis (fixture provider, clearly labeled) → result → checkpoint breakdown → drill → library.

## Stage 3 — Vision infrastructure

- `native/camera-engine` (iOS Swift/AVFoundation): capture, rolling buffer, orientation transforms.
- `native/vision-core` (Swift/Obj-C++/Core ML): pose baseline execution, paddle detector slot, temporal stroke detector, phase segmenter, feature extraction; portable C++ core where feasible.
- Coordinate system docs + tests (normalized image / pixel / body-relative).
- `ml/` training + export + evaluation scaffolding; dataset manifests; annotation schema (formal JSON Schema).
- Exit: on-device pose over recorded fixture video producing real `PoseFrame` streams into the shared feature extractor.

## Stage 4 — Single-shot analyzer

- Real capture → stroke clip → pose+paddle → phases → features → scoring engine → result screen with confidence gating and priority fix, replay w/ overlays, drill recommendation.
- Fixture inference replaced piecewise; each replacement flips a provider flag, never silently.

## Stage 5 — Live Court

- Rolling native buffer, continuous detection, on-device scoring, AudioCoach TTS, session persistence, summary, thermal tiers, offline guarantee.

## Stage 6 — Backend completeness

- Presigned media uploads, cloud sync, progress/weekly reports, StoreKit/Play billing + entitlements, privacy center (export/delete workflows), feature flags, notifications.

## Stage 7 — Product depth

- Training plans, achievements, weekly review, references, share cards, social (friends/leaderboards, teen-safe defaults).

## Stage 8 — Advanced CV

- Ball tracking, court calibration, 2D→3D research, match/rally analysis.

## MVP critical path (directive §60)

camera → stroke detection → pose+paddle → phases → features → score → confidence → priority fix → Live Court → voice.

## Testing plan pointer

See `docs/TESTING.md` (created with Stage 1) + spec pp. 49–51: mobile unit/store/navigation/persistence/sync; backend unit/integration/auth/DB/queue/idempotency; E2E critical paths; native coordinate/rotation/mirroring/memory/thermal/lifecycle; golden-video regression.
