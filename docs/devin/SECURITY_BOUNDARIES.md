# Security boundaries for autonomous (Devin) sessions

Audit stream: security/secrets + backend/Supabase/auth. Snapshot of `origin/main` at `7c034aa`
(2026-09-04). Every statement is tagged **VERIFIED** (executed in this audit, command + result
recorded), **INFERRED** (read from code/docs, not executed), or **UNKNOWN** (no evidence available
from the repository). Nothing in this file contains a secret value; only names and locations.

Companion artifacts: `scripts/security-scan.sh` (the gitleaks gate) and `.gitleaks.toml` (its
policy; every allowlist entry carries a justification comment).

Gate invariants (each pinned by a regression test that `scripts/verify-cloud.sh` `security`
stage runs before the scan):

- **Only the pinned scanner runs.** Whichever `gitleaks` the wrapper is about to execute —
  `GITLEAKS_BIN`, the `SECURITY_SCAN_CACHE` copy, one found on `PATH`, or a fresh download — must
  hash to one of the per-platform pinned sha256 digests of the official v8.30.1 executables
  (`GITLEAKS_BIN_SHA256` in `scripts/security-scan.sh`, in addition to the release-tarball
  digests) and report exactly that version; the digest is checked before the file is ever run.
  Anything else is a setup failure (exit 2), never a warning, so a substituted or no-op binary
  cannot pass the gate (`scripts/tests/security-scan-binary-trust.sh`).
- **No whole-file allowlists.** `.gitleaks.toml` has no paths-only entries (a global path
  allowlist hides a committed secret in both scan modes, whatever the directory, extension or
  `.gitignore` says — `git add -f` still commits it), and every paths+regexes entry sets
  `condition = "AND"` and `targetRules` (gitleaks ORs the two by default, and `dir` mode skips a
  file matched by a global path allowlist before any rule runs). Fixture exemptions are one exact
  string or line shape per rule per file (`scripts/tests/gitleaks-allowlist-policy.sh`).

---

## 1. Secret scan results

### Method — VERIFIED

| Step                           | Command                                                                                                                                                                                                                                                             | Result                                                                                                                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool                           | gitleaks v8.30.1 release tarball, sha256 `551f6fc8…2470eb` verified against `gitleaks_8.30.1_checksums.txt`                                                                                                                                                         | installed                                                                                                                                                                                                                                                                  |
| Full history, default rules    | `gitleaks git --redact=100 .`                                                                                                                                                                                                                                       | 416 commits with diffs (728 in `rev-list`), 50.2 MB, 2.8 s → **511 findings**, all classified below                                                                                                                                                                        |
| Working tree, default rules    | `gitleaks dir --redact=100 .`                                                                                                                                                                                                                                       | 865 MB (~820 MB of it committed corpus `.mp4`/model binaries), 8.8 s → same finding classes                                                                                                                                                                                |
| Supplemental history regex     | `git log -p --all` piped through a regex for JWTs, `sk_live_`, PEM blocks, `AKIA`, `ghp_`, `sb_secret_`, `appl_`/`test_`/`goog_`, `AIza`, `SUPABASE_SERVICE_ROLE_KEY=`                                                                                              | 3 PEM header hits (all string templates in Deno tests / `externalAccounts.ts`), 2 RevenueCat PUBLIC keys; no JWT, no service key, no AWS/GitHub token                                                                                                                      |
| Sensitive filenames in history | `git log --all --diff-filter=A --name-only` filtered for `.env`, `.p8`, `.p12`, `.pem`, `.mobileprovision`, keystores, `GoogleService-Info.plist`, `credentials.json`                                                                                               | `.env.example` and `apps/mobile/android/app/debug.keystore` only                                                                                                                                                                                                           |
| With `.gitleaks.toml` policy   | `scripts/security-scan.sh` (tree + history)                                                                                                                                                                                                                         | **0 findings**, exit 0, 5.4 s including a cold pinned download; 4–5 s warm                                                                                                                                                                                                 |
| Gate FAILS on planted secrets  | untracked file with synthetic `ghp_…`, `sb_secret_…`, `sk_…`, `UPSTASH_REDIS_REST_TOKEN=…`, `REVENUECAT_WEBHOOK_AUTH=…` → `--tree`; throwaway commit with `AKIA…`, `ghp_…`, `sb_secret_…`, `sk_…`, a JWT and a PEM block → `--history --log-opts origin/main..HEAD` | exit 1 with 6/6 rules firing in each mode (`revenuecat-webhook-auth`, `github-pat`, `upstash-redis-rest-token`, `supabase-secret-api-key`, `revenuecat-secret-api-key`, `generic-api-key`; `aws-access-token`, `jwt`, `private-key`, …). Test branch deleted, never pushed |

