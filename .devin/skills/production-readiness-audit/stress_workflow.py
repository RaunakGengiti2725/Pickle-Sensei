"""Pickle Sensei — full-product STRESS workflow (run via `run_workflow`).

Every square inch of the product gets its own stress agents:

    unit × lens  ─►  stress agent (executes ≥ hundreds/thousands of scenario
                     iterations, seeds recorded, tests pushed to a branch)
                 ─►  adjudicators per group (dedupe + independent reproduction)
                 ─►  cluster (code) ─► implement ×N ─► review ∥ adversary ─► judge (code)

Units are enumerated deterministically below (screens, components, mobile
modules, edge routes, edge infra, DB tables/RPCs, packages, services, native).
Lenses are the stress dimensions the user demanded: rapid/concurrent
interaction, failure injection, lifecycle interruption, seeded randomized
long-runs, boundary/malformed/unicode/i18n input, long-run leak detection,
load/latency. Nothing here trusts prose: findings need repro + seed + artifact,
and a fix is accepted only when implementer, independent reviewer and
adversary all agree on evidence.

The runtime shim provides register_workflow/agent/pipeline/parallel/log and
WorkflowAgentError; do not import or define them.
"""

import asyncio
import json
import os
import re

REPO = "RaunakGengiti2725/Pickle-Sensei"
REPO_TOKEN = f"@{REPO}"
BASE_BRANCH = "devin/1788500670-production-readiness"
BASE_SHA = "1fb0efd7f3157060af4c61342f5102e068d2ddc5"
MAC_GREEN_RUN = "33909637479"  # fresh full Apple run on BASE_SHA (ok=true)
OUT_DIR = os.environ.get(
    "PS_STRESS_OUT",
    os.path.expanduser("~/repos/Pickle-Sensei/artifacts/production-readiness/run-1788500670/stress"),
)

M = "apps/mobile/src"
JEST = "cd apps/mobile && npm ci && npx jest --ci --silent <pattern>; add new suites under apps/mobile/__tests__/stress/"
DENO = "cd supabase/functions/api/__wf__ && deno task test; add new tests under supabase/functions/api/__wf__/stress_*.test.ts (in-process handler like tools/diagnostics/edge_error_taxonomy.ts; Postgres-backed paths via docker postgres:16 + supabase/migrations)"
PSQL = "docker run -d -p 5499:5432 -e POSTGRES_PASSWORD=x postgres:16; apply supabase/tests shim + every supabase/migrations/*.sql in order; drive with parallel psql / node pg; put SQL/scripts under supabase/tests/stress/"

# ---------------------------------------------------------------------------
# Deterministic inventory: (uid, kind, title, paths, harness hint)
# ---------------------------------------------------------------------------

SCREENS = [
    "SplashScreen", "WelcomeScreen", "OnboardingScreen", "SignInScreen", "HomeScreen", "AnalyzeScreen",
    "ResultScreen", "ResultDetailsScreen", "FormReviewScreen", "ProgressScreen", "StreakCalendarScreen",
    "LibraryScreen", "DrillLibraryScreen", "PaywallScreen", "SettingsScreen", "ManageAccountScreen",
    "ConsentSettingsScreen", "NotificationSettingsScreen",
]

COMPONENTS = [
    ("cmp-analysis-feedback-progress", "AnalysisFeedbackPrompt + AnalysisProgress + UncertaintyNote", [f"{M}/components/AnalysisFeedbackPrompt.tsx", f"{M}/components/AnalysisProgress.tsx", f"{M}/components/UncertaintyNote.tsx"]),
    ("cmp-players", "ClipPlayer + DrillVideoPlayer (media lifecycle, missing media, seek spam)", [f"{M}/components/ClipPlayer.tsx", f"{M}/components/DrillVideoPlayer.tsx"]),
    ("cmp-rank", "PlayerRankBanner + PlayerRankCard + RankIcon + RankUpCelebration", [f"{M}/components/PlayerRankBanner.tsx", f"{M}/components/PlayerRankCard.tsx", f"{M}/components/RankIcon.tsx", f"{M}/components/RankUpCelebration.tsx"]),
    ("cmp-stroke-result", "StrokeResult + strokeResultData/Model", [f"{M}/components/StrokeResult.tsx", f"{M}/components/strokeResultData.ts", f"{M}/components/strokeResultModel.ts"]),
    ("cmp-camera-ui", "CaptureEvidenceCard + CaptureGuidancePanel + TargetSelector", [f"{M}/camera/CaptureEvidenceCard.tsx", f"{M}/camera/CaptureGuidancePanel.tsx", f"{M}/camera/TargetSelector.tsx"]),
    ("cmp-consistency-ui", "AchievementsShowcase + ConsistencyCard + DaySecuredBanner + FlameIcon + MilestoneBadge + StreakCelebration", [f"{M}/consistency/AchievementsShowcase.tsx", f"{M}/consistency/ConsistencyCard.tsx", f"{M}/consistency/DaySecuredBanner.tsx", f"{M}/consistency/FlameIcon.tsx", f"{M}/consistency/MilestoneBadge.tsx", f"{M}/consistency/StreakCelebration.tsx"]),
    ("cmp-progress-charts", "PracticeVolumeChart + ScoreDotPlot + ScoreTrendChart + StatDeltaRow + PracticeSetCard + DashSectionHeader", [f"{M}/progress/PracticeVolumeChart.tsx", f"{M}/progress/ScoreDotPlot.tsx", f"{M}/progress/ScoreTrendChart.tsx", f"{M}/progress/StatDeltaRow.tsx", f"{M}/progress/PracticeSetCard.tsx", f"{M}/progress/DashSectionHeader.tsx"]),
    ("cmp-form-review-ui", "FixList + FormReviewCard + FormReviewOverlay + FormReviewPlayer + RecommendedDrills", [f"{M}/review/FixList.tsx", f"{M}/review/FormReviewCard.tsx", f"{M}/review/FormReviewOverlay.tsx", f"{M}/review/FormReviewPlayer.tsx", f"{M}/review/RecommendedDrills.tsx"]),
    ("cmp-navigation", "RootNavigator + PremiumTabBar + params (deep param fuzz, rapid tab switching, back-stack abuse)", [f"{M}/navigation/RootNavigator.tsx", f"{M}/navigation/PremiumTabBar.tsx", f"{M}/navigation/params.ts"]),
    ("cmp-design-system", "design/components + MascotMoment + BrandNotice + icons + safeArea + tokens", [f"{M}/design"]),
    ("cmp-notification-priming", "NotificationPrimingCard + copy", [f"{M}/notifications/NotificationPrimingCard.tsx", f"{M}/notifications/copy.ts"]),
    ("cmp-technique-intent-walkthrough", "TechniqueIntentPicker + FirstRunWalkthrough + walkthrough targets", [f"{M}/flow/TechniqueIntentPicker.tsx", f"{M}/walkthrough/FirstRunWalkthrough.tsx", f"{M}/walkthrough/targets.ts"]),
    ("cmp-training-components", "training/components.tsx", [f"{M}/training/components.tsx"]),
]

