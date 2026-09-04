# Test matrix — every test surface, what it needs, and what "green" means

Audit stream: `tests/QA + end-to-end readiness` (bootstrap). Measured on Ubuntu 22.04, Node 22.23.2,
pnpm 10.15.1, Python 3.12.14, Docker 27.4.1, ffmpeg 4.4.2, Deno 2.9.6, with
`docker compose up -d postgres postgres_test redis elasticmq` running. Wall-clock numbers are from
this one machine on 2026-09-04 and are indicative, not SLOs.

Provenance labels used throughout: **VERIFIED** = executed here, exit code recorded;
**INFERRED** = read from code/config, not executed; **UNKNOWN** = no ground truth available.

## 1. The matrix

Gate tiers: **PR** = runs on every PR in `.github/workflows/ci.yml`; **PR (conditional)** = part of a
PR-gate command but its body is skipped unless the env is present; **nightly/manual** = not wired
into CI, run on demand; **Mac** = only on the self-hosted `[self-hosted, macOS, ARM64]` runner.

| Surface                                                                  | Exact command                                                                                                                                           | Wall-clock (VERIFIED)                                                             | Deterministic?                                                                               | Requires                                                                      | Gate tier                       | Known skips / result                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root workspace (`pnpm -r --workspace-concurrency=1 test`, 29 workspaces) | `DATABASE_URL_TEST=postgres://pickle:pickle_test_password@localhost:5433/pickle_test pnpm test`                                                         | ~165 s run 1 (02:05:58→02:08:43), ~170 s run 2; exit 0 both                       | Yes for all but the ffmpeg-encoding suites (see §3)                                          | Postgres 5433, ffmpeg (capture-envelope/swing-lab)                            | PR                              | 7 tests skipped total: `@pickle/queue` 3 (no `SQS_ENDPOINT_TEST`), `@pickle/swing-lab` 4 (missing `report.json` replay fixtures). Counts identical across both runs.                                                                                                                                                                               |
| ├ `@pickle/admin-web` (vitest)                                           | `pnpm --filter @pickle/admin-web test`                                                                                                                  | 0.5 s                                                                             | Yes                                                                                          | —                                                                             | PR                              | 9 files / 97 tests pass. `--passWithNoTests` is present but moot: tests exist (coach-review agreement + schema validators).                                                                                                                                                                                                                        |
| ├ `@pickle/shared-types`                                                 | `pnpm --filter @pickle/shared-types test`                                                                                                               | 0.5 s                                                                             | Yes                                                                                          | —                                                                             | PR                              | 12 files / 93 pass. `--passWithNoTests` present, moot.                                                                                                                                                                                                                                                                                             |
| ├ `@pickle/api` (Fastify, legacy/local)                                  | `DATABASE_URL_TEST=… pnpm --filter @pickle/api test`                                                                                                    | 35.7 s                                                                            | Yes with DB (all 28 files are `describe.skipIf(!testUrl)` for the DB parts)                  | Postgres 5433                                                                 | PR (conditional)                | 28 files / 232 pass with DB. Without `DATABASE_URL_TEST` every DB describe is SKIPPED (visible in vitest output).                                                                                                                                                                                                                                  |
| ├ `@pickle/database`                                                     | `DATABASE_URL_TEST=… pnpm --filter @pickle/database test`                                                                                               | 12.4 s                                                                            | Yes with DB                                                                                  | Postgres 5433 (CI user is superuser; `roles.destructive` creates login roles) | PR (conditional)                | 6 files / 41 pass. All 7 describes are `skipIf(!testUrl)`.                                                                                                                                                                                                                                                                                         |
| ├ `@pickle/media-worker`                                                 | `DATABASE_URL_TEST=… pnpm --filter @pickle/media-worker test`                                                                                           | 10.8 s                                                                            | Yes with DB                                                                                  | Postgres 5433                                                                 | PR (conditional)                | 11 files / 53 pass. 8 describes are `skipIf(!testUrl)`.                                                                                                                                                                                                                                                                                            |
| ├ `@pickle/queue`                                                        | `SQS_ENDPOINT_TEST=http://localhost:9324 pnpm --filter @pickle/queue test`                                                                              | 0.2 s (in-memory) / ElasticMQ run: 2 files, 8 tests pass                          | Yes                                                                                          | ElasticMQ (`docker compose up -d elasticmq`) for the 3 SQS tests              | PR (conditional)                | CI does not start ElasticMQ → `sqs.integration.test.ts` (3 tests) is ALWAYS skipped in CI. VERIFIED passing locally with the endpoint set.                                                                                                                                                                                                         |
| ├ `@pickle/capture-envelope`                                             | `pnpm --filter @pickle/capture-envelope test`                                                                                                           | 17.1 s                                                                            | ffmpeg-encoded synthetic fixtures; three describes `skipIf(!hasFfmpeg)`                      | ffmpeg + ffprobe on PATH                                                      | PR (conditional)                | 8 files / 72 pass here. Without ffmpeg the red-team describes are skipped silently-but-visibly (vitest prints ↓).                                                                                                                                                                                                                                  |
| ├ `@pickle/swing-lab`                                                    | `pnpm --filter @pickle/swing-lab test`                                                                                                                  | 69.8 s (largest single suite)                                                     | Mostly; `oodGateRedTeam` needs ffmpeg `drawtext`; `sessionEngine` replays need run artifacts | ffmpeg (drawtext/libfreetype for 1 test)                                      | PR (conditional)                | 77 files / 894 pass / 4 skipped: `sessionEngine.test.ts` replay describes for runs whose `report.json` is not in the repo.                                                                                                                                                                                                                         |
| ├ 22 other pure packages/tools                                           | part of `pnpm test`                                                                                                                                     | each 0.2–1.6 s                                                                    | Yes                                                                                          | —                                                                             | PR                              | hard-case-queue 17, incident-response 17, rollout 22, slo 15, iphone-trials 107, latency-slo 36, analytics 43, api-contracts 13, audio-coach-core 29, swing-domain 19, evaluation 15, first-party-intake 26, model-registry 34, vision-contracts 5, scoring 49, analysis-pipeline 71, vision-geometry 98, release-ops 18, mac-bench 38 — all pass. |
| Database migrate + seed (fresh DB)                                       | `DATABASE_URL=postgres://pickle:pickle_dev_password@localhost:5432/pickle_dev pnpm --filter @pickle/database migrate && … seed`                         | a few seconds                                                                     | Yes                                                                                          | Postgres 5432                                                                 | PR                              | `migrations: 29 applied, 0 already applied`; `seed complete`. Exit 0.                                                                                                                                                                                                                                                                              |
| Mobile TypeScript                                                        | `cd apps/mobile && npm ci && npx tsc --noEmit`                                                                                                          | tsc: no output, exit 0                                                            | Yes                                                                                          | npm (NOT pnpm)                                                                | PR (`mobile` job)               | —                                                                                                                                                                                                                                                                                                                                                  |
| Mobile Jest (logic suites)                                               | `cd apps/mobile && npx jest --silent`                                                                                                                   | 18.7 s run 1 (cold cache), 10.7 s run 2; exit 0 both                              | Yes                                                                                          | npm                                                                           | PR (`mobile` job)               | `Test Suites: 1 skipped, 247 passed, 247 of 248`; `Tests: 1 skipped, 2900 passed, 2901`. The skip is `importedRealFootageAnalysis.test.ts` (`describe.skip` when Mac-generated pose/meta artifacts are absent — they are not in git). Identical counts both runs.                                                                                  |
| Mobile iOS distribution preconditions                                    | `cd apps/mobile && npm run check:distribution`                                                                                                          | < 2 s                                                                             | Yes (static)                                                                                 | —                                                                             | manual                          | Exit 0: "All Linux-validatable distribution preconditions passed." Explicitly does NOT cover pod install/archive/sign/upload.                                                                                                                                                                                                                      |
| Mobile UI / device / Xcode                                               | `.github/workflows/mac-smoke-test.yml`, `cd apps/mobile/ios && bundle exec pod install`, Xcode build                                                    | UNKNOWN (no Mac here)                                                             | UNKNOWN                                                                                      | Mac, Xcode, self-hosted M4 runner                                             | Mac                             | NOT attempted. No detox/maestro/e2e script exists in `apps/mobile/package.json` (VERIFIED: scripts are android/ios/check:distribution/lint/start/test).                                                                                                                                                                                            |
| ML annotation validators                                                 | `python3 -m unittest discover -s ml/scripts -p 'test_*.py'`                                                                                             | 0.002 s reported, ~1 s wall                                                       | Yes                                                                                          | Python 3.12                                                                   | PR                              | `Ran 17 tests … OK`.                                                                                                                                                                                                                                                                                                                               |
| Edge function unit/behaviour tests (Deno)                                | `(cd supabase/functions/api/__wf__ && deno task test)`                                                                                                  | 17 s                                                                              | Yes                                                                                          | Deno 2.x                                                                      | manual (NOT in ci.yml)          | `122 passed (7 steps) / 0 failed / 6 ignored`. The 6 ignored are all of `be-edge-routes-shots-rank.test.ts` (`ignore: PG_URL === ""`). `db_migrations_rls_indexes.audit.test.ts` also self-ignores when `docker info` fails.                                                                                                                       |
| Edge fn DB-backed audit (the 6 ignored)                                  | see §2.2 — throwaway postgres:16 + `PICKLE_AUDIT_PG_URL=… deno test -A --config supabase/functions/api/__wf__/deno.json supabase/functions/api/__wf__/` | 3 s for the 6 tests (+ container start + 29 migrations)                           | Yes                                                                                          | Docker, Deno                                                                  | manual                          | VERIFIED: `6 passed / 0 failed` when the env var points at a migrated throwaway DB.                                                                                                                                                                                                                                                                |
| Edge fn billing/entitlement DB race check                                | `./supabase/functions/api/__wf__/wf-billing-entitlement-sync-db.sh`                                                                                     | tens of seconds (container + migrations)                                          | Yes (24 concurrent reserves, asserts exactly 2 permits)                                      | Docker                                                                        | manual                          | VERIFIED: `SEQUENTIAL … ALL PASSED`, `accepted=2 denied=22 reserved_rows=2`, `BILLING-ENTITLEMENT-SYNC DB CHECKS: ALL PASSED`.                                                                                                                                                                                                                     |
| Edge fn standalone type check                                            | `(cd supabase/functions/api && deno check cache.ts rateLimit.ts http.ts legal.ts)`                                                                      | < 5 s                                                                             | Yes                                                                                          | Deno                                                                          | manual                          | Exit 0. `index.ts` is deliberately excluded (pre-existing untyped-supabase-client errors, per AGENTS.md).                                                                                                                                                                                                                                          |
| Supabase RLS + security regression matrix                                | `./supabase/tests/run_rls_tests.sh`                                                                                                                     | ~1 min (container + shim + 29 migrations + matrix; exact wall not captured)       | Yes                                                                                          | Docker (falls back to local `initdb` if absent)                               | PR (`supabase-security` job)    | `SECURITY REGRESSION MATRIX: ALL CASES PASSED`.                                                                                                                                                                                                                                                                                                    |
| Admin-web browser smoke (NEW, this stream)                               | `pnpm --filter @pickle/admin-web e2e` (first time: `pnpm --filter @pickle/admin-web exec playwright install chromium`)                                  | 5 s cold (Playwright boots API + vite itself); 6 s with `PICKLE_E2E_DATABASE_URL` | Yes                                                                                          | Chromium (~115 MB download); optional Postgres 5432 for test 3                | manual (not wired into CI)      | Without `PICKLE_E2E_DATABASE_URL`: 2 passed, 1 skipped (reason in HTML report). With it: 3 passed. Screenshots: `apps/admin-web/e2e/dist/artifacts/{admin-console-anonymous,coach-review-lab,admin-console-authenticated}.png`.                                                                                                                    |
| Release manifest consistency                                             | `pnpm release:check`                                                                                                                                    | < 2 s                                                                             | Yes (static)                                                                                 | —                                                                             | manual                          | "All release-manifest checks passed." Explicitly excludes signing/archive/TestFlight/store/live monitoring.                                                                                                                                                                                                                                        |
| Load tests (k6)                                                          | `k6 run -e BASE_URL=$BASE tools/loadtest/{smoke,auth-abuse,user-flow,wf-*}.js`                                                                          | NOT RUN                                                                           | No — network, live rate limits, real tokens                                                  | k6, a deployed API, real ID token for `user-flow`                             | manual / external               | Would hit a live backend; intentionally not executed in this audit.                                                                                                                                                                                                                                                                                |
| Latency SLO reports                                                      | `pnpm --filter @pickle/latency-slo slo report …` / `slo compare …`                                                                                      | NOT RUN (its 36 vitest tests ARE in `pnpm test`)                                  | Report is a pure transform; inputs are device/Linux measurements with provenance labels      | Measurement JSON inputs                                                       | manual                          | Linux numbers are labelled as such by the tool; never present them as device evidence.                                                                                                                                                                                                                                                             |
| Container image build                                                    | `docker build -f services/api/Dockerfile …`, `-f services/media-worker/Dockerfile …`                                                                    | NOT RUN                                                                           | Yes                                                                                          | Docker                                                                        | main-only CI job (`containers`) | INFERRED from ci.yml (`if: github.ref == 'refs/heads/main'`).                                                                                                                                                                                                                                                                                      |