### Classification of the 511 default-rule findings — VERIFIED (each value inspected)

No (a) real secret was found in the working tree or in any reachable commit. **No rotation is
required from this audit.**

| Class                                                                      | Count           | Location (names only)                                                                                                             | Verdict                                                                                                                                                                           |
| -------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Corpus/session identifiers (`sessionKey`, `subjectKey`)                    | ~470            | `datasets/**/*.json(l)`, `packages/swing-lab/src/labelQueueV3.ts`, `packages/swing-lab/test/*`, `packages/hard-case-queue/test/*` | (b) recording ids such as `dvids-marne-2024`, `rec-…`; grant nothing                                                                                                              |
| Store product slugs (`productKey`)                                         | 2               | `services/api/test/billing-access.test.ts`                                                                                        | (b) product identifier                                                                                                                                                            |
| Dev HS256 issuer fixtures (`…secret-0123456789`)                           | 10              | `services/api/test/*.test.ts`                                                                                                     | (c) test-only; the issuer constructor throws outside development/test (`docs/SECURITY.md`); legacy Fastify stack is not deployed                                                  |
| `sk_test_revenuecat` literal                                               | 5               | `supabase/functions/api/__wf__/*`                                                                                                 | (c) test stub for the `REVENUECAT_SECRET_API_KEY` env var; not a Stripe or RevenueCat key                                                                                         |
| Synthetic `header.<b64>.sig` token                                         | 1               | `apps/mobile/__tests__/wf/be-mobile-security-secrets.test.ts`                                                                     | (c) fixture proving provider tokens are never persisted                                                                                                                           |
| CocoaPods spec checksums                                                   | 4               | `apps/mobile/ios/Podfile.lock`                                                                                                    | (b) SHA-1 podspec digests                                                                                                                                                         |
| ASC API **Issuer ID** + **Key ID**                                         | 1               | `docs/DISTRIBUTION.md` (`APP_STORE_CONNECT_API_KEY_ISSUER_ID`, `…_KEY_ID`)                                                        | (b) identifiers, not credentials — useless without the `.p8`, which lives only on the launch Mac. Still: they narrow an attacker's search, so treat as "public but do not spread" |
| RevenueCat PUBLIC SDK keys (`appl_…`, `test_…`)                            | 2 (regex sweep) | `apps/mobile/src/config/runtimeConfig.ts`                                                                                         | (b) designed to ship in the binary; cannot read/mutate subscribers server-side (that needs `sk_…`)                                                                                |
| Google OAuth client ids, Supabase project URL, Apple team id, App Store id | —               | `runtimeConfig.ts`, `Info.plist`, `fastlane/Appfile`                                                                              | (b) public identifiers (the Google token audience is verified server-side by Supabase Auth)                                                                                       |
| Android debug keystore                                                     | 1 file          | `apps/mobile/android/app/debug.keystore`                                                                                          | (c) INFERRED: the React Native template debug-signing keystore (Android debug builds only, conventionally public) — not a Play release key; Android is not shipping               |
| Local docker/dev defaults                                                  | —               | `.env.example`, `docker-compose.yml`, `infra/postgres/init-roles.sql`, `.github/workflows/ci.yml` (`pickle_ci_password`)          | (c) placeholders for local/CI containers only; `.env` itself is gitignored and was never committed                                                                                |
| Supabase anon/publishable key, service-role key, any JWT                   | 0               | —                                                                                                                                 | not present anywhere in tree or history (VERIFIED by regex sweep + gitleaks `jwt` rule)                                                                                           |