MODULES = [
    ("mod-auth-store", "authStore (hydrate, sign-in/out, one implicit sign-out rule)", [f"{M}/auth/authStore.ts"]),
    ("mod-session-vault", "sessionVault Keychain persistence (corrupt/missing/oversized records)", [f"{M}/account/sessionVault.ts"]),
    ("mod-session-keeper", "sessionKeeper + sessionLifecycle refresh rotation (timers, foreground re-check, backoff)", [f"{M}/account/sessionKeeper.ts", f"{M}/account/sessionLifecycle.ts"]),
    ("mod-bootstrap-api-session", "bootstrap + apiSession (bearer resolution per request, transitional provider token)", [f"{M}/account/bootstrap.ts", f"{M}/account/apiSession.ts"]),
    ("mod-account-deletion-consent", "deletion + consentApi + onboarding + deviceContext", [f"{M}/account/deletion.ts", f"{M}/account/consentApi.ts", f"{M}/account/onboarding.ts", f"{M}/account/deviceContext.ts"]),
    ("mod-run-capture-analysis", "runCaptureAnalysis + practiceSet (cancellation, provider throw, permit race)", [f"{M}/analysis/runCaptureAnalysis.ts", f"{M}/analysis/practiceSet.ts"]),
    ("mod-telemetry", "stabilityTelemetry + usabilityTelemetry (never leaks PII/pose, bounded buffers)", [f"{M}/analysis/stabilityTelemetry.ts", f"{M}/analysis/usabilityTelemetry.ts"]),
    ("mod-tts", "audio/tts (overlap, interruption, unavailable engine, rapid cues)", [f"{M}/audio/tts.ts"]),
    ("mod-billing", "billing store + revenueCatClient + accessApi (purchase/restore/cancel/error interleavings)", [f"{M}/billing"]),
    ("mod-capture", "camera capture + captureEnvelope + deviceBench (device denial, frame drops, odd fps/aspect)", [f"{M}/camera/capture.ts", f"{M}/camera/captureEnvelope.ts", f"{M}/camera/deviceBench.ts"]),
    ("mod-consistency-engine", "consistency engine + milestones + store + bootstrap hook (timezones, DST, clock jumps)", [f"{M}/consistency/engine.ts", f"{M}/consistency/milestones.ts", f"{M}/consistency/store.ts", f"{M}/consistency/useConsistencyBootstrap.ts"]),
    ("mod-db", "data/db.ts SQLite open/migrate (malformed rows, disk failure, concurrent opens)", [f"{M}/data/db.ts"]),
    ("mod-repository", "data/repository.ts (10k rows, dupes, deletes during reads, account scope)", [f"{M}/data/repository.ts", f"{M}/data/accountScope.ts"]),
    ("mod-sync-outbox", "data/sync.ts outbox drain (concurrent drains, rollback, poison rows, 4xx/5xx/429 classes)", [f"{M}/data/sync.ts"]),
    ("mod-sync-runtime", "data/syncRuntime.ts + offlineCapabilities (reconnect storms, app state flaps)", [f"{M}/data/syncRuntime.ts", f"{M}/data/offlineCapabilities.ts"]),
    ("mod-api-client", "data/api.ts (malformed/partial/oversized responses, timeouts, duplicate responses)", [f"{M}/data/api.ts"]),
    ("mod-launch-gate", "flow/launchGate (all state combos, no skip affordance)", [f"{M}/flow/launchGate.ts"]),
    ("mod-live-court", "flow/liveCourt + liveSessionCoach + liveSessionSummary (10k+ events, out-of-order, duplicate, malformed, pause/resume/background)", [f"{M}/flow/liveCourt.ts", f"{M}/flow/liveSessionCoach.ts", f"{M}/flow/liveSessionSummary.ts"]),
    ("mod-session-flow", "flow/session + sessionNative + sessionProgress (native bridge failures, progress monotonicity)", [f"{M}/flow/session.ts", f"{M}/flow/sessionNative.ts", f"{M}/flow/sessionProgress.ts"]),
    ("mod-library-focus", "library/libraryFocus", [f"{M}/library/libraryFocus.ts"]),
    ("mod-notifications", "notificationStore + plan + service + bootstrap hook (permission denial/revoke, scheduling limits)", [f"{M}/notifications/notificationStore.ts", f"{M}/notifications/plan.ts", f"{M}/notifications/service.ts", f"{M}/notifications/useNotificationBootstrap.ts", f"{M}/notifications/types.ts"]),
    ("mod-progress-api-history", "progress/api + practiceHistory + practiceSetProgress", [f"{M}/progress/api.ts", f"{M}/progress/practiceHistory.ts", f"{M}/progress/practiceSetProgress.ts"]),
    ("mod-progress-rank", "progress/playerRank + rankCelebration + gameplayProgression + duprEstimate + techniqueDashboard (numeric boundaries, empty/huge histories)", [f"{M}/progress/playerRank.ts", f"{M}/progress/rankCelebration.ts", f"{M}/progress/gameplayProgression.ts", f"{M}/progress/duprEstimate.ts", f"{M}/progress/techniqueDashboard.ts"]),
    ("mod-review-models", "review/formReviewModel + formReviewGeometry + poseSidecar + recommendedDrillsModel + appStoreReview", [f"{M}/review/formReviewModel.ts", f"{M}/review/formReviewGeometry.ts", f"{M}/review/poseSidecar.ts", f"{M}/review/recommendedDrillsModel.ts", f"{M}/review/appStoreReview.ts"]),
    ("mod-access-store", "state/accessStore (permits, free-rating counts, stale snapshots, refresh races)", [f"{M}/state/accessStore.ts"]),
    ("mod-app-store", "state/appStore + profile (hydrate ordering, pre-auth stash adoption, account switch)", [f"{M}/state/appStore.ts", f"{M}/state/profile.ts"]),
    ("mod-consent-store", "state/consentStore", [f"{M}/state/consentStore.ts"]),
    ("mod-training", "training/api + store (drills catalog, saved drills, plan) ", [f"{M}/training/api.ts", f"{M}/training/store.ts", f"{M}/training/types.ts"]),
    ("mod-vision-providers", "vision/providers (provider selection, throws, partial results)", [f"{M}/vision/providers.ts"]),
    ("mod-walkthrough-store-util", "walkthroughStore + util/plural + util/uuid", [f"{M}/walkthrough/walkthroughStore.ts", f"{M}/util"]),
    ("mod-app-root", "App.tsx root Gate + index.js (cold/warm launch ordering, error boundaries)", ["apps/mobile/App.tsx", "apps/mobile/index.js"]),
]

EDGE_ROUTES = [
    "POST /v1/account/bootstrap", "POST /v1/auth/refresh", "POST /v1/auth/logout",
    "GET /v1/me", "PUT /v1/me/onboarding", "GET /v1/me/access", "POST /v1/billing/sync",
    "POST /v1/analysis-permits", "POST /v1/analysis-permits/:id (release/consume)", "POST /v1/shots:sync", "POST /v1/shots",
    "POST /v1/sessions", "POST /v1/sessions/:id (end)", "POST /v1/analyses/:id", "POST /v1/me/evaluation/trials",
    "GET /v1/progress", "GET /v1/rank",
    "GET /v1/me/consent/status", "POST /v1/me/consent/grant", "POST /v1/me/consent/withdraw",
    "POST /v1/me/delete-request", "POST /v1/me/delete-confirm",
    "GET /v1/catalog/drills", "GET /v1/catalog/drills/:slug", "GET /v1/me/saved-drills", "PUT /v1/me/saved-drills/:slug", "DELETE /v1/me/saved-drills/:slug",
    "GET /v1/training-plans/current", "POST /v1/training-plans",
    "POST /webhooks/revenuecat", "GET /healthz + /privacy + /terms + unknown paths/methods (router fallthrough)",
]

EDGE_INFRA = [
    ("edge-cache", "cache.ts L1/L2 session cache (Upstash down, key flood, logout eviction, TTL skew)", ["supabase/functions/api/cache.ts"]),
    ("edge-ratelimit", "rateLimit.ts budgets (XFF spoofing, burst, Retry-After, memory under 100k keys)", ["supabase/functions/api/rateLimit.ts"]),
    ("edge-http", "http.ts helpers + sanitizeUserText (unicode, size caps, header injection)", ["supabase/functions/api/http.ts"]),
    ("edge-legal", "legal.ts text routes", ["supabase/functions/api/legal.ts"]),
    ("edge-drills-media", "drills.ts + drillMedia.ts (catalog, signing, slug fuzz)", ["supabase/functions/api/drills.ts", "supabase/functions/api/drillMedia.ts"]),
    ("edge-external-accounts", "externalAccounts.ts (Apple/Google credential storage, revocation, cleanup)", ["supabase/functions/api/externalAccounts.ts"]),
    ("edge-authenticate", "authenticate() + bearer/provider-token branches + request ids", ["supabase/functions/api/index.ts"]),
]

DB_UNITS = [
    ("db-access-state-permits", "access_state() + reserve_analysis_permit() + analysis_permits + access_lock_key", ["supabase/migrations"]),
    ("db-apply-synced-shot", "apply_synced_shot(jsonb) + enforce_scored_shot_permit + shots/shot_measurements/shot_phases/shot_checkpoints", ["supabase/migrations"]),
    ("db-free-rating-ledger", "free_rating_ledger + lifetime/identity_scored_count + record/inherit ledger triggers + reject_ledger_mutation", ["supabase/migrations"]),
    ("db-rank", "player_rank_state + recompute_player_rank + player_rank_tier + handle_shot_rank_refresh", ["supabase/migrations"]),
    ("db-profiles-onboarding", "profiles + complete_onboarding + handle_new_user + handle_user_email_updated + set_updated_at", ["supabase/migrations"]),
    ("db-sessions-captures", "sessions + captures + evaluation_trials + analysis_feedback", ["supabase/migrations"]),
    ("db-billing-webhook-tables", "billing_entitlements + webhook_events (service-only, idempotency keys, sweeps)", ["supabase/migrations"]),
    ("db-deletion-consent", "account_deletion_requests/feedback + consent_records + account_external_credentials + cascades", ["supabase/migrations"]),
    ("db-drills-saved", "user_saved_drills + grants", ["supabase/migrations"]),
    ("db-rls-matrix", "every RLS policy/grant/anon revoke as a whole (two-user matrix under concurrency)", ["supabase/tests", "supabase/migrations"]),
    ("db-pg-cron-sweeps", "pg_cron sweeps (stale permits, deletion expiry, webhook retention) racing live writes", ["supabase/migrations"]),
]