Root `pnpm format:check`, `pnpm lint`, `pnpm typecheck` are PR-gate too (all VERIFIED exit 0 on
this branch; see the PR).

## 2. How to test a real user flow, per surface

### 2.1 Backend API (`services/api`, Fastify — legacy/local only, the app does not call it)

```bash
docker compose up -d postgres postgres_test redis
DATABASE_URL=postgres://pickle:pickle_dev_password@localhost:5432/pickle_dev pnpm --filter @pickle/database migrate
DATABASE_URL=postgres://pickle:pickle_dev_password@localhost:5432/pickle_dev pnpm --filter @pickle/database seed
DATABASE_URL=postgres://pickle:pickle_dev_password@localhost:5432/pickle_dev \
  DEV_AUTH_SECRET=pickle-e2e-dev-secret-0123456789 pnpm dev:api        # → http://127.0.0.1:3001
curl -s http://127.0.0.1:3001/v1/health                                # {"status":"ok","version":"0.1.0"}
```

Authenticated flow: `PICKLE_ENV=development` enables `DevTokenVerifier`
(`services/api/src/auth/tokens.ts`): HS256, issuer `pickle-dev`, claim `pickle_role: user|admin`,
secret ≥ 16 chars from `DEV_AUTH_SECRET`. `apps/admin-web/e2e/devToken.ts` mints one with
`node:crypto`. Then `POST /v1/account/bootstrap` (body: `locale`, `timezone`,
`device{platform,osVersion,appVersion,model}`) creates the `app_user`, and `GET /v1/flags`,
`GET /v1/admin/quality-dashboard` etc. work with `Authorization: Bearer <token>`. Without a
`DATABASE_URL` the server starts but every DB route returns 503 `api.datastore_unavailable`.