---

## 2. Secret / credential / identity inventory (names only)

Column "Devin?" = may an autonomous session ever hold it. Default **no** for anything that can
mutate production. Scope: dev / prod (there is no staging — see §3).

### 2.1 Supabase Edge Function secrets (`supabase secrets set …`, read via `Deno.env` in `supabase/functions/api`) — INFERRED from code + AGENTS.md; presence in prod asserted by `docs/RELEASE_READINESS_2026-09-03.md` §7 (UNVERIFIED here)

| Name                                                                       | Used by                                                                                                                                                             | Scope | Least privilege                                                                                                                 | Devin?                                                              |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` / `SB_PUBLISHABLE_KEY`                 | platform-injected; every RLS-scoped query runs as the user's session on top of the anon key                                                                         | prod  | OK — anon has zero table grants (matrix case C)                                                                                 | anon key: yes if ever needed (public by design); never needed today |
| `SUPABASE_SERVICE_ROLE_KEY`                                                | platform-injected; `billingAdminDb()` only: `billing_entitlements`, `webhook_events`, `account_external_credentials`, deletion checkpoints, `auth.admin.deleteUser` | prod  | Bypasses RLS entirely. Acceptable only because usage is confined to the lazy admin client; every new use is a human-review item | **never**                                                           |
| `REVENUECAT_SECRET_API_KEY` (fallback `REVENUECAT_PUBLIC_SDK_KEY`)         | `/v1/billing/sync`, webhook re-verification, RevenueCat customer deletion                                                                                           | prod  | Secret key can delete customers — required for account deletion; keep it a v1 secret key scoped to this project                 | **never**                                                           |
| `REVENUECAT_WEBHOOK_AUTH`                                                  | `POST /webhooks/revenuecat` Authorization check (constant-time compare, fail-closed when unset)                                                                     | prod  | OK                                                                                                                              | **never**                                                           |
| `APPLE_SIGN_IN_CLIENT_ID`, `APPLE_SIGN_IN_TEAM_ID`, `APPLE_SIGN_IN_KEY_ID` | Apple server-to-server token exchange/revocation (`externalAccounts.ts`)                                                                                            | prod  | identifiers                                                                                                                     | identifiers only (client id/team id are public)                     |
| `APPLE_SIGN_IN_PRIVATE_KEY` (Sign in with Apple `.p8`)                     | same                                                                                                                                                                | prod  | Signs Apple client secrets; loss ⇒ rotate in Apple Developer                                                                    | **never**                                                           |
| `APPLE_TOKEN_ENCRYPTION_KEY` (32 random bytes, base64)                     | encrypts stored Apple refresh tokens in `account_external_credentials`                                                                                              | prod  | Loss = cannot revoke stored tokens; leak = decrypts them. Back it up out-of-band                                                | **never**                                                           |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (optional)            | `cache.ts` L2 auth-session cache + `rateLimit.ts`                                                                                                                   | prod  | Token reads/writes the cache of **verified session ids**; treat as sensitive                                                    | **never**                                                           |

### 2.2 Apple / App Store — INFERRED (`apps/mobile/ios/fastlane/*`, `docs/DISTRIBUTION.md`)

| Name                                                                                                      | Where it lives                                                                     | Used by                                    | Least privilege                                                                                                       | Devin?                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App Store Connect API key (`APP_STORE_CONNECT_API_KEY_KEY_ID`, `…_ISSUER_ID`, `…_KEY` / `…_KEY_FILEPATH`) | env on the launch Mac; `.p8` at `~/.appstoreconnect/AuthKey_<KEY_ID>.p8`, mode 600 | fastlane `prep_signing`, `beta`, `release` | Role **App Manager** (deliberately not Admin — cloud-managed signing is avoided). Can upload builds and edit metadata | **never** — an autonomous session may only trigger the human-approved GitHub Actions workflow that runs on that Mac; it must never read, copy, or print the key |
| Apple Distribution certificate + App Store provisioning profile                                           | Mac keychain / `build/signing` (gitignored)                                        | fastlane `build`                           | fine                                                                                                                  | never (lives on the runner)                                                                                                                                     |
| Apple Developer account / App Store Connect login (2FA)                                                   | the owner                                                                          | manual submission, IAP, agreements         | human-only                                                                                                            | **never**                                                                                                                                                       |
| Sandbox tester Apple IDs                                                                                  | App Store Connect → Users and Access → Sandbox                                     | StoreKit sandbox purchases on device       | test-only                                                                                                             | no (device-only; none exist in the repo)                                                                                                                        |

### 2.3 RevenueCat — INFERRED

| Name                            | Where                                                 | Used by                                   | Devin?       |
| ------------------------------- | ----------------------------------------------------- | ----------------------------------------- | ------------ |
| iOS PUBLIC SDK key `appl_…`     | `apps/mobile/src/config/runtimeConfig.ts` (committed) | Purchases SDK                             | yes (public) |
| Android TEST STORE key `test_…` | same                                                  | simulated purchases; Android not shipping | yes (public) |
| Secret API key `sk_…`           | Supabase secret only                                  | see 2.1                                   | **never**    |
| Webhook shared secret           | Supabase secret + RevenueCat dashboard                | see 2.1                                   | **never**    |
| RevenueCat dashboard login      | owner                                                 | offerings, entitlements, keys             | **never**    |

### 2.4 Google — INFERRED

| Name                                                                     | Where                                       | Notes                                                                                  | Devin?       |
| ------------------------------------------------------------------------ | ------------------------------------------- | -------------------------------------------------------------------------------------- | ------------ |
| iOS OAuth client id, Web OAuth client id (`…apps.googleusercontent.com`) | `runtimeConfig.ts`, `Info.plist` (reversed) | public identifiers; Supabase Google provider must list both as allowed audiences (B-1) | yes (public) |
| Web OAuth client **secret**                                              | Google Cloud Console → Supabase Dashboard   | only for browser OAuth; not used by the app                                            | **never**    |

### 2.5 Database roles — VERIFIED locally (matrix + schema dump), INFERRED for hosted

| Role                                                                                               | Environment                                                                                                              | Privilege                                                                         | Devin?          |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | --------------- |
| Supabase `anon`, `authenticated`, `service_role`                                                   | prod Supabase (shimmed locally)                                                                                          | see §4                                                                            | local shim only |
| Supabase Postgres `postgres` superuser / Dashboard SQL editor / `supabase db push` link            | prod                                                                                                                     | full DDL — the only path that can change RLS/grants/ledgers                       | **never**       |
| `pickle` (docker-compose superuser), `pickle_app`, `pickle_worker`, `pickle_migrator`, `pickle_ro` | local Docker / CI containers only                                                                                        | passwords are committed dev defaults (`.env.example`, `init-roles.sql`, `ci.yml`) | yes (local)     |
| RDS master `pickle_admin` + `<env>/db-url-*` Secrets Manager entries (Terraform `infra/terraform`) | legacy AWS stack — **never applied** (`RUNBOOK_CONSENT_DB_ROLES.md` §6: no production AWS credentials exist in the repo) | n/a                                                                               | **never**       |

### 2.6 CI / runner identities — VERIFIED (workflows read)

| Identity                                                                | Evidence                                                                                                                                             | Devin?                                                                                                 |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `GITHUB_TOKEN` in `.github/workflows/ci.yml`                            | `permissions: contents: read` at workflow level; **no `secrets.*` or `vars.*` referenced in any workflow** (`grep` returned nothing)                 | n/a                                                                                                    |
| Self-hosted runner `[self-hosted, macOS, ARM64]` (`mac-smoke-test.yml`) | `workflow_dispatch` only. The runner's registration token and the Mac's ASC key/keychain are the crown jewels of the release path                    | may **dispatch** an approved workflow; must never run arbitrary code on it outside a reviewed workflow |
| Devin's own GitHub identity / git proxy                                 | pushes branches, opens PRs                                                                                                                           | yes — that is its job; branch protection on `main` should stay enforced                                |
| Test accounts                                                           | **none exist in the repo** (no seeded users; `packages/database/src/seed.ts` seeds catalog data only). Sign-in requires a real Apple/Google identity | UNKNOWN whether the owner keeps dedicated test Apple/Google accounts                                   |

---

## 3. Environment separation as it actually exists

| Layer           | dev                                                                                                                                          | staging                                                                                                                                                                                  | prod                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Backend (real)  | `supabase functions serve` (never exercised here), `__wf__` Deno tests against `supabase_stub.ts`; Docker/initdb Postgres for the RLS matrix | **none.** Only one Supabase project ref appears anywhere in tree or history (`ucqnaiwqwjtgvlduiuib`, 21 refs in tree / 26 in history — VERIFIED). No preview branches, no second project | Supabase project `ucqnaiwqwjtgvlduiuib`: Postgres + Edge Function `api` + Auth |
| Legacy backend  | `pnpm dev:api` (Fastify) + docker-compose Postgres/Redis/MinIO/ElasticMQ                                                                     | `infra/terraform/envs/staging` exists but has never been applied (RUNBOOK §6)                                                                                                            | not deployed; the app does not call it                                         |
| Mobile config   | `runtimeConfig.ts` points at **production** (API origin, RevenueCat production key); Debug builds purchase in Apple's sandbox                | none                                                                                                                                                                                     | same values                                                                    |
| Signing / store | Xcode development signing on the owner's devices                                                                                             | TestFlight internal (`fastlane beta`) — same ASC app, same backend                                                                                                                       | `fastlane release` uploads binary only; submission is a human click            |

Consequence: **every** Supabase mutation (`db push`, `functions deploy`, `secrets set`, Dashboard
edits, SQL editor) is a production change. There is no rehearsal environment. Until a staging
project exists, autonomous sessions rehearse only against the throwaway RLS cluster
(`./supabase/tests/run_rls_tests.sh`) and the Deno stub harness.

---

## 4. Backend / auth boundary review

### 4.1 RLS + grants — VERIFIED against a fresh Postgres 16 with `shim_auth.sql` + all 17 migrations (schema dump via `pg_policies`, `role_table_grants`, `column_privileges`, `pg_proc`)

- **All 19 tables** have RLS enabled; 3 views are `security_invoker=true`; `anon` holds **no**
  table grant and cannot execute any app RPC.
- **Service-only tables (RLS on, zero policies, all client grants revoked):**
  `account_external_credentials` (encrypted Apple refresh tokens), `free_rating_ledger`
  (identity-lifetime free-rating count), `webhook_events` (RevenueCat audit log).
- **Server-written, client-readable:** `billing_entitlements` (SELECT only; written by the
  service-role client after RevenueCat verification), `player_rank_state` (SELECT only;
  trigger-maintained), `profiles` (SELECT + column-restricted UPDATE; created by the
  `handle_new_user` definer trigger, no client INSERT/DELETE).
- **Append-only ledgers (trigger-enforced for every role, plus no client UPDATE/DELETE grant):**
  `consent_records`, `evaluation_trials`, `analysis_feedback` (`reject_ledger_mutation`),
  `account_deletion_feedback` (`reject_deletion_feedback_mutation`, INSERT-only, anonymised on
  account deletion — the one row that outlives the account).
- **Write-once evidence (INSERT + SELECT only):** `shot_phases`, `shot_measurements`,
  `shot_checkpoints`, `shots` (INSERT-only via `apply_synced_shot`; UPDATE **and** DELETE revoked
  as of `20260902130000`).
- **Column-restricted UPDATE grants:** `sessions(ended_at)`, `analysis_permits(status, outcome)`,
  `account_deletion_requests(user_id, challenge, created_at, expires_at)` (PostgREST upsert shape),
  `profiles(first_name, gender, handedness, skill_level, primary_goal, biggest_problem,
focus_checkpoint, onboarding_state, provider)`.
- **Full owner CRUD:** `captures`, `user_saved_drills`, `sessions`/`analysis_permits`/
  `account_deletion_requests` (DELETE allowed, UPDATE column-restricted).
- **Functions:** 5 `SECURITY DEFINER` functions, all `search_path=""`, and only
  `identity_scored_count()` (auth.uid()-scoped, no parameters) is executable by `authenticated`;
  the other four are trigger bodies with EXECUTE revoked. RPCs `access_state()`,
  `apply_synced_shot(jsonb)`, `reserve_analysis_permit(text)`, `lifetime_scored_count()`,
  `complete_onboarding()`, `access_lock_key(uuid)` are `SECURITY INVOKER` (RLS applies) and
  granted to `authenticated` only.
- **Matrix result:** `./supabase/tests/run_rls_tests.sh` → `SECURITY REGRESSION MATRIX: ALL CASES
PASSED`, exit 0, 2.2 s wall clock on this Ubuntu box (Docker `postgres:16`). Labelled cases
  A1–A9, B1–B5 (+B4b), C, D1–D4, E1–E9, F1–F5 (+F4b), H1–H7, I1–I3, J1–J9 = 54 boundary cases, each
  containing one or more assertions.

Residual observations (no change made — human review items, not blockers):

- INFERRED: with hosted-like default privileges, `authenticated` retains `REFERENCES`, `TRIGGER`
  and `TRUNCATE` on every client table (and INSERT/UPDATE/DELETE on the three `security_invoker`
  views). None of these is reachable through PostgREST/the Edge Function, and the views resolve
  to the underlying tables' grants, but a future migration
  `revoke truncate, references, trigger on all tables in schema public from anon, authenticated`
  would make the DB posture independent of the API surface. Whether the hosted project's default
  privileges match the shim is B-1-class Dashboard/SQL verification — UNKNOWN from the repo.
- VERIFIED (schema dump): `complete_onboarding()`, `player_rank_tier()` and `set_updated_at()` are
  the three functions without a pinned `search_path` (all INVOKER, so no privilege escalation;
  `player_rank_tier` is a pure helper executable by anon; `set_updated_at` is a trigger body with
  EXECUTE revoked).
- `pg_cron` schedules (`expire-stale-analysis-permits`, `purge-expired-deletion-requests`,
  `purge-old-webhook-events`) are skipped locally (extension absent) — their production state is
  UNKNOWN from the repo.

### 4.2 Public (no-auth) routes — VERIFIED by reading `supabase/functions/api/index.ts` `handleRequest`

| Route                                            | Guard                                                                                                                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`/`HEAD` `…/healthz`                         | per-IP `PUBLIC_PAGE_LIMIT`                                                                                                                                                                                   |
| `GET`/`HEAD` `…/support`, `…/privacy`, `…/terms` | per-IP limit; plain text (`legal.ts`). Note: `/support` is public too, although AGENTS.md lists only healthz/privacy/terms                                                                                   |
| `POST …/webhooks/revenuecat`                     | per-IP `WEBHOOK_LIMIT`; `REVENUECAT_WEBHOOK_AUTH` constant-time compare, 503 fail-closed when unset; entitlements re-verified against RevenueCat, never trusted from the body; audit row in `webhook_events` |
| `POST /v1/account/bootstrap`                     | body cap → per-IP budget → auth-failure budget → spends an Apple/Google **ID token** once via `signInWithIdToken`; returns the Supabase session                                                              |
| `POST /v1/auth/refresh`                          | body cap → per-IP `AUTH_REFRESH_LIMIT`; refresh token in body; 401 counts as an auth failure                                                                                                                 |
| everything else                                  | `authenticate()` (Supabase access token, cached ≤10 min by token hash; provider ID tokens accepted **transitionally**), then per-user route budgets                                                          |

### 4.3 Dangerous areas requiring human review before merge — INFERRED (ownership map)

| Area                                                                                                               | Files                                                                                                                                                                                       | Why                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any migration touching RLS policies, grants/revokes, definer functions, triggers, or the three service-only tables | `supabase/migrations/*.sql` (esp. `…_defense_in_depth.sql`, `…_scale_and_security.sql`, `…_free_rating_identity_ledger.sql`, `…_shots_delete_revoke.sql`, `…_external_account_cleanup.sql`) | applied to prod with `supabase db push`; history is immutable; a wrong grant is a cross-user data exposure                                                                                                                                              |
| Ledgers / permits / billing                                                                                        | `free_rating_ledger`, `analysis_permits`, `reserve_analysis_permit()`, `apply_synced_shot()`, `lifetime_scored_count()`, `billing_entitlements`, `webhook_events`                           | revenue integrity (two free ratings, entitlement truth). Static pin: `__wf__/db_migrations_rls_indexes.test.ts`; live: matrix H/J                                                                                                                       |
| Edge-function auth paths                                                                                           | `index.ts` `authenticate()`, `authenticateProviderToken()`, `bootstrapAccount()`, `refreshSessionRoute()`, `logoutRoute()`, `cache.ts`, `rateLimit.ts`                                      | session minting/rotation/revocation; the auth cache holds verified sessions                                                                                                                                                                             |
| Entitlement checks                                                                                                 | `index.ts` `/v1/billing/sync`, `handleRevenueCatWebhook`, `access_state()`; mobile `accessStore`, `useRatingRouteGate`                                                                      | paywall bypass / false lockout                                                                                                                                                                                                                          |
| Account deletion + external revocation                                                                             | `index.ts` `delete-request`/`delete-confirm`, `externalAccounts.ts`, `account_external_credentials`, `auth.admin.deleteUser`, `account_deletion_feedback`                                   | irreversible; touches Apple + RevenueCat + Auth admin with the service-role key                                                                                                                                                                         |
| Legal text                                                                                                         | `legal.ts` §7/§8, support page, in-app deletion confirmation                                                                                                                                | must stay in step with ledger retention behaviour (App Review + privacy law)                                                                                                                                                                            |
| Anything that adds a `Deno.env.get` or a new `billingAdminDb()` call                                               | `supabase/functions/api/**`                                                                                                                                                                 | widens the secret or RLS-bypass surface                                                                                                                                                                                                                 |
| Workflows on the self-hosted Mac runner                                                                            | `.github/workflows/*.yml` with `runs-on: [self-hosted, …]`                                                                                                                                  | the repo is **public**: a self-hosted job triggered by `pull_request` would run fork code on the machine that holds the ASC key. Keep such jobs on `workflow_dispatch`/trusted `push` only and keep "Require approval for all outside collaborators" on |
| Mobile runtime config                                                                                              | `apps/mobile/src/config/runtimeConfig.ts`, `Info.plist` URL schemes                                                                                                                         | points production users at a backend / billing project                                                                                                                                                                                                  |

---

## 5. Rules for autonomous sessions

### May do freely

- Run and extend local verification: root `pnpm` gates, `apps/mobile` `npm ci && npx tsc --noEmit &&
npx jest`, `./supabase/tests/run_rls_tests.sh` (throwaway Docker/initdb cluster),
  `(cd supabase/functions/api/__wf__ && deno task test)`, `deno check` on the standalone modules,
  `python3 -m unittest discover -s ml/scripts -p 'test_*.py'`, `scripts/security-scan.sh`.
- Use the local Docker stack (`docker compose up -d postgres postgres_test redis`) with the
  committed dev passwords; `pnpm --filter @pickle/database migrate|seed` against it.
- Add **new** migrations, tests and edge-function code on a branch for human review — never apply
  them anywhere but the throwaway cluster.
- Hold public identifiers (Supabase URL, anon key if ever needed, Google client ids, RevenueCat
  public SDK keys, Apple team/app ids).
- Dispatch an already-reviewed GitHub Actions workflow on the Mac runner when the task calls for
  it, and read its logs.

### Must never do (without an explicit human go-ahead in the session)

- `supabase db push`, `supabase functions deploy`, `supabase secrets set|unset`, `supabase link`
  to the production ref, Dashboard/SQL-editor changes, Auth provider changes, storage bucket
  changes.
- Hold or print: `SUPABASE_SERVICE_ROLE_KEY`, `REVENUECAT_SECRET_API_KEY`, `REVENUECAT_WEBHOOK_AUTH`,
  `APPLE_SIGN_IN_PRIVATE_KEY`, `APPLE_TOKEN_ENCRYPTION_KEY`, `UPSTASH_REDIS_REST_TOKEN`, the App
  Store Connect `.p8`/`APP_STORE_CONNECT_API_KEY_KEY`, the Google web-client secret, any Apple ID /
  RevenueCat / Supabase / Google Cloud console login, the self-hosted runner token.
- App Store Connect: submit for review, change pricing/availability/agreements, enable TestFlight
  external testing, Family Sharing or Made for Kids (`docs/APP_STORE_SUBMISSION.md` hard rules).
- Edit an already-applied migration, add user INSERT/UPDATE policies to `billing_entitlements`,
  add client grants to the service-only tables, or write `count(*) from public.shots` into a
  free-rating decision point (AGENTS.md).
- Weaken or skip `supabase/tests/security_regression.sql`, the `__wf__` pins, or
  `scripts/security-scan.sh` (no `|| true`; no paths-only or OR-evaluated path allowlists in
  `.gitleaks.toml`; no unpinned `GITLEAKS_BIN`, cache or `PATH` binary — the wrapper refuses
  anything whose sha256 is not one of the pinned executables).
- Commit `.env`, `supabase/.temp/`, `build/signing`, or anything the scanner flags. If a real
  secret is ever found: report the path@commit only, never the value; rotation is a human action.

### Recommended follow-ups (owner decisions, not done here)

1. Create a **staging Supabase project** (or use Supabase Branching) so migrations and function
   deploys can be rehearsed; today every deploy is production.
2. ~~Wire `scripts/security-scan.sh` into `verify-cloud.sh`/CI~~ — done: the `security` stage runs
   the scope, allowlist-policy and binary-trust regressions and then the scan (~15 s: the tree
   scan now reads the committed corpus media too, since extension allowlists were removed).
3. Close B-1/B-3 from `docs/SECURITY_CERTIFICATION_2026-08-30.md` (Dashboard config verification,
   one rotation drill) and record the evidence.
4. Consider the `TRUNCATE/REFERENCES/TRIGGER` revoke migration and pinning `search_path` on
   `complete_onboarding()`, `player_rank_tier()`, `set_updated_at()`.
5. Consider moving the ASC Issuer/Key IDs out of `docs/DISTRIBUTION.md` into the runner's
   environment documentation — harmless today, but there is no benefit to publishing them.
