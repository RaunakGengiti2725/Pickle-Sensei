# Pre-launch checklist

Repeatable go/no-go list for every production release. Items marked ✅ are
implemented/verified in the codebase as of 2026-08-30 (scale + security
hardening wave); items marked ☐ are the manual steps to re-run before each
release. Evidence pointers reference the code so re-verification is fast.

## 1. Secrets & key hygiene

- ✅ No secret keys in the repo — scan run for Supabase service/secret keys,
  Stripe-style keys, AWS keys, private key blocks, JWTs. Client code ships
  only PUBLIC values (RevenueCat public SDK key, Google OAuth client IDs) in
  `apps/mobile/src/config/runtimeConfig.ts`.
- ✅ `.env*` files are gitignored; `supabase/.temp/` ignored too.
- ☐ Re-run the scan before release:
  `rg -n "sk_live|service_role|AKIA[0-9A-Z]{16}|BEGIN (RSA |EC )?PRIVATE KEY|sbp_" --glob '!node_modules'`
- ☐ Rotate `REVENUECAT_SECRET_API_KEY` / `REVENUECAT_WEBHOOK_AUTH` if anyone
  who had access leaves the project.
- ☐ Swap the RevenueCat TEST key (`test_…`) for `appl_…`/`goog_…` in
  `runtimeConfig.ts` before store submission (see AGENTS.md → Billing).

## 2. Database security (Supabase)

- ✅ RLS enabled on EVERY table; owner-only policies (`auth.uid() = user_id`)
  on all user tables (`20260829120000`, `20260829140000`, `20260829150000`,
  `20260830120000`, `20260831000000` migrations).
- ✅ Append-only ledgers (`consent_records`, `evaluation_trials`,
  `analysis_feedback`) have NO update/delete policies or grants.
- ✅ `billing_entitlements` writable ONLY by the service role (verified
  RevenueCat paths); users can read their own row, never write.
- ✅ `webhook_events` service-role only (RLS on, zero policies, zero grants).
- ✅ `anon` revoked on all tables AND the derived views
  (`progress_daily`, `practice_days`, `player_technique_rating`).
- ✅ SECURITY DEFINER functions pin `search_path`; `recompute_player_rank`
  not executable by clients; RPCs (`access_state`, `apply_synced_shot`) are
  SECURITY INVOKER (RLS applies) and granted to `authenticated` only.
- ✅ No storage buckets exist (no cloud media). ☐ If a bucket is ever added:
  private by default + owner-scoped storage policies + size/MIME limits.
- ☐ Spot-check as anon + as user B against user A's rows after schema
  changes (PostgREST: expect empty/permission errors).

## 3. API security & robustness (Edge Function `api`)

- ✅ Rate limiting on every route: per-IP pre-auth budget, auth-failure
  budget (token stuffing gets blocked before Supabase Auth), per-user
  budgets per route family, strict budgets on billing sync / shots sync /
  trials / consent / account deletion. 429 + `Retry-After` (the mobile
  outbox treats 429 as retryable).
- ✅ Server-side validation on every write (shape, enums, UUIDs, ranges,
  length caps); request bodies size-capped; per-trial payload cap mirrored
  by a DB CHECK constraint.
- ✅ User text sanitized before storage (control/zero-width/bidi characters
  stripped — XSS/spoofing defense in depth; RN renders via `<Text>`, and the
  only HTML surfaces are the static, CSP-locked legal pages).
- ✅ 5xx responses never leak internals (DB errors logged server-side only);
  security headers on all responses (nosniff, no-store; CSP/X-Frame-Options
  on HTML).
- ✅ No admin routes exist; the only privileged paths (billing verdict,
  webhook log, account deletion) run server-side behind verification.
- ✅ Graceful DB-down behavior: every query error → generic 503 the app maps
  to a retryable state; the outbox keeps local ratings until accepted.
- ☐ After deploy: `curl $BASE/healthz`, `curl $BASE/privacy`, and one
  invalid-token call (expect 401, generic message).

## 4. Payments

- ✅ No card data anywhere in our DB — purchases run through StoreKit/Play
  via RevenueCat; we store only {premium, product_key, expires_at,
  verified_at}.
- ✅ Entitlements verified SERVER-SIDE against RevenueCat's API on every
  billing sync; client StoreKit state is never trusted.
- ✅ RevenueCat webhook: shared-secret `Authorization` header
  (constant-time compare), event body never trusted — subscriber re-verified
  against RevenueCat before any entitlement write; events audit-logged with
  id-dedupe; lapsed subscriptions revoke premium on next sync/webhook.
- ☐ Configure the webhook in RevenueCat → Integrations → Webhooks:
  URL `https://<ref>.supabase.co/functions/v1/api/webhooks/revenuecat`,
  Authorization header = value of `REVENUECAT_WEBHOOK_AUTH` secret.