The 28 vitest files in `services/api/test/**` are the automated version of this: real Fastify +
real Postgres (`DATABASE_URL_TEST`), several using isolated schemas per file.

### 2.2 Edge function (`supabase/functions/api`, Deno — the production backend)

```bash
(cd supabase/functions/api/__wf__ && deno task test)                     # 122 pass, 6 ignored
# Run the 6 DB-backed ones (docstring in be-edge-routes-shots-rank.test.ts):
docker run -d --name pickle-audit -p 55432:5432 -e POSTGRES_PASSWORD=pg postgres:16
docker cp supabase/tests pickle-audit:/tests && docker cp supabase/migrations pickle-audit:/migrations
docker exec pickle-audit bash -c 'psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql \
  && for f in /migrations/*.sql; do psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"; done'
PICKLE_AUDIT_PG_URL=postgres://postgres:pg@127.0.0.1:55432/postgres \
  deno test -A --no-check --config supabase/functions/api/__wf__/deno.json supabase/functions/api/__wf__/
docker rm -f pickle-audit
./supabase/functions/api/__wf__/wf-billing-entitlement-sync-db.sh          # permit race check
./supabase/tests/run_rls_tests.sh                                          # RLS / grants matrix
```

The `__wf__` tests exercise route handlers and the DB RPCs (`apply_synced_shot`,
`reserve_analysis_permit`, rank parity) directly. There is no local `supabase start` flow
documented in this repo (UNKNOWN whether the CLI stack runs here); a true HTTP round-trip against
the edge function means a deployed project, which is out of scope for a Linux Devin session and
must never target production `ucqnaiwqwjtgvlduiuib`.

