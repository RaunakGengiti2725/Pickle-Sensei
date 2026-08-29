# Pickle Sensei

Pickleball coaching platform with automatic, native camera capture and on-device body-pose visualization.

```
PHONE ON FENCE → LIVE BODY POSE + MEASURED JOINT MOTION → WRIST-MOTION TRIGGER
→ PRIVATE CLIP CAPTURE → AWAITING VALIDATED STROKE + SCORING MODELS
```

The shipping camera path does not ask the player to select a stroke. iOS and Android show a live skeleton and a motion-intensity glow derived from observed joint movement, then automatically retain a short clip around the motion trigger. A validated pickleball stroke classifier, phase model, paddle/ball tracking, and coach-calibrated scoring model are not available yet, so captures remain `unknown`/`awaiting_model`; the app does not fabricate a stroke name, score, drill, or speed. Live Court remains unavailable until those models pass release gates.

The account service implements a hard entitlement boundary after exactly two successful server-accepted ratings. Because unvalidated captures do not create ratings, they do not consume either free rating. The training catalog intentionally ships empty until reviewed, rights-cleared drills and human instruction media are published.

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
packages/analysis-pipeline stroke → phases → features → score → priority orchestration
packages/api-contracts     Zod /v1 contracts → OpenAPI 3.1
packages/database          PostgreSQL migrations, runner, catalog/inactive config seeds
packages/queue             SQS/in-memory job queue abstraction
packages/analytics         typed event taxonomy (spec p. 43)
services/api               Fastify modular monolith — full /v1 surface (docs/API.md)
services/media-worker      queue consumer + §58 deletion-workflow executor
apps/mobile                React Native 0.87 app (builds + runs; npm-managed, D-013)
apps/admin-web             Vite React admin console (flags, model bundles, user lookup)
native/vision-core         Swift: contracts and Apple Vision pose baseline
native/camera-engine       Swift: AVFoundation capture + rolling buffer
ml/                        v2 61-technique ontology/manifests + release validator
infra/terraform            network / compute / data / media modules + staging env
```

## Non-negotiables

- No faked functionality: production runtime contains no demo inference or seeded training content. Deterministic test doubles, where needed, live under test code only.
- The app stays `unknown`/`awaiting_model` instead of inventing a stroke or score. Once validated scoring is released, the confidence gate must continue to abstain below 0.65.
- Seeded scoring configs are validation hypotheses, never active models. A fresh database has zero active scoring models; canonical score sync accepts only an explicitly released model backed by a 100%-active SHA-256 bundle, dataset snapshot, locked evaluation-report hash, coach-validation reference, releasing admin, and the exact shot-config version.
- ML schemas are v2 and cover 61 pickleball techniques plus explicit `unknown_technique`, `no_stroke`, `partial`, and `aborted` outcomes. Release-eligible data cannot be synthetic and must satisfy consent, rights, two-annotator, and coach-adjudication gates.
- Joint-motion glow is a visualization of measured pose displacement, not a diagnosis. Ball speed/MPH is withheld until calibrated ball tracking can support a real measurement.
- Every score carries its full model/config version vector; history is never silently rescored.
- Zero-silent-failure: every operation resolves to a typed success or typed failure.
- Technique Score is not a skill rating, and serve legality stays separate from technique.
