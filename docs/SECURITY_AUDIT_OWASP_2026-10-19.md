# Pickle Sensei — OWASP Top 10 audit (2026-10-19)

Scheduled whole-app review of `main` @ `c7a20769d9b617645c03ecfd62ac77f1f75008df`:
the iOS client (`apps/mobile`), the Supabase backend (Edge Function
`supabase/functions/api`, migrations/RLS, auth + storage configuration), the
RevenueCat / App Store payment integration, and the legacy Fastify service
(`services/api`, not deployed — the app only calls the Edge Function).
Method: manual source review against OWASP Top 10 (2021) plus the repository's
own regression gates. Supersedes nothing; complements
`docs/SECURITY_CERTIFICATION_2026-08-30.md`, whose external items (B-1
Dashboard verification, B-3 rotation drill) are still the open manual gates.

**Headline: no code-level vulnerability that could be fixed without a product
decision was found. No behaviour was changed by this audit.** Three findings
need an owner decision (§3); the rest is confirmation evidence (§2) and the
exact gate results (§4), including the gates that could NOT run in this
environment.

Severity scale: Critical / High / Medium / Low / Info (CVSS-like, judged on
exploitability from an App Store build without developer credentials).

## 1. Scope and what was examined

| Surface                        | Where                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Edge Function routes + helpers | `supabase/functions/api/{index,http,legal,cache,rateLimit,drills,drillMedia,accountDeletionOperations}.ts`                                  |
| Database                       | all `supabase/migrations/*.sql` (36 RLS-enabled tables, grants, RPCs, triggers) + `supabase/tests/*`                                        |
| Supabase config in repo        | `supabase/config.toml`, `supabase/README.md`                                                                                                |
| Mobile client                  | `apps/mobile/src/{billing,state,account,api,training,components,screens,config}`, `ios/PickleSensei/Info.plist`                             |
| Payments                       | `verifyRevenueCatSubscriber`, `POST /webhooks/revenuecat`, `billing_entitlements`, `webhook_events`, mobile `accessStore`/`membershipState` |
| Hosted web surfaces            | `GET /privacy`, `/terms`, `/support`, `/healthz` (Edge Function); `apps/admin-web` (local dev console only)                                 |
| Legacy server                  | `services/api/src` (Fastify: app bootstrap, auth plugin, admin/billing/shots routes)                                                        |

Not in the repository and therefore **not verifiable here**: Supabase
Dashboard settings (Auth providers + audiences, redirect URLs, Auth rate
limits, exposed schemas, storage buckets), RevenueCat project configuration
(which apps/stores feed the `pickle_sensei_pro` entitlement), App Store Connect
server-notification settings. See §3 and §5.

## 2. Findings by OWASP category

### A01 Broken Access Control — PASS with one decision item (§3.1)

- Every `/v1/*` route runs after `authenticate()` (one dispatcher in
  `index.ts`; public routes are only `GET /healthz|/support|/privacy|/terms`
  and the secret-gated `POST /webhooks/revenuecat`). Per-user rate limits are
  keyed by the verified `auth.uid()`, never by a client-supplied id.