### 2.3 Admin web in a real browser (Playwright, `apps/admin-web/e2e/**`)

```bash
pnpm --filter @pickle/admin-web exec playwright install chromium      # once per machine
pnpm --filter @pickle/admin-web e2e                                    # 2 pass, 1 skipped (test 3)
PICKLE_E2E_DATABASE_URL=postgres://pickle:pickle_dev_password@localhost:5432/pickle_dev \
  pnpm --filter @pickle/admin-web e2e                                  # 3 pass (needs migrate+seed above)
```

`e2e/playwright.config.ts` starts both servers itself (`@pickle/api start` on :3001 with
`PICKLE_ENV=development` + `DEV_AUTH_SECRET`; vite on 127.0.0.1:5173 whose config proxies
`/v1` → :3001) and reuses a server already answering on those exact addresses. `pnpm dev:api`
(started with `DATABASE_URL=…` from §2.1 and the same `DEV_AUTH_SECRET`) is therefore reused.
Plain `pnpm --filter @pickle/admin-web dev` is NOT: it binds `[::1]:5173` only, so
`http://127.0.0.1:5173` is refused (VERIFIED, use `http://localhost:5173` in a browser) and
Playwright starts its own vite on 127.0.0.1 beside it — the run still passes. To share one vite,
start it as `pnpm --filter @pickle/admin-web exec vite --host 127.0.0.1`. The skip reason for
test 3 is recorded in the HTML report (`dist/report/`), not printed by the `list` reporter.
What is asserted (`smoke.e2e.ts`):

