# ARCHITECTURE

## System overview

```
Player ── React Native App (product UI, orchestration)
              │
              ├── Native camera capture (AVFoundation on iOS; CameraX on Android)
              ├── Native pose overlay (Apple Vision / MediaPipe; skeleton,
              │        measured joint-motion intensity, framing, motion trigger)
              ├── Scoring Engine (`packages/scoring`; dormant in the shipping
              │        capture path until validated model measurements exist)
              ├── AudioCoach (deterministic cue core + native TTS)
              └── Encrypted local DB (SQLite) + local video directory
              │
        REST /v1 API (Fastify modular monolith, TypeScript)
              ├── OIDC/Auth ─ Cognito-class provider
              ├── PostgreSQL (RDS) ─ canonical structured data
              ├── Redis ─ cache/rate limiting
              ├── SQS ─ media + ML jobs → media-worker, ml-worker (Python+GPU later)
              ├── S3 private media + CloudFront
              ├── Analytics pipeline (typed events)
              └── OpenTelemetry
Admin/Coaching CMS ─ admin-web (later phase)
```

Key principle (spec p. 3): **the video frame loop never depends on React Native JavaScript or network latency.** RN owns product UI; native owns camera acquisition, preprocessing, model execution, temporal tracking, live feedback loop.

## Monorepo layout

```
apps/mobile            React Native app (Stage 2+)
apps/admin-web         Internal CMS (Stage 6+)
apps/marketing-web     Next.js marketing (later)
services/api           Modular monolith: identity, profiles, catalog, media,
                       analysis, sessions, progress, training, social, billing,
                       notifications, privacy, admin
services/media-worker  SQS consumer: normalize/transcode/thumbnail
services/ml-worker     Cloud deep analysis (not implemented; API returns typed 501)
packages/shared-types  Domain model, error taxonomy, states — zero deps
packages/api-contracts Zod schemas + OpenAPI for /v1; consumed by api + mobile
packages/database      SQL migrations, migration runner, seeds
packages/scoring       Scoring engine + coaching priority engine (pure TS)
packages/audio-coach-core  Deterministic cue selection (pure TS)
packages/vision-contracts  IPoseProvider/IPaddleDetector/IStrokeDetector/
                       IPhaseSegmenter/IBallTracker interfaces
packages/config        Shared tsconfig/eslint
native/vision-core     Apple Vision pose baseline and temporal motion trigger
native/camera-engine   AVFoundation capture and rolling buffer
native/audio-coach     TTS binding (Stage 5)
native/media-encoder   Clip encoding (Stage 3)
ml/                    pose, paddle, ball, stroke-detection, phase-segmentation,
                       biomechanics, scoring, datasets, annotations, evaluation,
                       training, export, experiments
infra/terraform        VPC, ALB, ECS, RDS, Redis, S3, CloudFront, SQS, DLQ, IAM,
                       KMS, Secrets, CloudWatch, WAF, ECR
docs/                  This documentation set
.github/workflows      CI/CD
```

## Data flow: single-shot analysis

iOS: AVFoundation → Apple Vision body pose → live skeleton + measured joint-motion glow → wrist-motion trigger → retain ~2 seconds before and ~1.5 seconds after the trigger → store a private clip plus the bounded v1 pose-evidence summary → return `unknown`/`awaiting_model`.

Android: CameraX → bundled MediaPipe BlazePose → the same live pose/motion presentation and automatic short-clip capture → store a private clip plus the same evidence contract → return `unknown`/`awaiting_model`.

There is no stroke picker in this flow. The result preserves analyzed-input counts, usable/missing pose counts, canonical-joint visibility/coverage, and sparse camera-relative per-joint movement from the detected interval. The overlay and result show observations only; they do not claim a stroke classification or coaching diagnosis. Every clip carries a typed ball-speed state, but a number is accepted only with calibrated ball-track provenance; shipping native capture returns `unavailable`. See `docs/CAPTURE_EVIDENCE.md`. Paddle detection, calibrated ball tracking, stroke classification, phase segmentation, feature extraction, and coach-validated scoring must all pass their release gates before the latter half of the intended pipeline can run. Cloud deep analysis is disabled with a typed 501 and releases its permit; it does not queue a pretend result.