PACKAGES = [
    ("pkg-analysis-pipeline", "packages/analysis-pipeline", "pnpm --filter @pickle/analysis-pipeline test"),
    ("pkg-scoring-swing-domain", "packages/scoring + packages/swing-domain", "pnpm --filter @pickle/scoring test; pnpm --filter @pickle/swing-domain test"),
    ("pkg-vision-geometry-contracts", "packages/vision-geometry + packages/vision-contracts", "pnpm --filter @pickle/vision-geometry test"),
    ("pkg-swing-lab", "packages/swing-lab (classifiers, trackers, OOD, coach gates)", "pnpm --filter @pickle/swing-lab test"),
    ("pkg-evaluation", "packages/evaluation runner/comparator", "pnpm --filter @pickle/evaluation test; bench:regression on a clean tree"),
    ("pkg-audio-coach-core", "packages/audio-coach-core cue engine", "pnpm --filter @pickle/audio-coach-core test"),
    ("pkg-capture-envelope", "packages/capture-envelope", "pnpm --filter @pickle/capture-envelope test"),
    ("pkg-analytics", "packages/analytics redaction guard + drift", "pnpm --filter @pickle/analytics test"),
    ("pkg-queue", "packages/queue (SQS/ElasticMQ)", "pnpm --filter @pickle/queue test with docker elasticmq"),
    ("pkg-database", "packages/database migrate/seed (legacy stack)", "pnpm --filter @pickle/database test with docker postgres"),
    ("pkg-model-registry", "packages/model-registry", "pnpm --filter @pickle/model-registry test"),
    ("pkg-shared-types-api-contracts", "packages/shared-types + packages/api-contracts", "pnpm --filter @pickle/shared-types test"),
    ("pkg-ops-bundle", "first-party-intake, hard-case-queue, incident-response, release-ops, rollout, slo", "pnpm --filter <pkg> test for each"),
    ("ml-scripts", "ml/ Python tooling + tools/paddle-lab + tools/mining", "python3 -m unittest discover -s ml/scripts -p 'test_*.py'"),
]

SERVICES = [
    ("svc-media-worker", "services/media-worker (transcode, deletion tasks, retries, temp files)", ["services/media-worker"], "pnpm --filter @pickle/media-worker test; docker elasticmq + minio"),
    ("svc-api-legacy", "services/api Fastify (dev-token gates, flags)", ["services/api"], "scripts/verify-cloud.sh --only db,admin --start-services; tools/diagnostics/local_api_probe.mjs"),
    ("svc-admin-web", "apps/admin-web + Playwright smoke", ["apps/admin-web"], "pnpm --filter @pickle/admin-web build && e2e"),
]

NATIVE = [
    ("native-vision-core", "native/vision-core Swift package", ["native/vision-core"]),
    ("native-swing-lab-camera", "native/swing-lab + native/camera-engine", ["native/swing-lab", "native/camera-engine"]),
    ("native-ios-bridges", "apps/mobile/ios native bridges + AppDelegate + Info.plist", ["apps/mobile/ios"]),
]

# Lens id → what the agent must do (all executable, scale stated)
LENSES = {
    "rapid-interaction": "RAPID/CONCURRENT INTERACTION: render the unit with @testing-library/react-native + fake timers; script ≥300 interaction bursts (double/triple taps, tap-during-transition, simultaneous controls, back during async, spam navigation) from a seeded generator; assert single side effect per intent (one permit, one request, one navigation), no orphan loading state, no duplicate modal, no thrown act() warnings/unhandled rejections.",
    "failure-injection": "FAILURE INJECTION: for every dependency of the unit (fetch/api, SQLite, Keychain, camera, Vision provider, TTS, RevenueCat, permissions, clock, navigation) inject throw / reject / timeout / malformed / partial / slow / never-resolves; ≥60 injected faults; assert recoverable state with a visible retry/back control, no infinite spinner (advance fake timers 60s), no silent failure, no fake success, no corrupted persisted state.",
    "lifecycle": "LIFECYCLE INTERRUPTION: background/foreground, unmount mid-request, kill/relaunch (re-hydrate from persisted state), cancel mid-flight, token rotation mid-request, account switch, permission revoke-later; ≥100 interleavings from a seeded schedule; assert no leaked timers/listeners (jest --detectOpenHandles), idempotent re-hydrate, no state from a previous user.",
    "randomized-seeded": "SEEDED RANDOMIZED LONG-RUN: hand-rolled or fast-check style generator of legal/near-legal action sequences over the unit's public API (≥2000 sequences, length 5-60, seeds recorded per sequence); model-check invariants (documented in AGENTS.md or code comments) after every step; minimize and record every failing seed; determinism check: same seed twice → identical trace.",
    "boundary-i18n-a11y": "BOUNDARY/I18N/A11Y: long strings (200+ chars, CJK, Arabic RTL, ZWJ emoji, combining marks, German compounds), empty/null/undefined props, zero/negative/huge numerics, 3 font scales × 3 widths, 12 locales (de-DE fr-FR ar-EG hi-IN ja-JP pt-BR tr-TR ru-RU th-TH zh-CN en-IN es-419) and 8 timezones (UTC±14, DST edges); every interactive element must have accessible role/label and ≥44pt target; report clipped/overlapping/unlabeled with rendered-tree evidence; ≥150 rendered variants.",
    "long-run-leak": "LONG-RUN LEAK: mount/unmount or invoke the unit ≥500 times in one process with --expose-gc; record heap after every 50 iterations and open handles; timers/listeners/subscriptions must return to baseline; monotone heap slope >5% per 100 iterations is a finding; also measure render/invocation time drift.",
    "concurrency": "CONCURRENCY: drive the unit with Promise.all bursts (≥500 interleavings from a seeded scheduler): duplicate calls, call-during-call, cancel-during-call, two actors on the same row/id, rotation/logout during request, clock skew; assert idempotency, no double spend (free ratings/permits), no duplicate rows, no lost update, no deadlock (bounded wall time).",
    "boundary-malformed": "BOUNDARY/MALFORMED INPUT: ≥3000 generated inputs — malformed/truncated JSON, wrong types, prototype-pollution keys, numeric overflow/NaN/Infinity/-0, null bytes, 64KB+ strings vs byte/codepoint/grapheme caps, path traversal in ids/slugs, future schema versions, empty arrays/objects, unicode normalization pairs; assert graceful rejection (typed error, 4xx, logged) — never a throw out of a store/handler, never a 500 with detail, never a write.",
    "fuzz-boundary": "FUZZ/BOUNDARY (edge route): ≥3000 generated requests (body/query/headers/path params) against the in-process handler with stubbed Supabase/RevenueCat; assert only 400/401/403/404/405/413/415/429 for bad input, generic 5xx bodies, no stack traces, no write on rejection, request-id present; record every seed/payload that produced a 5xx.",
    "failure-load": "FAILURE INJECTION + LOAD (edge route): stub each upstream (Supabase auth/DB/PostgREST, Upstash, RevenueCat) to fail/timeout/return malformed in turn (≥40 fault cases) and assert user-visible error class + recoverability; then ≥1000 requests p50/p95 latency and Supabase round-trip count per request (a hot path doing >3 round trips is a finding), plus memory of L1 caches under 20k distinct users.",
    "static-xctest": f"APPLE (Linux plane only — NEVER trigger a Mac run or push ci/mac-*): write NEW stress XCTests (empty/1-frame/huge/corrupt buffers, cancellation mid-extraction, 2 people, rapid start/stop, memory pressure loops) on your branch; `swift build` is impossible on Linux — do static review of memory (CVPixelBuffer/CMSampleBuffer lifetimes), thread safety, force unwraps, error swallowing; cross-check with the fresh Mac artifacts: `gh run download {MAC_GREEN_RUN}` (xcresult summaries, extract summary, launch summary). Report everything Apple-runtime as UNVERIFIED-on-Linux unless the artifacts show it.",
}

