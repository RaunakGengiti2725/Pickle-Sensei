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
- API: `supabase functions deploy api --no-verify-jwt`
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
  the bearer 60s before expiry, retries transient failures with backoff, and
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
- Free ratings follow the SIGN-IN IDENTITY, not the account row
  (`20260902150000_free_rating_identity_ledger.sql`, 2026-09-02). Deleting
  the account used to reset the two lifetime free ratings (every counted
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
- 5xx bodies are generic (detail only in function logs). Free-text inputs are
  sanitized (`http.ts sanitizeUserText`). pg_cron sweeps stale permits,
  expired deletion requests, old webhook events.
- Public no-auth routes: `GET /healthz`, `GET /privacy`, `GET /terms`
  (`legal.ts` — plain text on purpose: the supabase.co gateway rewrites
  Content-Type and sandboxes HTML; keep the support email real),
  `POST /webhooks/revenuecat`
  (secret-gated; entitlements re-verified against RevenueCat, never trusted
  from the event body; audit-logged in `public.webhook_events`).
- `deno check` on `index.ts` reports pre-existing untyped-supabase-client
  errors (insert/update infer `never`) — deploy bundling type-strips, and the
  standalone modules (`cache.ts`, `rateLimit.ts`, `http.ts`, `legal.ts`)
  check clean.
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
- Free-rating ledger freshness (2026-09-02): `accessStore.canonicalAccess`
  is a server snapshot, and `GET /v1/me/access` derives `used` from SYNCED
  scored shots and `reserved` from live permits — so it goes stale the
  moment a scoring run starts and nothing in the store refreshes it by
  itself. Two hooks keep it honest: SettingsScreen `useFocusEffect` →
  `refreshAccess()` on every visit for synced (non-`localOnly`) sessions
  (skipped while a load is in flight; the old value stays on screen until
  the new one lands), and AnalyzeScreen re-reads it in its UNMOUNT cleanup
  once a run called `runCaptureAnalysis` — never while mounted, because
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
  DashSectionHeader (`type.micro`, letterSpacing 1.2 everywhere).
- Centered state/celebration headlines (signed-out states, Analyze states,
  Result moments, Paywall title): `type.h1`.
- Data numerals may size per card, but the SAME role must match everywhere
  (e.g. card technique scores are `type.score` at 30/34 on Home, Progress,
  and Library; big stat counters are `type.display` at 64/66).

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

Owner-scoped kv namespaces (`profile`, `rank.celebrated`, `notifications`,
`consistency`) are pinned in `repository.ts OWNER_SCOPED_KV_NAMESPACES` and
purged together on account deletion — add new namespaces there.

## Auto Analyze camera — record button, then TRUE auto capture (iOS, 2026-09-02)

`GuidedCaptureViewController.swift` is a camera app, not a wizard. It opens
in `composing` (live preview + exoskeleton, NOTHING recorded; the translucent
player silhouette — `CaptureSilhouette` imageset, alpha 0.3 → 0.14 as a body
is tracked → hidden once tracked-ready, mirrored in RN as
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
trackable frame once `triggerWarmupMs` (1 s) of the file exists;
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
each evidence-gated and SKIPPED when its evidence is absent: **Score** (ring,
DUPR line, ONE `selectInsight` sentence, THIS SET card) → **The problem**
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
three tiles — `7.1` + `/10` caption / `SCORE`, `strengthList(analysis, ∞)`
count / `HELD`, `fixList(analysis, ∞)` count / `TO FIX` — numerals in the
card `type.score` 30/34 role, then the rows Priority fix `name — direction`
(or "Every checkpoint held") and Strongest `name · score`; the footer "Try it
again" re-arm + Back · Done). There is NO "See full breakdown" link any more
(product decision 2026-09-02: the last page is a quick recap to move on
from). The ENTIRE former result surface still lives in `ResultBreakdownSheet`
(`StrokeResult hideCtaRow` + `FormReviewCard` + full `FixList` + stroke map +
provenance + `TrainingPlanSection` + `AnalysisFeedbackPrompt`, light sheet),
rendered by the route `ResultDetails { analysisId }`
(`screens/ResultDetailsScreen.tsx`, `ScreenHeader "Full breakdown"`, loads
through the shared `useStrokeResultEvidence`) — which the guide no longer
navigates to, so it is currently reachable from nowhere in the app — and
inline by the abstained / legacy ONE-page case (the honest ledger) with Try
again / Done. `DaySecuredBanner` stays at shell level (one-shot ceremony). Nothing
new is said anywhere — every page reads the same pure selectors as before;
keep it that way and keep the audits (`coachLockAudit`,
`resultEvidenceAudit`, `zeroHandholdingCopyAudit`…) green.

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
