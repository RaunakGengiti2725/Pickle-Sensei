# LOCAL DEVELOPMENT

## Prerequisites

- Node.js 20.x (`.nvmrc`-equivalent: `engines` in root package.json)
- pnpm 10.x (`corepack enable` or `npm i -g pnpm@10`)
- Docker Desktop (for PostgreSQL/Redis/MinIO/ElasticMQ) — optional for pure-package work

## Bootstrap

```bash
pnpm install
cp .env.example .env
```

## Local infrastructure

```bash
docker compose up -d postgres redis minio elasticmq
pnpm db:migrate
pnpm db:seed
```

`pnpm db:migrate` applies `packages/database/migrations/*.sql` through migration `0014` transactionally with checksum verification. `pnpm db:seed` loads the technique/checkpoint catalog and versioned **validating** scoring hypotheses used by engine tests; it activates none of them, so a fresh database has zero active scoring models. It also does **not** publish placeholder drills or instructional media: training content remains empty until reviewed, rights-cleared records are released. Both commands are idempotent.

## Everyday commands

```bash
pnpm lint          # eslint across the monorepo
pnpm format        # prettier write
pnpm typecheck     # strict tsc in every package
pnpm test          # vitest in every package
pnpm build         # currently typecheck (packages are consumed from source; see DECISIONS)
pnpm dev:api       # Fastify API on :3001 (tsx watch)
```

Smoke check the API:

```bash
curl -s localhost:3001/v1/health
```

## Database-backed tests

Integration tests are **skipped, visibly, never green-washed** unless a test database is provided:

```bash
docker compose up -d postgres_test
DATABASE_URL_TEST=postgres://pickle:pickle_test_password@localhost:5433/pickle_test pnpm --filter @pickle/database test
```

CI always runs them against a service container (`.github/workflows/ci.yml`).

## Mobile (iOS)

```bash
cd apps/mobile
npm install
(cd ios && LANG=en_US.UTF-8 pod install)   # UTF-8 locale required (ruby 3.4)
npx react-native start                     # Metro, terminal 1
npx react-native run-ios                   # build + launch simulator, terminal 2
```

### Open in Xcode

Always the **workspace**, never the project:

```bash
xed apps/mobile/ios/PickleSensei.xcworkspace
```

- Scheme `PickleSensei` is shared/committed; press Run.
- `ios/.xcode.env.local` (machine-local, gitignored) pins `NODE_BINARY` to the
  nvm node path so Xcode's bundle phase finds node. If node moves (nvm
  upgrade), update that file.
- Keep Metro running in a terminal; Xcode builds the native side only.
- Sign in with Apple: the entitlement is wired
  (`PickleSensei/PickleSensei.entitlements`). To exercise it, pick your team
  under Signing & Capabilities and sign the simulator into an Apple ID
  (Settings → Sign in). Without that, the button shows a truthful
  "not configured/available" state.
- Google Sign-In: paste an iOS OAuth client id into
  `src/config/authConfig.ts` and add its reversed client id as a URL scheme in
  Info.plist. Until then the button reports "not configured" — by design.

The native camera is wired into the app. On supported iOS devices it uses Apple Vision body pose to draw the live skeleton and measured joint-motion glow, automatically retains a clip around player motion, and returns `unknown`/`awaiting_model`. A simulator can verify navigation and lifecycle, but cannot establish camera/model accuracy; use a physical device for capture QA.

## Mobile (Android)

Build the Android app with JDK 17 and an installed Android SDK. The native path uses CameraX and the bundled MediaPipe pose model for the same live skeleton, motion visualization, and automatic short-clip capture. Physical-device validation remains required.

Neither platform has a runtime switch that generates a sample score. Test-only doubles are confined to test suites. With no validated classifier/scoring model, captured clips intentionally remain unscored. No speed/MPH appears because calibrated ball tracking is not implemented.

## Environment conventions

- `PICKLE_ENV`: development | test | staging | production. Production runtime has no deterministic vision provider or demo inference mode.
- Secrets: never committed; `.env.example` holds placeholders and non-secret local defaults only. Production secrets live in AWS Secrets Manager (infra stage).

## Repo layout

See `docs/ARCHITECTURE.md`. Packages export TypeScript source directly (internal-only); nothing here is published to npm.