KIND_LENSES = {
    "screen": ["rapid-interaction", "failure-injection", "lifecycle", "randomized-seeded", "boundary-i18n-a11y", "long-run-leak"],
    "component": ["rapid-interaction", "boundary-i18n-a11y"],
    "module": ["concurrency", "failure-injection", "randomized-seeded", "boundary-malformed"],
    "edge-route": ["concurrency", "fuzz-boundary", "failure-load"],
    "edge-infra": ["concurrency", "boundary-malformed", "failure-load"],
    "db": ["concurrency", "boundary-malformed"],
    "package": ["randomized-seeded", "boundary-malformed", "long-run-leak"],
    "service": ["concurrency", "failure-injection"],
    "native": ["static-xctest"],
}


def slugify(s: str) -> str:
    return re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()[:50]


def build_units() -> list[dict]:
    units: list[dict] = []
    for s in SCREENS:
        units.append({"uid": f"scr-{slugify(s)}", "kind": "screen", "title": f"{s} (full screen render inside the real navigator/providers)", "paths": [f"{M}/screens/{s}.tsx"], "hint": JEST, "group": "screens"})
    for uid, title, paths in COMPONENTS:
        units.append({"uid": uid, "kind": "component", "title": title, "paths": paths, "hint": JEST, "group": "components"})
    for uid, title, paths in MODULES:
        grp = "mobile-auth-account" if uid in ("mod-auth-store", "mod-session-vault", "mod-session-keeper", "mod-bootstrap-api-session", "mod-account-deletion-consent", "mod-app-store", "mod-launch-gate", "mod-app-root", "mod-consent-store") else (
            "mobile-data-sync" if uid in ("mod-db", "mod-repository", "mod-sync-outbox", "mod-sync-runtime", "mod-api-client", "mod-access-store") else (
                "mobile-analysis-capture-live" if uid in ("mod-run-capture-analysis", "mod-telemetry", "mod-tts", "mod-capture", "mod-live-court", "mod-session-flow", "mod-vision-providers", "mod-review-models") else "mobile-progress-training-misc"))
        units.append({"uid": uid, "kind": "module", "title": title, "paths": paths, "hint": JEST, "group": grp})
    for r in EDGE_ROUTES:
        grp = "edge-auth-billing" if any(k in r for k in ("bootstrap", "auth/", "billing", "webhooks", "healthz")) else ("edge-shots-permits" if any(k in r for k in ("permits", "shots", "sessions", "analyses", "evaluation", "progress", "rank")) else "edge-account-drills")
        units.append({"uid": f"route-{slugify(r)}", "kind": "edge-route", "title": f"edge route `{r}` in supabase/functions/api/index.ts", "paths": ["supabase/functions/api/index.ts"], "hint": DENO, "group": grp})
    for uid, title, paths in EDGE_INFRA:
        units.append({"uid": uid, "kind": "edge-infra", "title": title, "paths": paths, "hint": DENO, "group": "edge-infra"})
    for uid, title, paths in DB_UNITS:
        units.append({"uid": uid, "kind": "db", "title": title, "paths": paths, "hint": PSQL, "group": "database"})
    for uid, title, hint in PACKAGES:
        grp = "packages-cv" if uid in ("pkg-analysis-pipeline", "pkg-scoring-swing-domain", "pkg-vision-geometry-contracts", "pkg-swing-lab", "pkg-evaluation", "ml-scripts") else "packages-ops"
        units.append({"uid": uid, "kind": "package", "title": title, "paths": [title.split(" ")[0]], "hint": hint + " (never edit tolerances/baseline/datasets; no fabricated labels)", "group": grp})
    for uid, title, paths, hint in SERVICES:
        units.append({"uid": uid, "kind": "service", "title": title, "paths": paths, "hint": hint, "group": "services"})
    for uid, title, paths in NATIVE:
        units.append({"uid": uid, "kind": "native", "title": title, "paths": paths, "hint": "Linux static + XCTest authoring; Apple truth from run " + MAC_GREEN_RUN, "group": "native"})
    return units


# ---------------------------------------------------------------------------
# Shared prompt fragments + schemas
# ---------------------------------------------------------------------------

COMMON_RULES = f"""Repository: {REPO_TOKEN} (public GitHub monorepo; shipping product = iOS app `apps/mobile`, backend = Supabase Edge Function `supabase/functions/api`).
START STATE: `git fetch origin && git checkout {BASE_SHA}` (branch `{BASE_BRANCH}`). All work is relative to this commit; never push to `main`; never open a pull request (the coordinator integrates).
Read `AGENTS.md`, `REVIEW.md`, `docs/devin/OPERATING_SYSTEM.md`, `docs/devin/TEST_MATRIX.md`, `APP_STORE_SUBMISSION.md` and the skills in `.agents/skills/` first.
Environment: Node 22 + pnpm 10 are present (mobile `node:sqlite` tests need Node >= 22.13). If `deno` is missing: `curl -fsSL https://deno.land/install.sh | sh` (adds ~/.deno/bin). Docker services: `docker compose up -d postgres postgres_test redis elasticmq` or pass `--start-services` to verify-cloud. apps/mobile uses npm (never pnpm inside it): `cd apps/mobile && npm ci`.
Execution planes (never claim results from a plane you did not run):
- cloud (Linux): `scripts/verify-cloud.sh --tier pr|full --start-services` → `artifacts/verify-cloud/<run>/summary.json`; mobile `cd apps/mobile && npx tsc --noEmit && npx jest --ci --silent`; edge `(cd supabase/functions/api/__wf__ && deno task test)`; RLS `./supabase/tests/run_rls_tests.sh`; ML `python3 -m unittest discover -s ml/scripts -p 'test_*.py'`.
- bench: `pnpm --filter @pickle/evaluation bench:regression --out-dir /tmp/cand --run-id cand` then `pnpm -s --filter @pickle/evaluation bench:compare datasets/reports/regression/baseline.json /tmp/cand/cand.json --json > /tmp/cand/compare.json` on a CLEAN commit. Never edit `regression.tolerances.json`, `datasets/`, or the baseline. Linux CV numbers are a replay proxy, not Apple device truth.
- mac (Apple truth): the self-hosted M4 runner is ONE physical machine. You MUST NOT run `scripts/mac-full-verify.sh --remote`, push any `ci/mac-*` branch, or touch `.github/workflows/mac-*.yml`. Read Apple evidence from the fresh green run on {BASE_SHA[:8]}: `gh run download {MAC_GREEN_RUN}`. Never claim Swift/Vision/iOS runtime behaviour from Linux.
Hard rules: never weaken/skip/delete tests, never add `|| true`, never fabricate labels/metrics/evidence, never touch production Supabase (project ucqnaiwqwjtgvlduiuib) or App Store Connect, never store or print secrets, never modify the Mac runner, never modify applied migrations (add a new one), never use pnpm inside apps/mobile, never use destructive git commands. User-facing copy must follow `APP_STORE_SUBMISSION.md` (no Android/Google Play/guest mode/Live Court/DUPR/competitor mentions; no accuracy %, superlatives or AI-coach-equivalence claims).
Evidence standard: every claim carries the exact command, exit code and artifact path. Label statements VERIFIED (you ran it) / INFERRED (read code) / UNKNOWN. Upload key artifacts (logs, JSON tables of seeds/results, heap tables, rendered trees) with the upload_attachment tool and return the URLs in `attachment_urls`. A skipped/unavailable stage is NOT a pass.
Findings format (one object each): {{"severity":"P0|P1|P2|P3","title":"<short>","files":["path:line",...],"repro":"<exact command or steps, including seed>","observed":"<what happened>","expected":"<what should happen>","evidence":"<attachment url or artifact path>","regression":"yes|no|unknown (vs main)"}}. P0 = data loss, security breach, auth bypass, crash on a core flow, fundamentally incorrect analysis, release blocker. P1 = major broken feature, serious reliability/performance/CV failure. P2 = important edge case, degraded UX, recoverability problem. P3 = polish. Report ONLY what you reproduced with a recorded seed/payload or can point to at file:line with a concrete failure mode; do not pad. An empty findings list with strong `verified_ok` evidence and a large executed-scenario count is a valid and valuable result."""

FINDING_ITEM = {
    "type": "object",
    "properties": {
        "severity": {"type": "string"},
        "title": {"type": "string"},
        "files": {"type": "array", "items": {"type": "string"}},
        "repro": {"type": "string"},
        "observed": {"type": "string"},
        "expected": {"type": "string"},
        "evidence": {"type": "string"},
        "regression": {"type": "string"},
    },
}