- ☐ Store setup: offering with MONTHLY/ANNUAL/LIFETIME packages, entitlement
  `pickle_sensei_pro`, target prices $7.99/$59.99/$159.99 (app only ever
  displays store-returned prices).
- ☐ Sandbox test: purchase, restore, cancel, lapse → app access follows the
  server verdict each time. Prerequisite on the test device: sign a Sandbox
  Apple Account (App Store Connect → Users and Access → Sandbox) into
  Settings → Developer → Sandbox Apple Account. Until then every purchase
  attempt in an Xcode build raises iOS's "Sign in to Apple Account"
  credential dialog — that is StoreKit's sandbox sign-in, not the app's;
  App Store builds show the normal Face ID payment sheet instead.

## 5. Accounts & privacy

- ✅ Two-step delete account (Settings → Manage account → quiet
  "Delete account" link — one level deep, still findable per 5.1.1(v)): step 1 mints a
  15-minute server challenge, step 2 confirms after a mandatory pause;
  deletion cascades through every user table; local owner data purged and
  Google SDK disconnected afterward. Strictly rate-limited.
- ✅ Privacy policy + terms hosted at `GET /privacy` and `/terms` (public;
  served as formatted plain text — the supabase.co gateway sandboxes HTML),
  linked from the paywall and Settings.
- ☐ Confirm the support email in `supabase/functions/api/legal.ts` is a
  monitored mailbox, and have counsel review both pages.
- ☐ App Store privacy nutrition labels must match the policy (identity,
  fitness data; no tracking).

## 6. Scale & performance

- ✅ Auth session caching (Upstash Redis when configured; per-isolate
  fallback): Supabase Auth consulted ~once per user per 10 min, not per
  request.
- ✅ Access check = 1 RPC; shot sync = 1 atomic RPC per shot + 1 batched
  replay lookup (was ~7 sequential queries per shot with compensating
  deletes); rank/progress parallelized + cached (60s TTL, write-time
  invalidation).
- ✅ Partial indexes matching the hot counters (`shots_user_scored_idx`,
  `shots_user_type_scored_idx`).
- ✅ Async housekeeping via pg_cron (stale permits, expired deletion
  requests, old webhook events) — never on the request path.
- ✅ N+1 sweep done on the edge function (batched lookups; no per-item
  queries in loops except the atomic per-shot RPC).
- ☐ Set Upstash secrets for cross-instance caching + limits:
  `supabase secrets set UPSTASH_REDIS_REST_URL=… UPSTASH_REDIS_REST_TOKEN=…`
- ☐ Run `tools/loadtest/` (smoke + auth-abuse + user-flow) and check
  thresholds pass (see that README for interpretation).

## 7. Mobile app QA (every release)

- ☐ Screen-by-screen button sweep: Home, Library, Add/Analyze, Performance,
  Settings, Paywall (both pages), Consent, Notifications, Live Court,
  Result, Drill Library — every button, link, back gesture, destructive
  action.
- ☐ Empty states: fresh account (no analyses, no rank, no streak, no saved
  drills, no notifications), plus airplane-mode variants of each.
- ☐ Offline/degraded: capture + analyze offline → outbox syncs on
  reconnect; API 5xx → retryable copy, never a crash; billing sync offline →
  "verification pending" state.
- ☐ Device matrix: small phone (SE/mini), large phone (Pro Max), keyboard
  open on forms, landscape where supported, Dynamic Type at large sizes,
  reduced motion on.
- ☐ Image/video memory: repeated capture→analyze cycles, drill video
  playback, no leaks (Xcode Instruments).
- ✅ Re-render hygiene: zustand selectors on hot screens; paywall page
  transitions are transform/opacity on the native driver.
- ☐ `cd apps/mobile && npx tsc --noEmit && npx jest --silent` green;
  `pnpm -r typecheck` green.

## 8. Store & operations

- ☐ iOS: Release scheme build on device; TestFlight via
  `bundle exec fastlane beta`; version/build bumped; App Store screenshots
  current.
- ☐ Env vars set in Supabase: `REVENUECAT_SECRET_API_KEY`,
  `REVENUECAT_WEBHOOK_AUTH`, `SB_PUBLISHABLE_KEY` (optional),
  `UPSTASH_REDIS_REST_URL`/`TOKEN` (recommended). `SUPABASE_SERVICE_ROLE_KEY`
  is platform-injected.
- ☐ Migrations applied (`supabase db push`) BEFORE deploying the function
  (`supabase functions deploy api --no-verify-jwt`).
- ☐ Supabase backups: PITR or scheduled backups enabled on the project;
  restore procedure tested once.
- ☐ Monitoring: Supabase function logs reviewed after deploy; alert on
  sustained 5xx; `GET /healthz` wired into an uptime monitor.
- ☐ Analytics/crash reporting decision recorded (none shipped today — if
  added, update the privacy policy + nutrition labels first).