1. `/#/` renders the API console (h1, token input, hint), `GET /v1/health` returns
   `{status:"ok",version}` both directly and via an in-page `fetch("/v1/health")` through the vite
   proxy; zero console errors, zero `pageerror`s, zero failed/4xx/5xx requests.
2. `/` (empty hash → Coach Review Lab) renders from the checked-in `datasets/coach-review/*` via
   the vite middleware, same fault checks.
3. (needs `PICKLE_E2E_DATABASE_URL`) mints an admin dev token, `POST /v1/account/bootstrap`, pastes
   the token into the UI, waits for `GET /v1/flags` = 200, asserts all five panels render and the
   seeded flag table is non-empty.

Screenshots land in `apps/admin-web/e2e/dist/artifacts/*.png`; traces on failure in
`e2e/dist/test-results/`; HTML report in `e2e/dist/report/`. `dist/` is git/prettier/eslint-ignored
at the root. `*.e2e.ts` is used instead of `*.spec.ts` so the package's `vitest run` does not
collect Playwright files. Type-check the suite with
`pnpm --filter @pickle/admin-web exec tsc -p e2e/tsconfig.json` (the package `typecheck` only covers
`src/`).

Not wired into `.github/workflows/ci.yml` (coordinator-owned). If it is added: `CI=1` disables
server reuse and `test.only`; add `pnpm --filter @pickle/admin-web exec playwright install --with-deps chromium`.

### 2.4 Mobile logic (Jest, Linux)

```bash
cd apps/mobile && npm ci && npx tsc --noEmit && npx jest --silent
```

247 suites / 2900 tests cover stores, flows, navigation gates, paywall/billing state, session
persistence, etc. with `@react-native/jest-preset`. This is behaviour-level coverage of the app
logic, not a rendered device UI. `importedRealFootageAnalysis.test.ts` only runs when Mac-produced
pose/meta artifacts are present (they are not committed) → 1 suite always skipped on Linux/CI.

