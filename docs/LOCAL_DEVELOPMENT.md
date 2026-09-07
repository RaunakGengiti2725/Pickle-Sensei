# LOCAL DEVELOPMENT

## Prerequisites

- Node.js 20.x for the pnpm workspace (`engines` in root package.json)
- Node.js 22.x, at least 22.13.0, and npm for `apps/mobile` (separate from the root workspace; CI uses Node 22)
- pnpm 10.x (`corepack enable` or `npm i -g pnpm@10`)
- Docker Desktop (for PostgreSQL/Redis/MinIO/ElasticMQ) — optional for pure-package work

## Bootstrap

```bash
pnpm install
cp .env.example .env
```

## Local infrastructure

The Docker services and Fastify commands below support the legacy workspace
backend and its tests. The shipping iPhone app uses the Supabase Edge API in
`supabase/functions/api`, with its separate `supabase/migrations` history. Do not
apply `packages/database` migrations to the Supabase project or point the mobile
app at Fastify as an interchangeable backend.

```bash
docker compose up -d postgres redis minio elasticmq
pnpm db:migrate
pnpm db:seed
```

`pnpm db:migrate` applies `packages/database/migrations/*.sql` transactionally with checksum verification. `pnpm db:seed` loads the technique/checkpoint catalog and versioned **validating** scoring hypotheses used by engine tests; it activates none of them, so a fresh database has zero active scoring models. It also does **not** publish placeholder drills or instructional media: training content remains empty until reviewed, rights-cleared records are released. Both commands are idempotent.

### Database roles (least privilege)

Migration `0018_consent_role_separation.sql` creates four cluster-wide NOLOGIN group
roles — `pickle_migration_owner`, `pickle_application_runtime`, `pickle_worker_runtime`,
`pickle_readonly` — and grants each schema's privileges to them. The runtime roles get
full DML on ordinary tables but only the intended paths on the consent system
(append/read on `consent_record`; no delete on `consent_subject`; read-only on
`consent_subject_erasure`), and they own nothing, so they cannot alter the consent
schema or disable its append-only triggers.

On a fresh docker volume, `infra/postgres/init-roles.sql` also creates local login
users (`pickle_app`, `pickle_worker`, `pickle_ro`, `pickle_migrator`) that hold
membership in those group roles. Services pick them up through
`DATABASE_URL_APP` (services/api) and `DATABASE_URL_WORKER` (services/media-worker),
both optional — everything still falls back to `DATABASE_URL`, so existing local
setups keep working. Migrations/seed always run with owner credentials
(`DATABASE_URL`). Existing dev volumes predating the init script keep working via the
fallback; to adopt the login roles, recreate the volume or apply the init file
manually with `psql`.

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

Switch to Node 22.x (at least 22.13.0) before working in `apps/mobile`; the locked
React Native/Metro packages require it. This app is **npm-managed** with its own
`package-lock.json`: do not run pnpm here. Node 22.22.0 with npm 10.8.2 is a verified
install pairing. The app's engine range matches the locked React Native/Metro
requirements: `^22.13.0 || ^24.3.0 || >= 26.0.0`. This excludes Node 23, Node 25,
and Node 24.0–24.2; it is a compatibility range, not a claim that each admitted
version has passed this app's verification.

Use Ruby 3.4.5 and Bundler 2.6.9, matching `apps/mobile/Gemfile.lock`, plus Xcode and
its selected command-line tools. The lockfile selects CocoaPods **1.15.2** and its
Ruby dependencies; the broader Gemfile constraints alone do not pin them. Install
the locked bundle in frozen mode and confirm the bundled CocoaPods version:

```bash
cd apps/mobile
node --version
npm --version
ruby --version
bundle --version
npm ci
BUNDLE_FROZEN=true bundle install
bundle exec pod --version
(cd ios && LANG=en_US.UTF-8 bundle exec pod install)   # UTF-8 locale required (ruby 3.4)
npx react-native start                     # Metro, terminal 1
npx react-native run-ios                   # build + launch simulator, terminal 2
```

### Lockfile reproducibility

Use `npm ci` for an unchanged checkout. npm mirrors the app's Node engine into
`package-lock.json` at `packages[""].engines.node`; it does not replace that value
with the running Node version. An intentional engine edit must keep both files in
sync without changing dependency versions or integrity hashes.

Always use **`bundle exec pod install`**, not a globally installed `pod`. Repeat
installs need the same lockfiles, Node/npm and Ruby/Bundler toolchains, Xcode/SDK,
UTF-8 locale, and native install options. The default Podfile uses static libraries
(`USE_FRAMEWORKS` unset), forces the New Architecture, and leaves RN's prebuilt
core/dependencies and Hermes defaults enabled. Local tarball overrides,
`RCT_USE_PREBUILT_RNCORE`, `RCT_USE_RN_DEP`, or Sentry framework overrides can change
podspec contents; unavailable prebuilt artifacts can also change RN's install path.
Fresh installs need access to the npm/Ruby/CocoaPods registries and Maven/GitHub
artifacts, not another developer's local credentials or generated caches.