STRESS_SCHEMA = {
    "type": "object",
    "properties": {
        "findings": {"type": "array", "items": FINDING_ITEM},
        "verified_ok": {"type": "array", "items": {"type": "string"}, "description": "'<invariant that held> — <command> → exit 0 — <scenarios/iterations> — <artifact>'"},
        "scenarios_executed": {"type": "integer", "description": "total executed scenario iterations (interactions, sequences, requests, inputs)"},
        "seeds_failed": {"type": "array", "items": {"type": "string"}, "description": "every failing seed/payload id (minimized) with one-line effect"},
        "tests_added": {"type": "integer"},
        "attack_branch": {"type": "string", "description": "pushed branch holding the new stress tests/harness (empty if none)"},
        "baseline_exit_codes": {"type": "array", "items": {"type": "string"}, "description": "'<existing suite command> → exit N' run before stressing"},
        "attachment_urls": {"type": "array", "items": {"type": "string"}},
        "blocked_external": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
    },
    "required": ["findings", "verified_ok", "scenarios_executed", "seeds_failed", "tests_added", "attack_branch", "attachment_urls", "blocked_external", "summary"],
}

ADJUDICATE_SCHEMA = {
    "type": "object",
    "properties": {
        "confirmed": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "severity": {"type": "string"},
                    "title": {"type": "string"},
                    "files": {"type": "array", "items": {"type": "string"}},
                    "repro": {"type": "string"},
                    "expected": {"type": "string"},
                    "evidence": {"type": "string"},
                    "acceptance": {"type": "array", "items": {"type": "string"}},
                    "merged_from": {"type": "array", "items": {"type": "string"}},
                },
            },
        },
        "rejected": {"type": "array", "items": {"type": "string"}},
        "deferred_p3": {"type": "array", "items": {"type": "string"}},
        "blocked_external": {"type": "array", "items": {"type": "string"}},
        "status": {"type": "string", "enum": ["PASS", "FAIL", "DEGRADED", "UNVERIFIED", "BLOCKED"]},
        "status_reason": {"type": "string"},
        "scenarios_total": {"type": "integer"},
        "attachment_urls": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
    },
    "required": ["confirmed", "rejected", "deferred_p3", "blocked_external", "status", "status_reason", "summary"],
}

IMPLEMENT_SCHEMA = {
    "type": "object",
    "properties": {
        "branch": {"type": "string"},
        "head_sha": {"type": "string"},
        "approach": {"type": "string"},
        "acceptance_results": {"type": "array", "items": {"type": "string"}},
        "failing_test_first_commit": {"type": "string"},
        "cloud_pr_tier_exit": {"type": "integer"},
        "files_changed": {"type": "array", "items": {"type": "string"}},
        "bench_regressions": {"type": "integer"},
        "attachment_urls": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
    },
    "required": ["branch", "head_sha", "acceptance_results", "cloud_pr_tier_exit", "files_changed", "summary"],
}

REVIEW_SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": ["approve", "request_changes", "reject"]},
        "blocking_issues": {"type": "array", "items": {"type": "string"}},
        "acceptance_verified": {"type": "array", "items": {"type": "string"}},
        "reverify_exit": {"type": "integer"},
        "test_fails_without_fix": {"type": "boolean"},
        "summary": {"type": "string"},
    },
    "required": ["verdict", "blocking_issues", "acceptance_verified", "reverify_exit", "test_fails_without_fix", "summary"],
}

ADVERSARY_SCHEMA = {
    "type": "object",
    "properties": {
        "break_found": {"type": "boolean"},
        "breaks": {"type": "array", "items": {"type": "string"}},
        "attack_branch": {"type": "string"},
        "attacks_tried": {"type": "integer"},
        "summary": {"type": "string"},
    },
    "required": ["break_found", "breaks", "attacks_tried", "summary"],
}


def dump(obj) -> str:
    return json.dumps(obj, sort_keys=True, ensure_ascii=False)


def save(name: str, obj) -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, name), "w", encoding="utf8") as fh:
        json.dump(obj, fh, indent=2, sort_keys=True, ensure_ascii=False)


MAX_CONCURRENT = int(os.environ.get("PS_STRESS_CONCURRENCY", "55"))
# The org-wide cap is 100 concurrent sessions shared with manual fix/review
# sessions, so creation is throttled often; a throttled agent must wait as long
# as it takes (a whole stress lens is lost otherwise) and must NOT hold a slot
# while it sleeps.
THROTTLE_MAX_ATTEMPTS = int(os.environ.get("PS_STRESS_THROTTLE_ATTEMPTS", "240"))
_SEM: asyncio.Semaphore | None = None


def sem() -> asyncio.Semaphore:
    global _SEM
    if _SEM is None:
        _SEM = asyncio.Semaphore(MAX_CONCURRENT)
    return _SEM


def _is_throttle(msg: str) -> bool:
    return (
        "429" in msg
        or "concurrent session limit" in msg
        or "could not create session" in msg
        or "Too Many Requests" in msg
    )


async def safe_agent(prompt, **kwargs):
    for attempt in range(THROTTLE_MAX_ATTEMPTS):
        async with sem():
            try:
                return await agent(prompt, **kwargs)
            except WorkflowAgentError as err:
                msg = str(err)
                if not _is_throttle(msg):
                    log(f"agent {kwargs.get('label')} FAILED: {err}")
                    return None
        log(
            f"agent {kwargs.get('label')}: session creation throttled "
            f"(attempt {attempt + 1}/{THROTTLE_MAX_ATTEMPTS}); backing off"
        )
        await asyncio.sleep(min(600, 120 + 30 * attempt))
    log(f"agent {kwargs.get('label')} FAILED: gave up after repeated session-creation throttling")
    return None


# ---------------------------------------------------------------------------
# Stress agents
# ---------------------------------------------------------------------------


async def stress(unit: dict, lens: str) -> dict | None:
    branch = f"devin/stress-{unit['uid']}-{lens}"
    plane_note = ""
    if unit["kind"] in ("edge-route", "edge-infra"):
        plane_note = " Run the REAL handler in-process (see tools/diagnostics/edge_error_taxonomy.ts and existing __wf__ tests) with stubbed Supabase/RevenueCat/Upstash; where the route hits Postgres RPCs, ALSO run against docker postgres:16 with every migration applied. Duplicate delivery/idempotency and free-rating double-spend are P0 if broken."
    elif unit["kind"] == "db":
        plane_note = " Two users minimum; parallel psql/node-pg sessions under READ COMMITTED (and SERIALIZABLE where the code claims it); every anomaly needs an exact SQL repro; check RLS from the authenticated role via `set local role authenticated; set local request.jwt.claims`."
    elif unit["kind"] == "screen":
        plane_note = " Render the screen inside the real providers/navigator the app uses (see existing __tests__ that render App.tsx or screens with mocked native modules) so navigation, stores and hooks are real; mock only native modules and fetch."
    elif unit["kind"] == "package":
        plane_note = " Use committed fixtures + seeded synthetic streams only (no fabricated labels); property checks: determinism for same seed, bounded abstention, no NaN/Infinity in outputs, cancellation honoured."
    prompt = f"""{COMMON_RULES}

ROLE: STRESS TESTER — unit `{unit['uid']}` ({unit['kind']}): {unit['title']}. Paths: {dump(unit['paths'])}. Harness hint: {unit['hint']}.{plane_note}
LENS `{lens}` — {LENSES[lens]}
Procedure:
1. Baseline: run the unit's EXISTING tests/checks first and record `<command> → exit N` in `baseline_exit_codes`.
2. Build the stress harness for this lens at the stated scale (this is a run-it task, not an essay): seeded RNG, every iteration replayable from its seed, results as a JSON table (seed → outcome) uploaded as an attachment. Record `scenarios_executed` honestly (count only iterations that actually ran).
3. Classify every failure BROKEN (finding with seed + observed vs expected + artifact; `regression` vs `origin/main` when you can tell) or HELD (verified_ok). Minimize failing seeds. If a failure is flaky, re-run the seed 10× and report the rate.
4. Push the harness/tests to branch `{branch}` (NEW files only — never modify existing tests or production code; keep the harness fast enough to live in the suite: put slow campaigns behind an env flag like STRESS_ITER with a small default). Report the branch in `attack_branch`.
Anything needing a human, credential, physical device, or the hosted Supabase platform goes in `blocked_external` with the precise minimum action — never mark it passing. Never trigger a Mac run."""
    limit = 60 if unit["kind"] in ("screen", "db", "edge-route") else 50
    return await safe_agent(prompt, phase=f"stress-{unit['kind']}", schema=STRESS_SCHEMA, label=f"{unit['uid']}--{lens}", soft_time_limit_minutes=limit)


