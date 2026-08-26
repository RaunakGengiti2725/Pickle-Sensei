# IMPLEMENTATION STATUS

Statuses: NOT_STARTED | IN_PROGRESS | BLOCKED | IMPLEMENTED | TESTED
Rule: IMPLEMENTED only if it exists; TESTED only if tests actually pass.

Last updated: 2026-08-26 (session 2 — full-system build)

## Foundation & platform

| Item                                                                                                                                                            | Status                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Monorepo, strict TS, lint/format, Vitest, CI                                                                                                                    | TESTED                                                                   |
| docs set (SPEC_DIGEST, ARCHITECTURE, PLAN, DECISIONS, DATABASE, SCORING, TESTING, API, LOCAL_DEVELOPMENT, DEPLOYMENT, ML_SYSTEM, LIVE_COURT, PRIVACY, SECURITY) | IMPLEMENTED (matches reality as of this date)                            |
| packages/shared-types · scoring · audio-coach-core · vision-contracts · analysis-pipeline · api-contracts · queue · analytics                                   | TESTED (19+9+5+3+6+3+3 = 48 package tests)                               |
| packages/database — 8 migrations, 40+ tables, runner, seeds (catalog, sm-v1, offerings, flags, achievements, labeled dev drills)                                | TESTED (unit + integration vs real Postgres 16)                          |
| packages/feature-flags                                                                                                                                          | folded into API flags module (evaluation + stable rollout hash) — TESTED |
| packages/logging                                                                                                                                                | NOT_STARTED (API uses Fastify/pino; OTel exporter pending)               |

## Backend

| Item                                                                                                                                                                                                                                                                                                                                                                           | Status                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| services/api — auth (OIDC + guarded dev issuer), identity/onboarding, goals, catalog+drills+model-bundle+references, shots:sync, sessions+finalize, library, progress+weekly reports, media (presigned, consent-gated), analyses (quota-gated), billing offerings+entitlements, social, privacy (consent/export/delete §58), flags, achievements, share-cards, admin (audited) | TESTED — 27 API tests incl. 21 integration vs real PostgreSQL |
| services/media-worker — job consumer (media.process/purge, honest declines for share.render & analysis.deep) + deletion workflow executor                                                                                                                                                                                                                                      | TESTED — 4 integration tests vs real PostgreSQL               |
| services/ml-worker (cloud deep analysis)                                                                                                                                                                                                                                                                                                                                       | NOT_STARTED (jobs queue visibly; worker declines)             |
| Store receipt validation (Apple/Google)                                                                                                                                                                                                                                                                                                                                        | BLOCKED on credentials — typed 501, never faked (D-016)       |
| Rate limiting middleware                                                                                                                                                                                                                                                                                                                                                       | NOT_STARTED (Redis provisioned)                               |
| OpenTelemetry export                                                                                                                                                                                                                                                                                                                                                           | NOT_STARTED (request-ids + audit log in place)                |
| Push notifications delivery                                                                                                                                                                                                                                                                                                                                                    | NOT_STARTED (tokens + notification table exist)               |

## Mobile (apps/mobile — RN 0.87 New Architecture, iOS)

| Item                                                                                                           | Status                                                                          |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| App builds (xcodebuild, all pods incl. native TTS module)                                                      | TESTED — BUILD SUCCEEDED                                                        |
| Runs on simulator                                                                                              | VERIFIED — launched on iPhone 16 sim, onboarding renders (screenshot)           |
| Design system (tokens + Button/Card/ScoreRing/CheckpointRow/TrendChart/Empty/Error/Loading/FixtureBanner/Pill) | IMPLEMENTED                                                                     |
| Onboarding → personalized focus                                                                                | IMPLEMENTED (renders on device)                                                 |
| Home (score, trend, actions, focus, recent)                                                                    | IMPLEMENTED                                                                     |
| Analyze flow (shot select → preflight copy → REAL pipeline over labeled fixture → result)                      | IMPLEMENTED; engine logic TESTED via jest                                       |
| Result screen (asymmetric hierarchy, abstention state, traceability footer)                                    | IMPLEMENTED                                                                     |
| Live Court (setup → running loop → cues + native TTS → pause/end → summary)                                    | Engine TESTED (jest, 3 tests); screens IMPLEMENTED                              |
| Library, Progress, Settings/Privacy                                                                            | IMPLEMENTED                                                                     |
| SQLite persistence + outbox sync engine                                                                        | Sync engine TESTED (jest, 4 tests); repository IMPLEMENTED                      |
| Native PickleAudioCoach TTS pod                                                                                | IMPLEMENTED (compiles into app)                                                 |
| Vertical slice 1 (launch→onboarding→home→analyze→result→library)                                               | IMPLEMENTED end-to-end in app; interactive drive pending simulator panel access |
| Real camera capture UI / preflight CV                                                                          | NOT_STARTED (native wiring next)                                                |
| Android                                                                                                        | NOT_STARTED (RN codebase portable by design)                                    |

