# Pickle Sensei — Security Certification (2026-08-30)

Scope: the Supabase deployment (Postgres/RLS, Edge Function `api`, Auth), the
Fastify backend (`services/api`), the React Native app, CI/CD, secrets, and
dependencies — audited as a production system facing hostile clients, replayed
requests, compromised accounts, abusive automation, and leaked credentials.

This document records what was **verified by execution or direct inspection**,
what was fixed, and what remains open. Nothing here claims the system is
"unhackable" or "100% secure" — no such claim is possible. It records which
release gates are satisfied by evidence and which are not.

---

## Verdict

**NO-GO — SECURITY BLOCKERS REMAIN** for a full production release.

All _code-level_ release gates are satisfied (see the gate table). The NO-GO is
driven by **externally verifiable configuration and architecture items that
cannot be confirmed or fixed from this repository**:

1. **B-1 (P0, external): Supabase Dashboard configuration is unverified.**
   Auth provider allowlists (Google/Apple client IDs), redirect URLs, storage
   bucket privacy, exposed-schema list, and Auth rate limits live in the
   Dashboard, not in migrations. The repo's own docs require manual setup
   (`supabase/README.md`). Until someone with Dashboard access confirms:
   no storage buckets exist (or all are private), the exposed schema list is
   `public` only, and the Google/Apple providers restrict `aud` to the two
   client IDs in `apps/mobile/src/config/runtimeConfig.ts`, cross-user media
   exposure cannot be ruled out.
2. **B-2 — RESOLVED IN CODE (verification pending against a live Supabase
   project): revocable Supabase-session bearers.** The provider ID token is
   now spent exactly once: `/v1/account/bootstrap` exchanges it via
   `signInWithIdToken` and returns a Supabase session (short-lived access
   token + rotating refresh token). Every other endpoint accepts only the
   Supabase access token (provider tokens are explicitly rejected with a
   pointer to bootstrap); `/v1/auth/refresh` rotates the session and
   `/v1/auth/logout` revokes all refresh tokens server-side (global scope).
   Sign-out in the app calls the logout endpoint before clearing memory. A
   stolen access token now dies within the access-token TTL after revocation
   (configure a short JWT expiry in the Dashboard — see manual actions), and
   a stolen refresh token is dead immediately. Remaining before this can be
   marked verified: exercise bootstrap/refresh/logout against a live
   Supabase project with a real Google ID token.
3. **B-3 (P1, external): production credential rotation is unexercised.**
   No production secrets exist in the repo (verified — see Secrets), but there
   is also no evidence a rotation of the Supabase service keys / OAuth client
   secrets has ever been performed. The runbook below defines the drill; it
   must be executed once before release.

When B-1 is confirmed, B-2's live verification is performed, and B-3 is
executed by the owner, the code-level posture supports **GO**.

---

## Threat model (summary)

| Actor                                      | Reachable surface                 | Primary control                                                                                                                                          | Verified by                                                         |
| ------------------------------------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Anonymous attacker                         | Edge Function, Supabase REST      | 401 before routing; anon role has zero table grants                                                                                                      | RLS matrix case C; Edge Function `authenticate()` gates every route |
| Malicious authenticated user               | Own row-space                     | Owner-only RLS + column-level grants; append-only ledgers                                                                                                | RLS matrix cases B, D, E                                            |
| Compromised account                        | Same as above + victim's own data | Blast radius = one user's rows; no lateral movement (case B)                                                                                             | RLS matrix                                                          |
| Replayed/modified client                   | Edge Function                     | Server recomputes/validates everything; idempotent writes; score/version columns not client-writable                                                     | Case E; Edge Function batch caps (200)                              |
| Abusive automation                         | Edge Function, services/api       | Per-user/per-IP limiter (Edge), route-tiered limiter (`rateLimitPlugin.ts`), 1 MiB body cap, DB payload CHECKs                                           | Code + case F                                                       |
| Leaked publishable key                     | Supabase REST                     | Publishable key grants only `anon` — which has no table access                                                                                           | Case C                                                              |
| Leaked service-role key                    | Everything                        | Key is not in the repo, mobile bundle, or Edge Function (verified); Dashboard custody is B-1                                                             | Secret scan                                                         |
| Malicious/compromised admin (services/api) | Admin routes                      | `pickle_role=admin` is server-asserted via OIDC claims, never client-writable; all admin routes behind `requireAdmin`                                    | Route inventory                                                     |
| Hostile uploaded media                     | media-worker                      | Out of scope for the Supabase deployment (no storage routes exist in the Edge Function — verified); services pipeline validates type/size and is bounded | Route inventory                                                     |

