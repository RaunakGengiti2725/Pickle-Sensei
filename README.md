# Pickle Sensei

AI pickleball coaching platform. Put your phone on the fence. Hit. Your coach watches every rep.

```
PHONE ON FENCE → STROKE AUTO-DETECTED → BODY + PADDLE ANALYZED → PHASES → FEATURES
→ CHECKPOINTS SCORED → 0–10 TECHNIQUE SCORE → PRIMARY FIX → DRILL → LIVE COURT VOICE COACHING
```

Live Court Mode — automatic rep detection, on-device scoring, spoken cues, zero network dependency — is the product. Single-shot analysis is the diagnostic on-ramp.

## Documentation

| Doc                                                                                                                                         | Purpose                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [docs/SPEC_DIGEST.md](docs/SPEC_DIGEST.md)                                                                                                  | The Deep Research blueprint as an implementation checklist (source of truth) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                                                                                                | System + monorepo architecture                                               |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)                                                                                  | Stage 0–8 build order                                                        |
| [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md)                                                                              | Live build ledger (statuses are honest)                                      |
| [docs/DECISIONS.md](docs/DECISIONS.md)                                                                                                      | Recorded engineering decisions                                               |
| [docs/LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md)                                                                                      | Getting a dev environment running                                            |
| [docs/DATABASE.md](docs/DATABASE.md) · [docs/API.md](docs/API.md) · [docs/SCORING.md](docs/SCORING.md) · [docs/TESTING.md](docs/TESTING.md) | Subsystem references                                                         |

## Quick start

```bash
pnpm install
docker compose up -d postgres redis minio elasticmq
cp .env.example .env
pnpm db:migrate && pnpm db:seed
pnpm dev:api        # → http://127.0.0.1:3001/v1/health
pnpm test           # all suites
```

Mobile (iOS simulator):

```bash
cd apps/mobile && npm install && (cd ios && LANG=en_US.UTF-8 pod install)
npx react-native run-ios
```

## Monorepo

```
packages/shared-types      domain model, typed error taxonomy, UI states
packages/scoring           scoring + coaching-priority engines (spec math, tested)
packages/audio-coach-core  deterministic Live Court cue engine (no LLM in the loop)
packages/vision-contracts  pose/paddle/stroke/phase/ball provider interfaces
                           + FixtureVisionProvider (dev-only, production-guarded)
packages/analysis-pipeline stroke → phases → features → score → priority orchestration
packages/api-contracts     Zod /v1 contracts → OpenAPI 3.1
packages/database          PostgreSQL migrations (8), runner, seeds
packages/queue             SQS/in-memory job queue abstraction
packages/analytics         typed event taxonomy (spec p. 43)
services/api               Fastify modular monolith — full /v1 surface (docs/API.md)
services/media-worker      queue consumer + §58 deletion-workflow executor
apps/mobile                React Native 0.87 app (builds + runs; npm-managed, D-013)
apps/admin-web             Vite React admin console (flags, model bundles, user lookup)
native/vision-core         Swift: contracts, ApplePoseProvider, TemporalStrokeDetector
native/camera-engine       Swift: AVFoundation 60fps capture + rolling buffer
ml/                        annotation ontology + validator, dataset manifests, golden layout
infra/terraform            network / compute / data / media modules + staging env
```

## Non-negotiables

- No faked functionality: fixture providers are production-guarded and tag every artifact `source: "fixture"`.
- The app abstains below confidence 0.65 instead of inventing a score.
- Every score carries its full model/config version vector; history is never silently rescored.
- Zero-silent-failure: every operation resolves to a typed success or typed failure.
- Technique Score is not a skill rating, and serve legality stays separate from technique.