def slim(report: dict | None, source: str) -> dict:
    if not report:
        return {"source": source, "findings": [], "verified_ok": [], "seeds_failed": [], "blocked_external": [], "scenarios_executed": 0, "summary": "agent failed / no output"}
    return {
        "source": source,
        "findings": report.get("findings", []),
        "verified_ok": report.get("verified_ok", [])[:25],
        "seeds_failed": report.get("seeds_failed", [])[:40],
        "attack_branch": report.get("attack_branch", ""),
        "attachment_urls": report.get("attachment_urls", [])[:12],
        "blocked_external": report.get("blocked_external", []),
        "scenarios_executed": report.get("scenarios_executed", 0),
        "baseline_exit_codes": report.get("baseline_exit_codes", []),
        "summary": report.get("summary", "")[:1500],
    }


# ---------------------------------------------------------------------------
# Adjudication per group (chunked so one adjudicator sees ≤ 10 reports)
# ---------------------------------------------------------------------------


async def adjudicate(area_id: str, area_title: str, reports: list[dict], scope_hint: list[str]) -> dict | None:
    prompt = f"""{COMMON_RULES}

ROLE: ADJUDICATOR for stress area `{area_id}` — {area_title}. Scope hint: {dump(scope_hint)}.
You receive independent stress-tester reports (each has an attack branch with the harness and a seeds table). Do NOT trust them; your job is to deduplicate, REPRODUCE, and decide.
Reports: {dump(reports)}
Procedure:
1. Deduplicate findings (same root cause → one confirmed item with `merged_from` listing source titles).
2. For every P0/P1/P2 candidate: check out {BASE_SHA[:8]}, fetch the tester's attack branch, replay the recorded seed(s)/payload(s) yourself. Confirm only what you reproduced (or what is an undeniable file:line defect). Reject with a reason otherwise (not reproducible, by design per AGENTS.md/APP_STORE_SUBMISSION.md, test-harness bug, duplicate, P3 → deferred_p3). A harness that fails because of ITS OWN bug is not a product finding — say so.
3. For each confirmed item set final severity, the repo-relative FILES a fix will touch (production files + test file(s) to add/extend; no `:line`), and 2-5 EXECUTABLE acceptance criteria (exact commands that must exit 0 / assertions that must hold, including the replaying seed).
4. Sum `scenarios_total` from the reports you consider real. Set `status`: FAIL if any confirmed P0/P1; DEGRADED if only P2 confirmed or real flakiness; PASS if nothing confirmed AND the executed-scenario evidence is substantial across the lenses; UNVERIFIED if evidence is thin or agents failed; BLOCKED if only an external/human action stands in the way. Never convert UNVERIFIED into PASS.
Upload reproduction logs as attachments. Change no production code; you may push reproduction tests to `devin/adjudicate-stress-{area_id}`."""
    return await safe_agent(prompt, phase="adjudicate", schema=ADJUDICATE_SCHEMA, label=f"adjudicate-{area_id}", soft_time_limit_minutes=55)


# ---------------------------------------------------------------------------
# Clustering + fix loop (same evidence gates as the audit workflow)
# ---------------------------------------------------------------------------


def norm_file(f: str) -> str:
    return f.strip().split(":")[0].strip().lstrip("./")


def build_clusters(confirmed: list[dict]) -> list[dict]:
    out: list[dict] = []
    for area in sorted({c.get("area", "") for c in confirmed}):
        out.extend(_build_clusters([c for c in confirmed if c.get("area", "") == area]))
    return out


