# Pickle Sensei — agent notes

Monorepo (pnpm workspaces). The shipping app is `apps/mobile` (React Native 0.87,
npm + package-lock.json — do NOT use pnpm inside apps/mobile). The production
backend is the Supabase Edge Function in `supabase/functions/api/` (Deno);
`services/api` (Fastify) is an older implementation the mobile app does not call.

## Verify

- Canonical entry points (CI runs exactly these — see `docs/devin/OPERATING_SYSTEM.md`):
  `scripts/verify-cloud.sh --tier pr` (Linux gates, per-stage logs +
  `summary.json` under `artifacts/verify-cloud/`), `scripts/mac-full-verify.sh`
  (Apple gates; from Linux `--remote` pushes HEAD to a `ci/mac-*` branch that
  runs on the self-hosted M4 runner), `scripts/verify-all.sh` (both). Skills
  in `.agents/skills/` describe when to run which. Review rules: `REVIEW.md`.
- Mobile: `cd apps/mobile && npx tsc --noEmit && npx jest --silent`
- Workspace: `pnpm -r typecheck` and `pnpm --filter @pickle/shared-types test`
- CI's `verify` job = `pnpm format:check` + `pnpm lint` + `pnpm typecheck` +
  `pnpm test` (needs a Postgres for @pickle/database — CI service user
  `pickle` is superuser) + `@pickle/database migrate/seed` + the ml/scripts
  python unittests. Root `eslint .` covers apps/mobile too. Prettier: the
  ROOT version (3.9.6 via ^3.6.2) is the formatting authority; apps/mobile
  pins the SAME exact version so `npx prettier --check` agrees in both
  places — bump them together or formatting ping-pongs.
- Supabase RLS/security matrix: `./supabase/tests/run_rls_tests.sh`
- iOS native deps: `cd apps/mobile/ios && bundle exec pod install`

## Deploy (Supabase project `ucqnaiwqwjtgvlduiuib`, linked via CLI)

- DB: `supabase db push` (migrations in `supabase/migrations/`, named
  `YYYYMMDDHHMMSS_description.sql`; remote history is tracked — never edit an
  applied migration, add a new one)
- The September 6 integration reconciles two migration histories. Production
  already has `20260905190106_api_only_database_access`; do not renumber it.
  Inspect `supabase migration list` and `supabase db push --dry-run --include-all`
  before an approved coordinated rollout. Older pending audit migrations require
  `supabase db push --include-all`, not a plain push. The RLS runner verifies
  fresh installation and upgrades from both historical states; the forward
  `20260907120000_preserve_permit_predicate_grant.sql` keeps the pure predicate
  callable after the API-only migration revokes earlier function grants.
- API: `supabase functions deploy api --no-verify-jwt`
- Edge dependencies are pinned EXACTLY: `index.ts` imports
  `npm:@supabase/supabase-js@2.112.4` and the function-local
  `supabase/functions/api/deno.json` + `deno.lock` fix the resolution the
  deploy bundles (a bare `@2` would resolve the latest 2.x, unreviewed, on
  every deploy). Static pin: `__wf__/db_migrations_rls_indexes.test.ts`
  ("edge deps"). To bump: change the version in the `index.ts` import, then
  `cd supabase/functions/api && rm deno.lock && deno install --entrypoint
index.ts` (regenerates `deno.lock`), update the `SUPABASE_JS_PIN` constant
  in that test, run `(cd supabase/functions/api/__wf__ && deno task test)`
  and `deno check cache.ts rateLimit.ts http.ts legal.ts`, and commit the
  import, the lockfile and the test together.
- Secrets: `supabase secrets set REVENUECAT_SECRET_API_KEY=…` (billing sync falls
  back to `REVENUECAT_PUBLIC_SDK_KEY`, currently set to the Test Store key),
  `REVENUECAT_WEBHOOK_AUTH=…` (shared secret the RevenueCat webhook must send
  as its Authorization header), `APPLE_SIGN_IN_CLIENT_ID=com.picklesensei`,
  `APPLE_SIGN_IN_TEAM_ID=…`, `APPLE_SIGN_IN_KEY_ID=…`,
  `APPLE_SIGN_IN_PRIVATE_KEY=…` (the Sign in with Apple `.p8` PEM), and
  `APPLE_TOKEN_ENCRYPTION_KEY=…` (base64-encoded 32 random bytes). The Apple
  values are required for server-side authorization-code exchange and account-
  deletion revocation. Optionally set `UPSTASH_REDIS_REST_URL` +
  `UPSTASH_REDIS_REST_TOKEN` (cross-instance cache + rate limits; without
  them the function falls back to per-isolate memory).
  `SUPABASE_SERVICE_ROLE_KEY` is platform-injected (used only for server-owned
  billing/audit/external-credential rows and Auth admin deleteUser).

## Auth sessions (durable sign-in — closing the app must NEVER sign out)

- Contract (2026-09-01): `POST /v1/account/bootstrap` spends the Apple/Google
  ID token once (`signInWithIdToken`) and returns `session {accessToken,
refreshToken, expiresAt}` beside the account. Every other route takes the
  Supabase ACCESS token as bearer (`authenticate()` verifies it with
  `auth.getUser`, cached like before); `POST /v1/auth/refresh {refreshToken}`
  rotates it (per-IP budget, 401 counts as an auth failure);
  `POST /v1/auth/logout` revokes THIS device's session (`scope=local` — other
  devices stay signed in) and drops the bearer from the auth cache.
  `authenticate()` still accepts a raw provider ID token TRANSITIONALLY for
  app builds that predate the contract — remove that branch once none are in
  the field. Deploy the edge fn BEFORE shipping the app build (an old server
  returns no `session`; the app then bears the provider token for that run
  and has nothing to persist — i.e. the pre-fix behaviour, not a crash).