## Native (parse-verified Swift, not yet wired into the app)

| Item                                                                                           | Status                                       |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------- |
| vision-core: contracts + ApplePoseProvider (real Vision body-pose) + TemporalStrokeDetector v0 | IMPLEMENTED (swiftc -parse vs iOS SDK clean) |
| camera-engine: AVFoundation session + 60fps config + rolling ring buffer                       | IMPLEMENTED (parse-verified)                 |
| RN bridge for VisionCore/CameraEngine                                                          | NOT_STARTED                                  |
| media-encoder                                                                                  | NOT_STARTED                                  |

## ML

| Item                                                               | Status                                                         |
| ------------------------------------------------------------------ | -------------------------------------------------------------- |
| Annotation ontology v1 (JSON Schema) + validator                   | TESTED (7 python tests)                                        |
| Dataset manifest schema (provenance + consent)                     | IMPLEMENTED                                                    |
| Golden-set layout + evaluation rubric + data plan                  | IMPLEMENTED (docs; sets fill with real footage)                |
| Learned models (paddle, phases, stroke classifier, pose fine-tune) | NOT_STARTED — data collection prerequisite; nothing fabricated |

## Web & infra

| Item                                                                                                                                        | Status                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| apps/admin-web (flags, model-bundle release, audited user lookup)                                                                           | IMPLEMENTED (typechecks, builds; drives tested API routes)                                   |
| apps/marketing-web                                                                                                                          | NOT_STARTED                                                                                  |
| infra/terraform (network, compute ALB/ECS/ECR/autoscaling, data RDS/Redis/KMS/Secrets, media S3/SQS/DLQ + retention lifecycle, staging env) | IMPLEMENTED (no terraform binary here — CI plan is the gate; honestly noted in infra README) |
| CloudFront, WAF, Cognito, CloudWatch alarms, GPU capacity, org baseline                                                                     | NOT_STARTED                                                                                  |
| Dockerfiles (api, media-worker) + CI container job                                                                                          | IMPLEMENTED                                                                                  |

## Known issues / blockers

- Simulator live panel requires `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` (user's password) — headless simctl verification used instead.
- CocoaPods needs a UTF-8 locale (`LANG=en_US.UTF-8 pod install`) — documented in LOCAL_DEVELOPMENT.
- Scoring metric targets remain coach-panel calibration hypotheses (labeled everywhere).
- `progress_daily` upsert requires PG15+ (`UNIQUE NULLS NOT DISTINCT`, migration 0008).

## Tests run this session (2026-08-26, session 2)

- Root: format ✓ · lint ✓ · typecheck (10 workspace projects) ✓ · `pnpm test` sequential — all suites green
- API integration vs real Postgres 16: 27/27 (bootstrap→onboarding→sync→sessions→library→progress→flags→billing→quota/entitlement→media consent→social→privacy export/delete)
- media-worker vs real Postgres: 4/4 (purge, visible backlog, full deletion workflow incl. hard delete ordering, honest no-transcoder path)
- Mobile: `tsc --noEmit` ✓ · jest 7/7 (LiveCourtEngine over real pipeline; outbox sync)
- ML validator: 7/7 python unit tests
- iOS: baseline and full app `xcodebuild` BUILD SUCCEEDED; app launched on iPhone 16 simulator, onboarding screenshot captured
- Swift native sources: `swiftc -parse` clean vs iphonesimulator SDK
- admin-web: typecheck ✓, vite build ✓

## Next highest-priority tasks

1. Wire CameraEngine + ApplePoseProvider + TemporalStrokeDetector into the app via a VisionCore RN module (replaces fixture provider path in dev; enables MODEL_UNAVAILABLE-free release path).
2. Camera preflight UI with real framing validation states.
3. Feature extraction (Swift) producing the sm-v1 metric vocabulary from live pose/paddle frames; golden vectors shared with @pickle/scoring.
4. Rate limiting + OTel export + CI dependency/secret scanning.
5. Store billing credentials → activate receipt validation + webhooks.
6. Coach advisory panel: calibrate sm-v1 targets → sm-v2.