Assets: accounts, profile data, shot/score history, consent history, rank
state, analysis permits, API capacity. Trust boundaries: iOS app (untrusted),
Supabase Auth (verifier), Postgres (RLS-authoritative), Edge Function
(anon key + user session only), services/api (OIDC-verified).

---

## Release gates — evidence table

| Gate                                    | Status            | Evidence                                                                                                                                                                                          |
| --------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No cross-user data exposure             | PASS (code)       | RLS regression matrix B1–B4 executed green (`supabase/tests/`); every table RLS-enabled with owner-only policies                                                                                  |
| No service-role key in client/edge code | PASS              | Edge Function uses `SUPABASE_ANON_KEY` + user session only; repo+history scan found no service key                                                                                                |
| No authentication bypass                | PASS (code)       | Every Edge route authenticates before routing; services/api routes inventoried — all `/v1/*` behind `authenticate`/`requireAdmin` except catalog reads and signature-verified webhooks            |
| No RLS bypass via definer functions     | PASS              | All `SECURITY DEFINER` functions pin `search_path=''`; client EXECUTE revoked; views are `security_invoker`                                                                                       |
| No public bucket for private media      | UNVERIFIED — B-1  | No buckets defined in repo; Dashboard state unknown                                                                                                                                               |
| No client-controlled admin              | PASS              | Admin role only from verified OIDC claim (`services/api/src/auth/tokens.ts`); Supabase deployment has no admin surface                                                                            |
| Consent history tamper-proof            | PASS              | Append-only enforced at grant, policy AND trigger layer (case D1–D3); deletion cascade still works (D4)                                                                                           |
| No IDOR/BOLA on core APIs               | PASS (code)       | All Edge queries filter by the RLS session user; services/api ownership in SQL (`WHERE user_id=$me`); UUID possession never grants access                                                         |
| No unbounded expensive public endpoint  | PASS              | 401 before any DB work; per-IP limit on failed auth; batch caps (200); 1 MiB body cap; DB-level payload CHECKs                                                                                    |
| No committed production secret          | PASS              | Full-history Gitleaks: 503 findings, all classified false-positive (dataset `sessionKey` corpus IDs, labeled test-only HS256 strings, Podfile.lock checksums, a public product-key constant)      |
| No major exploitable dependency         | PASS w/ note      | Workspace `pnpm audit`: 0 known vulns. Mobile: 9 "high" all chain to image-size GHSA-w3rx-r6r6-pgpr — dev-time Metro bundler only, no fixed release exists, not present in the shipped app binary |
| Token revocability                      | PASS (code) — B-2 | Bearer is a short-lived Supabase access token; logout revokes all refresh tokens (global scope); provider ID tokens accepted only by bootstrap; live-project verification pending                 |

---

## What was fixed in this change

### Database (`supabase/migrations/20260830000000_security_hardening.sql`)

- **Column-level UPDATE grants**: clients can no longer modify score history,
  model-version provenance, identity columns (`user_id`, `email`), or
  bookkeeping timestamps — even in their own rows. Editable surface per table
  is now exactly what the app edits.
- **Write-once evidence**: `shot_phases` / `shot_measurements` /
  `shot_checkpoints` lose client UPDATE/DELETE.
- **Trigger-enforced append-only ledgers**: `consent_records`,
  `evaluation_trials`, `analysis_feedback` reject UPDATE/DELETE for _every_
  role (defense against future accidental grants); account-deletion cascades
  still pass.
- **`user_id NOT NULL`** on all ledgers (no owner-less rows invisible to
  every policy).
- **Payload size CHECKs** on every client-writable text/jsonb column
  (anti blob-storage abuse), and a strict slug format for saved drills.
- **Explicit anon/public revokes** on derived views and trigger functions.

### Edge Function (`supabase/functions/api/index.ts`)

- **Error redaction**: raw Postgres/auth error strings no longer reach
  clients; they go to function logs, clients get an opaque retryable 503.
