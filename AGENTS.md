# Pickle Sensei — agent notes

Monorepo (pnpm workspaces). The shipping app is `apps/mobile` (React Native 0.87,
npm + package-lock.json — do NOT use pnpm inside apps/mobile). The production
backend is the Supabase Edge Function in `supabase/functions/api/` (Deno);
`services/api` (Fastify) is an older implementation the mobile app does not call.

## Verify

- Mobile: `cd apps/mobile && npx tsc --noEmit && npx jest --silent`
- Workspace: `pnpm -r typecheck` and `pnpm --filter @pickle/shared-types test`
- ESLint is currently broken repo-wide (eslint 8 config loading eslint 9 from the
  pnpm root — pre-existing). Use `npx prettier --check` for formatting.
- iOS native deps: `cd apps/mobile/ios && bundle exec pod install`

## Deploy (Supabase project `ucqnaiwqwjtgvlduiuib`, linked via CLI)

- DB: `supabase db push` (migrations in `supabase/migrations/`, named
  `YYYYMMDDHHMMSS_description.sql`; remote history is tracked — never edit an
  applied migration, add a new one)
- API: `supabase functions deploy api --no-verify-jwt`
- Secrets: `supabase secrets set REVENUECAT_SECRET_API_KEY=…` (billing sync falls
  back to `REVENUECAT_PUBLIC_SDK_KEY`, currently set to the Test Store key),
  `REVENUECAT_WEBHOOK_AUTH=…` (shared secret the RevenueCat webhook must send
  as its Authorization header), and optionally `UPSTASH_REDIS_REST_URL` +
  `UPSTASH_REDIS_REST_TOKEN` (cross-instance cache + rate limits; without
  them the function falls back to per-isolate memory).
  `SUPABASE_SERVICE_ROLE_KEY` is platform-injected (used ONLY for the
  billing_entitlements upsert, the webhook_events audit log, and the Auth
  admin deleteUser behind two-step account deletion).

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
- Entitlement id: `pickle_sensei_pro` (legacy alias `premium` also honored).
- Offering packages must use standard types MONTHLY / ANNUAL / LIFETIME.
- Target prices: $7.99/mo, $59.99/yr, $159.99 lifetime — set on the store
  products; the app only ever displays store-returned prices. ASC product ids:
  `pickle_sensei_pro_monthly`, the yearly successor of
  `pickle_sensei_pro_annual` (see docs/DISTRIBUTION.md; both subscriptions
  must live in ONE subscription group), `pickle_sensei_pro_lifetime`
  (non-consumable).
- Backend fallback secret `REVENUECAT_PUBLIC_SDK_KEY` still holds the TEST
  STORE key — swap it (or set `REVENUECAT_SECRET_API_KEY`) at deploy time,
  never mid-hold.
- `public.billing_entitlements` is written ONLY by the edge function via
  service role. Never add user INSERT/UPDATE policies to it.

## Launch flow (onboarding BEFORE login)

App.tsx Gate order: Welcome → onboarding questionnaire (device-once) →
sign-in → app; `src/flow/launchGate.ts` + `__tests__/launchGate.test.ts` pin
it. Pre-auth answers stash under device kv `onboarding.pending-profile` and
are adopted by the first writable owner appStore.hydrate() sees WITHOUT a
profile (canonical accounts save through `/v1/me/onboarding` first — server
focusCheckpoint wins); an existing local/server profile always beats the
stash, which is single-use. `onboarding.device-complete` marks the device
onboarded (backfilled whenever a profile hydrates) and deliberately survives
sign-out/deletion so returning users go straight to sign-in. Signed-in
sessions with no profile still get the in-account OnboardingScreen (default
`mode='account'`; the pre-auth gate passes `mode='preauth'`).

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

## Launch splash (static brand, no video)

`src/screens/SplashScreen.tsx` renders pixel-identical layers to the native
launch storyboard — the `SplashGlow`/`SplashLockup` imagesets are the same
bitmaps as `assets/brand/splash-glow*.png` / `splash-lockup*.png`, same
geometry — so React taking over is invisible; the only motion is the glow
breathing, and the overlay fades once App.tsx `ready` (hydration) is true.
An MP4 intro variant (react-native-video) was built and then removed on
2026-08-31 — the user prefers this static one; don't reintroduce the video
without being asked. JS splash assets and the storyboard imagesets must move
together: deleting the PNGs breaks the Xcode "Bundle React Native code and
images" phase (Metro `UnableToResolveError`).

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
- Paywall legal links (App Review 3.1.2): `runtimeConfig.legalPrivacyUrl` /
  `legalTermsUrl` point at the API function's public `GET /privacy` and
  `GET /terms` pages (`supabase/functions/api/legal.ts`); wired in
  RootNavigator's PaywallRoute and Settings → About.
- `Info.plist` declares `ITSAppUsesNonExemptEncryption=false` (HTTPS only) so
  App Store Connect skips the export-compliance question per build.
