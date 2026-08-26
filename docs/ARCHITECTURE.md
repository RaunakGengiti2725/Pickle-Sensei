# ARCHITECTURE

## System overview

```
Player ── React Native App (product UI, orchestration)
              │
              ├── Native CameraEngine (AVFoundation; buffers, rolling record)
              ├── Native VisionCore (C++/Core ML/LiteRT; pose, paddle, ball-later,
              │        stroke phase model, feature extraction)
              ├── Local Scoring Engine (shared TS core `packages/scoring`,
              │        mirrored natively for live loop where latency demands)
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
services/ml-worker     Cloud deep analysis (later; Python+FastAPI)
packages/shared-types  Domain model, error taxonomy, states — zero deps
packages/api-contracts Zod schemas + OpenAPI for /v1; consumed by api + mobile
packages/database      SQL migrations, migration runner, seeds
packages/scoring       Scoring engine + coaching priority engine (pure TS)
packages/audio-coach-core  Deterministic cue selection (pure TS)
packages/vision-contracts  IPoseProvider/IPaddleDetector/IStrokeDetector/
                       IPhaseSegmenter/IBallTracker + FixtureVisionProvider (dev-only)
packages/config        Shared tsconfig/eslint
native/vision-core     Swift/ObjC++/C++ vision runtime (Stage 3)
native/camera-engine   AVFoundation capture (Stage 3)
native/audio-coach     TTS binding (Stage 5)
native/media-encoder   Clip encoding (Stage 3)
ml/                    pose, paddle, ball, stroke-detection, phase-segmentation,
                       biomechanics, scoring, datasets, annotations, evaluation,
                       training, export, experiments
infra/terraform        VPC, ALB, ECS, RDS, Redis, S3, CloudFront, SQS, DLQ, IAM,
                       KMS, Secrets, CloudWatch, WAF, ECR
fixtures/              Deterministic dev fixtures (clearly labeled)
docs/                  This documentation set
.github/workflows      CI/CD
```

## Data flow: single-shot analysis

Mobile LE → CameraEngine guided capture → VisionCore continuous frames → framing/paddle readiness → stroke + phases → pose/paddle/temporal features → scoring engine → score + checkpoints + priority fix → save structured analysis + local clip → show result. Cloud-sync-disabled: structured result sync only. Cloud enabled: presigned upload → private S3 → POST /v1/analyses → SQS deep analysis → updated result.

## Data flow: Live Court

Start session → 60fps capture + rolling buffer → per repetition: stroke event → freeze pre/post window → analysis frames → phases + mechanics + confidence → local score persist → cue select → TTS. End session → instant local summary → batch sync shots/session → canonical server acknowledgement.

## Scoring pipeline (pure, versioned)

```
vision measurements → metric scores q_m → checkpoint scores C_j → checkpoint confidence
→ overall technique score S (0–10) → analysis confidence A → coaching priority
```

- Data-driven per-shot configuration (weights, targets, applicability) from `scoring_model*` tables / bundled JSON; no shot-specific switch blocks.
- A < 0.65 ⇒ `LOW_CONFIDENCE` result with setup guidance; no numeric grade.
- Every result carries the full version vector (app, model bundle, pose, paddle, stroke, phase, scoring model, shot config).

## Vision provider abstraction

```
VisionProvider
├── RealVisionProvider      (native inference; production)
└── FixtureVisionProvider   (deterministic dev fixtures; NEVER in production builds)
```

`FixtureVisionProvider` refuses to construct when `NODE_ENV==='production'`/release build flag, and every result it emits is tagged `source: 'fixture'` end-to-end so UI can label it. Directive §5/§61.

## Coordinate systems (directive §15)

- `normalized-image`: x,y ∈ [0,1], origin top-left, pre-rotation applied. Canonical interchange format.
- `pixel`: integer frame coordinates; used only inside native preprocessing.
- `body-relative`: origin mid-hip, scaled by shoulder-hip distance; used by biomechanics features.
- `world-approx`: pose-model world output, labeled approximate; never presented as laboratory measurement.
  Conversions live in one module with tests; never implicit.

## Error taxonomy (directive §6)

Every operation returns a typed result: success | timeout | retryable | permanent | low-confidence | permission | network | unsupported-device | corrupted-media | auth failure. No silent fallbacks. `packages/shared-types/src/errors.ts`.

## Offline-first

SQLite durable store, client-generated UUIDs, outbox table with retry + idempotency keys; server upsert semantics on `shots:sync`/`sessions:batch`. Reconnect never duplicates.

## Backend

Fastify + TypeScript modular monolith; modules communicate in-process via typed service interfaces. Zod request/response validation from api-contracts. Postgres via `pg` with per-request context (request id, actor). Redis rate limiting. SQS jobs. Split a module out only with real scaling/organizational need.

## Model delivery

Signed model bundles (SHA-256 manifest), server-controlled compatibility matrix, staged rollout + rollback, per-model kill switch. Model release train independent of app binary.
