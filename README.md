# Pickle Sensei

Pickleball technique coaching with player-initiated iOS recording, on-device pose analysis, and guided Form Review.

```
PLACE PHONE → TAP RECORD → SWING → RECORDED POSE EVIDENCE
→ TECHNIQUE SCORE OR ABSTENTION → FORM REVIEW → PRACTICE AGAIN
```

The shipping app is `apps/mobile`, an npm-managed React Native app. It calls the production Supabase Edge Function in `supabase/functions/api`; `services/api`, its database package, and the AWS infrastructure are a separate, older implementation. Start with `AGENTS.md` for the current product contracts. Historical architecture and release documents do not establish what is deployed.

On iOS, recording starts only after the player taps record. The camera follows measured body motion and retains a stroke window; imported videos use an explicit pose-extraction pass. The app composes the geometry providers and `Sm1TechniqueScorer` in `src/vision/providers.ts`. It can return a versioned technique score, or withhold it when evidence is insufficient. Form Review uses the recorded clip and hash-verified pose sidecar, with playback controls and coaching text below the video. Android camera parity is not established by iOS tests. Live Court remains dormant.

These scores use engineering target ranges that still need independent coach and repeatability validation. A wrist-speed peak is not verified ball contact; wrist geometry is not a measured paddle track. The app does not measure ball speed, forces, or injury risk. See `docs/SCORING.md` for the limits of the method.

Free access allows two lifetime scored ratings per sign-in identity, including after account deletion and recreation. Reservations protect that allowance while analysis is pending; abstentions do not spend it. The backend verifies RevenueCat entitlements and owns billing writes. The current drill UI reads the server catalog and labels stroke-family matches; the production API does not currently create training plans.

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

The root workspace uses Node 20 and pnpm 10.15.1. The mobile app requires Node 22.11 or newer and npm; do not run pnpm inside `apps/mobile`.

The following commands start the **legacy service sandbox**, not the backend used by the shipping app. Database migration commands here apply `packages/database/migrations`, not `supabase/migrations`.

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
- Missing evidence stays unknown or unscored; the score engine abstains below its 0.65 confidence threshold. That heuristic confidence is not a calibrated probability of correctness.
- Scoring configs remain validation hypotheses until the required independent evidence exists. The legacy database seeds activate no scoring models, and its release-gated sync contract is distinct from the shipping Supabase sync path. A passing software test does not validate coaching accuracy.
- ML schemas are v2 and cover 61 pickleball techniques plus explicit `unknown_technique`, `no_stroke`, `partial`, and `aborted` outcomes. Release-eligible data cannot be synthetic and must satisfy consent, rights, two-annotator, and coach-adjudication gates.
- Joint-motion glow is a visualization of measured pose displacement, not a diagnosis. Ball speed/MPH is withheld until calibrated ball tracking can support a real measurement.
- Every score carries its full model/config version vector; history is never silently rescored.
- Zero-silent-failure: every operation resolves to a typed success or typed failure.
- Technique Score is not a skill rating, and serve legality stays separate from technique.