## Data flow: Live Court

The deterministic cue/session engines and native text-to-speech binding exist, but the end-to-end Live Court loop is unavailable in product because no validated classifier/scoring bundle can produce trustworthy repetitions. Intended future flow: continuous native capture → validated repetition event → mechanics + confidence → accepted local score → cue → persistence → canonical sync.

## Scoring pipeline (pure, versioned)

```
vision measurements → metric scores q_m → checkpoint scores C_j → checkpoint confidence
→ overall technique score S (0–10) → analysis confidence A → coaching priority
```

- Data-driven per-shot configuration and scoring math exist, but current targets are engineering hypotheses rather than coach-calibrated release values. They are not fed by the shipping camera path.
- A < 0.65 ⇒ `LOW_CONFIDENCE` result with setup guidance; no numeric grade.
- Every result carries the full version vector (app, model bundle, pose, paddle, stroke, phase, scoring model, shot config).

## Runtime truth boundary

Production runtime accepts only real native camera observations and canonical server data. Deterministic inputs used to exercise pure scoring/cue logic are test-only and are not exported as a runtime vision provider. The database retains a legacy `fixture` source enum value for migration compatibility; the app does not create or present those rows.

Training recommendations are also data-bound: the production catalog starts empty and only serves reviewed drills and rights-cleared media published through the catalog workflow. It never substitutes placeholder workouts or unlicensed web videos.

## Coordinate systems (directive §15)

- `normalized-image`: x,y ∈ [0,1], origin top-left, pre-rotation applied. Canonical interchange format.
- `pixel`: integer frame coordinates; used only inside native preprocessing.
- `body-relative`: origin mid-hip, scaled by shoulder-hip distance; used by biomechanics features.
- `world-approx`: pose-model world output, labeled approximate; never presented as laboratory measurement.
  Conversions live in one module with tests; never implicit.

## Error taxonomy (directive §6)

Every operation returns a typed result: success | timeout | retryable | permanent | low-confidence | permission | network | unsupported-device | corrupted-media | auth failure. No silent fallbacks. `packages/shared-types/src/errors.ts`.

## Offline-first

SQLite durable store, client-generated UUIDs, outbox table with retry + idempotency keys. Every shot outbox item retains its pre-inference permit id; the server atomically binds shot + permit and finalizes the permit. Only exact owner/shot/permit replays are idempotent, and mobile deletes only ids the server explicitly accepts. Rejections remain queued with their typed reason.

## Backend

Fastify + TypeScript modular monolith; modules communicate in-process via typed service interfaces. Zod request/response validation from api-contracts. Postgres via `pg` with per-request context (request id, actor). Redis rate limiting. SQS jobs. Split a module out only with real scaling/organizational need.

## Entitlement boundary

The server reserves an analysis permit before inference and atomically binds a successful rating to that permit. Exactly two lifetime successful, server-accepted ratings are free; abstentions, model-unavailable captures, failures, cancellations, and incorrect-recognition releases do not consume them. The third attempted rating is a hard paywall unless the canonical entitlement is active. Until a validated model can emit an accepted rating, the allowance remains untouched.

## Model delivery

Signed model bundles use a server-controlled compatibility matrix, staged rollout/rollback, and per-model kill switches. A scoring model is separately released through the audited `PUT /v1/admin/scoring-models/:shotType/:version/release` gate only when its bundle is 100% active and SHA-256 verified and its dataset snapshot, locked evaluation-report hash, coach-validation reference, releasing admin, and exact shot-config version are recorded. Seeds remain `validating`; fresh databases have zero active scoring models. Canonical sync rechecks the release record rather than trusting a client version string.