### 2.5 Mobile UI, camera, StoreKit, Xcode — Mac runner only

Not attempted here. Facts: iOS native deps need `bundle exec pod install`; builds/archives/TestFlight
need Xcode on the self-hosted `[self-hosted, macOS, ARM64]` runner (`mac-smoke-test.yml` is the only
Mac workflow present). `npm run check:distribution` and `pnpm release:check` are the Linux-side
static preconditions and say so in their output. Anything about device latency, camera capture,
purchase sheets or screenshots of the real app is UNKNOWN from a Linux session.

## 3. Flaky / external / conditional — policy and inventory

Policy (from `docs/TESTING.md`): **Skipped ≠ passed**; DB tests report skipped locally without a
database and CI always runs them; no disabled tests to get green CI; deterministic doubles only for
pure math/state transitions. Applied here: every skip below is _conditional on environment_, prints
as a skip, and was executed at least once in this audit with the environment present (except the
Mac-only artifact one, which cannot be).

### 3.1 Every skip / ignore / suppression pattern in the repo (grep, VERIFIED)

| Pattern                                                                    | Where                                                                                                                                                                              | Justification found                                                                                                                                     |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `describe.skipIf(!testUrl)`                                                | 7 describes in `packages/database/test`, 19 in `services/api/test`, 8 in `services/media-worker/test`                                                                              | `DATABASE_URL_TEST` gate documented in docs/TESTING.md; CI provides the DB. Skips are visible.                                                          |
| `describe.skipIf(!endpoint)`                                               | `packages/queue/test/sqs.integration.test.ts`                                                                                                                                      | `SQS_ENDPOINT_TEST`; **CI never sets it** → 3 tests never run in CI. Local ElasticMQ run passes.                                                        |
| `describe.skipIf(!hasFfmpeg)` ×3                                           | `packages/capture-envelope/test/{h26EnvelopeRedTeam,redteamBypassF22,redteamEnvelope}.test.ts`                                                                                     | CI installs ffmpeg (`Install ffmpeg (synthetic test fixtures)` step) so they run there.                                                                 |
| `it.skipIf(!ffmpegHasDrawtext)`                                            | `packages/swing-lab/test/oodGateRedTeam.test.ts:115`                                                                                                                               | Ubuntu's ffmpeg has drawtext; ran here.                                                                                                                 |
| `describe.skipIf(!existsSync(report.json))`                                | `packages/swing-lab/test/sessionEngine.test.ts:436`                                                                                                                                | Replay fixtures for 4 runs are re-derivable lab artifacts, not committed (`.gitignore` datasets rules) → 4 skipped everywhere including CI.             |
| `artifactsPresent ? describe : describe.skip`                              | `apps/mobile/__tests__/importedRealFootageAnalysis.test.ts:99`                                                                                                                     | Needs Mac-generated pose/meta files → 1 suite skipped on Linux and in CI's `mobile` job.                                                                |
| `ignore: PG_URL === ""`                                                    | `supabase/functions/api/__wf__/be-edge-routes-shots-rank.test.ts` (6 tests)                                                                                                        | Documented in the file header with the exact throwaway-DB recipe; VERIFIED 6/6 pass with it.                                                            |
| `ignore: skip` (Docker probe)                                              | `supabase/functions/api/__wf__/db_migrations_rls_indexes.audit.test.ts:176`                                                                                                        | Skips when `docker info` fails; ran here (Docker present).                                                                                              |
| `--passWithNoTests`                                                        | `apps/admin-web/package.json`, `packages/shared-types/package.json`                                                                                                                | Both packages have tests (97 and 93) — the flag is inert today. Recommend removal by owners so an accidental test deletion cannot go green.             |
| `\|\| true`                                                                | `supabase/tests/run_rls_tests.sh:17,50`; `__wf__/wf-billing-entitlement-sync-db.sh:27,61,62`; `tools/mac-bench/run-mac-bench.sh:126`; `tools/iphone-trials/run-iphone-trial.sh:49` | All cleanup (`docker rm -f`, `pg_ctl stop`, `rm __pycache__`) or `grep -c` count capture (grep exits 1 on zero matches); none hide a failing assertion. |
| `continue-on-error`, `xit(`, `test.todo`, `describe.skip(` (unconditional) | none found                                                                                                                                                                         | —                                                                                                                                                       |