def _build_clusters(confirmed: list[dict]) -> list[dict]:
    items = sorted(confirmed, key=lambda c: (c["severity"], c["id"]))
    parent = list(range(len(items)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    owner: dict[str, int] = {}
    for i, it in enumerate(items):
        for f in sorted({norm_file(x) for x in it.get("files", []) if x.strip()}):
            if f in owner:
                union(i, owner[f])
            else:
                owner[f] = i
    groups: dict[int, list[dict]] = {}
    for i, it in enumerate(items):
        groups.setdefault(find(i), []).append(it)
    clusters = []
    for root in sorted(groups):
        members = sorted(groups[root], key=lambda c: (c["severity"], c["id"]))
        parts = [members[i : i + 3] for i in range(0, len(members), 3)]
        for part in parts:
            sev = min(m["severity"] for m in part)
            files = sorted({norm_file(f) for m in part for f in m.get("files", []) if f.strip()})
            clusters.append(
                {
                    "cluster_id": "+".join(m["id"] for m in part),
                    "severity": sev,
                    "files": files,
                    "items": part,
                    "shared_files_with_siblings": len(parts) > 1,
                    "competing": 2 if sev in ("P0", "P1") else 1,
                }
            )
    return clusters


def cluster_brief(cl: dict) -> str:
    return dump([{k: it.get(k) for k in ("id", "severity", "title", "repro", "expected", "evidence", "acceptance", "files")} for it in cl["items"]])


async def implement(cl: dict, variant: int) -> dict | None:
    n = cl["competing"]
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", cl["cluster_id"])[:60].strip("-")
    variant_note = (
        f"You are implementer {variant + 1} of {n} working INDEPENDENTLY; the winner is chosen on evidence. Variant {variant + 1}: {'take the most direct root-cause fix' if variant == 0 else 'take a genuinely different approach (different layer or mechanism) and state it in `approach`'}."
        if n > 1
        else ""
    )
    criteria = [a for it in cl["items"] for a in it.get("acceptance", [])]
    prompt = f"""{COMMON_RULES}

ROLE: IMPLEMENTER. Fix stress cluster `{cl['cluster_id']}` (severity {cl['severity']}). {variant_note}
Confirmed defects (each independently reproduced by an adjudicator from a recorded seed): {cluster_brief(cl)}
Files you may edit (the ONLY paths; other fixers own everything else concurrently{' — sibling fixers may also touch some of these files: keep your diff minimal and localized' if cl.get('shared_files_with_siblings') else ''}): {dump(cl['files'])} — if a correct fix truly needs another file, add it minimally and justify it in `summary`.
Acceptance criteria, in order (one `acceptance_results` line per criterion): {dump(criteria)}
Required loop: REPRODUCE with the seed → commit the regression test FAILING on the unfixed code (`failing_test_first_commit`) → FIX the root cause (no workaround, no broad try/catch, no weakened assertion, no `|| true`) → test PASSES → re-run the stress campaign that found it with ≥ the original iteration count → full relevant suite(s) → `scripts/verify-cloud.sh --tier pr --start-services` (exit → `cloud_pr_tier_exit`; `--tier full` if you touched db/edge/rls; if ONLY the security stage fails and gitleaks points at commits that are not ancestors of your HEAD, say so verbatim in `summary` and also run `scripts/security-scan.sh --history --log-opts {BASE_SHA[:8]}..HEAD` + `--tree`). Bench plane: `bench:compare` with 0 regressions. Migrations: NEW file only, grants sized to the writes. Copy rules apply.
Branch `devin/fix-stress-{slug}-v{variant + 1}` from {BASE_SHA[:8]}; commit, push (NO pull request), report `branch`, `head_sha`, `files_changed`. Report FAIL honestly for any unmet criterion."""
    return await safe_agent(prompt, phase="fix-implement", schema=IMPLEMENT_SCHEMA, label=f"fix-{slug}-v{variant + 1}", soft_time_limit_minutes=60)


async def review(cl: dict, cand: dict) -> dict | None:
    criteria = [a for it in cl["items"] for a in it.get("acceptance", [])]
    prompt = f"""{COMMON_RULES}

ROLE: INDEPENDENT REVIEWER. Do NOT trust the implementer; verify everything yourself.
Cluster `{cl['cluster_id']}` ({cl['severity']}): {cluster_brief(cl)}
Candidate branch `{cand['branch']}` at `{cand['head_sha']}`; implementer claims: {dump(cand.get('acceptance_results', []))}; claimed files: {dump(cand.get('files_changed', []))}.
Allowed files: {dump(cl['files'])}. Acceptance criteria: {dump(criteria)}.
1. `git diff {BASE_SHA[:8]}...{cand['branch']}` — every changed path must be inside the allowed files (or justified); unrelated changes, weakened/removed assertions, skipped tests, `|| true`, broad catches, copy-rule violations, edits to applied migrations, grant widening → blocking.
2. Apply `REVIEW.md` + `AGENTS.md` (auth/RLS/grants, error bodies, model versioning, Apple lifecycle, privacy, copy).
3. Re-run on the candidate: the new regression test(s) with the recorded seed, the originating stress campaign, the relevant suites, and `scripts/verify-cloud.sh --tier pr --start-services` (exit → `reverify_exit`). Then locally revert ONLY the production change (keep the test) and confirm the new test FAILS (`test_fails_without_fix`); restore afterwards. Bench-plane: re-run `bench:compare`.
4. One `acceptance_verified` line per criterion: 'VERIFIED|NOT VERIFIED — <criterion> — <how>'.
`approve` only if every criterion is VERIFIED, reverify_exit is 0 (or the only failure is the shared-remote gitleaks history stage, stated verbatim), test_fails_without_fix is true, and there are no blocking issues. Do not edit the branch."""
    return await safe_agent(prompt, phase="fix-review", schema=REVIEW_SCHEMA, label=f"review-{cand['branch'][-40:]}", soft_time_limit_minutes=45)


async def adversary(cl: dict, cand: dict) -> dict | None:
    prompt = f"""{COMMON_RULES}

ROLE: ADVERSARIAL TESTER. Break candidate branch `{cand['branch']}` (at `{cand['head_sha']}`) which claims to fix stress cluster `{cl['cluster_id']}`: {cluster_brief(cl)}
Attack the FIX and its neighbourhood with the SAME kind of stress that found the defect at ≥2× the scale (new seeds, different orderings, concurrency, unicode, boundary sizes, cancellation mid-flight, stale/expired sessions, RLS/grant boundaries, background/foreground, clock skew). Did the fix introduce a regression elsewhere (run the suites of every module that imports the changed files)? Compare with {BASE_SHA[:8]} — only regressions or bugs in the changed code count as breaks. Write NEW failing tests exposing real bugs on branch `devin/attack-fix-{cand['head_sha'][:8]}` and push it (`attack_branch`). Report `break_found` only with an exact repro (seed) and observed-vs-expected. Never modify the candidate branch. Never trigger a Mac run."""
    return await safe_agent(prompt, phase="fix-adversary", schema=ADVERSARY_SCHEMA, label=f"adversary-{cand['branch'][-40:]}", soft_time_limit_minutes=45)


_P3_BREAK = re.compile(r"^\W*(p3|severity\W*p3)\b", re.IGNORECASE)


def blocking_breaks(adv: dict) -> list[str]:
    return [b for b in adv.get("breaks", []) if not _P3_BREAK.match(str(b))]


def judge(cl: dict, evaluated):
    eligible = []
    for cand, rev, adv in evaluated:
        if not rev or not adv:
            log(f"judge {cl['cluster_id']}: {cand['branch']} missing review/adversary output -> rejected")
            continue
        all_pass = bool(cand["acceptance_results"]) and all(r.strip().upper().startswith("PASS") for r in cand["acceptance_results"])
        blocking = blocking_breaks(adv)
        verified_clean = cand["cloud_pr_tier_exit"] == 0 or rev["reverify_exit"] == 0
        ok = all_pass and rev["verdict"] == "approve" and rev["test_fails_without_fix"] and not blocking and int(cand.get("bench_regressions", 0) or 0) == 0
        cand["judge"] = {"verified_clean_on_child": verified_clean, "needs_integration_verify": not verified_clean, "adversary_p3_followups": [b for b in adv.get("breaks", []) if b not in blocking]}
        log(f"judge {cl['cluster_id']}: {cand['branch']} impl_pass={all_pass} verify={cand['cloud_pr_tier_exit']} review={rev['verdict']}/{rev['reverify_exit']} tfwf={rev['test_fails_without_fix']} adv_break={adv['break_found']} blocking={len(blocking)} -> {'ELIGIBLE' if ok else 'rejected'}")
        if ok:
            eligible.append((cand, rev, adv))
    if not eligible:
        return None
    eligible.sort(key=lambda t: (0 if t[0]["judge"]["verified_clean_on_child"] else 1, len(t[1]["blocking_issues"]), -int(t[2]["attacks_tried"]), len(t[0].get("files_changed", [])), t[0]["branch"]))
    return eligible[0][0]


def pick_round2_base(evaluated):
    usable = [(c, r, a) for c, r, a in evaluated if r and a]
    if not usable:
        return None
    usable.sort(key=lambda t: (len(blocking_breaks(t[2])), len(t[1]["blocking_issues"]), 0 if t[1]["verdict"] == "approve" else 1, t[0]["branch"]))
    return usable[0]


async def implement_round2(cl: dict, cand: dict, rev: dict, adv: dict) -> dict | None:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", cl["cluster_id"])[:60].strip("-")
    criteria = [a for it in cl["items"] for a in it.get("acceptance", [])]
    extra = [f"REVIEW BLOCKER: {b}" for b in rev.get("blocking_issues", [])] + [f"ADVERSARY BREAK: {b}" for b in blocking_breaks(adv)]
    prompt = f"""{COMMON_RULES}

ROLE: IMPLEMENTER (ROUND 2). Cluster `{cl['cluster_id']}` (severity {cl['severity']}): {cluster_brief(cl)}
Round-1 candidate `{cand['branch']}` at `{cand['head_sha']}` (approach: {cand.get('approach', 'n/a')}) was REJECTED. Reviewer: {dump(rev.get('summary', ''))}. Adversary: {dump(adv.get('summary', ''))}{(' — attack branch with failing tests: ' + adv['attack_branch']) if adv.get('attack_branch') else ''}.
Start from `{cand['branch']}` (branch `devin/fix-stress-{slug}-r2`). Fix EVERY item below at the root cause (adopt adversary tests as regression tests unless you prove them wrong in `summary`):
{dump(extra)}
Original acceptance criteria (still required; one `acceptance_results` line per criterion, then one per extra item): {dump(criteria)}
Allowed files: {dump(cl['files'])} plus files round 1 already changed; justify anything else in `summary`.
Required loop: failing test first (`failing_test_first_commit`) → fix → passing → originating stress campaign at ≥ original scale → full relevant suites → `scripts/verify-cloud.sh --tier pr --start-services` (`cloud_pr_tier_exit`; `--tier full` for db/edge/rls; shared-remote gitleaks caveat as in round 1). Bench: 0 regressions. No PR. Report honestly."""
    return await safe_agent(prompt, phase="fix-implement-r2", schema=IMPLEMENT_SCHEMA, label=f"fix-{slug}-r2", soft_time_limit_minutes=60)


async def fix_cluster(cl: dict) -> dict:
    log(f"fix cluster {cl['cluster_id']} ({cl['severity']}, {cl['competing']} implementer(s), files={len(cl['files'])})")
    cands = [c for c in await asyncio.gather(*[implement(cl, v) for v in range(cl["competing"])]) if c]
    if not cands:
        return {"cluster": cl, "winner": None, "candidates": [], "reason": "no candidate produced"}

    async def evaluate(cand):
        rev, adv = await asyncio.gather(review(cl, cand), adversary(cl, cand))
        return cand, rev, adv

    evaluated = list(await asyncio.gather(*[evaluate(c) for c in cands]))
    winner = judge(cl, evaluated)
    rounds = [[{"candidate": c, "review": r, "adversary": a} for c, r, a in evaluated]]
    if not winner:
        base = pick_round2_base(evaluated)
        if base:
            cand, rev, adv = base
            r2 = await implement_round2(cl, cand, rev, adv)
            if r2:
                rev2, adv2 = await asyncio.gather(review(cl, r2), adversary(cl, r2))
                winner = judge(cl, [(r2, rev2, adv2)])
                rounds.append([{"candidate": r2, "review": rev2, "adversary": adv2}])
    log(f"fix cluster {cl['cluster_id']}: winner = {winner['branch'] if winner else 'NONE (nothing proven)'} after {len(rounds)} round(s)")
    return {"cluster": cl, "winner": winner, "candidates": rounds[0], "rounds": rounds, "reason": "" if winner else "no candidate passed implementer+reviewer+adversary gates"}


# ---------------------------------------------------------------------------
# Group pipeline: stress fan-out → chunked adjudication
# ---------------------------------------------------------------------------

GROUP_TITLES = {
    "screens": "Every screen under rapid interaction, failure injection, lifecycle interruption, seeded randomized sequences, boundary/i18n/a11y, long-run leak",
    "components": "Every shared component under rapid interaction and boundary/i18n/a11y",
    "mobile-auth-account": "Mobile auth/account/launch modules (authStore, vault, keeper, bootstrap, deletion/consent, appStore, launchGate, App root)",
    "mobile-data-sync": "Mobile data layer (SQLite db, repository, sync outbox/runtime, api client, accessStore)",
    "mobile-analysis-capture-live": "Mobile analysis/capture/live-court/voice/review models",
    "mobile-progress-training-misc": "Mobile progress/consistency/notifications/training/library/walkthrough/util",
    "edge-auth-billing": "Edge routes: bootstrap, refresh, logout, billing sync, webhook, healthz/legal/router",
    "edge-shots-permits": "Edge routes: permits, shots sync, sessions, analyses, evaluation trials, progress, rank",
    "edge-account-drills": "Edge routes: me/onboarding/access/consent/deletion, drills catalog, saved drills, training plans",
    "edge-infra": "Edge infrastructure: cache, rate limit, http/sanitize, legal, drills media, external accounts, authenticate()",
    "database": "Postgres RPCs/tables/RLS/pg_cron under concurrency and malformed input",
    "packages-cv": "CV/analysis packages + ML tooling under seeded randomized, malformed and long-run stress",
    "packages-ops": "Ops/shared packages under seeded randomized, malformed and long-run stress",
    "services": "media-worker, legacy Fastify API, admin-web under concurrency and failure injection",
    "native": "Native Swift (Linux static + XCTest authoring; Apple truth from run " + MAC_GREEN_RUN + ")",
}


async def run_group(gid: str, units: list[dict]) -> dict:
    jobs = [(u, lens) for u in units for lens in KIND_LENSES[u["kind"]]]
    results = await asyncio.gather(*[stress(u, lens) for u, lens in jobs])
    reports = [slim(r, f"{u['uid']}--{lens}") for r, (u, lens) in zip(results, jobs)]
    save(f"stress-{gid}.json", reports)
    executed = sum(r.get("scenarios_executed", 0) for r in reports)
    raw = sum(len(r["findings"]) for r in reports)
    log(f"{gid}: {len(jobs)} stress agents done — {executed} scenario iterations, {raw} raw findings")

    # chunk reports so each adjudicator sees ≤ 10; failed agents (no output) are
    # still passed through so the status can reflect thin evidence.
    chunks = [reports[i : i + 10] for i in range(0, len(reports), 10)] or [[]]
    adjs = await asyncio.gather(*[adjudicate(f"{gid}-{i + 1}" if len(chunks) > 1 else gid, GROUP_TITLES[gid], ch, sorted({p for r in ch for u in units if u["uid"] == r["source"].split("--")[0] for p in u["paths"]})) for i, ch in enumerate(chunks)])
    merged = {"confirmed": [], "rejected": [], "deferred_p3": [], "blocked_external": [], "status": "PASS", "status_reason": [], "scenarios_total": 0, "attachment_urls": [], "summary": []}
    rank = {"PASS": 0, "BLOCKED": 1, "DEGRADED": 2, "UNVERIFIED": 3, "FAIL": 4}
    for i, adj in enumerate(adjs):
        if not adj:
            merged["status"] = "UNVERIFIED" if rank[merged["status"]] < rank["UNVERIFIED"] else merged["status"]
            merged["status_reason"].append(f"chunk {i + 1}: adjudicator produced no output")
            continue
        for c in adj["confirmed"]:
            c = dict(c)
            c["id"] = f"{gid}::{c.get('id') or c.get('title', 'x')}"
            c["area"] = gid
            c.setdefault("severity", "P2")
            merged["confirmed"].append(c)
        for k in ("rejected", "deferred_p3", "blocked_external", "attachment_urls"):
            merged[k].extend(adj.get(k, []))
        merged["scenarios_total"] += int(adj.get("scenarios_total", 0) or 0)
        if rank[adj["status"]] > rank[merged["status"]]:
            merged["status"] = adj["status"]
        merged["status_reason"].append(f"chunk {i + 1}: {adj['status']} — {adj['status_reason']}")
        merged["summary"].append(adj.get("summary", ""))
    merged["status_reason"] = " | ".join(merged["status_reason"])
    merged["summary"] = " | ".join(merged["summary"])
    merged["scenarios_executed_reported"] = executed
    save(f"adjudicate-{gid}.json", merged)
    log(f"{gid}: status={merged['status']} confirmed={len(merged['confirmed'])} scenarios_total={merged['scenarios_total']}")
    return {"id": gid, "reports": reports, "adjudication": merged}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


async def main():
    units = build_units()
    groups: dict[str, list[dict]] = {}
    for u in units:
        groups.setdefault(u["group"], []).append(u)
    jobs_by_kind: dict[str, list[str]] = {}
    for u in units:
        for lens in KIND_LENSES[u["kind"]]:
            jobs_by_kind.setdefault(u["kind"], []).append(f"{u['uid']}--{lens}")
    n_jobs = sum(len(v) for v in jobs_by_kind.values())
    n_adj = sum(max(1, (len([1 for u in g for _ in KIND_LENSES[u["kind"]]]) + 9) // 10) for g in groups.values())
    await register_workflow(
        {
            "name": "pickle-sensei-full-product-stress",
            "description": f"Every screen, component, mobile module, edge route, edge infra module, DB RPC/table, package, service and native target × its stress lenses (rapid/concurrent, failure injection, lifecycle, seeded randomized long-run, boundary/i18n/a11y, leak, fuzz, load) → {n_jobs} stress agents → {n_adj} adjudicators (independent seed replay) → clustered fixes with competing implementers, independent review and adversarial retest. Base {BASE_SHA[:8]} on {BASE_BRANCH}.",
            "product": "Pickle Sensei (RaunakGengiti2725/Pickle-Sensei)",
            "soft_time_limit_minutes": 50,
            "phases": [
                *[{"title": f"stress-{kind}", "detail": f"{kind} units × lenses {dump(KIND_LENSES[kind])}", "labels": sorted(labels)} for kind, labels in sorted(jobs_by_kind.items())],
                {"title": "adjudicate", "detail": "dedupe + independent seed replay + area status (≤10 reports per adjudicator)", "count": n_adj},
                {"title": "fix-implement", "detail": "competing implementers per confirmed cluster (failing test first, campaign re-run)"},
                {"title": "fix-review", "detail": "independent reviewer re-verifies + revert check"},
                {"title": "fix-adversary", "detail": "adversarial re-stress of each candidate at ≥2× scale"},
                {"title": "fix-implement-r2", "detail": "one follow-up implementer per rejected cluster; re-gated by fresh reviewer ∥ adversary"},
            ],
        }
    )
    log(f"base {BASE_SHA} on {BASE_BRANCH}; {len(units)} units in {len(groups)} groups → {n_jobs} stress agents, {n_adj} adjudicators; out={OUT_DIR}")
    save("units.json", units)

    group_results = await asyncio.gather(*[run_group(g, groups[g]) for g in sorted(groups)])

    scoreboard = {}
    confirmed: list[dict] = []
    blocked: list[str] = []
    total_exec = 0
    for r in group_results:
        adj = r["adjudication"]
        scoreboard[r["id"]] = {"status": adj["status"], "reason": adj["status_reason"], "confirmed": len(adj["confirmed"]), "scenarios_total": adj["scenarios_total"], "scenarios_reported": adj["scenarios_executed_reported"]}
        confirmed.extend(adj["confirmed"])
        blocked.extend(f"{r['id']}: {b}" for b in adj.get("blocked_external", []))
        total_exec += adj["scenarios_executed_reported"]
    save("scoreboard-stress-pre-fix.json", scoreboard)
    save("confirmed-findings.json", confirmed)
    save("blocked-external.json", sorted(set(blocked)))
    log(f"stress adjudication complete: {total_exec} scenario iterations reported; {len(confirmed)} confirmed findings; statuses={dump({k: v['status'] for k, v in scoreboard.items()})}")

    fixable = [c for c in confirmed if c.get("severity") in ("P0", "P1", "P2") and c.get("files")]
    clusters = build_clusters(fixable)
    save("fix-clusters.json", clusters)
    log(f"{len(fixable)} fixable findings → {len(clusters)} fix clusters ({sum(c['competing'] for c in clusters)} implementers)")

    fix_results = await asyncio.gather(*[fix_cluster(cl) for cl in clusters])
    save("fix-results.json", list(fix_results))
    winners = [f["winner"] for f in fix_results if f["winner"]]
    unfixed = [f["cluster"]["cluster_id"] for f in fix_results if not f["winner"]]
    save("winners.json", winners)
    log(f"stress fix loop complete: {len(winners)} proven fix branches; {len(unfixed)} clusters without a proven fix: {dump(unfixed)}")
    log("INTEGRATION is performed by the coordinator: merge winners.json branches onto the integration branch, run verify-cloud full + bench:compare + mac-full-verify --remote, then the final-review workflow.")


asyncio.run(main())