- Database access from the function is a **user-scoped** PostgREST client
  (anon key + the user's access token) through `isSupabaseEndpointRequest`;
  RLS applies to every read/write. The restrictive `api_requests_only`
  policy (`20260905190106_api_only_database_access.sql`) additionally
  refuses any `authenticated` request that does not carry the server-held
  `x-pickle-api-key`, so a stolen access token cannot query PostgREST
  directly.
- All 36 public tables have RLS enabled; owner policies are
  `(select auth.uid()) = user_id` (or equivalent via the owning row).
  Service-owned tables (`billing_entitlements`, `webhook_events`,
  `free_rating_ledger`, `api_private.*`, audit/deletion checkpoints) have **no
  client policies and no client grants**. Column-level UPDATE grants are sized
  to the exact writes the function performs (`20260831160000_defense_in_depth.sql`).
- Entitlement (`pickle_sensei_pro`) cannot be unlocked client-side: the app
  derives premium only from the server `access_state()` / `/v1/billing`
  verdict (`apps/mobile/src/billing/membershipState.ts`,
  `state/accessStore.ts` — local RevenueCat `customerInfo` never unlocks), and
  the server verdict is computed from RevenueCat's REST API
  (`verifyRevenueCatSubscriber`), never from the request body or the webhook
  body. Scored-shot writes are gated by `reserve_analysis_permit()` /
  `enforce_scored_shot_permit()` under `access_lock_key(uid)`.
- Service-role key (`SUPABASE_SERVICE_ROLE_KEY`) is used only by
  `billingAdminDb()` for billing/webhook/audit rows, encrypted Apple-token
  storage, external-deletion checkpoints, Auth admin `deleteUser`/user lookup,
  and the `/healthz?readiness=1` RPC probe. No user-data path uses it.
- Evidence: `./supabase/tests/run_rls_tests.sh` PASS (§4).

### A02 Cryptographic Failures — PASS

- Only HTTPS endpoints anywhere (`runtimeConfig.ts` API base is
  `https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api`; no
  non-local `http://` in mobile source). `Strict-Transport-Security` set on
  all function responses.
- iOS ATS: `NSAllowsArbitraryLoads=false`; `NSAllowsLocalNetworking=true` is
  the React Native template default (Metro) — Info only.
- Refresh token stored in Keychain (`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`);
  access/provider tokens are memory-only; SQLite kv holds no session material.
  Apple refresh tokens at rest are encrypted with `APPLE_TOKEN_ENCRYPTION_KEY`.
- Webhook secret compared with `constantTimeEqual`.

### A03 Injection — PASS

- No string-built SQL anywhere: the Edge Function uses PostgREST builders and
  RPCs; migrations use `format('%I')` for identifiers; the legacy Fastify
  service uses `$n` parameters throughout (`services/api/src/modules/**`).
- PostgREST keyset `.or()` filters built from DB row values are quoted and
  escaped (`postgrestFilterValue`), column names regex-validated.
- No `child_process`/`Deno.Command`/`eval`/`new Function`; no template
  engines. Path segments go through `decodePathSegment` (400 on malformed
  escapes); bodies are size-capped and must be JSON objects (`readBody`);
  free text is sanitized (`sanitizeUserText` strips control/bidi chars).
- Fastify rejects NUL bytes in URLs before routing.

### A04 Insecure Design — PASS

- Fail-closed defaults: webhook returns 503 when `REVENUECAT_WEBHOOK_AUTH` is
  unset; billing returns 503 `billing_unconfigured` without an RC key;
  malformed RevenueCat payloads yield "unavailable", never a negative verdict
  that could revoke membership; permits/free-allowance are enforced in SQL
  under advisory locks.
- Rate limits: per-IP pre-auth, auth-failure budget, per-route/per-user
  budgets, public-page and webhook budgets (`rateLimit.ts`), 413 on oversized
  bodies.

### A05 Security Misconfiguration — PASS with decision items (§3.2, §3.3)

- Headers on every function response: `Content-Security-Policy: default-src
'none'; frame-ancestors 'none'`, `X-Frame-Options: DENY`, HSTS,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`;
  `Cache-Control: no-store` on JSON. **No CORS headers are emitted** — the API
  is native-only, so browsers get no cross-origin read access. No cookies are
  used anywhere (bearer tokens only).
- `verify_jwt = false` in `supabase/config.toml` is intentional
  (`/v1/account/bootstrap` accepts provider ID tokens and verifies them via
  Supabase Auth `signInWithIdToken`; every other route verifies the Supabase
  access token with `auth.getUser`).
- `/healthz?readiness=1` performs an unauthenticated (rate-limited) DB probe
  and returns only `{ok, readiness.database}` — Info.
- 5xx bodies are generic; detail only in function logs.
- Supabase **Auth configuration is Dashboard-only** (config.toml has no
  `[auth]` section) — see §3.3.
- No Supabase Storage usage exists in the codebase (no `storage.*` policies
  or `storage.from()` calls); any bucket in the project would be
  Dashboard-created and unreviewed — see §3.3.

### A06 Vulnerable and Outdated Components — PASS (static)

- Edge dependency pinned exactly (`npm:@supabase/supabase-js@2.112.4`,
  `deno.lock`, static pin test). `pnpm-lock.yaml` and
  `apps/mobile/package-lock.json` committed. Dependency-advisory scanning
  (`npm audit`/`pnpm audit`) could not run (registry blocked in this
  environment) — see §4.

### A07 Identification and Authentication Failures — PASS with decision item (§3.2)

- `authenticate()` verifies bearer issuers (Google/Apple/Supabase only),
  rejects expired tokens before any network call, verifies Supabase sessions
  with `auth.getUser`, checks the provider identity link and the per-session
  revocation fence (`is_api_session_active`), caches only _verified_
  sessions keyed by token hash.
- Bootstrap, refresh and logout have dedicated budgets; 401s charge the
  per-IP auth-failure budget.
- Transitional acceptance of raw provider ID tokens remains (documented in
  `AGENTS.md`) — §3.2.

### A08 Software and Data Integrity Failures — PASS

- RevenueCat webhook: shared-secret `Authorization` header checked in constant
  time (RevenueCat does not offer HMAC signatures — the shared secret is the
  vendor mechanism); event ids reserved via RPC before processing (replay
  safe); entitlement state is **re-fetched from RevenueCat**, never trusted
  from the event; every event audited in `webhook_events`.
- App Store Server Notifications: **no endpoint exists in this codebase**;
  App Store notifications are consumed by RevenueCat, which is the only
  entitlement source of truth for the server. Confirm in App Store Connect
  that the production/sandbox notification URL points at RevenueCat (§5).
- Settlement receipts for scored shots are bound and verified
  (`20260908110000`, `shot.receipt_invalid` / mismatch codes).

### A09 Security Logging and Monitoring Failures — PASS

- Auth refusals, rate-limit trips, webhook processing, billing failures and
  account-deletion checkpoints are logged with typed codes; no bearer tokens,
  secrets or request bodies are logged (grep of `console.*` in
  `supabase/functions/api` and `apps/mobile/src`).

### A10 Server-Side Request Forgery — PASS

- Every outbound `fetch` target is fixed: Supabase REST/Auth (guarded by
  `isSupabaseEndpointRequest`, `redirect: "error"`), `api.revenuecat.com`,
  `appleid.apple.com`, Upstash URL from env. No request-controlled URL is
  fetched. Mobile `Linking.openURL` targets are static legal/App Store URLs
  or catalog media whose URLs are server constants (`drillMedia.ts`) and are
  re-validated as HTTPS on the client (`training/api.ts isHttpsUrl`); the
  in-app WebView (`DrillVideoPlayer.shouldLoadInPlayer`) allows only HTTPS
  playback hosts.

### XSS / hosted pages

- `/privacy`, `/terms`, `/support` are **plain text** (`text/plain;
charset=utf-8`, `nosniff`, CSP `default-src 'none'`) built from compile-time
  constants in `legal.ts`; no request data is interpolated. Nothing in the
  function emits HTML. `apps/admin-web` is a local dev console (Vite
  `localhost:5173`, not deployed); it has no `dangerouslySetInnerHTML`/`innerHTML`
  and no CSP meta tag (Info — add one if it is ever hosted).

## 3. Findings that need a product / operations decision (not changed)

### 3.1 Sandbox / Test Store entitlements count as production membership

- **OWASP:** A01 Broken Access Control (also A04). **Severity:** High _if_
  the RevenueCat project exposes `pickle_sensei_pro` to the Test Store app;
  Medium otherwise (Apple sandbox only — requires a developer-provisioned
  Sandbox Apple Account).
- **Where:** `verifyRevenueCatSubscriber` (`supabase/functions/api/index.ts`
  ~L3634–3730) folds every active entry of `subscriber.entitlements` into the
  verdict without consulting the backing subscription's `store` or
  `is_sandbox`. The same verdict feeds both `/v1/billing` sync and the
  webhook path.
- **Why it matters:** the Android build ships a RevenueCat **Test Store**
  public key (`test_…`, `apps/mobile/src/config/runtimeConfig.ts`), so a Test
  Store app exists for this product. Whether it lives in the SAME RevenueCat
  project as the iOS App Store app (and therefore shares the subscriber and
  the `pickle_sensei_pro` entitlement) cannot be determined from the repo:
  `AGENTS.md` is inconsistent about the server fallback key — the Deploy
  section says `REVENUECAT_PUBLIC_SDK_KEY` is "currently set to the Test
  Store key" while the Billing section says it "holds the PRODUCTION App
  Store public key (`appl_…`) as of 2026-09-01"; the deployed secret is not
  visible here. Test Store purchases are free and need no payment
  credentials; public SDK keys are, by design, extractable from any build. If
  the Test Store app shares the project and its products are attached to
  `pickle_sensei_pro`, anyone who logs the RC SDK in with their own canonical
  account id (returned to them by `/v1/account/bootstrap`) and "buys" a Test
  Store product receives server-verified premium. The code gap (no
  `store`/`is_sandbox` check) is certain; the exploitability depends on that
  project configuration.
- **Decision needed:** (a) confirm in the RevenueCat dashboard whether the
  Test Store app is in the production project and whether its products map to
  `pickle_sensei_pro`; if so detach them or move Test Store to a separate
  project, and reconcile the two `AGENTS.md` statements about
  `REVENUECAT_PUBLIC_SDK_KEY` with the deployed value; (b) decide whether the server should
  ignore entitlements whose backing `subscriptions[product].store` is
  `test_store` and/or `is_sandbox === true` in production. Rejecting
  `is_sandbox` would break the documented dev/TestFlight sandbox flow
  (`AGENTS.md` "Decision 2026-09-02"), so this must not be changed silently.
  A code change here is small (one filter in the entitlement fold + fixtures
  in `__wf__/billing_provider_shapes.test.ts`) once the policy is chosen.

### 3.2 Transitional provider-ID-token bearer branch

- **OWASP:** A07. **Severity:** Low. `authenticate()` still accepts a raw
  Google/Apple ID token as the bearer for pre-2026-09-01 app builds; each
  such request performs `signInWithIdToken` (cached ~10 min). It widens the
  accepted credential types and keeps Supabase Auth in the hot path for old
  clients. `AGENTS.md` already schedules removal "once none are in the
  field". **Decision:** confirm no pre-contract builds remain in the field
  (App Store Connect version adoption), then remove the branch and its tests.

### 3.3 Dashboard-only controls remain unverified from the repo

- **OWASP:** A05. **Severity:** Medium (unchanged from B-1 in
  `docs/SECURITY_CERTIFICATION_2026-08-30.md`). Not representable in git:
  Supabase Auth provider allowlists and the Google/Apple audience (client-id)
  checks that `signInWithIdToken` relies on, redirect URLs, Auth rate limits,
  `exposed schemas` (should be `public` only — `api_private` must not be
  exposed), storage buckets (should be none / private), and the RevenueCat
  webhook URL + Authorization value. **Decision:** run the B-1 checklist
  against project `ucqnaiwqwjtgvlduiuib` and record the result (owner-only;
  cannot be done from CI).

### 3.4 Public-SDK-key fallback for server verification (Info)

- `verifyRevenueCatSubscriber` and the billing sync fall back to
  `REVENUECAT_PUBLIC_SDK_KEY` when `REVENUECAT_SECRET_API_KEY` is unset.
  RevenueCat still authenticates the request and returns the real subscriber,
  so integrity holds, but the fallback hides a missing production secret.
  Suggest requiring the secret key in production (fail 503) — ops decision.

## 4. Verification run for this audit (exact commands and results)

Environment: Devin cloud VM, Linux 6.8 x86_64, Node v24.19.0, pnpm 10.15.1,
Deno 2.9.7, Docker 29.7. **Outbound network was restricted to
`git-manager.devin.ai`**; the gates below that need a registry/Docker Hub/
GitHub download could not run and are listed honestly as NOT RUN.

| Command                                                             | Result                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                                                 | PASS ("All matched files use Prettier code style!")                                                                                                                                                                                            |
| `pnpm lint`                                                         | PASS (eslint ., no findings)                                                                                                                                                                                                                   |
| `pnpm typecheck` (= `pnpm build`)                                   | PASS (all workspace projects)                                                                                                                                                                                                                  |
| `./supabase/tests/run_rls_tests.sh`                                 | PASS (security_regression, account_deletion_operations, analysis_release_policy; fresh + both historical upgrade paths). Ran against the locally cached `postgres:16-alpine` image tagged as `postgres:16` because Docker Hub was unreachable. |
| `scripts/verify-cloud.sh --only test,db,ml,scripts`                 | test PASS (197 s), db PASS, ml PASS, scripts **unavailable** (needs the `bash:3.2` Docker image — not pullable here)                                                                                                                           |
| `(cd supabase/functions/api/__wf__ && deno task test)`              | **NOT RUN** — Deno could not fetch `npm:`/`jsr:` dependencies (`registry.npmjs.org` blocked)                                                                                                                                                   |
| `cd apps/mobile && npm ci && npx tsc --noEmit && npx jest --silent` | **NOT RUN** — `apps/mobile/node_modules` absent and registry blocked                                                                                                                                                                           |
| `scripts/security-scan.sh` (gitleaks 8.30.1)                        | **NOT RUN** — pinned binary download from GitHub blocked                                                                                                                                                                                       |
| `pnpm audit` / `npm audit`                                          | **NOT RUN** — registry blocked                                                                                                                                                                                                                 |

No source file other than this document changed, so the NOT RUN gates are
unaffected by this PR; CI (`scripts/verify-cloud.sh --tier pr`) runs all of
them on the PR itself.

## 5. Recommended follow-ups (owner)

1. §3.1: audit the RevenueCat project (Test Store ↔ `pickle_sensei_pro`
   mapping) today; then choose the server policy on `store`/`is_sandbox`.
2. §3.3: complete and record the B-1 Dashboard checklist; confirm App Store
   Connect → App Information → App Store Server Notifications points at
   RevenueCat's URL (production and sandbox).
3. §3.2: remove the transitional provider-token branch once adoption data
   allows.
4. §3.4: set `REVENUECAT_SECRET_API_KEY` in production and consider dropping
   the public-key fallback.
