---
name: test-authentication
description: Verify Pickle Sensei's sign-in/session contract end to end without live provider credentials — mobile durable-session suites (Keychain vault, refresh rotation, sign-out), edge-function auth routes (bootstrap/refresh/logout, session cache, rate limits), and the Supabase RLS matrix that pins per-user data isolation. Use whenever touching authStore, sessionVault, sessionKeeper, authenticate(), /v1/account/bootstrap, /v1/auth/*, Supabase auth config, RLS, or when an auth/sign-out bug is reported.
---

# Testing authentication

Contract (AGENTS.md "Auth sessions"): `POST /v1/account/bootstrap` spends the
Apple/Google ID token once (`signInWithIdToken`) and returns a Supabase
session; every other route takes the Supabase ACCESS token as bearer;
`POST /v1/auth/refresh` rotates; `POST /v1/auth/logout` revokes this device
only. Mobile keeps only `{provider, canonical id, refreshToken, email,
displayName}` in the Keychain (`src/account/sessionVault.ts`); the access
token is never persisted; closing the app must NEVER sign out; the one
implicit sign-out is the server refusing the refresh token (401/403).

Sign-in is Apple/Google only. There is no password login and no "guest
mode" wording anywhere user-facing.

## Deterministic suites (run all three; each is a gate)

1. Mobile — the pinned behaviour lives in these suites (run from `apps/mobile`, npm not pnpm):
   ```bash
   cd apps/mobile
   npx jest --ci __tests__/authDurableSession.test.ts __tests__/authHydrateRestore.test.ts \
     __tests__/authStore.test.ts __tests__/accountBootstrap.test.ts \
     __tests__/wf/be-auth-session-lifecycle.test.ts __tests__/wf/flow-sign-in-auth.test.tsx \
     __tests__/wf/SignInScreen.buttons.test.tsx __tests__/wf/be-mobile-security-secrets.test.ts \
     __tests__/launchGate.test.ts __tests__/onboardingScreen.test.tsx
   ```
   `authDurableSession.test.ts` covers: Apple/Google sign-in persists only
   refresh token + descriptor; relaunch restores from Keychain with one
   refresh; offline / 5xx refresh keeps the user signed in; only 401/403
   signs out; malformed vault record is discarded; explicit sign-out clears
   Keychain and revokes server-side; long-lived clients resolve the current
   bearer via `bearerTokenFor(canonicalAppUserId)`.
2. Edge function (Deno, no network):
   ```bash
   cd supabase/functions/api/__wf__ && deno task test
   ```
   Relevant files: `account_routes.test.ts` (bootstrap/refresh/logout,
   deletion challenge), `auth_session_cache_test.ts` (verified-session cache
   keyed by token hash), `index_preauth_test.ts` (expired provider token
   refused pre-verification, 413 caps, webhook secret), `rateLimit*.test.ts`
   (per-IP pre-auth + auth-failure budgets → 429/Retry-After),
   `account_external_cleanup.test.ts` (Apple revocation on deletion).
   Then `deno check cache.ts rateLimit.ts http.ts legal.ts` (index.ts has
   known pre-existing untyped-client errors — not a regression signal).
3. Database isolation — the RLS/security regression matrix (Docker postgres:16):
   ```bash
   ./supabase/tests/run_rls_tests.sh
   ```
   Applies every migration, then `supabase/tests/security_regression.sql`
   asserts allowed AND denied paths (owner rows, anon revokes, append-only
   ledgers, column grants, free-rating identity ledger J1–J9).

Or all at once: `scripts/verify-cloud.sh --only mobile,edge,rls`.

## Adding coverage for an auth change

- Mobile behaviour → extend `__tests__/authDurableSession.test.ts` (it has
  the Keychain/SDK/fetch harness); do not create a parallel harness.
- Route behaviour → `__wf__/account_routes.test.ts` using `routesHarness.ts`
  / `supabase_stub.ts`.
- Any new table/column/policy → a NEW migration + assertions in
  `security_regression.sql` (never edit an applied migration).
- If a client-side column write is added, extend the column-level UPDATE
  grant in a new migration or production returns 42501 → 503.

## Live verification (only when a real device/simulator run is required)

Real Apple/Google sign-in needs a device or the iOS Simulator on the M4
runner with a Sandbox Apple Account — it cannot run on Linux and must not
use the user's personal account. Route through `macos-verification`; the
launch check proves the app boots signed-out without crashing, which is the
deterministic floor. Anything beyond (tapping Sign in with Apple) is a human
step on the Mac.

## Failure signals and where to look

- "signed out after relaunch" → hydrate order in `authStore.hydrate()`
  (vault first, refresh ≤ 8 s, proceed signed in), `sessionKeeper.ts`
  foreground re-check; the suite `relaunch (hydrate) with a persisted
session` reproduces it.
- 401 storms → `rateLimit.ts` auth-failure budget; check the edge logs
  (`supabase functions logs api` requires the linked project — human/CLI
  auth) before changing budgets.
- 503 on a user write → 42501 from a missing column grant; see
  `20260831160000_defense_in_depth.sql`.

## Forbidden

- Persisting the access token or provider token anywhere on device.
- Weakening `authenticate()` (e.g. accepting unverified tokens) to make a
  test pass; the transitional raw-provider-token branch is to be REMOVED,
  not extended.
- Adding user INSERT/UPDATE policies on `public.billing_entitlements`.
- Testing against the production Supabase project with real accounts.