- Mobile: `src/account/sessionVault.ts` keeps `{provider, canonical id,
refreshToken, email, displayName}` in the device Keychain/Keystore via
  `react-native-keychain` (`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`; needs
  `bundle exec pod install` after checkout). The ACCESS token and the
  provider token are never persisted anywhere; SQLite kv holds no session
  material. `authStore.hydrate()` restores from the vault FIRST (Apple and
  Google alike, no provider SDK): the user is signed in from the record, the
  refresh token is exchanged (launch waits ≤ 8s, then proceeds signed-in with
  local data while the refresh continues), and `sessionKeeper.ts` rotates
  the bearer 60s before expiry (never sooner than 30s after the previous
  rotation — a short-lived or clock-skewed `expiresAt` must not become a
  once-a-second refresh storm; `__tests__/sessionKeeperShortLife.test.ts`),
  retries transient failures with backoff, and
  re-checks on every foreground (timers don't fire while suspended). The ONE
  implicit sign-out is the server refusing the refresh token (401/403). The
  legacy Google silent-restore flag is only a fallback for devices that
  signed in before the vault existed. Long-lived API clients (sync transport,
  billing, training) resolve the bearer per request through
  `bearerTokenFor(canonicalAppUserId)` — never capture `bearerToken` at
  construction, and never reconfigure those stores on rotation (configure
  resets their state). Pinned by `__tests__/authDurableSession.test.ts`.

## Scale & security (edge function)

- `cache.ts` (L1 per-isolate + L2 Upstash Redis) caches VERIFIED auth
  sessions ~10 min keyed by token hash — Supabase Auth is consulted once per
  user per window, not per request. `rateLimit.ts` enforces per-IP pre-auth,
  auth-failure, and per-user route budgets (429 + Retry-After; the mobile
  outbox already treats 429 as retryable).
- Hot paths are RPCs from `20260831000000_scale_and_security.sql`:
  `access_state()` (1 round trip) and `apply_synced_shot(jsonb)` (atomic
  shot+details+permit write, SECURITY INVOKER so RLS applies). Rank/progress
  responses cache 60s and are invalidated by accepted shot syncs.
- THE FREE ALLOWANCE IS ONE LIFETIME RATING (D-045, 2026-09-10; two
  before). It has ONE server definition — `public.free_rating_limit()`
  (`20260910170000_free_rating_limit_one.sql`, an immutable constant,
  EXECUTE for `authenticated` only, in the K27 RPC allowlist) — read by
  `reserve_analysis_permit()`, `apply_synced_shot()`'s backstop, the shots
  write gate `enforce_scored_shot_permit()` and `issue_offline_grant()`;
  never write the literal into a decision point again (change the
  constant in a NEW migration). The edge fn mirrors it as
  `FREE_RATING_LIMIT` in `index.ts` (accessPayload derives
  used/remaining/limit from it; the static pin ties the two numbers
  together), the app's pre-auth copy as `src/billing/freeRatings.ts`
  `FREE_RATING_LIMIT`; everything with a server snapshot renders
  `freeRatings.limit` as declared (`accessApi.ts parseAccess` accepts any
  positive allowance and checks the counters against it — a build and a
  deployment that disagree for a moment show honest copy, never a refused
  response). The 0..2 request-shape caps on offline ticket issuance stay:
  apps in the field ask for two tickets and are clamped, never refused.
  `security_regression.sql` runs sections A–W at the historical two under
  a test-only owner override of the constant (its header explains why) and
  pins the shipping value in section X. Rollout: `db push` before
  `functions deploy`; either half alone is safe.
- Free ratings follow the SIGN-IN IDENTITY, not the account row
  (`20260902150000_free_rating_identity_ledger.sql`, 2026-09-02). Deleting
  the account used to reset the lifetime free ratings (every counted
  row cascades from auth.users; sign in again with the same Apple ID /
  Google account → fresh zero). `public.free_rating_ledger` keeps
  `sha256('provider:provider_id')` (the auth.identities subject — stable per
  Apple ID / Google account, Apple's even after the revocation deletion
  performs) → lifetime scored count, with NO FK anywhere, written by the
  definer trigger `shots_record_free_rating_ledger` on every scored shot
  insert (every identity of the user is set to identity-max + 1). ALL THREE
  decision points — `access_state()`, `reserve_analysis_permit()`,
  `apply_synced_shot()`'s backstop — count through
  `public.lifetime_scored_count()` = greatest(own scored shots,
  `identity_scored_count()`); never write `count(*) from public.shots` in
  any of them again (static pin: `__wf__/db_migrations_rls_indexes.test.ts`;
  live: security_regression.sql J1–J9). The table is service-only (RLS on,
  no policies, no client grants); `identity_scored_count()` is the one
  definer reader and is auth.uid()-scoped with no parameters. Premium
  bypasses it exactly as before; abstentions never touch it. Retention past
  deletion is disclosed in `legal.ts` §7/§8 + the support page, and the
  in-app deletion confirmation says used free ratings stay used — keep all
  three in step with the behaviour. Known limit: a different provider with
  a different subject (e.g. Apple then Google) is a different identity.
  `access_state().scored_count` is therefore identity-lifetime (the exit
  survey's `scored_count` stamp inherits that meaning).
  `20260905000100_late_linked_identity_ledger.sql`: an identity linked AFTER
  ratings were spent inherits the account's lifetime count at link time
  (AFTER INSERT trigger on auth.identities, definer, greatest-only, plus a
  one-shot backfill) — live: J10/J11.
- Table-layer permit gate (`20260905000000_scored_shot_write_gate.sql`): the
  RPC is the intended write path, but `authenticated` also holds INSERT on
  `public.shots`, so a BEFORE INSERT trigger refuses any client-written
  `result_kind='scored'` row without a LIVE reserved permit and re-checks the
  lifetime allowance under the same `access_lock_key(uid)` (premium bypasses
  the allowance, never the permit). `shots_low_confidence_unscored` (NOT
  VALID) makes `low_confidence ⇒ overall_score is null` a table invariant,
  mirroring the edge parser. Both trigger functions are revoked from clients.
  Owner/service writes (no JWT `sub`) are untouched. Live: section L.
- 5xx bodies are generic (detail only in function logs). Free-text inputs are
  sanitized (`http.ts sanitizeUserText`). pg_cron sweeps stale permits,
  expired deletion requests, old webhook events.
- Public no-auth routes: `GET /healthz`, `GET /privacy`, `GET /terms`
  (`legal.ts` — plain text on purpose: the supabase.co gateway rewrites
  Content-Type and sandboxes HTML; keep the support email real),
  `POST /webhooks/revenuecat`
  (secret-gated; entitlements re-verified against RevenueCat, never trusted
  from the event body; audit-logged in `public.webhook_events`).
- Edge API typecheck: `npx --yes deno@2.5.6 check --node-modules-dir=none
--frozen --lock=deno.lock supabase/functions/api/index.ts`. The 2026-09-05
  hardening fixed the old `never` inference errors: use the SDK's
  `SupabaseClient` type rather than `ReturnType<typeof createClient>`.
  Keep the SDK import pinned to the version in `deno.lock`. Deno owns that
  generated lockfile's formatting.
- Defense in depth (`20260831160000_defense_in_depth.sql`): column-level
  UPDATE grants sized to EXACTLY the writes the edge fn performs (shots have
  NO client update — favorites are device-local, sync is INSERT-only via the
  RPC; sessions move only `ended_at`; permits only `status`/`outcome`),
  trigger-enforced append-only ledgers, NOT NULL ledger owners, NOT VALID
  size caps, anon/public revokes. If you add a client-side column write,
  extend the grant in a NEW migration or every 42501 shows up as a 503.
  PostgREST upserts (`resolution=merge-duplicates`) put EVERY payload column
  in DO UPDATE — the grant must include them all (see
  account_deletion_requests).
- RLS/security regression matrix: `./supabase/tests/run_rls_tests.sh`
  (Docker postgres:16, or a throwaway local initdb cluster when Docker is
  absent; CI job `supabase-security`). It installs hosted-like default
  privileges first, applies every migration in order, then asserts the
  allowed AND denied paths (owner flows, RLS, anon, append-only, column
  grants, size caps, function EXECUTE). Historical audit:
  `docs/SECURITY_CERTIFICATION_2026-08-30.md` (see its status addendum).
- Load tests: `tools/loadtest/` (k6). Release gate: `docs/PRELAUNCH_CHECKLIST.md`.

## Billing

- Client key lives in `apps/mobile/src/config/runtimeConfig.ts`. iOS uses the
  PRODUCTION App Store public key (`appl_…`, real StoreKit — sandbox Apple IDs
  in dev/TestFlight) as of 2026-08-30; Android still uses the TEST STORE key
  (`test_…`, simulated) until a Play submission exists.
- The "Sign in to Apple Account" dialog over the paywall is StoreKit's App
  Store authentication, NOT the app's sign-in and NOT a bug. Sign in with
  Apple/Google identifies the account to OUR backend; it cannot sign the
  device into the App Store, and no app can skip App Store auth for a
  purchase. Development-signed (Xcode) builds purchase in Apple's SANDBOX,
  which asks for a Sandbox Apple Account on every attempt until one is
  signed in at Settings → Developer → Sandbox Apple Account (create testers
  in App Store Connect → Users and Access → Sandbox); after that the sheet
  reads `[Environment: Sandbox]` and confirms with Face ID. TestFlight runs
  in sandbox under the tester's own Apple Account; App Store builds use the
  device's Apple Account and the normal Face ID payment sheet. Only the two
  explicit paywall buttons reach StoreKit auth — Continue (`purchasePackage`)
  and Restore purchases (`restorePurchases`, RC's SK2 path reads
  `Transaction.all` + `AppTransaction.shared`); never call restore/sync
  automatically, that prompt is the cost. Decision 2026-09-02: keep real
  StoreKit sandbox in dev (a Test Store key for iOS Debug builds was
  considered and declined).
- Entitlement id: `pickle_sensei_pro` (legacy alias `premium` also honored).
- Offering packages must use standard types MONTHLY / ANNUAL / LIFETIME.
- THE RECOMMENDED PLAN IS MONTHLY (D-047, 2026-09-10): `accessStore`
  pre-selects `monthly` (then annual, then lifetime). The paywall sits on the
  app's chalk surface; the pricing page is full-width rows Monthly · Yearly ·
  Lifetime (`PaywallScreen.tsx`: `RECOMMENDED_PERIOD`, `PLAN_ORDER`) and the
  monthly row is the ONE ink card (volt `RECOMMENDED` pill, volt amount while
  selected; `tokens.ts` `membership`), siblings white with an ink edge when
  chosen. Cal AI / Rivian restraint: no chips beyond yearly's computed
  `SAVE n%`, flat fills, ink pill CTA, volt exactly twice. Badge copy must pass
  H06 (no `BEST`/`MOST POPULAR`). Pinned by `__tests__/paywallPodium.test.tsx`
  and the paywall button/flow suites.
- Target prices: $7.99/mo, $59.99/yr, $159.99 lifetime — set on the store
  products; the app only ever displays store-returned prices. ASC product ids:
  `pickle_sensei_pro_monthly`, the yearly successor of
  `pickle_sensei_pro_annual` (see docs/DISTRIBUTION.md; both subscriptions
  must live in ONE subscription group), `pickle_sensei_pro_lifetime`
  (non-consumable).
- Backend fallback secret `REVENUECAT_PUBLIC_SDK_KEY` holds the PRODUCTION
  App Store public key (`appl_…`) as of 2026-09-01. Setting
  `REVENUECAT_SECRET_API_KEY` (RevenueCat dashboard → API keys → secret) is
  still preferred — the fallback only covers subscriber reads.
- `public.billing_entitlements` is written ONLY by the edge function via
  service role. Never add user INSERT/UPDATE policies to it.
- Entitlement row semantics (2026-09-06): the row keeps the NEWEST
  `verified_at` (`billing_entitlements_keep_newest_verdict`, a stale verdict
  is dropped and the edge fn re-reads the stored row). `verified_at` is
  RevenueCat's `request_date_ms` only when it lies within
  `REVENUECAT_CLOCK_MAX_AHEAD_MS` (5 min) ahead / `REVENUECAT_CLOCK_MAX_BEHIND_MS`
  (24 h) behind the isolate clock read BEFORE the RC round trip; otherwise
  (and when absent/NaN/≤0/out of range) that pre-request clock is used — a
  far-future provider clock must never become a key that outranks every later
  real verdict. Anything the edge fn answers about a stored row goes through
  `effectivePremium()` — premium AND (expires_at IS NULL OR expires_at >
  now()), the same predicate `access_state()` and every other DB decision
  point apply — so a stored `premium=true` past its `expires_at` is NOT
  premium.
  Pinned by `__wf__/fix6_billing.test.ts` + `attack_fix5_billing.test.ts`.
- Free-rating ledger freshness (2026-09-02): `accessStore.canonicalAccess`
  is a server snapshot, and `GET /v1/me/access` derives `used` from SYNCED
  scored shots and `reserved` from live permits — so it goes stale the
  moment a scoring run starts and nothing in the store refreshes it by
  itself. Two hooks keep it honest: SettingsScreen `useFocusEffect` →
  `refreshAccess()` on every visit for synced (non-`localOnly`) sessions
  (skipped while a load is in flight; the old value stays on screen until
  the new one lands), and AnalyzeScreen re-reads it in its UNMOUNT cleanup
  once a run called `runCaptureAnalysis` — chained onto that run's promise
  so the read sees the permit consumed/released, never the intermediate
  reserved state — and never while mounted, because
  `useRatingRouteGate` replaces a mounted screen whose `canStartRating`
  flips false and would tear down the "last free analysis" prompt. The
  Settings membership row words "N free ratings left" from
  `canStartRating` / `freeRatings.availableToReserve`, NOT `remaining`: a
  scored shot whose permit is still syncing has already spent its rating.
  Pinned in `__tests__/settingsMembershipRow.test.tsx` and
  `__tests__/analyzeScreenAccessRefresh.test.tsx`.

## Typography canon (title roles must match EXACTLY across screens)

All text styles come from `src/design/tokens.ts type` — never invent ad-hoc
fontSize/fontFamily near a token. Title roles:

- Top-level pages (Progress, Library, Settings): `type.hero` title at
  content paddingTop `space.xl`, `type.body` subtitle `marginTop: space.sm`,
  `maxWidth: 340`.
- Pre-auth landings (Welcome, SignIn, Analyze camera landing) and every
  onboarding step: optional `type.micro` kicker → `type.hero` title
  (`marginTop: space.sm` after a kicker) → `type.body` sub
  (`marginTop: space.sm`, `maxWidth: 340`).
- Sub-page headers: `ScreenHeader` (`type.h3`). Section headers:
  `SectionTitle` (`type.h3`); Progress's dark dashboard uses
  DashSectionHeader (`type.micro`, letterSpacing 1.2 everywhere). With
  `wrapTitle`, `ScreenHeader` gives the title a full-width row below controls
  at `fontScale >= 2`; otherwise it preserves the standard centered row.
  Do not shrink the font or reuse the narrow Back/Close side slots for long
  accessibility titles. The Consistency header is natively checked on a
  375-point iPhone at fontScale 3.571.
- Centered state/celebration headlines (signed-out states, Analyze states,
  Result moments, Paywall title): `type.h1`.
- Data numerals may size per card, but the SAME role must match everywhere
  (e.g. card technique scores are `type.score` at 30/34 on Home, Progress,
  and Library; big stat counters are `type.display` at 64/66).

## Floating tab bar that docks at the page end (2026-09-10)

`PremiumTabBar` is positioned ABSOLUTELY over the tab screens with two frames
(`src/navigation/tabBarLayout.ts`): FLOATING — a rounded card (`radius.lg`,
`shadow.floating`, same `color.tabBar`/`color.line`) 16 from each side,
resting JUST above the home indicator (iOS: `max(insets.bottom − 14, 12)` =
20 on Face ID phones, the card dips into the soft 34pt inset like the
system's own bars; Android: `max(insets.bottom + 8, 12)`, above the
system-owned navigation band) — while the focused page scrolls, and DOCKED
— full width, square, flush, stretched under the home indicator, the bar as
it always sat — once that page's end is reached. The owner judged the earlier
42pt lift "too high" (2026-09-10); tune `TAB_BAR_INDICATOR_DIP`, never the
docked frame.
The latch (`src/navigation/tabBarDock.ts`, a zustand store keyed by tab)
closes within 8 of the end and opens only 32 back up (hysteresis); a page
that cannot scroll never docks. Each tab screen (Home, Library, Progress,
Settings) MUST spread `useTabScrollDock('<Tab>')` onto its main
ScrollView/FlatList (every mounted variant — its callback ref releases the
latch on unmount) and end its scroll content with
`paddingBottom: useTabBarContentInset()` (the TALLER frame's footprint — the
docked bar on Face ID phones, the card elsewhere — + the Coach button's 24
rise + 8, so it clears both), wrapping full-screen Loading/Error states in a
padded `screen` View. The bar animates
between frames with Reanimated (240ms ease-out, snaps under reduced motion);
the Coach menu anchors follow `tabBarRowBottom(inset, docked)`; its scrim
covers the whole screen. Never hardcode 70/26/16 elsewhere. Pinned by
`__tests__/premiumTabBar.test.tsx` ("floating geometry"),
`__tests__/tabBarLayout.test.tsx` and `__tests__/tabBarDock.test.tsx`. Screen
tests that stub `react-native-safe-area-context` must provide
`useSafeAreaInsets`. RN 0.87 has no `StyleSheet.absoluteFillObject` (only
`absoluteFill`); spell edges out. Worklets must capture plain numbers, not
the `StyleSheet` module.

## Launch flow (onboarding BEFORE login — and REQUIRED)

App.tsx Gate order: Welcome → onboarding questionnaire + notification choice
→ sign-in → app; `src/flow/launchGate.ts` + `__tests__/launchGate.test.ts`
pin it. "Start your first read" ALWAYS enters the questionnaire — the gate
takes no device-history input (a device-level "already onboarded" marker used
to short-circuit it to sign-in on any phone that had ever held a profile; it
was removed 2026-09-01 for conversion — invest first, then create the
account). The questionnaire CANNOT be skipped (product decision 2026-09-01:
the app is personalized from it): pre-auth, step one's control is a plain
Back to Welcome (`stageWhenLeavingOnboarding()`, no alert, no "Skip to
sign-in" — that escape was removed), later steps' Back returns to the previous
question, and the ONLY way to reach sign-in through the flow is finishing it.
Every other path loops back into onboarding until it's done once: Welcome's
"I already have an account" link goes to sign-in, but an account with no
profile lands in the in-account OnboardingScreen (`mode='account'`), whose
only other exit is signing out. Pinned in `__tests__/onboardingScreen.test.tsx`
(preauth + in-account escape cases). Do not reintroduce hidden gating on the
primary CTA or any skip affordance. Pre-auth answers stash under
device kv `onboarding.pending-profile` and are adopted by the first writable
owner appStore.hydrate() sees, REPLACING any profile that owner already had
(newest intent wins — someone who chose "Start your first read" and answered
everything meant it; canonical accounts save through `/v1/me/onboarding`
first — server focusCheckpoint wins). The stash is single-use; a failed
server save keeps both the stash (retried next hydrate) and the existing
profile. Pinned in `__tests__/appStorePreAuthOnboarding.test.ts`. The final
notification screen asks before the OS prompt: only “Turn on reminders” may
request permission, while “Not now” never does. Its device-level
`onboarding.pending-notifications` choice is adopted by the first writable
owner notificationStore.hydrate() sees unless that owner already has reminder
prefs. Signed-in sessions with no profile still get the in-account
OnboardingScreen (default `mode='account'`; the pre-auth gate passes
`mode='preauth'`).

## App Store rating prompts

`src/review/appStoreReview.ts` (device-level kv `review.prompt-state`, never
owner-scoped): EVERY scored analysis in AnalyzeScreen's scored→Result path
fires `reportScoredAnalysisForReview()` — StoreKit is asked each time and
iOS itself throttles/stops the sheet (≤3/365 days, silent after the user
rates); never draw a custom rating nag (App Review 5.6.1). The free-limit
path deliberately does NOT prompt (no sheet over the upgrade moment).
Settings → About "Rate Pickle Sensei" calls `rateAppFromSettings()`: with
`APP_STORE_ID` set in runtimeConfig it deep-links to the write-review page
and durably ends the per-analysis asks; until then it falls back to the
in-app sheet (no stop signal). Set `APP_STORE_ID` (numeric ASC Apple ID)
once the App Store record exists. Native module:
`ios/LocalPods/PickleNative/Sources/PickleStoreReview.swift` + bridge — new
files under `Sources/` need `bundle exec pod install` to enter the pod
target. The OS sheet never appears in TestFlight builds by design; dev
builds always show it.

## Ratings display: ESTIMATED DUPR first, the /10 beneath (D-046, 2026-09-10)

Every rating a player reads — the analysis `overallScore`, the rank
`rating`, their averages, bests, deltas and tier bands — is printed as an
ESTIMATED DUPR. The map is NOT linear (DUPR is bunched in the 3s; 5.0+ is
the top ~0.7% of rated players, 6.0+ ≈ 190 people): `DUPR_ANCHORS` in
`src/progress/duprEstimate.ts` tie the scoring engine's band boundaries to
DUPR's published bands — score 0 → 2.00, 6.5 (checkpoints average the
red/yellow line) → 3.00, 8.0 (the green line) → 4.00, 9.5 → 5.00, 10 → 6.00
(the ceiling; never higher) — linear between anchors, two decimals
(`formatDupr`; 5.8 → 2.89, 7.0 → 3.33, 7.8 → 3.87, 9.0 → 4.67). Differences
are ALWAYS `duprDelta(from, to)` / `formatDuprDelta` / `formatDuprDistance`
= the difference of the two converted endpoints — never a rescaled score
gap, the map is not linear. `duprFraction` is the fill of a ring/bar (the
DUPR's position between 2.00 and 6.00); `formatTechniqueScore` prints the
"6.4 /10" line; `duprAccessibilityLabel` is VoiceOver's phrase;
`DUPR_ESTIMATE_NOTE` the disclaimer. `src/progress/DuprReadout.tsx` renders
the canonical pair — big DUPR + ` DUPR` unit, micro `x.x /10` beneath — in
the host's numeral role; `ScoreRing` does the same inside the ring (its arc
is `duprFraction`). Rules: the big number is
ALWAYS the DUPR and ALWAYS says DUPR (unit, caption or kicker); the 0–10
figure is ALWAYS the smaller secondary; surfaces with room carry the
disclaimer (Result score page, rank banner fold-out, rank card, Progress
footer, Settings); never print a bare `toFixed(1)` score or a "/10"-only
number again. The DATA never changes — SQLite, sync payloads, the server,
`computePlayerRank` and the tier thresholds stay on 0–10; convert at render
only. Checkpoint scores (0–100) are a different quantity and stay as they
are. The rank tiers keep their 0–10 thresholds, so their DUPR bands read
Bronze 2.00–2.53 · Silver 2.54–2.76 · Gold 2.77–2.99 · Platinum 3.00–3.66 ·
Diamond 3.67+ (re-anchoring the ladder to DUPR bands is a separate
shared-types + migration + edge decision). DUPR is a third-party trademark:
the H06 scan bans it in App Store metadata + Info.plist
(`STORE_ONLY_RULES`) and allows it in-app; if Apple
ever challenges the label, change `DUPR_LABEL`/`DUPR_ESTIMATE_LABEL`/the
note in that one module. Pinned by `__tests__/duprEstimate.test.tsx`; the
older validated-benchmark contract (`techniqueBenchmarkDisplay.ts`,
`__tests__/techniqueBenchmarkDisplay.test.ts`) is unchanged and still
governs the future calibrated interval.

## Player rank

One formula in three places that MUST stay identical
(`packages/shared-types/src/playerRank.ts`, migration
`20260831130000_form_weighted_rank.sql`, edge fn `GET /v1/rank` fallback) —
form-weighted v2: per technique take the most recent 8 scored real analyses
(order `captured_at desc, id desc`), linear weights newest=8…oldest=1, score =
round2 of the weighted average (integer-hundredths math); rating = round2 of
the confidence-weighted average of the ROUNDED technique scores where each
technique weighs `min(its scored count, 5)`; tiers UNCHANGED
bronze<3.5≤silver<5≤gold<6.5≤platinum<7.5≤diamond. Divisions (III→II→I,
thirds of a tier band) are presentation-only, derived from the rating via
`playerRankDivisionForRating` — never stored. Deploy order matters: `supabase
db push` BEFORE `functions deploy` (the new edge code selects view columns the
migration adds).

Rank-shift ceremony: surfaces that resolve a rank (PlayerRankBanner,
PlayerRankCard) report it to `src/progress/rankCelebration.ts`, which keeps a
durable owner-scoped kv record (`rank.celebrated:<owner>`) and raises the
`RankUpCelebration` overlay (mounted in App.tsx) once per upward tier change.
The Home banner no longer navigates on tap — it glow-pulses and unfolds the
tier ladder in place (`player-rank-banner-toggle`); its streak block is a
separate press target that opens the StreakCalendar route.

Rank insignia (owner request 2026-09-10 — every division is its own badge):
`RankIcon tier division` renders one of fifteen custom badges (Bronze III …
Diamond I) from `src/components/rankInsigniaArt.ts` (pure geometry, named
tones) painted with the tier's material in `design/tokens.ts` `rankTier`
(copper / steel / gold / ice / sapphire — flat four-tone facets, NO
gradients, shadows or particles; the inventory visual contract still
applies). Grammar: tier = silhouette + engraved mark (coin/chevron,
hex/arrow, shield/star, crest/lozenge, cut gem); division III = bare plate
over the numeral plaque, II adds wings, I adds the second wings + crown —
the plaque spells the SAME numeral as the copy (III/II/I, III at the
floor). `division` omitted → the plate-only tier mark (ladder rows, 26px);
`tier: null` → the muted unranked emblem. `RANK_TIER_STYLE[tier].accent`
is what the ladder fills / YOU pill borrow (≥ 4.5:1 on surfaceDark).
Pinned by `__tests__/rankUpCelebration.test.tsx` ("rank insignia").

## Progress dashboard (Performance tab)

`ProgressScreen` is a WHOOP-style dark dashboard (bg `surfaceDark`,
light-content status bar — same surface family as GameplayProgressScreen).
All comparison math lives in the pure module
`src/progress/techniqueDashboard.ts` (pinned by
`__tests__/techniqueDashboard.test.ts`): per stroke, only scored reads that
match the newest read's scoringModelVersion+shotConfigVersion are ever
compared; prior-window values exist ONLY when comparable history predates the
current window (a first measured window renders no comparison — nothing is
invented); a personal best fires only when a real earlier best is strictly
beaten; the insight line states window arithmetic only. Averages aggregate
in integer TENTHS (the rank formula's integer-math convention) so results
are exact and independent of row order — float summation once flipped a
±0.0 delta's triangle. The screen's own `dayKey` guards unparseable
timestamps (formatToParts throws on Invalid Date; one corrupt row must
exclude itself, not crash the page). UI pieces:
`src/progress/StatDeltaRow.tsx` (key-statistics row, ▲ mint / ▼ flame
prior-window triangles), `src/progress/ScoreTrendChart.tsx` and the upgraded
`PracticeVolumeChart` (value labels only on short windows, translucent
"today" column, honest 4dp stubs for unscored days). The technique tab also
links to `GameplayProgress` (otherwise only reachable from LiveSummary).
Pins: `__tests__/progressScreenDashboard.test.tsx` (render + retry + DST +
midnight + canonical/server-signal paths),
`__tests__/techniqueDashboardEdgeCases.test.ts` (timezones incl. UTC+14 and
Lord Howe, window edges, seeded invariants, order-independence, 5k-fact
volume), `__tests__/progressChartsComponents.test.tsx` (chart/stat-row
honesty).

## Practice tab — what counts as verified practice (2026-09-03)

`practiceHistory.ts isVerifiedPracticeCapture()` is the ONE rule, used by the
aggregation AND the "Recent captures" list: payload passed the strict parser,
still matches the row metadata, and carries measured pose evidence — a guided
capture always does (trigger + capture evidence); an IMPORTED clip counts once
`clip.poseSequence` is on the row (`updateCaptureClipPayload` right after
extraction, i.e. every scored import). A raw import nobody analyzed is a video
file, not practice. Before this, imports were excluded outright ("automatic
captures only") and a scored Import Video scan left every Practice number at
zero while Technique showed the score. Imports count toward captures, active
days, streak and the volume bars; the camera-only instrumentation (pose
tracked, pose availability, joint coverage) aggregates guided captures only
and renders "—" (not 0.0s) when the window has none (`cameraCaptureCount`).
The hero discloses stored clips the chart refuses to count
(`excludedCaptureCount` → `excludedCapturesNote`, testID
`practice-excluded-note`) so an exclusion is never silent again. Pinned:
`practiceHistory.test.ts` (measured import counts / raw import excluded),
`progressScreenDashboard.test.tsx` ("counts a scored IMPORTED clip"),
`progressScreenCopy.test.ts`.

## Home "This week" card (scored reads, two lenses)

Rebased 2026-09-03 from capture evidence to SCORED READS. The card reads
`listRealAnalysisFacts` + `buildTechniqueDashboard(range: '7d')` — the same
comparable-reads rule Progress applies — so a scored analysis shows up
whatever path captured it (guided camera or imported video). It previously
counted only `automatic_pose_trigger` captures with valid pose evidence: the
first scan (an import) scored 3.7 while the card still read "Your court is
ready". `listCaptureHistory`/`buildPracticeHistory` (pose tracked, capture
streak) stay on Progress → Practice only (see the Practice-tab rule above for
which captures count there). Two lenses on the SAME reads:
`src/progress/ScoreDotPlot.tsx` (one dot per read at its exact score in its
day column, same-day reads fanned out chronologically, newest read volt +
halo, faint time-order trace via react-native-svg once `onLayout` knows the
width, direct value labels while ≤ 8 reads — alternating sides inside a fan
and never outside the plot) and `PracticeVolumeChart` (reads per day,
`accessibilityLabel` override). Toggle = two `tab`s in a `tablist` in the
card header (`home-week-chart-scores|reads`, 28pt segments + vertical
hitSlop 8 = 44pt); the choice is a DEVICE-level kv `home.week-chart`
(`WEEK_CHART_KV_KEY`, default scores; a failed kv read never fails the Home
load). Both plots are 82pt tall so toggling never moves the card. Footer:
scored days / avg score / best score. Empty copy tells a first week ("Your
court is ready.") from a quiet week ("Quiet week so far." — comparable reads
exist before the window, i.e. `scoredReps.previous !== null`).
`TechniqueDashboard.reads` (`ScoredReadPoint[]`, ascending, id tiebreak)
feeds the dots. Pinned: `__tests__/scoreDotPlot.test.tsx`,
`techniqueDashboard.test.ts` (reads), `wf/HomeScreen.buttons.test.tsx`
("This week card").

## Consistency (streak / Momentum XP / achievements)

`apps/mobile/src/consistency/`: pure engine (`engine.ts`) replays the FULL
activity history on every refresh — a day counts only for meaningful training
(real analyses incl. honest abstentions from `local_shot`, session strokes,
qualifying drill completions mirrored into the ledger by the training store).
App opens never count, and streaks NEVER touch the skill rating. Streak
Shields: +1 per 7 consecutive trained days, hold ≤ 2, auto-spent per missed
day (shielded days bridge but don't grow the run). Momentum XP: 20/day + 5
per extra activity (cap +15) + one-time milestone bonuses; levels via
`momentumLevelForXp`. Milestones at 1/3/7/14/30/60/100/365 days plus volume
achievements (see `milestones.ts`).

The owner-scoped store (`store.ts`, kv `consistency:<owner>`) persists ONLY
what cannot be derived: drill ledger, celebrated-milestone ids (one durable
ceremony each — `StreakCelebration` overlay in App.tsx), and the once-per-day
"Day N secured" marker (consumed by `DaySecuredBanner` on ResultScreen).
Surfaces: Home top-bar flame chip + rank-banner streak block, Progress
`ConsistencyCard` + `AchievementsShowcase` (locked badges advertise honestly:
"N days away"), the `StreakCalendar` screen (month grid, shielded days, day
detail), Settings Player row. Streak-defense notifications read
`computeConsistencySnapshot()` (see `notificationStore.defaultLoadContext`);
copy states only facts true at delivery (`streakDefenseCopy`).

Achievement badges (owner request 2026-09-10 — every achievement is its own
badge): `MilestoneBadge glyph value rarity earned size` renders one of TEN
custom insignia from `consistency/achievementBadgeArt.ts` (pure geometry on
a 96-unit canvas, named tones `deep/base/light/bright/mark/plaque`) — coin
(First Spark), ember tile (Kindling), heater shield (Week One), twelve-lobe
rosette with crossed paddles (Fortnight Form), laurel medallion (30 Day
Club), hex seal with comet (Sixty Deep), crowned crest (Century Club),
winged crest with the phoenix flame (Eternal Flame), ribboned medal with a
check (100 Sessions), target rings with a paddle on the bull (Specialist).
Paint comes from the RARITY's material in `design/tokens.ts
achievementRarity` (chalk / court / volt / violet / flame / ember — flat
four-tone facets, NO gradients, shadows or particles; the inventory visual
contract lists both files) or `achievementLocked` (charcoal, dashed
`accent` rim on the silhouette — `achievementSilhouetteIndex`). LAYOUT
CONTRACT (owner: "no overlap, premium", 2026-09-10): each numbered badge
declares its OWN ribbon banner rect (`achievementBadgePlaque(glyph)`) that
lies wholly inside the plate's face ≥ 2 units from its edge (pointed-bottom
plates keep straight flanks down to the banner for it); emblems stop ≥ 3
units above the banner and clear of the bevel highlights; nothing leaves
the 96-unit canvas; and every banner is wide enough for its own numeral in
every size role at the default font scale — the geometry comments in the
art module carry the computed margins, and the "sizes every banner" test
re-derives the fit with Manrope Bold's real digit advances
(`numeralWidth`). The value is ONE uncapped RN Text centred on that rect in
the material's `bright` (micro < 64pt, h3 ≥ 64, score ≥ 120); when the
scaled digits would touch the banner's ends or outgrow its height
(`fontScale`, or a 3-digit value at 40pt), the banner is not drawn and the
number flows onto an `inkElevated` plaque BELOW the art — never clipped,
shrunk or overlapping. The StreakCalendar next-reward chip renders at 48pt
for that reason. The showcase's rarity pill and the celebration's eyebrow
borrow `RARITY_PALETTE[rarity]` (`accent` on dark ≥ 4.5:1 vs
`surfaceDark`, `deep` on light ≥ 4.5:1 vs `surface`). `badgeArtFor(id)` is
the id → glyph/value map (`fix-26-milestoneRewards` pins that reward copy
names the art it grants). Pinned by `__tests__/streakCelebration.test.tsx`
"flat milestone insignia" (materials, distinct drawings, locked rim,
banner fit, numeral flow) and `wf/AchievementsShowcase.buttons.test.tsx`.
To check the art by eye, render the shapes to SVG with the same paint
resolution as `MilestoneBadge` and `qlmanage -t` the sheet — that is how
every badge was audited.

Owner-scoped kv namespaces (`profile`, `rank.celebrated`, `notifications`,
`consistency`, `practice.set`, `billing.pending-fulfilment`,
`analysis.release-policy`, `walkthrough.complete`) are pinned in
`repository.ts OWNER_SCOPED_KV_NAMESPACES` and purged together on account
deletion — add new namespaces there.

## First-run walkthrough (once per ACCOUNT, 2026-09-10)

`src/walkthrough/FirstRunWalkthrough.tsx` is the 5-step spotlight tour over
the real interface (Coach button → honest ratings on the rank banner →
Library tab → Progress tab → the daily streak on the Home flame chip, target
`home-streak`, added 2026-09-10 as the closing step so the earlier step
indices the suites pin stay put; Skip / Next / Got it / backdrop / hardware
back all end or advance it), raised by App.tsx `maybeShowFirstRun()` the first time
`session + profile` are both present. Its "seen" record is OWNER-scoped —
`walkthrough.complete:<owner>` (`walkthrough/walkthroughKey.ts`, a pure
module so tests never load the native db) — NOT device-level (decision
2026-09-10: every new account gets the tour; the old `walkthrough.device-complete`
key is simply ignored). The record is written BEFORE the overlay shows
(crash-loop safety), a signed-out process never evaluates, the request is
tagged with its owner through `identifyCeremony(request, owner)` so
`CeremonyHost` presents it only to that account, and a `subscribeToDataOwner`
listener drops a tour still showing when the owner changes so the next
account's evaluation is never blocked by a stale request. Settings → About
"App walkthrough · Replay" re-raises it without touching the record. Pinned by
`__tests__/walkthroughStore.test.ts` (new account tours, same account does
not, owner switch mid-evaluation writes nothing) and the ceremony/overlay
suites, which seed `walkthroughKeyForOwner(owner)` for EVERY account they
sign in as.

## Auto Analyze camera — record button, then TRUE auto capture (iOS, 2026-09-02)

`GuidedCaptureViewController.swift` is a camera app, not a wizard. It opens
in `composing` (live preview + exoskeleton, NOTHING recorded; the translucent
player silhouette — `CaptureSilhouette` imageset, alpha 0.3 → 0.2/0.14 as a
body is tracked → FULLY hidden the moment readiness is `ready` in ANY stage
(composing included, 2026-09-10; `updateSilhouette` +
`silhouetteDismissedByFraming`: `holdStill` keeps it dismissed so it never
pulses on a weight shift, it returns only on noPerson / fullBodyRequired /
moveCloser / moveFarther) and once locked, mirrored in RN as
`assets/capture/silhouette*.png` — shows where to stand). The ONE control is
the `CaptureShutterButton`: record while composing
(`startRecording(.initial)`: rolling spool + REC chip + 50 s timer, status
"RECORDING / Step into the outline"), STOP & ANALYZE while recording. Product
decisions pinned by field tests on 2026-09-02: (1) the athlete presses record
— an auto-start on camera open was shipped for one build and rejected
("started recording without me clicking"); (2) there is NO start-spot tap
(removed; the primary-person rule + D-027 machinery stay inert unless a
region is set, which nothing does now); (3) DETECTION IS NEVER GATED ON
FRAMING — a field recording showed a swing going undetected because the
athlete stood a step too far ("Move a little closer") and the trigger only
armed on readiness `ready`. Now `considerTrigger` feeds the detector every
trackable recorded frame. A completed event must fit inside the current
recording's atomic URL/timestamp snapshot; no fixed warm-up discards an early
complete swing;
`PoseReadinessEvaluator` only decides the status copy ("A little closer, then
swing", …) and the BODY TRACKED state (`armed`, presentation + telemetry
only, dropped after `armedLossFramesToDisarm` consecutive no-person/partial
frames). STOP & ANALYZE (`captureFromStop`): an offline pass
`TemporalStrokeDetector.strongestEvent(in:)` with the permissive
`manualStopConfig` (v4 algorithm, pinned by vision-core tests) runs over the retained 15 s
pose history — only poses inside the current file, excluding the final
`manualStopApproachMs` (1.2 s, the walk to the phone) — and the strongest
swing-like window becomes the stroke (`pendingStrokeIsManual`: provenance
`<liveVersion>/manual-stop-relaxed-1` on BOTH trigger and evidence, no
completion telemetry, `completionFinalize` at the stop); with no such window
`stopRecordingWithoutCapture` discards through the engine's suppression and
composes again with "No swing found — tap record and swing again".
`CaptureEvidenceAccumulator` retention is 15 s to match. While recording,
nothing returns the athlete to setup except their own stop: the 50 s
observation timer restarts the spool in place via
`flipCameraRestartingSpool(to: same position)` (engine-suppressed finish,
REC timer untouched, detector reset so no event straddles files) and the
movie output's 60 s hard cap does the same through `startRecording(.restart)`.
Invariants: discard a spool ONLY through the engine's own suppression paths
(`discardActiveRecording`, decided on the session queue against
`movieOutput.isRecording`); `recordingRequested` (shutter) and
`recordingStarted` (delegate fired) are separate flags — the trigger needs
both; `startRecording` clears `discardRecordingOnFinish`; a
`recordingAlreadyActive` start failure is retried after 150 ms. JS
`CameraEvent.session` carries `recording_started(reason: shutter |
spool_restart)`, `recording_stopped(reason)`, `manual_stop_requested`,
`manual_stop_no_motion`; `stroke_detected` carries `source: 'manual_stop'`
for the offline pass. Analyze landing copy: "Tap record. Swing once.";
`ANALYZE_STEPS` 02 "Tap record to start" (the zero-handholding audit requires
a "start" step whose detail mentions tap + walk).

TOUCH OWNERSHIP (the camera once shipped "frozen" because of this): the
preview carries a zoom `UIPinchGestureRecognizer`. UIKit exempts only its
stock controls (UIButton, UISwitch, …) from a parent view's recognizers; our
chrome is custom `UIControl`s, so without protection a recognizer claims
every touch and CANCELS the control's touches — no button fires. Two layers
keep every button alive and both must stay: the recognizers have
`cancelsTouchesInView = false` and a delegate
(`gestureRecognizer(_:shouldReceive:)`) that refuses touches beginning on
any `UIControl` or chrome surface; and every custom control overrides
`gestureRecognizerShouldBegin` to veto ancestor recognizers (UISlider's own
trick). Never add a recognizer to the camera view without the delegate, and
never replace the custom controls with plain `UIView`s + tap recognizers.

PERFORMANCE + AUTO-CAPTURE RELIABILITY (2026-09-02, after "super laggy /
not capturing"): `PoseOverlayView` is Core Animation ONLY — shape layers for
bones/joints/limb heat/trails and one radial `CAGradientLayer` per joint glow,
updated in a single `CATransaction` per pose frame. Never reintroduce
`draw(_:)`/`setNeedsDisplay` rendering there: the old CPU path
re-rasterized the full-screen 3× bitmap with ~90 radial gradients per frame
and saturated the main thread. The controller feeds the overlay the RAW pose
every frame (`update(pose:readinessState:jointCoverage:timestampMs:)`) so the
exoskeleton snaps onto the body the instant Vision sees it, even on frames
the readiness evaluator rejects; arming still goes through the evaluator.
`updateCapturePresentation` runs per frame — labels/accessibility only
change when the copy changed (`copyChanged`), the ISO formatter is a static,
glass views set `shadowPath`. THREAD OWNERSHIP: the detector, readiness
evaluator, evidence accumulator and every target-acquisition variable belong
to `visionQueue`; main-thread code mutates them ONLY via `onVisionQueue {}`
(`spotMarked` is the main-thread mirror), `finishSuccess` reads target
telemetry via `visionQueue.sync` (never called from the vision queue). The
occupancy hunt's second inference is throttled to ~10 Hz
(`acquisitionScanIntervalMs`). Missed-capture fixes: a person-less frame no
longer resets the detector (its ≤250 ms sample-gap rule already neutralizes
gaps), and an armed capture tolerates `armedLossFramesToDisarm` (15 ≈ 0.5 s)
consecutive `noPerson`/`fullBodyRequired` frames before disarming — a
follow-through that clips the frame edge used to throw the stroke away. The
observation timer is 50 s, 10 s under the engine's 60 s hard movie cap.
`TemporalStrokeDetector` is v4 (`temporal-stroke-heuristic-4`, also in
`packages/model-registry` defaultManifest; `swift test` in
`native/vision-core` pins it — 31 detector tests). Wrist speed is
HIP-RELATIVE ((wristΔ − hipMidΔ)/dt) in BODY-HEIGHTS/second (shoulder→ankle
span, EMA-smoothed, hip×2.2 / last-known / 0.5 fallbacks; a frame without a
visible hip yields NO speed sample, never absolute speed) so detection is
invariant to distance, to walking (v3 fired on a walking athlete: body
translation + arm swing crossed the trigger) and to camera bumps. "100 %
sure it is a swing" is three gates, all required: QUIET ONSET — a candidate
opens only if a run of ≥ `minQuietBeforeMs` (350 ms) at ≤ `quietWristSpeed`
(0.45 bh/s) ended within `maxOnsetToTriggerMs` (1.2 s) of the crossing of
`triggerWristSpeed` (1.15 bh/s; walking arm-swing is never quiet that long);
CLOSE — ≤ `endWristSpeed` (0.5) continuously for `settledWindowMs` (160 ms)
after `minStrokeMs` from the crossing; PATH — the swinging wrist travelled ≥
`minWristPathBodyHeights` (0.3) relative to the hips, else silent drop. The
emitted window is `startMs` = last quiet sample (onset, so it contains the
ready position + backswing) … `endMs` = last settled sample (contains the
tail) — deliberately, because the JS `GeometricPhaseSegmenter` rejects any
window whose smoothed peak is < 2× its median speed ("no distinct stroke
peak … idle movement" = the "Nothing was rated" screen) and v3's
trigger-crossing→first-slow-sample windows were mostly fast. `manualStopConfig`
(stop button's offline pass) is the same algorithm at trigger 0.8 / quiet
250 ms / path 0.25. `PoseReadinessEvaluator` arms after 450 ms of stillness
(was 700) with center travel ≤ 0.055 — presentation only.

Chrome is OUR OWN, never UIKit's: no `UIVisualEffectView` materials, no
`UIButton.Configuration`, no SF Symbols. `CaptureGlassView` (surfaceDark at
60 % + hairline, continuous corners), `CaptureGlyphButton` (close / flip
glyphs drawn as 1.8-pt round-cap paths in the icons.tsx 24-box language),
`CaptureTextChip` (Manrope small caps: zoom presets, AUTO FRAME toggle),
`CaptureShutterButton` (chalk ring, volt radial core → flame stop square), all
in `GuidedCaptureViewController.swift`; colors come from
`CaptureChromePalette` (token values). Layout is three zones that CANNOT
overlap: top bar (close · zoom presets centered at default-high priority,
pushed off the neighbours on narrow phones · REC chip at the right), a
FIXED-HEIGHT (68 pt, one-line shrink-to-fit) left-aligned status card (state
dot + kicker + instruction), and the bottom row (AUTO FRAME when supported ·
STOP · flip, "Tap to stop and analyze" under the stop). The GUIDE BAND —
silhouette + `PoseOverlayView.guideRect` brackets — is derived in
`viewDidLayoutSubviews` from the laid-out card bottom and shutter top
(`guideBand()`), never from screen percentages, so on a 6.1" phone it spans
≈26–82 % and a body matching the outline is ≈0.4 of the frame
shoulders→ankles (inside the readiness evaluator's 0.32–0.88 window). Keep
every status string short enough for one line at 17 pt / 24 pt prominent
(≈34 / 26 characters) — longer copy shrinks. Overlay: heat glows are scaled by
`heatOpacity` (0.55) and drawn UNDER the exoskeleton (bones + joint nuclei,
normal blend with a dark contour) — the heat marks motion, it never paints
the athlete over. Android's `GuidedCaptureActivity` still runs the older
tap-to-start flow (not shipping).

## iOS camera overlays (coordinate-space invariant)

Pose landmarks are NORMALIZED-IMAGE space: top-left origin, **rotation
already applied** (native/vision-core `VisionCoreContracts.swift`). The
AVCaptureVideoPreviewLayer conversion APIs
(`layerPointConverted(fromCaptureDevicePoint:)` /
`captureDevicePointConverted(fromLayerPoint:)`) use the UNROTATED sensor
space — feeding landmarks through them drew the body heat map rotated 90°
and skewed off-center target taps. Overlay drawing and tap mapping MUST go
through the `AVCaptureVideoPreviewLayer.layerPoint(fromNormalizedImagePoint:)`
/ `normalizedImagePoint(fromLayerPoint:)` helpers in `PoseOverlayView.swift`
(displayed-picture-rect mapping + preview mirroring). Android's
`PoseOverlayView.kt` already does its own FILL_CENTER math — correct as is.

## Result copy for machine tokens

Uncertainty limiting-factor tokens (`paddle_track_unavailable`,
`checkpoint_unobserved:<key>`, `analysis_confidence_below_threshold`, …)
must never render raw: `strokeResultModel.ts limitingFactorCopy()` maps each
known token to noun / reason / ledger forms (checkpoint names come from the
shared `CHECKPOINT_NAMES` there; ResultScreen imports it). Unknown tokens
fall back to humanized text. Pinned in `strokeResultModel.test.ts`.

The three MODALITY tokens (`MODALITY_SCOPE_FACTORS`: paddle / ball / court
"unavailable") are structural — this engine has no paddle, ball or court
tracker and paddle-side checkpoints are measured at the hitting wrist — so
they are never phrased as a per-analysis failure: `selectInsight` skips them
(the old "We couldn't establish a paddle track — nothing was invented" line
must not come back), the ledger folds them into ONE calm `scope` footnote
(`MEASUREMENT_SCOPE_NOTE`). For a SCORED analysis the insight is measured:
`fixList(analysis)[0]` headline + coaching cue (`basis: measured_fault`), or
`measured_clean` when every checkpoint is green. The replay phase strip and
contact tick now come from `analysis.phases` (`phaseTimelineFromAnalysis` /
`effectivePhaseTimeline`, source `wrist`, tick = wrist-speed peak) whenever
the record carries no `temporalPhasesV2`; `UncertaintyNotes` is gated on the
same effective timeline (`contact_estimate` note instead of "contact wasn't
located").

## Form Review (flagship replay) + What to fix + drills

`src/review/formReviewModel.ts` (pure, pinned by `formReviewModel.test.ts`)
turns a ShotAnalysis (+ the hash-verified pose sidecar) into a
`FormReviewScript`: one `ReviewStop` per measured phase that has scored
checkpoints (contact always), `atMs` = the phase's `representativeMs`
(clip-relative, same axis as the sidecar), verdict fix/watch/strong from the
worst band, `headline` = measured fact (`stopHeadline`), `cue` =
`coachingCue(key, direction, shotType)` (85 pickleball cues, ≤150 chars, a
positive "keep it" cue for `none`), `focusJoints`/`jointHeat`/`reviewArrow`
dominant-side aware (`dominantSide` mirrors the phase segmenter's wrist-path
rule; `facingSign` mirrors the feature extractor). `fixList` / `strengthList`
feed `src/review/FixList.tsx` (What to fix, priority first) and the Result
insight; `recommendedDrillsModel.ts` + `RecommendedDrills.tsx` fetch
`GET /v1/catalog/drills?family=` and label the match honestly
(`DRILL_MATCH_NOTE`). The replay PLAYER is `src/review/FormReviewPlayer.tsx`
(props `analysis, clip, review, sequence, script, initialStop?,
stageHeight?, fill?`), hosted by BOTH `screens/FormReviewScreen.tsx` (route
`FormReview: { analysisId, phase? }`, a thin loader: evidence + sidecar hash
check + script, `fill` — no ScrollView) and the Result guide's page 2.
LAYOUT (2026-09-02, second pass — user feedback: "things overlapping…
cluttered"; the earlier "controls on the video" pass answered "I have to
scroll down to unpause", and BOTH constraints hold because the hosts pin the
player in a non-scrolling flex column): NOTHING IS DRAWN OVER THE BODY. The
stage carries only the video, `FormReviewOverlay` and the arrow + its volt
label (plus the rare partial-evidence caption); under it, as fixed-height
SIBLINGS in this order: the STOP CARD (testID `form-review-stop-card`: micro
row `<verdict dot + word> · <PHASE TITLE>` left / `STOP n OF m` right, the
measured headline in `type.caption` muted, the cue in `type.body` with
`minHeight` = 3 lines so the stage never resizes between stops — every cue
is ≤ 120 chars; the verdict word reads `PRIORITY FIX` when
`analysis.priorityFix.checkpoint` leads the stop, else FIX / WATCH / STRONG
tinted flame / volt / mint), the TIMELINE row (4 pt neutral band with the
played part in `onDarkMuted`, 10 pt verdict-tinted stop markers — the shown
one ringed `onDark` — a 14 pt knob, and the clock `0.00s` inline at the
right), and ONE SYMMETRIC TRANSPORT row centered around a 56 pt volt
play/pause: speed chip · prev · play · next · AUTO, the four outer chips all
44 pt `inkElevated` circles (AUTO fills volt when on). The card stays visible
while playing (it no longer covers anything). No phase chip, no clock chip,
no scrim, no phase-colored band, no "COACHING CUE" label, no legend. Tapping
the stage still toggles play/pause. `fill` makes the stage `flex: 1` (the
parent decides the height; `containRect` letterboxes inside). It plays the
clip through `ClipPlayer resizeMode="contain"` (+ `rate` for ¼×/½× — both
props exist on iOS + Android players and the bridge `.m`) and draws
`FormReviewOverlay` (react-native-svg) in the letterboxed `containRect` —
landmarks are normalized to the FULL video frame, so the overlay rect MUST be
the contain rect, never the stage. Auto-pause:
`nextAutoPause` fires once per stop per pass (visited set; scrubs re-arm
stops ahead of the new position) and seeks exactly to `stop.atMs` so frame
and skeleton agree. No frame within `POSE_FRAME_TOLERANCE_MS` → nothing is
drawn (never interpolated). Evidence: `strokeResultData.ts` adds `review`
(`width/height` + `poseSequence` ref) beside `clip`; `poseSidecar.ts` reads +
sha256-checks + `parsePoseSequence` exactly like `runCaptureAnalysis`.
CAPTURE URIs ARE ABSOLUTE `file://` URLS INTO THE APP CONTAINER
(`ClipMediaStore` writes `uri` / `posterUri` / sidecar `uri` as
`absoluteString`) and iOS relocates that container between installs — on
every Xcode build in practice — while keeping the files. Symptom (2026-09-02):
a clip that played yesterday renders a silent BLACK stage today AND its
sidecar reads "No verified pose sequence" (the old path fails the
Captures-root guard). Fix: every native reader resolves through
`ClipMediaStore.resolveCaptureURL(fromStoredUri:)` (recorded URL if it
exists → same UUID file name inside TODAY's Captures dir → else unchanged so
the caller fails honestly): `PickleClipPlayerView.sourceUri` and
`PickleVideoCapture.readTextFile`. A clip that STILL cannot open emits
`onClipError` (iOS `.failed` status / Android `setOnErrorListener`; Android
keeps emitting `onClipEnd` too) → `ClipPlayer onError` →
`FormReviewPlayer` unmounts the black layer and shows the "clip file is gone"
caption (`replayStageCaption(clip, sequence, clipUnreadable)`); the JS clock
drives the pose-only replay. The RN `Image` poster fallback still uses the
raw URI (only matters on builds without the native player). Never store or
compare container-absolute paths as identity; if you add a reader, resolve
first.
IMPORTED clips: `AnalyzeScreen` persists the extracted pose sequence back
onto the capture row (`updateCaptureClipPayload`) right after
`extractImportedPoseSequence`, so the review of an import replays its
exoskeleton on every later visit — before this the row kept the
pre-extraction payload and the review drew nothing.

RESULT = A 4-PAGE GUIDE (2026-09-02, `screens/ResultScreen.tsx`, pinned by
`__tests__/resultGuide.test.tsx`; NO PAGE SCROLLS on a 6.1" phone — user
feedback): dark shell (`surfaceDark`, the route's `contentStyle` matches so
nothing flashes light), top row close · segmented progress · "N OF M ·
LABEL", pinned footer (primary Next with a descriptive label, Back/Done
links). `GuideShell scroll={false}` gives a page a fixed flex column. Pages,
each evidence-gated and SKIPPED when its evidence is absent: **Score** (kicker
`ESTIMATED DUPR · <STROKE>`, the `ScoreRing` — big estimated DUPR, `EST.
DUPR` caption, `6.4 /10` micro line — then `DUPR_ESTIMATE_NOTE`
(`result-dupr-note`), ONE `selectInsight` sentence, THIS SET card) → **The problem**
(with replay evidence the page IS `FormReviewPlayer fill` and NOTHING else —
no kicker, no h1, no sub line, no "Full screen" link (2026-09-02: the page
headline only repeated the player's stop card and cost the video its height;
the full-screen route rendered the same player at the same size). It opens
frozen on the stop whose `checkpoints` contain the priority fix's `key`
(phase match is the fallback), so the card reads `PRIORITY FIX · <PHASE>` +
the fault's headline + cue on arrival. The kicker + h1 fault name + "Scored N
— direction" sub + ≤2 `FixList` cards render ONLY when there is no clip AND
no sidecar) → **Drills** (`RecommendedDrills dark` with per-drill Save →
`useTrainingStore().setDrillSaved`; empty/error → "Browse library") →
**Next** ("Ready for another swing?", ONE recap card `result-guide-summary`:
three tiles — `6.26` / `EST. DUPR` / `7.1 /10` micro, `strengthList(analysis, ∞)`
count / `HELD`, `fixList(analysis, ∞)` count / `TO FIX` — numerals in the
card `type.score` 30/34 role, then the rows Priority fix `name — direction`
(or "Every checkpoint held") and Strongest `name · score`; the footer "Try it
again" re-arm + Back · Done). There is NO "See full breakdown" link any more
(product decision 2026-09-02: the last page is a quick recap to move on
from). The ENTIRE former result surface still lives in `ResultBreakdownSheet`
(`StrokeResult hideCtaRow` + `FormReviewCard` + full `FixList` + stroke map +
provenance + `TrainingPlanSection` + `AnalysisFeedbackPrompt`), rendered by
the route `ResultDetails { analysisId }` (`screens/ResultDetailsScreen.tsx`,
`ScreenHeader "Full breakdown" dark`, loads through the shared
`useStrokeResultEvidence`; the SCORE page's footer links to it) and inline by
the abstained / legacy ONE-page case (the honest ledger) with Try again /
Done. THE WHOLE RESULT IS DARK (2026-09-10, user decision — "not the lighter
version"): `StrokeResult`, the ledger, measured rows, `UncertaintyNotes`,
`CheckpointRow dark`, `FixList dark`, `TrainingPlanSection` (`PlanDrillCard
dark`), `AnalysisFeedbackPrompt` and the details route all sit on
`surfaceDark`; there is no light sheet left anywhere in Result — do not
reintroduce one. The NOT-SCORED page (a `low_confidence` read: `analysis`
exists, `overallScore` null) hosts `FormReviewPlayer` INLINE as the replay
(`StrokeResult replaySlot`, pinned by `resultGuide.test` "not-scored read
with replay evidence"): `useStrokeResultEvidence` verifies the pose sidecar
for unscored reads too, and `buildFormReviewScript` on a score-less analysis
yields exactly ONE stop — the wrist-speed peak with the contact-only copy —
so the player shows the whole body with the exoskeleton and claims no
verdict. Result-null abstentions (AUTO family-only) keep the replay card,
which is now `contain` and sized from the recorded frame
(`replayStageHeight`: portrait → up to 420pt, landscape → 168pt) so the
body is never cropped to a 16:9 torso. In `FormReviewPlayer` the video is
drawn in its `containRect` as a rounded card (`form-review-video-card`) on a
stage that paints NOTHING — and the native `PickleClipPlayerView` /
`ClipPlayerView` backgrounds are transparent — so a portrait clip on a wide
stage never shows black pillarbox bars. `DaySecuredBanner` stays at shell
level (one-shot ceremony). Nothing new is said anywhere — every page reads
the same pure selectors as before; keep it that way and keep the audits
(`coachLockAudit`, `resultEvidenceAudit`, `zeroHandholdingCopyAudit`…)
green.

## Practice set (same-sitting re-analysis)

`src/analysis/practiceSet.ts`: every SCORED analysis in one sitting shares a
`sessionId` (a `local_session` row of mode `practice_set`, synced through the
existing `session.create` outbox kind). `planPracticeSet` (read-only: TRY
AGAIN handoff `sessionId` wins → live kv set within
`PRACTICE_SET_IDLE_TIMEOUT_MS` (20 min) → fresh uuid) runs BEFORE
`runCaptureAnalysis` so the id lands in the ShotAnalysis; `commitPracticeSet`
runs only after a scored outcome (session row + outbox + owner-scoped kv
`practice.set:<owner>` — registered in `OWNER_SCOPED_KV_NAMESPACES`), so an
abstained/failed run bookkeeps nothing (`analyzeScreenFullFlowE2E` pins "no
outbox write on network loss"). `sync.ts drainOutbox` drains
`session.create`/`finalize` rows BEFORE `shot.sync` and a
`shot.session_not_found` rejection does not spend the retry budget (the
session row was queued moments after the shot). `TryAgainHandoff.sessionId`
carries the set through Result → Analyze → camera. `RealAnalysisFact` now
carries `sessionId`, `priorityCheckpoint`, `checkpointScores`;
`src/progress/practiceSetProgress.ts` (pure, integer tenths, same
stroke + scoringModelVersion + shotConfigVersion only) →
`PracticeSetCard` ("THIS SET": Δ headline, attempt pills, one factual insight)
on the Progress Technique tab (`latestPracticeSet`, ≤24 h) and on the Result
surface (`summarizePracticeSet`, ≥2 comparable attempts).

## Library saved drills

A saved entry renders whenever its server catalog detail loaded
(`drillDetails[slug]` present); coach-reviewed `mappings` are a label on
SavedDrillCard ("Reviewed prescription" vs "Server catalog"), NEVER a
visibility gate — the backend serves `mappings: []` for every drill today,
so gating on it hid all bookmarks. Entries whose detail fetch failed stay
held with honest copy + retry. Pinned by `librarySavedDrills.test.tsx`.

## Live Court — REMOVED from the v1 launch (engine dormant)

The Live Court PAGE and every entry point were cut for launch (2026-08-31):
no `LiveCourt`/`LiveSummary`/`GameplayProgress` routes, no Home card, no
COACH-menu action, no Settings rows, no `live_court` paywall source, and no
coach-voice-selection surfaces (the onboarding voice step, Settings → Coach
voice screen, `src/audio/coachVoices|voiceCoachStore|CoachVoicePicker`, and
`src/coach/` characters were deleted; `tts.ts` is back to the plain
available/speak/stop port). Deleted screens live in git history for a
future version.

The ENGINE stays in-tree, tested and dormant, so a later release can
re-mount the page: `src/flow/session.ts` (SessionEventEngine wrapper),
`liveCourt.ts`, `sessionNative.ts`, `liveSessionCoach.ts` (deterministic cue
policy over `packages/audio-coach-core/src/liveSession.ts`),
`sessionProgress.ts`, `liveSessionSummary.ts`,
`src/progress/gameplayProgression.ts`, `repository.listLiveSessionHistory`,
and the native session capture + preview stack
(`SessionCaptureCoordinator.swift`, `PickleSessionPreview.swift`,
`PickleAudioCoach.swift` incl. its voice-catalog/speakCue methods — all
dormant, no JS callers). Engine suites still run: `liveCourt.test.ts`,
`sessionFlow/sessionNative/sessionProgress/sessionUiMapping/
sessionRealAnalysisE2E/liveSessionCoach/gameplayProgression` and
`audio-coach-core/test/liveSession.test.ts`. Do not add UI reachability to
any of this without an explicit product decision to relaunch Live Court.

## Drill videos (YouTube referer invariant)

- YouTube refuses embedded players that arrive without an HTTP Referer
  (error 153 "Video player configuration error"). NEVER point a WebView or
  `Linking.openURL` at a bare `/embed/` URL.
- In-app playback lives ONLY in `src/components/DrillVideoPlayer.tsx`: an
  IFrame API HTML shell loaded with `baseUrl` = `https://com.picklesensei`
  (the app's bundle id in YouTube's documented app-referer format), plus an
  automatic fallback ladder embed → in-app watch page → error card with
  retry. Player errors and a 12s silent-player watchdog both fall forward.
- Everywhere else (LibraryScreen, ResultScreen) embeds open `sourceUrl`
  (the canonical watch page), never `embedUrl`.
- Pinned by `__tests__/drillVideoPlayer.test.tsx` (the ladder) and
  `__tests__/drillLibraryScreen.test.tsx`.

## Launch splash (MP4 intro, 2026-09-01)

`src/screens/SplashScreen.tsx` plays `assets/brand/splash.mp4` (the user's
brand animation: 1080x1920 9:16, HEVC + AAC, ~5.0s) through
`react-native-video` 6.x (Fabric subspec; the Podfile's
`RCT_NEW_ARCH_ENABLED=1` env is what selects it at pod-install time). The
file is used byte-identical — never re-encode, trim, mute or resize it.
Invariants:

- `resizeMode="contain"` on a pure-white canvas: the video is shown WHOLE at
  its own 9:16, never cropped/stretched to the phone; every frame's edges
  are #FFFFFF so the letterbox is invisible. The native cold-start surfaces
  paint the SAME white — `LaunchScreen.storyboard` (plain white view, no
  imagery), `AppDelegate.swift` window + root view (`launchCanvas`), Android
  `styles.xml` `windowBackground` — so process start → first video frame is
  one surface. Changing one means changing all four.
- Sound plays (`volume` 1, not muted) but as NON-essential audio:
  `ignoreSilentSwitch="obey"` (ambient category — the ring/silent switch
  mutes it and it mixes over whatever is already playing) and Android
  `disableFocus` (never pauses the user's music). A device on silent hears
  nothing by design.
- "Skip" (`splash-skip`): fades in once `onProgress` reports ≥ 1s of
  playback, centered in the bottom 15% of the page, transparent background,
  pure-black `type.bodyBold` label with a soft shadow. Nothing else may be
  drawn over the video.
- Handoff: the first screen renders UNDER the overlay (App.tsx); the exit is
  a 520ms native-driven cross-fade that starts only when the intro is over
  (ended / skipped / `onError` / 8s watchdog) AND App.tsx `ready` is true. A
  JS-driven twin value ramps the player's `volume` to 0 alongside the fade so
  a mid-intro skip tails off instead of cutting. `pointerEvents` flips to
  `none` for the fade so the revealed screen is tappable at once.
- Jest: `__mocks__/react-native-video.tsx` auto-mocks the player as an inert
  host view carrying its props/callbacks; `__tests__/splashScreen.test.tsx`
  pins the contract above (fake timers; RN's jest NativeAnimatedModule mock
  ends native-driven animations after 16ms and never fires value listeners —
  that is why the volume ramp is a separate `useNativeDriver: false` value).
- The old static assets (`assets/brand/splash-glow*`, `splash-lockup*`, the
  `SplashGlow`/`SplashLockup` imagesets) are no longer referenced by JS or
  the storyboard; they are kept only until someone decides to delete them.

## Notifications (local only — no push service)

- `apps/mobile/src/notifications/`: pure planner (`plan.ts`) → `SchedulerPort`
  adapter over `react-native-notify-kit` (`service.ts`, the Invertase-blessed
  Notifee fork; the ONLY file that touches the native module, lazily) →
  owner-scoped zustand store persisted in SQLite kv (`notifications:<owner>`).
- Everything is opt-in (master off by default), re-synced on every foreground
  (App.tsx `useNotificationBootstrap`), cancelled for signed-out processes, and
  only ids under the `ps.` prefix are ever cancelled.
- Reminder copy must stay lock-screen-safe (no names/scores) and never claim
  unverified facts (e.g. streak defense is only scheduled while true).
- Jest: `apps/mobile/__mocks__/react-native-notify-kit.ts` and
  `__mocks__/react-native-reanimated.ts` auto-mock the native modules; suites
  needing custom reanimated behavior keep inline jest.mock (premiumTabBar).

## iOS builds

The shared scheme's Run configuration is set to **Release** (no Metro banners,
no LogBox/dev menu — what production users see). Switch Edit Scheme → Run →
Debug for fast-refresh development. TestFlight: `apps/mobile/ios/fastlane`
(`bundle exec fastlane beta`, Mac + ASC API key required); App Store binary:
`bundle exec fastlane release` (binary-only, never auto-submits for review).

## App Store release invariants

- `PickleSensei.entitlements` MUST declare `com.apple.developer.applesignin`
  (Sign in with Apple; asserted by `npm run check:distribution`). Team
  `H26U6W4K6V` is the PAID Apple Developer team (confirmed 2026-08-30; the
  personal team kept its ID when the membership was purchased). Team ID lives
  in BOTH `project.pbxproj` (DEVELOPMENT_TEAM) and `ios/fastlane/Appfile`
  (team_id); the check script asserts they match. The App Store Connect API
  key for fastlane is `~/.appstoreconnect/AuthKey_PLHCZDTYYS.p8` (key id
  `PLHCZDTYYS`; never committed).
- Account deletion (App Review 5.1.1(v)): Settings → Manage account
  (`src/screens/ManageAccountScreen.tsx`) → quiet "Delete account" link →
  `src/account/deletion.ts` → two-step `/v1/me/delete-request` +
  `/v1/me/delete-confirm`. Deliberately one level off the Settings root but
  never deeper (Apple requires in-app deletion to stay findable). The final
  confirm button stays disabled ~5s, which must exceed the server's 3s
  challenge min-age. Only synced (non-guest) sessions show the Manage account
  row/link. Pinned by `__tests__/manageAccountScreen.test.tsx`.
- Exit survey (2026-09-02): the delete link opens a CENTERED pop-up
  (`DeleteAccountDialog`, same file) that steps Q1 "What's making you
  leave?" (7 single-select reasons) → Q2 "What would have kept you?" (6
  options + optional ≤500-char comment) → the unchanged confirmation.
  Header = back / "QUESTION n OF 2" segmented progress / close; pages slide
  in from the side they came from. Every page is skippable (Q1 "Skip the
  survey" sends nothing; Q2 "Skip this question" keeps Q1) and close always
  keeps the account — never gate deletion on it. Answers travel in the
  step-1 body (`POST /v1/me/delete-request { survey }`) so they are stored
  BEFORE the account exists no more; the server drops an unknown reason (or
  just an unknown `wanted`) but never the deletion. Vocabularies live in
  `ACCOUNT_DELETION_REASONS` / `ACCOUNT_DELETION_WANTED` (`deletion.ts`) and
  the edge fn's `DELETION_SURVEY_REASONS` / `DELETION_SURVEY_WANTED` —
  change both sides together. Table `public.account_deletion_feedback`
  (`20260902000000_account_deletion_feedback.sql`, `wanted` column added by
  `20260902120000_…_wanted.sql`) is one of the TWO rows that outlive
  deletion (the other is the free-rating identity ledger, see "Scale &
  security"): FK `ON DELETE SET NULL` anonymizes it (`user_id` null ⇒
  actually deleted; non-null ⇒ requested but kept), insert-only from clients
  (no SELECT), append-only via its own trigger (the generic
  `reject_ledger_mutation` would block the SET NULL and break deletion).
  Server stamps churn context (provider, platform, app_version,
  account_age_days, was_premium, scored_count). Disclosed in the privacy
  policy §5 (`legal.ts`). Query it in the Supabase SQL editor (service role).
- Paywall legal links (App Review 3.1.2): `runtimeConfig.legalPrivacyUrl` /
  `legalTermsUrl` point at the API function's public `GET /privacy` and
  `GET /terms` pages (`supabase/functions/api/legal.ts`); wired in
  RootNavigator's PaywallRoute and Settings → About.
- `Info.plist` declares `ITSAppUsesNonExemptEncryption=false` (HTTPS only) so
  App Store Connect skips the export-compliance question per build.

## Archived 3D Analysis direction (future v2, 2026-09-05)

This section records the parked v2 direction only. The later 2D production
and v1 integration decisions below control this checkout.

The new 3D Analysis system is the intended REPLACEMENT for primary 2D
exoskeleton/heatmap analysis, not a permanent optional viewer or second mode.
Keep shipping 2D functional during validation, then make released, eligible
3D analyses canonical through Result, navigation, loaders, state and storage.
Legacy 2D remains only where a documented technical fallback, regression
baseline or historical-record reader is necessary. Preserve raw 2D observations
when the chosen 3D estimator needs them; that does not preserve a competing UI.

The one analysis has synchronized actual reconstructed motion, a qualified
coach-reviewed compatible exemplar (otherwise eligible earlier own-best,
otherwise no reference), and a separately labelled modelled correction of the
player's own body. Preserve proportions, handedness and unaffected movement;
modify only supported components. Generated motion never becomes measured
truth, a rating, a reference observation or training ground truth.

Require separate visualization-, comparison-, coaching- and scoring-grade
validation, plus corrected-motion, UX/performance, physical-device, privacy,
release and migration checks. Passing one grade does not authorize another.
Keep unsupported capabilities blocked; do not unlock from finite XYZ values,
a demo, LLM agreement or synthetic tests. The current 2D operational guidance
above remains the shipping safety contract until the versioned cutover gates
pass; it is not a requirement to retain that primary experience forever.

The existing Astra master plan is `docs/prompts/astra-app-improvement.md`.
It defines the audit, experiments, evidence requirements, strict acceptance
criteria, route/history parity, rollback and retirement work. Canonical cutover
requires scoring-grade approval too: no 2D-score/3D-coaching hybrid, and no
legacy score to rescue a failed 3D-eligible run. Legacy scoring is limited to
explicit out-of-scope cohorts or an authorized rollback policy for new runs.
Before 3D writes, partition rank/best/comparison semantics by scoring definition
across SQL, shared code and Edge; do not blend 2D and 3D scores. Own-best requires
same-athlete evidence and approved 3D quality/review, not a legacy 2D score.
Platform/OS scope, same-clip re-analysis charging and rank-partition display
need explicit decisions before release. Follow the plan's
VERIFIED / MEASURED / PARTIAL / BLOCKED distinctions. No runtime cutover,
production deployment or legacy deletion is authorized merely by updating
the plan. Preserve account, consent, entitlement and scoring-history safeguards.

## V1 UI and analysis boundary (owner decision, 2026-09-06)

- V1 remains on the existing 2D analysis and replay path. Future 3D work is
  parked on `codex/3d-analysis-v2`; do not merge its estimator, native bridge,
  storage, routes or experimental viewer into v1, including Debug entry points.
- UI refinements preserve current main's auth, permit, scoring, persistence,
  consent and billing safeguards. Do not replace these with older branch code
  while resolving visual-change conflicts.
- Preserve the approved marks and original splash media. Use existing ink,
  chalk, court and volt tokens, flat surfaces, and meaningful motion only.
  Contextual guidance is text-first; decorative glows and particles stay out.
- iOS typography uses bundled Manrope PostScript names and explicit weights;
  Android retains its asset-name families. Essential text scales and wraps.
  Native price wrapping switches to wider cards, never a smaller font.
- Verify safe areas, full prices, rank text, recovery controls and effective
  touch targets on small phones with maximum Dynamic Type. Renderer tests are
  not native layout proof; keep synthetic fixtures offline and labelled.

## Supabase production hardening (2026-09-05)

- `20260905190106_api_only_database_access.sql` and the matching Edge Function
  require a coordinated rollout. Applying the migration blocks the old
  function's database requests; deploying the function first leaves its new
  RPCs unavailable. Obtain approval for a maintenance window, or stage the
  credential/session helpers before deploying and enforcing the policies.
  Do not deploy either half alone. No mobile update is required.
- User database requests carry the user's Supabase bearer plus an internal
  `x-pickle-api-key`. The Edge Function reads that key through the
  service-role-only `get_api_request_key()` RPC and caches it for 60 seconds.
  Keep the credential in `api_private.request_key`; never put it in mobile
  config, user responses, logs, or Redis. Rotation requires an operator to
  change the private row and allow the Edge cache to expire.
- Retain the RESTRICTIVE `api_requests_only` policy alongside owner RLS on
  user-accessible tables. Keep user RPCs SECURITY INVOKER and derived views
  `security_invoker=true`. A definer conversion can bypass the API gate.
  The security matrix pins table/column grants and the callable RPC allowlist.
  Add explicit grants and policies when introducing a new database surface.
- `is_api_session_active()` checks the JWT session id against `auth.sessions`
  and checks `not_after` and `auth.users.banned_until`. Run it after the user
  rate limit and before protected responses or side effects, including cached
  rank/progress and billing. Do not cache its verdict. Missing server proof
  raises a database error, which the API reports as retryable 503 rather than
  signing users out; a valid proof with a revoked session returns false/401.
- `service_role` bypasses RLS but still needs SQL grants. Historical fixes
  added missing direct-write grants, but ordered-billing and deletion
  migrations replace those writes with narrowly granted RPCs. Reconcile the
  reservation-era grants in `20260907110000_api_audit_integration.sql` through
  the forward readiness migration before rollout. Use the helpers appropriate
  to the applied migration boundary; never restore obsolete billing,
  webhook-audit or credential DML grants to make old callers or fixtures pass.
  Keep all client writes revoked and completed audit history immutable.
- Permits never reopen from a terminal state. The integrated late-sync RPC may
  settle an expired reservation through its vouch-aware path; the integration
  migration preserves that without allowing permit metadata to be rewritten.
  Shot/session and detail/shot ownership checks apply at the database layer.
  Captures and measurements have no API writer; keep their client write
  grants revoked until an approved feature requires them.
- Auth network failures, upstream 429s, and 5xx responses return retryable 503,
  not a revoked-session 401. Refresh uses one bounded REST request, avoiding
  the SDK's internal retry loop. JSON limits: 64 KiB normally, 512 KiB for
  webhooks, 5 MB for shot batches/evaluation trials; body deadline 30 seconds.
- Edge tests: `npx --yes deno@2.5.6 test -A --no-check --config
supabase/functions/api/__wf__/deno.json supabase/functions/api/__wf__/`.
  CI's `edge` job runs these, the frozen-lock entrypoint typecheck and offline
  cryptographic vectors through `scripts/verify-cloud.sh`; `supabase-security`
  runs the RLS matrix and repository security scan. The SQL shim tests broad client
  defaults AND absent service-role DML defaults; both require explicit grants.
  The local load stub now needs `SUPABASE_SERVICE_ROLE_KEY=stub-service-role-key`
  on the local Edge process, alongside its fake URL and anon key.
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` were set on
  2026-09-06. Shared rate limits apply while Redis is reachable; missing
  configuration or Redis errors fall back to per-isolate counters.
- Supabase Auth rate-limits `/auth/v1/token` per client IP, and behind the
  function every user shares one egress IP. When `SB_SECRET_KEY` holds a
  modern `sb_secret_…` key, `authApiHeaders()` uses it as the `apikey` on
  every Auth call (id-token exchange, getUser, refresh, logout) and adds
  `sb-forwarded-for` = the edge-authoritative client IP (`clientIp()`, IP
  literal only). Auth honours that header only with a secret key AND the
  Auth dashboard's IP-forwarding opt-in (enabled 2026-09-06). REST calls
  never use the secret key: they keep the publishable key + the USER's
  bearer, so RLS is unchanged. Pinned by `__wf__/auth_ip_forwarding.test.ts`
  (secret mode) and `account_routes.test.ts` (publishable fallback).
  Live Auth logs confirmed the forwarded client IP on 2026-09-06.

## Production stays 2D; 3D is parked for v2 (2026-09-05)

The owner explicitly chose to keep the previous 2D analysis for production.
The main checkout's mobile, native and shared-analysis code has been restored
to the pre-3D baseline `c23b266`; this includes Debug as well as Release.
Do not reintroduce the 3D pipeline into this checkout without a new request.

The complete in-progress 3D code, tests and research are saved on local branch
`codex/3d-analysis-v2`, commit `3616560`, in the separate worktree
`/Users/raunakgengiti/Pickle-Sensei-3d-v2`. That snapshot is future v2 work, not
an approved release. The existing Astra master plan remains its roadmap;
its implementation addendum describes archived work, not the current main app.
Unrelated backend changes and the separate Astra app-polish worktree are retained.

Never run Debug and Release Xcode builds concurrently against the same Pods
directory, even with separate DerivedData paths: RN's dependency/core/Hermes
configuration scripts replace shared prebuilt frameworks. Run them serially.

## Local analysis durability and verification (2026-09-06)

- Mobile verification uses Node 22, matching CI. The journal/pipeline tests use
  Node's built-in `node:sqlite`; Node 20 is insufficient for those suites.
  `apps/mobile/testSupport/sqlite.ts` runs the actual local migrations with a
  real in-memory SQLite engine. It is test-only, not a shipping native adapter.
- `getDb()` serializes native statements through the OP-SQLite transaction
  queue. Use `withTransaction(rawDb, async rawTx => ...)` for a compound write;
  do not issue manual `BEGIN`/`COMMIT` through the public `getDb().execute()`.
  Derive `forDataOwner(rawTx, context)` for owner-sensitive repository writes.
  `DataOwnerContext` includes a generation, so A → sign-out → A invalidates old
  work even though the UUID is the same.
- The legacy online analysis journal is `analysis_run_journal`. Reservation
  identity is durable before HTTP; the committed marker, practice set, result,
  and outbox share one transaction. Ambiguous commit acknowledgement means
  HOLD/recover, not refund. Operational journal methods take a raw database
  and immutable original owner/origin; never pass an owner-scoped handle or
  substitute the currently signed-in account. Recovery excludes active
  execution, not merely mounted screens. Register new owner tables/namespaces
  in the repository purge allowlists.
- A `replayed` analysis outcome reopens the existing result without another
  review request. `recovery_pending` must not claim that nothing was rated or
  mint another operation automatically. These guarantees are not the signed
  offline wallet; that protocol is still separate unfinished work.
- Guided capture, import, and extraction accept an operation ID/AbortSignal.
  Cleanup must abort its own operation, not call the global no-argument cancel
  from a stale screen. Native cancellation can reject promptly while retaining
  the busy barrier until existing work drains.
- The auth-owned billing lifecycle automatically reconciles through our
  backend REST API, including after a restart without a purchase marker.
  It does not call StoreKit purchase/restore/sync methods. Retries run only
  while active, using the store's bounded backoff and captured configuration.
  Ordinary bearer rotation must not reconfigure it. Preserve
  `billing.pending-fulfilment:<owner>` on sign-out; discard/invalidate it only
  for that owner after confirmed account deletion.
- Diagnostics are disabled until provider, disclosure, native-privacy and
  release-identity gates are approved. Do not add `Sentry.wrap`, another global
  handler, automatic native collection, or an upload token to bypass these
  gates. The current Xcode wrapper prepares local artifacts with uploads
  explicitly disabled; an unsigned build and matching dSYM are not live
  symbolication or device certification.
- FFmpeg 9 removed `-vsync`; current timestamp fixtures use the output option
  `-fps_mode passthrough`. Keep the VFR/duplicate-PTS assertions unchanged.
  A host without `drawtext` still cannot run the broadcast-overlay fixture.

## Follow-up reliability checks (2026-09-06)

- Rank, streak and walkthrough presentations share `flow/CeremonyHost.tsx`.
  The iOS host uses the installed `FullWindowOverlay`, not a native Modal
  controller: an absent `onShow`/`onDismiss` must never hold input or block the
  queue. Preserve native-fullScreenModal layering, owner generations, stale
  handler protection and interrupted requests. Renderer tests are not proof
  of native touch recovery or VoiceOver behavior.
- Consistency ledger absence and unreadable/corrupt/future-version data are
  different states. Unknown data cannot authorize a replacement ledger,
  milestone ceremony or drill/day marker write. Preserve the same owner's
  last valid snapshot and surface a load error instead of inventing an empty
  history; notification snapshots must not use incomplete drill facts.
- `__tests__/xc/xcMatrixNetworkAuth2.keeper.test.ts` retains 1,500 default
  seeds in 60 batches of 25, with a fixed virtual epoch and drained request,
  timer and listener cleanup. `XC_SEED` replays a uint32 seed; `XC_SEEDS` may
  select 1–10,000 seeds. Do not replace this with a larger global timeout,
  force-exit, skipped seeds or callbacks running after teardown. For repeated
  verification, set `XC_OUT` to an explicitly owned temporary artifact
  directory so new machine reports do not dirty the repository or its
  subsequent formatting check; this does not change seeds or coverage.
- A RevenueCat webhook audit row is a completion marker. Failed verification,
  entitlement persistence or audit storage returns retryable failure, not a
  successful acknowledgement that suppresses replay. FK failure alone does
  not prove a missing account; require the ticket RPC's locked Auth-row
  absence or an authoritative Auth admin `user_not_found` response.
  Previously poisoned markers need approved reconciliation, not an
  unrequested bulk deletion. Ordered verification is implemented and locally
  tested, but its cutover must drain old writers and coordinate the migration,
  Edge deployment and PostgREST reload before traffic resumes.
- Request Content-Length is advisory for rejection only, never a reason to
  allocate its claimed size before bytes arrive. The Edge body reader starts
  at bounded 8 KiB and grows from actual received bytes while preserving the
  existing per-route caps, cancellation and deadline.
- Native UI acceptance uses a fresh explicitly owned simulator, a dedicated
  Metro port and an external XCTest runner. The app is ad-hoc signed for
  simulator secure-storage testing; unsigned Release compilation does not
  establish Keychain behavior. The canonical Mac app build uses Xcode's
  `CODE_SIGN_IDENTITY=-` simulator path so simulated entitlements enter the
  binary; adding restricted entitlements with a post-build codesign command
  is not equivalent. No distribution certificate or profile is used. Missing
  Keychain entitlements fail the launch gate. Preserve other simulators.
- Hermes Inspector did not await the app's Promise implementation through
  CDP `awaitPromise`: it returned the Promise representation. Raw injected
  async helpers also returned premature DB results in the UI probe. Compile
  injected harness helpers with the installed Babel transforms and await
  explicitly observed completion; do not alter production Promise globals.
- In the iOS walkthrough's actual XCTest hierarchy, a React Native
  ScrollView testID identifies an `Other` wrapper; the native `ScrollView`
  is its child without that identifier. Resolve the wrapper first and then
  its native scroll descendant. A failed `app.scrollViews[id]` lookup does
  not establish that the UI lacks scrolling. Keep native button hit/viewport
  assertions and verify the end of overflowing copy using real swipes.
  Inspector clients must send the matching localhost Origin rather than
  disabling Metro's origin checks.
- Native test success requires an xcresult with the intended test actually
  executed, correct device/runtime, zero skips/expected failures, and no
  failures. An exit-zero selection that ran zero tests is not proof.
- Onboarding still requires a name (one trimmed character minimum, existing
  length cap); it may be a preferred name or nickname, not a verified legal
  name. Preserve the questionnaire, pre-auth ordering, and historical optional
  storage fields. Updated legal source remains an unpublished draft until an
  approved deployment; do not claim the live privacy page changed.
- The mobile CI job runs `node --test
scripts/generate-third-party-notices.test.mjs` and the generator's `--check`.
  These are offline source/provenance checks, not current-app clearance.
  Final native delivery also requires `--check-app` with the actual fresh
  Release source map and explicitly computed bundle/map hashes. Keep the
  vendor Sentry privacy resource in its own bundle, not the app manifest.
- Native Supabase SwiftPM linkage was removed with owner approval to preserve
  iOS 15.1. The business API uses JS and the Edge service; Apple/Google auth,
  Google AppAuth, Keychain, RevenueCat, and the CocoaPods aggregate remain.
  Do not re-add the unused Swift products to silence a dependency warning.
- A Devin renderer crash (`reason: crashed, code: 5`) was recorded on
  2026-09-07. It is separate from native application test failures. Until the
  environment is stable, keep active workers bounded, native builds/tests
  serial with low job counts, and tool output compact. Retain full test
  evidence in result bundles/reports instead of flooding the chat. Do not
  disable system security/indexing or change IDE settings as a workaround.
- Geometry v2 (`geometry-2`, `phase-geometry-2`, `features-geometry-2`) bounds
  phases to observed samples and does not infer recovery from clip duration.
  Optional missing phases omit dependent metrics; missing ground or forward
  direction is not filled with image-bottom/rightward defaults. Keep the
  scoring checkpoint weights and missing-observation penalties intact.
  Fusion passes actual width/height into each phase call; the mobile phase
  provider has no square-video fallback. Historical v1 records are not
  rewritten or silently upgraded. The geometry/pipeline regression suites
  cover these contracts; native media timing and scientific approval remain
  separate requirements.
- REGRESSION FIXED 2026-09-10 ("it doesn't score any more"): geometry-2
  dropped `recovery_time_ms` (it was the trigger window's tail padding —
  every v1 read showed "Recovery · 100") but sm-v1 still listed it as the
  `recovery` checkpoint's metric, so recovery became PERMANENTLY unobserved
  and the engine counted its weight (4–7%) as zero confidence on every read.
  Real Apple-Vision footage sits at 0.60–0.70 against the 0.65 abstention
  floor, so reads the v1 stack scored came back NOT SCORED (verified on all
  six `datasets/paddle-bench/runs/*` pose sequences: every clip v1 scored,
  v2 abstained on; with the fix the two agree wherever the phases agree).
  `recovery` now carries `metrics: []` in `packages/scoring/src/config/v1.ts`
  — NOT APPLICABLE (out of the confidence and score denominators, absent
  from `checkpoints`, no `checkpoint_unobserved:recovery` factor) — pinned
  by `packages/scoring/test/engine.test.ts` "never drags analysis
  confidence toward abstention". Rule: a checkpoint no extractor can measure
  must be not-applicable in the config, never a per-capture unobserved
  penalty; when a real recovery measurement exists, add the target back.

## Always-score contract (owner decision 2026-09-10 — "never show me this screen")

Field failures on the same day: a live Auto Analyze swing ended on "Your saved
analysis is held. Acceleration and contact-proxy observations are required."
(`features.missing_phase`: the window opened on the forward swing, the
run-up span collapsed to nothing and the WHOLE read was refused), and every
scored read — import or camera — carried "The server refused this read 8
times (shot.invalid_payload: Each phase needs key, startMs, representativeMs,
endMs, confidence.)": the segmenter cut the contact proxy at peak ± half a
FRACTIONAL sample interval and the edge `isMs` check (`Number.isInteger`,
`shot_phases` int columns; `PhaseSpanSchema` says `.int()`) refused it.
Once a clip with a tracked body reaches analysis, the product ALWAYS returns
a score from what was measured and discloses the rest; refusal is reserved
for footage with literally nothing to measure. Concretely:

- `toSyncPayload` (`apps/mobile/src/data/sync.ts`) is the ONE wire shaper:
  `timestamps` and every phase go out as whole ms (`Math.round`), phases
  carry exactly the five server fields, confidences are clamped to [0,1].
  Never send `analysis.phases`/`timestamps` verbatim; the offline-receipt
  digest (`toOfflineOutput`) goes through the same function so spend and
  replay agree. Pinned in `__tests__/sync.test.ts`. The server stays strict.
- `phase-geometry-3` (`packages/vision-geometry/src/phaseSegmenter.ts`):
  whole-ms boundaries; `accelerate`/`contact` guaranteed for every peak (the
  run-up keeps ≥1 sample before the peak, or the first observed frame),
  `prepare` keeps ≥1 sample (no visible backswing = a SHORT backswing, not
  unobserved); the run-up starts at the paddle-set speed DIP (walk back while
  non-increasing and ≥25% of peak), not at 25% alone; the analysis reads
  context frames around the trigger window (`PRE_CONTEXT_MS` 2000 /
  `POST_CONTEXT_MS` 1500 = the capture's own pre/post-roll; `ready` may
  borrow ≤500 ms before the backswing) while the peak is chosen INSIDE the
  window; the peak is the fastest local maximum whose run-up carried the
  wrist ≥ `MIN_RUN_UP_TRAVEL_TORSOS` (0.1 torso) — label swaps and jitter
  spikes are skipped, not mistaken for contact (`peakCandidates`, hint
  neighbourhood first); "no distinct stroke" is a confidence factor
  (`distinctness/2`, clamped 0.5–1), never a refusal. Abstentions left:
  `phase.too_few_pose_frames` (<6 frames ANYWHERE), `phase.wrist_not_tracked`
  (<4 speed samples anywhere), `phase.no_motion` (smoothed peak <0.05 ih/s,
  or flat AND slow — ratio <1.8 AND peak <0.45 ih/s — or every candidate's
  run-up travel under the torso rule), `phase.invalid_observations`. All six
  `datasets/paddle-bench/runs/*` real clips score on their recorded windows
  (they previously failed `no_distinct_stroke` or abstained).
- `features-geometry-3` (`featureExtractor.ts`): a missing accelerate/contact
  span falls back to the neighbouring measured phase (`resolveSwingSpans`,
  confidence ×0.5) — refuses only with NO phase at all; torso and ground fall
  back from the window to the WHOLE recording (fail only when the torso was
  never measured anywhere); forward direction falls back to the first/last
  visible run-up wrist. Missing joints still omit their metrics.
- Scoring (`packages/scoring`): `MIN_ANALYSIS_CONFIDENCE = 0`; the engine
  abstains ONLY when no applicable checkpoint was observed. Coverage is
  disclosed by `analysisConfidence`, the `lower_confidence` presentation
  (<0.8) and unobserved checkpoints (score null / band `unscored`). The 0.65
  floor was calibrated on 0.95-visibility fixtures; Apple Vision measures
  0.60–0.70 with every checkpoint observed. Do not reintroduce a floor.
- Pre-analysis gate (`pre-analysis-gate-3`, `preAnalysisGate.ts`):
  `BLOCKING_GATE_REASONS` = no_person_found, torso_not_measured,
  too_few_pose_frames, insufficient_fps (+ every frame-statistic reason);
  `ADVISORY_GATE_REASONS` = body_not_fully_visible, person_implausible_scale,
  tracking_dropout_gap, stroke_window_tracking_gap, low_pose_confidence.
  `decision.blocking` gates the phone path (`runCaptureAnalysis`), NOT
  `analyzable`; advisories travel as `capture_quality:<reason>` limiting
  factors (`captureQualityLimitingFactors` → `analyzeCapture` option
  `captureQualityFactors`) and cap the presentation at `lower_confidence`
  (a degraded read is never presented as normal). `strokeResultModel.ts`
  has copy for each. The visibility matrix's `must_not_be_confident`
  scenarios now SCORE with lower_confidence; `exit_reenter_through_contact`
  and `spectator_gesture` were reclassified accordingly.
- Versions: `geometry-3`, `phase-geometry-3`, `features-geometry-3`,
  `temporal-stroke-heuristic-6` (manifest + `visionProviders.test.ts` +
  `registry.test.ts`). `sm-v1` is unchanged (weights/targets untouched).
- Native heuristic-6 (`TemporalStrokeDetector.swift`, 78 tests): a wrist
  ACCELERATING past `strongTriggerWristSpeed` (2.5 bh/s; previous sample
  ≥ `strongCrossingMargin` 0.05 under it) opens a candidate WITHOUT a quiet
  onset — `startMs` = that wrist's latest quiet sample inside the onset
  horizon (`lastQuietSampleMs`), else the trigger interval start; a strong
  candidate that never settles COMPLETES at `maxStrokeMs` (path gate still
  applies) instead of being dropped; a hand already waving at threshold
  speed is not a crossing. Motion between 1.15 and 2.5 bh/s keeps the
  heuristic-4/5 onset rules. STOP & ANALYZE: `strongestEvent ??
fallbackMotionWindow` (window around the fastest hip-relative wrist
  interval ≥ `fallbackMotionFloor` 0.7 bh/s, −1000/+800 ms clamped to the
  file) — the spool is discarded only when nothing in it moved.
- Held screen (`AnalyzeScreen showOriginalRecovery`): when the ORIGINAL run
  reserved a permit and the analyzer returned its own verdict that the clip
  cannot be measured (`unavailable` with a reason; attempt released `failed`,
  no technical failure, no result), the screen is "Nothing was rated." +
  the verdict + "Record another clip" (`recovery: 'retry'`) — never the
  "Check saved analysis" loop, which only reconciles permits and cannot
  change a measurement verdict. Reconcile passes without a verdict,
  unclassified throws and no-permit refusals (release authority, reserve)
  keep the held/reconcile screen exactly as before. Pinned in
  `analyzeScreenFullFlowE2E` "a clip the analyzer cannot measure".
- Tests that need an ABSTAINED run (`kind: 'low_confidence'`) can no longer
  get one from the real engine: `__harness__/abstainingScorer.ts`
  (`installAbstainingScorer`) turns `analyzeCapture`'s verdict into the exact
  engine abstention for the fixtures' own marker (every frame confidence
  ≤ 0.5, the old "visibility 0.5" trick); the suite must namespace-mock
  `@pickle/analysis-pipeline` (`{ __esModule: true, ...actual }`).
- Mobile jest needs Node ≥22 (`node:sqlite`); on this Mac use
  `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx jest`.

## First-swing capture and monitoring (2026-09-06)

- The iOS trigger is `temporal-stroke-heuristic-6` (see the always-score
  contract above for what v6 added). Each wrist has its own
  quiet onset; only qualified motion contributes to the event, and the
  selected wrist must supply its own observed settled tail. A hidden wrist
  cannot borrow the other hand's stillness. Stillness uses bounded adjacent
  intervals (at most 125 ms) and sample counts; velocity still caps gaps at
  250 ms. Synthetic coverage includes 8/10/15/30/60 fps and both hands.
- `captureStrokeVideo({ handedness })` passes the player's saved hitting hand
  through `captureWithOptions` to the native trigger and manual-stop pass.
  Older native binaries and ambidextrous declarations retain the no-argument
  bridge fallback. This is declared context, not detected paddle identity; a brisk movement of the
  hitting hand can still be ambiguous. Do not claim perfect stroke accuracy.
- `isTrackingLimited` is advice, not another trigger gate. Native capture
  replaces "Swing when ready" with lighting/cooling guidance while observed
  pose cadence is insufficient and uses hysteresis before restoring readiness.
  A captured/saving state never regresses on late readiness events. JS scopes
  progress to the active native capture and ignores late/foreign callbacks.
- Classifier `stroke-heuristic-9` bounds all pose, paddle and speed evidence
  to the isolated swing, including neighboring raise/facing/wrist features.
  An overhead additionally needs two in-window observations of the wrist and
  elbow above their own visible shoulder, independent of torso normalization.
  `fusion-2` validates confidence and hierarchy before routing a prediction.
  The mobile bundle is `on-device-fusion-2`; evaluation records read the
  actual result's bundle version. Pose-only AUTO still identifies a side
  family or overhead, not an unobserved drive/volley/bounce distinction.
  The existing dev real-pose benchmark did not improve its aggregate labels;
  synthetic regression passes are not field-validation evidence.
- `Production Monitor` runs bounded public probes every 15 minutes on main.
  The monitor-only slice added no mobile SDK; the later Sentry foundation
  remains disabled pending the approvals described above. Apple's opt-in
  crash reports require verified dSYM symbolication and the owner procedure
  in `docs/OBSERVABILITY.md`. Database readiness is explicitly unverified until
  the coordinated backend rollout is approved, deployed, and the repository
  variable `PRODUCTION_MONITOR_READINESS` is enabled. Never enable it against
  the old static health response. Workflow notification delivery and physical
  iPhone capture remain checks for the responsible owner.
- Local full verification needs Node 22 for mobile and Bash 4+ for the
  security scanner; Bash 3.2 remains a separately tested script contract.
  Timestamp fixtures updated by the readiness work use `-fps_mode passthrough`.
  Check any remaining legacy `-vsync` callers against the installed FFmpeg;
  FFmpeg 9 removed that option. Never weaken timestamp assertions.
  A Docker-free edge audit can use `PICKLE_AUDIT_MATRIX_PG_URL`, which must
  point to an empty, disposable loopback PostgreSQL database.
- Pin `PICKLE_CI_SIMULATOR_UDID` (or the Mac workflow's `simulator_udid`
  input) to a dedicated disposable iPhone for native verification. A pin
  disables other-device cleanup and fails instead of falling back when the
  chosen device is unavailable. The launch check reinstalls its selected app;
  never point it at a simulator whose app data should be kept.
- iPhone clip storage (2026-09-10): `GuardedClipFile.withParent` opens the
  OS-provided app home or process temp directory directly, then applies
  `O_NOFOLLOW` to each child. Never walk from `/`: the simulator can permit
  ancestor reads that the physical iPhone sandbox denies. Provider imports
  copy into operation-owned Captures storage before guarded metadata checks;
  file access, protected content, unsupported movies and missing video tracks
  have distinct failures. `tools/macos-ci/test-clip-storage.py <new-output-dir>`
  compiles the shipping storage code and tests it in a root-read-denied macOS
  process with disposable home/temp directories. The canonical Mac
  `swift-native` stage runs it; this is not physical-device acceptance.
- React Native 0.87's `URL.pathname` parses HTTP(S), not `file://`: it returns
  `/` for a capture URI. Saved-analysis validation and confirmation hashes use
  `captureArtifactFileName` from `camera/nativeMediaIdentity.ts`, the existing
  strict non-normalizing parser. Do not replace it with the global URL parser
  or synthesize missing byte proof. `originalAnalysisRetry.test.ts` exercises
  the installed React Native URL class as well as Node's implementation.
- The shipping import review uses `TargetSelector automaticOnly`: one enabled
  Analyze video action, no player tap or fabricated seed. Persisted selections
  on older analyses and the native target-tracking contract remain unchanged.
- Launch audio uses the app's `.ambient` / `.default` session before React
  starts. The installed react-native-video 6.19.2 manager otherwise combines
  `.ambient` with `.moviePlayback` and repeatedly fails with OSStatus -50.
  Its public management-disable API and the splash's matching prop prevent
  those category rewrites without muting the original intro or ignoring the
  silent switch. Import copies finish inside the provider callback; metadata
  work then runs asynchronously at enforced default QoS, matching AVFoundation
  completion work rather than blocking a user-initiated picker callback.
- Production state checked 2026-09-10 (read-only): Edge `api` v35 deployed
  2026-09-06 08:52 UTC, migrations applied through `20260905190106`. That API
  predates `GET /v1/analysis/release-policy` (its uncoded 404 reaches the app
  as 502 `network.invalid_response`), so every fresh original analysis from
  this client ends `unavailable` at `requireReleaseAuthority` BEFORE any
  permit is reserved. The original-analysis held screen now prefixes the
  run's own `unavailable` reason to the recovery copy (`showOriginalRecovery`
  `reason`); only `recovery_pending` keeps the bare recovery sentence.
  `analyzeScreenFullFlowE2E` "predates the release-policy route" pins it.
  Even after the coordinated rollout, a verified `policy: null` is a
  mechanics-only partial: numeric scores need an installed, approved,
  activated release policy (database-owner RPCs in
  `20260908020000_analysis_release_authority.sql`).
- Settings "N free ratings left" is the server's count of SYNCED scored
  shots. A score that only exists on the device (its `shot.sync` row refused
  and exhausted, e.g. production's pre-`20260906130000` 24-hour permit cutoff
  → `access.permit_expired`) never moves it. Exhausted rows are re-armed ONLY
  by the explicit "Retry saving" on the Result score page (`retryShotSync`
  also matches `attempts >= OUTBOX_MAX_ATTEMPTS`); the drain never retries
  them by itself (`syncIntegrity.integration.test.ts`).