- **Rate limiting**: per-user (120/min) and per-IP-on-auth-failure (30/min).
- **Request body cap** (1 MiB) before parsing.
- **Revocable session bearers (B-2 fix)**: `/v1/account/bootstrap` is the
  only route that accepts a provider ID token; it performs the one-time
  `signInWithIdToken` exchange and returns the Supabase session. All other
  routes require the Supabase access token, verified via `auth.getUser`
  (bounded ≤1 min cache). New `/v1/auth/refresh` (rotates the session) and
  `/v1/auth/logout` (revokes all refresh tokens, global scope).

### CI (`.github/workflows/ci.yml`)

- **`permissions: contents: read`** — least-privilege workflow token.
- **New `supabase-security` job** runs the full RLS regression matrix on
  every PR: any future policy/grant/trigger regression fails CI.

### Regression tests (`supabase/tests/`)

- `run_rls_tests.sh` + `shim_auth.sql` + `security_regression.sql`: 20+
  executable cases across owner access, cross-user denial, anon denial,
  append-only integrity, column grants, payload caps, and privileged
  functions. Run locally verified green.

---

## Audit notes by area

**Supabase migrations** — all 16 client-reachable relations RLS-enabled,
owner-only policies, definer functions pinned; validated by applying all six
migrations to a clean Postgres 15 and running the matrix.

**Edge Function** — no service key; provider tokens verified by Supabase Auth
(`signInWithIdToken`) at bootstrap only; access tokens verified by
`auth.getUser`; JWT payload decode used for issuer routing/rejection only; all
queries run under the user's RLS session; UUID/enums validated; consent is
grant/withdraw append rows folded server-side; batch writes capped at 200.

**services/api** — OIDC verify (issuer/audience/signature/exp/JWKS), dev
HS256 constructible only in dev/test; all routes behind
`authenticate`/`requireAdmin` except public catalog reads and webhooks
(timing-safe authorization compare); ownership enforced in SQL; parameterized
queries throughout; route-tiered in-process rate limiter with bounded store.

**Mobile** — bearer/session material (access + refresh token) in memory only
(never SQLite, AsyncStorage, logs); background refresh rotates the access
token before expiry; sign-out calls `/v1/auth/logout` (server-side
revocation) before clearing memory; no secret logging found; config contains
only public identifiers (Supabase URL, OAuth client IDs, RC public SDK keys).
Tokens are lost on restart (UX, not security — Google restores silently).

**Secrets** — full-history Gitleaks scan (278 commits): 503 findings, 100%
classified benign (see gate table). No rotation required.

**CI/CD** — no `pull_request_target`, no secrets exposed to PR code, actions
are official `actions/*`+`pnpm/action-setup` (tag-pinned; SHA-pinning is a
worthwhile follow-up), token now read-only.

---

## Incident runbook (credential leakage / account compromise)

1. **Supabase service or anon key leaked**: Dashboard → Settings → API →
   rotate keys; redeploy the Edge Function (picks up new env); mobile clients
   are unaffected (they never hold Supabase keys — the URL+publishable key are
   public by design and grant nothing without RLS).
2. **OAuth client secret leaked**: rotate in Google Cloud Console / Apple
   Developer; update the Supabase Auth provider config; provider ID tokens
   die at natural expiry (~1 h) but they only grant bootstrap — application
   sessions are killed independently via refresh-token revocation.
3. **Account compromise**: delete or suspend the user in Supabase Auth (this
   revokes their refresh tokens); the stolen access token dies at its TTL;
   RLS confines the attacker to that user's rows until then; the append-only
   ledgers preserve the tamper-evident history.
4. **Data-layer regression suspected**: run
   `./supabase/tests/run_rls_tests.sh` — it reproduces the entire boundary
   matrix against the current migrations in ~1 minute.

## Manual actions required (owner)

- [ ] B-1: verify Dashboard config (providers restricted to the two client
      IDs, exposed schemas = `public`, no public buckets, Auth rate limits on).
- [ ] B-3: perform one full key-rotation drill using the runbook above.
- [ ] B-2: verify the new bootstrap/refresh/logout flow against a live
      Supabase project with a real Google ID token, and set a short access
      token JWT expiry (Dashboard → Auth → Sessions; e.g. 10–15 min) so a
      stolen access token dies quickly after revocation.
- [ ] Follow-up hardening (non-blocking): SHA-pin GitHub Actions; add
      Gitleaks + `pnpm audit` as CI jobs.