CocoaPods checksums cover podspec **bytes**, not just pod versions. Before accepting
checksum churn, compare the before/after JSON in `ios/Pods/Local Podspecs`, including
the generated `ReactCodegen`/`ReactAppDependencyProvider` specs and the
`React-Core-prebuilt`, `hermes-engine`, and `RNSentry` environment-sensitive specs.
Even array formatting changes hashes: let CocoaPods own those generated files;
do not reformat them. A warm sandbox can retain cached external podspec bytes even
under the pinned bundle. If `React-Core-prebuilt`'s
`pod_target_xcconfig.HEADER_SEARCH_PATHS` or `hermes-engine`'s
`subspecs[0].preserve_paths` differs **only in array whitespace**, first verify the
parsed specifications, npm source files and pod versions match. This targeted
command regenerates those external specifications from the installed, locked npm
sources without refreshing the pod repositories:

```bash
(cd apps/mobile/ios && bundle exec pod update React-Core-prebuilt hermes-engine --no-repo-update)
```

Use both explicit names; an unqualified `pod update` can upgrade other dependencies.
Keep `Podfile.lock` in place and verify that only the expected specification
checksums changed, with pod versions/dependency lists unchanged. Do not copy stale
generated caches into a fresh checkout, delete lockfiles, or update gems to hide a
difference. Run `bundle exec pod install` again and verify no further lockfile diff:

```bash
git diff --exit-code -- apps/mobile/package.json apps/mobile/package-lock.json apps/mobile/Gemfile.lock apps/mobile/ios/Podfile.lock
```

Run that check from the repository root against a clean baseline. Reviewing an
intentional uncommitted change does not make `git diff --exit-code` pass. For a
dirty checkout, compare file hashes before and after installation, or verify an
isolated snapshot containing the intended changes. A clean checkout/cache on one
Mac checks those inputs; it is not proof of identical results on a different
physical Mac or Xcode toolchain.

### Open in Xcode

Always the **workspace**, never the project:

```bash
xed apps/mobile/ios/PickleSensei.xcworkspace
```

- Scheme `PickleSensei` is shared. Its Run configuration defaults to **Release**,
  which bundles JavaScript and does not require a Metro server.
- For Metro and Fast Refresh, choose **Edit Scheme → Run → Debug**, start Metro
  in a separate terminal, then build and run the Debug app.
- `ios/.xcode.env.local` (machine-local, gitignored) pins `NODE_BINARY` to the
  nvm node path so Xcode's bundle phase finds node. If node moves (nvm
  upgrade), update that file using the supported mobile Node version.
- Run Debug and Release builds serially when they share `ios/Pods`; RN's build
  scripts replace shared prebuilt frameworks even with separate DerivedData.
- Sign in with Apple: the entitlement is wired
  (`PickleSensei/PickleSensei.entitlements`). To exercise it, pick your team
  under Signing & Capabilities and sign the simulator into an Apple ID
  (Settings → Sign in). Without that, the button shows a truthful
  "not configured/available" state.
- Google Sign-In: public iOS and web OAuth client IDs are already configured in
  `src/config/runtimeConfig.ts`; `src/config/authConfig.ts` re-exports them.
  `Info.plist` contains the matching reversed iOS client ID. If intentionally
  changing OAuth projects, update those public values and the reversed scheme
  together, then verify the backend provider's accepted audience. Never put a
  provider secret in the app.

The native camera is wired into the app. On supported iOS devices it uses Apple Vision body pose to draw the live body heat map (measured joint-motion intensity) and motion trails, automatically retains a clip around player motion, and returns `unknown`/`awaiting_model`. A simulator can verify navigation and lifecycle, but cannot establish camera/model accuracy; use a physical device for capture QA.

## Mobile (Android)

Build the Android app with JDK 17 and an installed Android SDK. The native path uses CameraX and the bundled MediaPipe pose model for the same live body heat map, motion visualization, and automatic short-clip capture. Physical-device validation remains required.

Neither platform has a runtime switch that generates a sample score. Test-only doubles are confined to test suites. The current iPhone path can score supported declared techniques from recorded poses using the legacy 2D pipeline; absent or invalid evidence produces an unavailable or abstained result. This behavior and passing tests do not establish scientific release approval for the scoring model or the proposed technique benchmark. Calibrated ball tracking is not implemented, so the app must not invent speed/MPH.

## Environment conventions

- `PICKLE_ENV`: development | test | staging | production. Production runtime has no deterministic vision provider or demo inference mode.
- Secrets: never committed; `.env.example` holds placeholders and non-secret local defaults only. The shipping mobile backend uses Supabase Edge Function secrets. AWS secret-manager examples belong to the separate legacy infrastructure; they are not instructions to change the production mobile backend.

## Repo layout

See `docs/ARCHITECTURE.md`. Packages export TypeScript source directly (internal-only); nothing here is published to npm.