### 3.2 Determinism / shared-state analysis

- **Why `--workspace-concurrency=1`:** `@pickle/database`, `@pickle/api`, and `@pickle/media-worker`
  all point at the same `DATABASE_URL_TEST`, and 15 test files across them run
  `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` before re-migrating (VERIFIED by grep:
  6 in api, 5 in media-worker, 4 in database incl. `migrate.test.ts` ×5 occurrences).
  `roles.destructive.integration.test.ts` additionally logs in as the real `pickle_app` /
  `pickle_worker` / `pickle_ro` / `pickle_migrator` users (idempotently created from
  `infra/postgres/init-roles.sql`). Two workspaces doing this concurrently would destroy each
  other's schema mid-test — the ci.yml comment ("suites share the DB service") matches the code.
  Not demonstrated by a parallel run in this audit (it would only prove breakage).
- **Within a package** the same three packages set `fileParallelism: false` in their
  `vitest.config.ts`, so files run one at a time; suites that do not reset `public` use a
  per-file schema (`roles_dit_<pid>_<uuid>`, "isolated PostgreSQL schema" in describe names).
- **ffmpeg:** capture-envelope (17 s) and swing-lab (70 s) synthesize video fixtures at test time.
  Output is deterministic for a given ffmpeg build; a different ffmpeg major (e.g. 6.x vs 4.4.2)
  could shift encoder output slightly — treat as a version-pinned dependency, not flake.
- **Time / randomness:** two consecutive root runs and two mobile runs produced identical pass /
  skip counts (VERIFIED); no time-of-day-sensitive failure observed. 8 test files under
  `services/api/test` and `packages/*/test` reference `Date.now`/fake timers; none flaked here.
- **Network:** no PR-gate suite contacts the internet (INFERRED from code; this box was not
  network-isolated). k6 load tests and anything under `tools/latency-slo` with real measurement
  inputs are external by design.
- **Docker:** RLS matrix, `wf-billing-entitlement-sync-db.sh`, the 6 `PICKLE_AUDIT_PG_URL` tests and
  the migrations audit all need Docker (or, for RLS only, a local `initdb`).
- **Order:** pure packages use vitest's default parallel file execution; the DB packages are
  serialized as above. No inter-file order dependence was observed across two runs.

### 3.3 Flakiness re-run results

| Suite                      | Run 1                                                                                  | Run 2                            | Difference                  |
| -------------------------- | -------------------------------------------------------------------------------------- | -------------------------------- | --------------------------- |
| Root `pnpm test` (29 ws)   | all pass; 7 skipped; ~165 s                                                            | all pass; 7 skipped; ~170 s      | none in counts              |
| Mobile `npx jest --silent` | 247 suites/2900 tests pass, 1/1 skipped; 18.7 s                                        | same counts; 10.7 s (warm cache) | none in counts; only timing |
| Admin-web e2e              | 2 pass / 1 skip (5 s) ×3 runs; 3 pass with DB ×2 runs; `CI=1` cold run 2 pass / 1 skip | —                                | none                        |

## 4. Gaps this audit could not close (honest list)

- Mac/Xcode/device UI: no Mac available — everything in §2.5 is UNKNOWN from here.
- Edge function over real HTTP (`supabase start` or a staging project): not attempted; only the
  in-process `__wf__` tests and DB RPC audits were run.
- k6 load tests: not run (would need a deployed target).
- The 4 swing-lab replay skips and the 1 mobile real-footage skip are permanent on any machine
  without the un-committed artifacts — they should be read as "not covered", never as "passing".
- `@pickle/queue` SQS tests never run in CI (no ElasticMQ service in `ci.yml`). Adding
  `elasticmq` to the CI services + `SQS_ENDPOINT_TEST` would close it; ci.yml is coordinator-owned.
- `deno task test` (`__wf__`) is not in `ci.yml` at all — the production backend's tests run only
  when someone runs them by hand.
