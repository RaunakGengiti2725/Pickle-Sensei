"""Pickle Sensei — production-readiness audit workflow (run via `run_workflow`).

    map(subsystem) ─► structural ×2 ∥ execution ×1 ∥ adversarial ×K  ─► adjudicate(subsystem) ─┐
    cross-cutting matrix / randomized / mutation / journeys / screens / security / perf / CI …  ─┤
                                                                                                 ├─► cluster (code) ─► implement ×N ─► review ∥ adversary ─► judge (code)
                                                                                                 ┘
Every agent is a separate-VM child session with its own clone of
RaunakGengiti2725/Pickle-Sensei pinned to BASE_SHA. Code moves ONLY via git
branches named in structured output. Findings move as structured JSON that the
script records under artifacts/production-readiness/<run>/ on the orchestrating
machine. Nothing here trusts prose: a fix is accepted only when the implementer's
own evidence, an independent reviewer, and an adversarial tester all agree.

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
BASE_SHA = "4d812e1aa699014cc0521fd92fde66908043aaa8"
MAC_BASELINE_RUN = "https://github.com/RaunakGengiti2725/Pickle-Sensei/actions/runs/33841813597"
MAC_PRIOR_GREEN_RUN = "https://github.com/RaunakGengiti2725/Pickle-Sensei/actions/runs/33829297073"
OUT_DIR = os.environ.get(
    "PS_AUDIT_OUT",
    os.path.expanduser("~/repos/Pickle-Sensei/artifacts/production-readiness/run-1788500670"),
)

# ---------------------------------------------------------------------------
# Deterministic inventory (Wave 1 architecture map, encoded)
# ---------------------------------------------------------------------------

SUBSYSTEMS = [
    # id, title, plane, paths, how-to-execute hint
    ("mobile-auth-session", "Mobile auth: authStore, sessionVault (Keychain), sessionKeeper refresh rotation, sign-out, bearer resolution", "cloud",
     ["apps/mobile/src/auth", "apps/mobile/src/account", "apps/mobile/src/data/accountScope.ts"],
     "cd apps/mobile && npx jest --ci --silent (auth* / session* suites); skill .agents/skills/test-authentication"),
    ("mobile-launch-onboarding", "Launch gate, Welcome/Splash/Onboarding/SignIn screens, pre-auth profile stash, navigation", "cloud",
     ["apps/mobile/App.tsx", "apps/mobile/src/flow/launchGate.ts", "apps/mobile/src/navigation", "apps/mobile/src/screens/WelcomeScreen.tsx", "apps/mobile/src/screens/SplashScreen.tsx", "apps/mobile/src/screens/OnboardingScreen.tsx", "apps/mobile/src/screens/SignInScreen.tsx", "apps/mobile/src/state/profile.ts", "apps/mobile/src/state/appStore.ts"],
     "cd apps/mobile && npx jest --ci --silent"),
    ("mobile-analyze-capture", "Analyze screen, camera capture/envelope, runCaptureAnalysis, vision providers, rating permits/access gate", "cloud",
     ["apps/mobile/src/screens/AnalyzeScreen.tsx", "apps/mobile/src/camera", "apps/mobile/src/analysis", "apps/mobile/src/vision", "apps/mobile/src/state/accessStore.ts", "apps/mobile/src/flow/session.ts", "apps/mobile/src/flow/sessionNative.ts", "apps/mobile/src/flow/sessionProgress.ts"],
     "cd apps/mobile && npx jest --ci --silent"),
    ("mobile-results-review", "Result/ResultDetails/FormReview screens, review module, tryAgainHandoff, coaching copy", "cloud",
     ["apps/mobile/src/screens/ResultScreen.tsx", "apps/mobile/src/screens/ResultDetailsScreen.tsx", "apps/mobile/src/screens/FormReviewScreen.tsx", "apps/mobile/src/screens/tryAgainHandoff.ts", "apps/mobile/src/review"],
     "cd apps/mobile && npx jest --ci --silent"),
    ("mobile-home-progress-library", "Home/Progress/Library/StreakCalendar screens, progress + consistency + library modules", "cloud",
     ["apps/mobile/src/screens/HomeScreen.tsx", "apps/mobile/src/screens/ProgressScreen.tsx", "apps/mobile/src/screens/LibraryScreen.tsx", "apps/mobile/src/screens/StreakCalendarScreen.tsx", "apps/mobile/src/progress", "apps/mobile/src/consistency", "apps/mobile/src/library"],
     "cd apps/mobile && npx jest --ci --silent"),
    ("mobile-settings-account", "Settings/ManageAccount/Consent/Notification screens, account deletion, consent store, notifications", "cloud",
     ["apps/mobile/src/screens/SettingsScreen.tsx", "apps/mobile/src/screens/ManageAccountScreen.tsx", "apps/mobile/src/screens/ConsentSettingsScreen.tsx", "apps/mobile/src/screens/NotificationSettingsScreen.tsx", "apps/mobile/src/state/consentStore.ts", "apps/mobile/src/notifications"],
     "cd apps/mobile && npx jest --ci --silent"),
    ("mobile-billing-paywall", "RevenueCat billing store, PaywallScreen, paywallCopy, entitlement gating", "cloud",
     ["apps/mobile/src/billing", "apps/mobile/src/screens/PaywallScreen.tsx", "apps/mobile/src/screens/paywallCopy.ts"],
     "cd apps/mobile && npx jest --ci --silent"),
    ("mobile-data-sync", "SQLite db/repository, sync outbox + transport + syncRuntime, offline capabilities, api client", "cloud",
     ["apps/mobile/src/data/db.ts", "apps/mobile/src/data/repository.ts", "apps/mobile/src/data/sync.ts", "apps/mobile/src/data/syncRuntime.ts", "apps/mobile/src/data/offlineCapabilities.ts", "apps/mobile/src/data/api.ts"],
     "cd apps/mobile && npx jest --ci --silent"),
    ("mobile-training-drills", "Training module, DrillLibraryScreen, drill media consumption", "cloud",
     ["apps/mobile/src/training", "apps/mobile/src/screens/DrillLibraryScreen.tsx"],
     "cd apps/mobile && npx jest --ci --silent"),
    ("mobile-live-court-voice", "Live Court flow (liveCourt/liveSessionCoach/liveSessionSummary), TTS audio, audio-coach-core cue engine — real-time event ordering, dedupe, interruptions, permission denial", "cloud",
     ["apps/mobile/src/flow/liveCourt.ts", "apps/mobile/src/flow/liveSessionCoach.ts", "apps/mobile/src/flow/liveSessionSummary.ts", "apps/mobile/src/audio", "packages/audio-coach-core"],
     "cd apps/mobile && npx jest --ci --silent; pnpm --filter @pickle/audio-coach-core test"),
    ("mobile-design-components-walkthrough", "Shared components, design tokens, walkthrough, util — accessibility labels/roles, dynamic type, touch targets, reduced motion", "cloud",
     ["apps/mobile/src/components", "apps/mobile/src/design", "apps/mobile/src/walkthrough", "apps/mobile/src/util"],
     "cd apps/mobile && npx jest --ci --silent"),
    ("mobile-ios-config", "iOS project: Info.plist privacy strings, entitlements, capabilities, pbxproj versions, Podfile, runtimeConfig, URL schemes, ATS, debug exclusion", "mac",
     ["apps/mobile/ios", "apps/mobile/src/config", "apps/mobile/package.json", "apps/mobile/app.json", "apps/mobile/index.js"],
     "read-only inspection + Linux checks; Apple truth only from the existing Mac artifacts"),
    ("edge-auth-cache-ratelimit", "Edge fn authentication(): bootstrap/refresh/logout, session cache (L1/L2), rate limits, request ids, http helpers", "cloud",
     ["supabase/functions/api/cache.ts", "supabase/functions/api/rateLimit.ts", "supabase/functions/api/http.ts", "supabase/functions/api/__wf__/auth_session_cache_test.ts", "supabase/functions/api/__wf__/rateLimit.test.ts", "supabase/functions/api/__wf__/rateLimit_test.ts", "supabase/functions/api/__wf__/index_preauth_test.ts", "supabase/functions/api/__wf__/request_id_test.ts", "supabase/functions/api/__wf__/http_test.ts"],
     "cd supabase/functions/api/__wf__ && deno task test"),
    ("edge-domain-routes", "Edge fn domain routes in index.ts: /v1/me/*, shots sync (apply_synced_shot), permits, rank/progress cache, onboarding, drills, external accounts, account deletion, legal", "cloud",
     ["supabase/functions/api/index.ts", "supabase/functions/api/drills.ts", "supabase/functions/api/drillMedia.ts", "supabase/functions/api/externalAccounts.ts", "supabase/functions/api/legal.ts", "supabase/functions/api/__wf__/account_routes.test.ts", "supabase/functions/api/__wf__/account_external_cleanup.test.ts", "supabase/functions/api/__wf__/be-edge-routes-shots-rank.test.ts", "supabase/functions/api/__wf__/router_test.ts", "supabase/functions/api/__wf__/externalAccounts_test.ts", "supabase/functions/api/__wf__/legal_test.ts"],
     "cd supabase/functions/api/__wf__ && deno task test"),
    ("edge-billing-webhook", "RevenueCat webhook, entitlement re-verification, billing_entitlements service-role writes, webhook_events audit, idempotency", "cloud",
     ["supabase/functions/api/__wf__/webhook.test.ts", "supabase/functions/api/__wf__/drills_billing_healthz.test.ts", "supabase/functions/api/__wf__/wf-billing-entitlement-sync-db.sh", "supabase/functions/api/__wf__/wf-billing-entitlement-sync-db.sql"],
     "cd supabase/functions/api/__wf__ && deno task test; webhook branch of index.ts"),
    ("db-schema-migrations", "17 Supabase migrations: tables, FKs, constraints, indexes, triggers, RPCs (access_state, apply_synced_shot, reserve_analysis_permit, lifetime_scored_count), pg_cron sweeps, cascades", "cloud",
     ["supabase/migrations", "supabase/config.toml", "supabase/functions/api/__wf__/db_migrations_rls_indexes.test.ts", "supabase/functions/api/__wf__/db_migrations_rls_indexes.audit.test.ts"],
     "./supabase/tests/run_rls_tests.sh; psql against a throwaway postgres:16 with all migrations applied"),
    ("db-rls-grants-isolation", "RLS policies, column grants, anon revokes, append-only ledgers, storage policies, cross-user isolation matrix", "cloud",
     ["supabase/tests"],
     "./supabase/tests/run_rls_tests.sh (extend security_regression.sql on an attack branch)"),
    ("storage-media-worker", "Storage buckets/policies, drill media signing, services/media-worker (transcode/upload lifecycle, temp files, retries)", "cloud",
     ["services/media-worker", "packages/queue", "packages/capture-envelope"],
     "pnpm --filter ... test with docker services (ElasticMQ/MinIO) via scripts/verify-cloud.sh --start-services"),
    ("pkg-vision-geometry", "packages/vision-geometry: court/pose geometry, homography, normalization, numeric stability", "bench",
     ["packages/vision-geometry", "packages/vision-contracts"],
     "pnpm --filter @pickle/vision-geometry test"),
    ("pkg-analysis-pipeline", "packages/analysis-pipeline: frame handling, segmentation, stroke classification, scoring stages, cancellation, partial failures", "bench",
     ["packages/analysis-pipeline", "packages/scoring", "packages/swing-domain"],
     "pnpm --filter @pickle/analysis-pipeline test; pnpm --filter @pickle/scoring test"),
    ("pkg-swing-lab", "packages/swing-lab: replay fixtures, estimator versions, lab scripts (root lab:* scripts)", "bench",
     ["packages/swing-lab", "packages/model-registry"],
     "pnpm --filter @pickle/swing-lab test"),
    ("pkg-evaluation-bench", "packages/evaluation regression runner/compare/tolerances; datasets/reports baseline; gold corpus coverage gaps (no label fabrication)", "bench",
     ["packages/evaluation", "datasets/reports", "datasets/pickleball/README.md", "regression.tolerances.json", "docs/EVALUATION.md"],
     "pnpm --filter @pickle/evaluation bench:regression --out-dir /tmp/cand --run-id cand; bench:compare against datasets/reports/regression/baseline.json"),
    ("native-vision-core", "native/vision-core Swift package: Apple Vision pose extraction, frame lifecycle, memory, thread safety", "mac",
     ["native/vision-core"],
     "Linux: static review + XCTest authoring only; execution truth from Mac artifacts"),
    ("native-swing-lab-camera-engine", "native/swing-lab + native/camera-engine: AVFoundation capture, Vision extraction CLI, Release build", "mac",
     ["native/swing-lab", "native/camera-engine"],
     "Linux: static review + XCTest authoring only; execution truth from Mac artifacts"),
    ("ml-tooling-datasets", "ml/ scripts + datasets/ tooling: label handling, splits, no leakage, deterministic seeds", "cloud",
     ["ml", "datasets/pickleball", "tools/mining", "tools/paddle-lab", "tools/e15_download.py"],
     "python3 -m unittest discover -s ml/scripts -p 'test_*.py'"),
    ("services-api-legacy-admin-web", "Legacy Fastify services/api + apps/admin-web console + Playwright smoke: dead-code status, auth, dev-token gating, flags", "cloud",
     ["services/api", "apps/admin-web", "packages/database", "packages/api-contracts"],
     "scripts/verify-cloud.sh --only db,admin,e2e --start-services"),
    ("shared-packages-ops", "Remaining packages: shared-types, analytics, first-party-intake, hard-case-queue, incident-response, release-ops, rollout, slo; infra/observability", "cloud",
     ["packages/shared-types", "packages/analytics", "packages/first-party-intake", "packages/hard-case-queue", "packages/incident-response", "packages/release-ops", "packages/rollout", "packages/slo", "infra/observability", "infra/postgres", "infra/terraform"],
     "pnpm -r typecheck; pnpm --filter <pkg> test"),
    ("ci-workflows-scripts", "GitHub workflows (ci.yml, mac-full-verify.yml, mac-smoke-test.yml), scripts/verify-*.sh, security-scan.sh, tools/macos-ci, tools/devin, tools/diagnostics — determinism, error hiding, artifact retention", "cloud",
     [".github/workflows", "scripts", "tools/macos-ci", "tools/devin", "tools/diagnostics"],
     "shellcheck; scripts/verify-cloud.sh --tier pr --start-services; read workflow YAML"),
    ("release-config-docs", "infra/release manifest, tools/release checker, APP_STORE_SUBMISSION.md, PRELAUNCH_CHECKLIST, version triple, store-copy rules, privacy docs", "cloud",
     ["infra/release", "tools/release", "docs/APP_STORE_SUBMISSION.md", "docs/PRELAUNCH_CHECKLIST.md", "docs/RELEASE_OPERATIONS.md", "docs/RELEASE_PLAN_V1.md", "docs/DISTRIBUTION.md", "APP_STORE_SUBMISSION.md"],
     "pnpm release:check; grep version triple per .agents/skills/release-verification"),
    ("security-secrets-deps", "Secret scanning (.gitleaks.toml, scripts/security-scan.sh), dependency vulnerabilities (pnpm audit, npm audit in apps/mobile, pip), lockfile integrity, insecure defaults, debug endpoints", "cloud",
     [".gitleaks.toml", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "apps/mobile/package-lock.json", "docs/SECURITY_BOUNDARIES.md", "tools/loadtest"],
     "scripts/security-scan.sh; pnpm audit --prod; cd apps/mobile && npm audit"),
]

CROSS_CUTTING = [
    # id, title, instructions
    ("matrix-network-auth-1", "Scenario matrix: NETWORK × AUTH cell 1 — {normal, slow, timeout} × {valid, expired, refreshing} sessions against the mobile api client + sync outbox + sessionKeeper (mock transport)", "Write a seeded jest matrix (>=150 executed combinations) under apps/mobile/__tests__/matrix/ driving api.ts/sync.ts/sessionKeeper with mocked fetch; every failure must record its seed and combination."),
    ("matrix-network-auth-2", "Scenario matrix: NETWORK × AUTH cell 2 — {offline, intermittent, reconnect} × {revoked, malformed token, refresh 401/403/5xx}", "Same harness family as cell 1; the ONE implicit sign-out rule (server refuses refresh) must hold; no other path may sign out."),
    ("matrix-network-server-3", "Scenario matrix: server responses — 4xx/5xx/429+Retry-After/malformed JSON/partial body/duplicate response/oversized body against every mobile api call site", "Enumerate call sites in apps/mobile/src/data/api.ts and stores; assert no unhandled rejection, no fake success, retryable classes match the outbox contract."),
    ("matrix-media-1", "Scenario matrix: MEDIA 1 — short/long/tiny/huge/portrait/landscape/odd aspect/low fps/high fps inputs through packages/analysis-pipeline and capture-envelope validation", "Generate synthetic pose/frame sequences with seeded RNG (no fabricated gold labels); assert completion vs explicit failure, never silent partial success."),
    ("matrix-media-2", "Scenario matrix: MEDIA 2 — corrupted/truncated/wrong-extension/unsupported-codec/missing-audio/unusual metadata through services/media-worker + capture-envelope + edge upload validation", "Use ffmpeg to craft real malformed files; assert cleanup of temp files, bounded retries, idempotent re-processing."),
    ("matrix-visibility", "Scenario matrix: PLAYER VISIBILITY — full/partial body, legs/arms missing, occlusion, exit/re-enter, multiple people, spectator, no player, far/close camera through pose normalization + segmentation + scoring", "Synthesize keypoint streams with seeded dropout/jitter from the committed fixtures; assert abstention/uncertainty paths fire instead of confident wrong scores."),
    ("matrix-behavioral", "Scenario matrix: BEHAVIORAL — rapid tapping, double submit, navigation during processing, background/resume, cancel, retry, kill/relaunch, stale cached state, simultaneous operations across AnalyzeScreen/appStore/accessStore/sync", "Render with @testing-library/react-native + fake timers; assert single permit reservation, no duplicate shots, no orphan loading state."),
    ("matrix-lifecycle-persistence", "Scenario matrix: LIFECYCLE/PERSISTENCE — fresh install, existing install, malformed persisted state (SQLite kv, Keychain vault), migration from older schema versions, cold vs warm launch ordering", "Corrupt/omit every persisted key deterministically; hydrate() must never throw, never sign out except the one allowed rule, never lose local shots."),
    ("matrix-concurrency-edge", "Concurrency matrix (edge fn): duplicate bootstrap, refresh during request, logout during sync, double permit reservation, concurrent apply_synced_shot for the same shot id, duplicate webhook delivery", "Drive the deno __wf__ harness concurrently (Promise.all bursts) and, where Postgres is available via docker, the RPCs directly; assert idempotency and no double spend of free ratings."),
    ("matrix-concurrency-db", "Concurrency matrix (Postgres): parallel psql sessions hitting reserve_analysis_permit / apply_synced_shot / free_rating_ledger trigger / account deletion cascade with SERIALIZABLE and READ COMMITTED", "Throwaway postgres:16 via docker with all migrations; use pgbench-style scripts or parallel psql; report exact anomalies with SQL repro."),
    ("randomized-state-machine-A", "Seeded randomized state-transition tests (seeds 1000-1099): launch→auth→analyze→cancel→retry→history→logout→login→background→resume→delete over launchGate + authStore + appStore + accessStore with a model checker style harness", "Write a fast-check or hand-rolled seeded generator; >=2000 sequences; every failing seed recorded and minimized; put harness under apps/mobile/__tests__/randomized/."),
    ("randomized-state-machine-B", "Seeded randomized state-transition tests (seeds 2000-2099) over the sync outbox + repository + offline capabilities: enqueue/flush/fail/retry/dedupe/delete under random network oracles", "Independent from other randomized agents; >=2000 sequences; assert outbox invariants (no loss, no duplicate accepted shots, monotone ids)."),
    ("randomized-state-machine-C", "Seeded randomized tests (seeds 3000-3099) over the edge fn router + authenticate() + rate limiter with random request interleavings, clock skew, cache expiry", "Deno harness; >=2000 requests per seed batch; assert 401/429 semantics, cache never serves a logged-out bearer."),
    ("randomized-pipeline-D", "Seeded randomized tests (seeds 4000-4099) over analysis-pipeline segmentation/classification with random keypoint noise, dropout, timing jitter, frame reordering", "Property: determinism for same seed, monotone confidence under added noise, abstention rate bounded; no fabricated labels — use synthetic streams and committed fixtures."),
    ("fuzz-edge-inputs", "Fuzzing: every edge route body/query/header with malformed JSON, huge strings, unicode edge cases, prototype-pollution keys, numeric overflow, null bytes, emoji, RTL, path traversal in ids", "Deno harness; >=5000 generated requests; assert only 400/401/404/413/429 — never 500 with a stack, never a write."),
    ("fuzz-mobile-persisted-state", "Fuzzing: SQLite kv / repository rows / Keychain vault payloads with random bytes, truncated JSON, wrong types, future schema versions", "Jest harness; hydrate/repository must reject gracefully with logged, user-recoverable state; never throw out of a store."),
    ("mutation-auth", "Mutation testing of the auth/session contract: mutate sessionKeeper/authStore/sessionVault/authenticate() (flip refresh timing, skip revoke, keep token on 401, cache logged-out bearer) and verify the existing suites FAIL for each mutant", "Report each mutant: killed/survived with the test that killed it; survived mutants are findings (test-quality gaps) — write the missing test on an attack branch."),
    ("mutation-rls-grants", "Mutation testing of the security matrix: drop/loosen one policy or grant at a time in a scratch copy of migrations and verify ./supabase/tests/run_rls_tests.sh FAILS for each mutant", "Never commit mutated migrations; scratch dir only. Survived mutants = findings."),
    ("mutation-free-rating-ledger", "Mutation testing of free-rating identity ledger: mutate lifetime_scored_count/identity_scored_count/access_state/reserve_analysis_permit backstops and verify security_regression.sql J1-J9 + edge tests FAIL", "Scratch copies only; report killed/survived per mutant."),
    ("mutation-pipeline-scoring", "Mutation testing of analysis-pipeline + scoring: off-by-one in segmentation windows, swapped stroke classes, inverted confidence, dropped abstention — do unit tests + bench:compare detect each?", "Do NOT edit tolerances/baseline/datasets; run bench on the mutant in /tmp and report which mutants the regression bench catches."),
    ("mutation-launch-gate", "Mutation testing of launchGate/onboarding gating: reintroduce a skip affordance, reorder gate, allow empty profile into app — do the pinned tests fail?", "Report killed/survived; write missing pins on an attack branch."),
    ("mutation-edge-webhook", "Mutation testing of webhook + billing entitlement sync: trust event body, skip secret, double-apply — do tests fail?", "Report killed/survived; write missing tests on an attack branch."),
    ("journey-first-launch-onboarding", "User journey E2E (Jest RNTL, full App tree): first launch → Welcome → all onboarding steps incl. back navigation, interruption mid-questionnaire, notification choice → SignIn", "Render App.tsx with mocked native modules; screenshots via react-test-renderer JSON snapshots + textual state dumps as evidence; assert no skip affordance exists."),
    ("journey-signin-restore", "User journey: Apple/Google sign-in → bootstrap → vault persist → kill/relaunch → restored signed-in within 8s budget → refresh rotation → sign-out (local scope) → other-device semantics", "Mock provider SDKs + fetch; assert exact persisted material (no access/provider token anywhere)."),
    ("journey-analyze-happy-and-fail", "User journey: Analyze → capture → permit reserve → analysis → Result → ResultDetails → FormReview; plus failure branches: permit denied, analysis throws, sync fails, free ratings exhausted → Paywall", "Full-tree render; assert every failure lands in a recoverable state with a retry/back control; no infinite spinner (fake timers advanced 60s)."),
    ("journey-history-library-delete", "User journey: Library/History load, empty state, reopen a result, delete shot (local + synced), stale entry after server mismatch, missing media", "Full-tree render; assert deletion consistency between SQLite and outbox and no ghost rows."),
    ("journey-settings-account-deletion", "User journey: Settings → Manage account → delete account (confirmation copy about used free ratings) → server request → local wipe → relaunch state; consent + notification settings persistence", "Full-tree render; assert copy matches legal.ts §7/§8 semantics and no data survives locally."),
    ("journey-paywall-purchase-restore", "User journey: Paywall → purchase (mock RC) success/cancel/error → entitlement reflected in accessStore → restore purchases → Settings membership row wording", "Mock react-native-purchases; assert only the two explicit buttons reach StoreKit auth; prices always store-returned."),
    ("journey-progress-streaks", "User journey: Progress/Streak calendar with 0/1/many shots, timezone boundaries (UTC±14), DST, week start locale, long names, RTL", "Deterministic clocks across at least 8 timezones; assert streak math never off-by-one across midnight boundaries."),
    ("journey-live-court-session", "User journey: Live Court session start/permission denial/stroke events (rapid, duplicate, out-of-order, malformed)/pause/resume/background/stop → summary; voice cue queue behaviour under overlap and interruption", "Drive liveCourt.ts/liveSessionCoach.ts/audio-coach-core with a scripted event stream (>=10k events accelerated); measure dropped/duplicate cues, ordering, memory growth (heap snapshots)."),
    ("journey-offline-first", "User journey: full offline session (analyze locally, queue sync) → reconnect → flush → server rejects some → user-visible reconciliation", "Assert no local data loss and honest status copy."),
    ("journey-account-switch", "User journey: sign out → sign in as another account on the same device: account-scoped SQLite data, no leakage of previous user's shots/profile/access state", "Assert accountScope isolation with two mocked identities."),
    ("journey-deep-links-urls", "Deep links / URL schemes / universal links / OAuth redirect handling: enumerate all registered schemes in Info.plist and RN Linking usage; attempt malicious payloads", "Report each handler with its validation; anything unvalidated is a finding."),
    ("journey-notifications-permissions", "Notifications + camera + mic permission flows: allow/deny/revoke-later/limited; settings deep-link; app must never dead-end", "Mock permission modules; assert copy and recovery controls."),
    ("screen-ux-a11y-i18n-1", "Per-screen UX/a11y/i18n audit: WelcomeScreen, SplashScreen, SignInScreen, OnboardingScreen — labels/roles, focus order, touch targets ≥44pt, dynamic type up to XXXL, long strings (Cyrillic/CJK/Arabic/German compounds), missing images", "Render each at 3 font scales × 3 viewport widths; report clipped/overlapping/unlabeled controls with rendered-tree evidence."),
    ("screen-ux-a11y-i18n-2", "Per-screen UX/a11y/i18n audit: HomeScreen, ProgressScreen, StreakCalendarScreen, LibraryScreen", "Same method as screen audit 1; include empty/loading/error/stale states."),
    ("screen-ux-a11y-i18n-3", "Per-screen UX/a11y/i18n audit: AnalyzeScreen, ResultScreen, ResultDetailsScreen, FormReviewScreen", "Same method; include every analysis state and failure copy."),
    ("screen-ux-a11y-i18n-4", "Per-screen UX/a11y/i18n audit: SettingsScreen, ManageAccountScreen, ConsentSettingsScreen, NotificationSettingsScreen, PaywallScreen, DrillLibraryScreen", "Same method; destructive actions need confirmation + accessible labels; paywall price/locale formatting."),
    ("i18n-locale-formatting", "Cross-cutting i18n: every Date/Intl/toLocale/number/decimal/percent/currency formatting site in apps/mobile and edge fn; timezone assumptions; hard-coded en-US; string concatenation of numbers", "Grep + execute under 12 locales (de-DE, fr-FR, ar-EG, hi-IN, ja-JP, pt-BR, tr-TR, ru-RU, th-TH, zh-CN, en-IN, es-419) with Intl polyfill states RN 0.87 ships; report every divergence."),
    ("i18n-unicode-names-text", "Cross-cutting i18n: Unicode names/display names/free text through sanitizeUserText, SQLite, edge validation, size caps (bytes vs code points vs graphemes), RTL, ZWJ emoji, combining marks", "Property tests; a valid 3-grapheme name must never be rejected as too long, and a 64KB payload must never pass a cap."),
    ("security-auth-attack-1", "Auth attack (independent #1): token replay, expired/forged/alg-none JWTs, provider-token transitional branch abuse, cache poisoning by token-hash collision, logout-then-reuse, refresh-token reuse after rotation", "Deno harness + code; every accepted request that should be rejected is P0."),
    ("security-auth-attack-2", "Auth attack (independent #2): same surface as #1 but start from the mobile client — what can a modified client make the server do? user-id spoofing in bodies, canonicalAppUserId confusion, account bootstrap with someone else's identity", "Do not read #1's work; independent."),
    ("security-cross-user-isolation-1", "Cross-user isolation (independent #1): two users in a throwaway Postgres — attempt reads/writes/deletes of the other's shots, sessions, permits, profile, access state, billing, deletion requests, drills favorites, storage objects via RLS + RPC + PostgREST-style upserts", "Extend security_regression.sql on an attack branch; any leak is P0."),
    ("security-cross-user-isolation-2", "Cross-user isolation (independent #2): same goal, via the edge fn routes with two mocked bearers and via SECURITY DEFINER functions' parameter surfaces", "Independent from #1."),
    ("security-injection-sanitization", "Injection & sanitization: SQL via RPC jsonb (apply_synced_shot), free-text fields, header injection, log injection, path traversal in drill media/storage keys, SSRF in any URL fetch, prototype pollution", "Deno + psql harness; exact payloads and results."),
    ("security-secrets-logging-privacy", "Secrets & privacy: secret scan (scripts/security-scan.sh), grep for tokens/keys in logs/telemetry payloads/analytics, Keychain accessibility class, what leaves the device (pose never uploaded), debug endpoints/flags reachable in Release", "No secret values in the report; cite file:line only."),
    ("security-dependencies", "Dependency audit: pnpm audit, npm audit (apps/mobile), pip freeze vs advisories, duplicated/conflicting versions, abandoned libs, lockfile drift, postinstall scripts; do NOT upgrade blindly — rank by exploitability in this app", "Report CVE id, package, reachable-or-not with evidence."),
    ("security-storage-policies", "Storage bucket policies & signed URLs: enumerate buckets in migrations/config, test anon/other-user access, URL expiry, path ownership binding, oversized upload caps", "Throwaway Postgres for policies; document what cannot be tested without the hosted platform as BLOCKED, not PASS."),
    ("security-rate-limit-dos", "Rate limiting & abuse: per-IP pre-auth, auth-failure, per-user budgets; bypass via header spoofing (X-Forwarded-For), cache key confusion, memory growth of L1 under key flood, Retry-After correctness; tools/loadtest/auth-abuse.js review", "Deno harness; measure heap growth under 100k distinct keys."),
    ("perf-edge-latency-n1", "Performance: edge fn per-route round trips (count Supabase calls per request), N+1 patterns, cache hit paths, payload sizes; benchmark with the deno harness (p50/p95 over 1000 requests per route)", "Profile first; report a table; a route doing >3 round trips on the hot path is a finding."),
    ("perf-mobile-render", "Performance: React Native render cost — re-render counts per store update for Home/Progress/Library/Analyze (why-did-you-render style instrumentation in jest), list virtualization, memo boundaries, heavy sync work on JS thread", "Report counts; runaway re-renders (>3 per single state change) are findings."),
    ("perf-sqlite-sync", "Performance: SQLite query plans (EXPLAIN QUERY PLAN) for repository queries at 10k shots; outbox flush batching; index coverage; history load time", "Generate 10k synthetic rows; report timings and plans."),
    ("perf-pipeline-throughput-memory", "Performance: analysis-pipeline throughput and heap over 500 consecutive synthetic analyses in one process (leak detection via --expose-gc heap deltas); temp-file growth in media-worker", "Report heap slope; monotone growth > 5% per 100 runs is a finding."),
    ("perf-startup-hydrate", "Performance: appStore/authStore hydrate() critical path — serial awaits, 8s launch budget adherence under slow refresh, work before first frame", "Instrument with fake timers; report the critical path and any avoidable serial I/O."),
    ("perf-bench-runner-determinism", "Performance/determinism: run bench:regression 3× on the same commit — identical outputs? runtime? any nondeterminism in metrics is a finding", "Report diffs between runs."),
    ("cv-bench-baseline-integrity", "CV: verify committed baseline.json provenance (dataset/model version, gitDirty false), rerun bench:regression on BASE_SHA and compare (must be 0/0); audit tolerances for anything so loose it cannot fail", "Never edit baseline/tolerances/datasets; report which metrics are null and why."),
    ("cv-gold-coverage-gaps", "CV: gold corpus coverage — per stroke class (forehand/backhand/serve/return/dink/volley/overhead), lighting, angle, multi-player, partial visibility: count labeled clips; identify unmeasurable claims; NEVER fabricate labels", "Output a coverage table; list which product claims lack any gold support (these become UNVERIFIED in the scoreboard)."),
    ("cv-failure-detection-abstention", "CV: failure detection & uncertainty — feed no-player, multi-player, occluded, far-camera fixtures and synthetic garbage; does the pipeline abstain with honest copy instead of scoring?", "Report confident-wrong cases with fixture ids."),
    ("cv-temporal-segmentation", "CV: temporal accuracy of stroke segmentation vs gold contact/segment timestamps where labels exist; sensitivity to fps (24/30/60/120) resampling", "Use only existing labels; report per-fps deltas."),
    ("cv-classification-confusion", "CV: shot classification confusion matrix on the gold corpus; per-class precision/recall; ambiguous strokes; compare to baseline report", "Only existing labels; no accuracy claims in user-facing copy — this is internal evidence."),
    ("cv-mac-vision-artifacts", "CV (Apple truth): download the Mac baseline artifacts (MAC_BASELINE_RUN once complete, else MAC_PRIOR_GREEN_RUN) with `gh run download`, inspect swing-lab-extract pose.json (pose count, confidence distribution, frame coverage) and the xcresult summaries; compare Linux replay proxy vs Apple Vision output on the same clip", "Never trigger a Mac run; report the divergence between planes."),
    ("mac-native-static-review-1", "macOS division (static #1): native/vision-core + native/swing-lab Swift — memory (CVPixelBuffer/CMSampleBuffer lifetimes), thread safety, force unwraps, error swallowing, Vision request reuse, main-thread blocking", "Linux only: read code + Mac artifacts; label INFERRED; no Mac run."),
    ("mac-native-static-review-2", "macOS division (static #2, independent): apps/mobile/ios native bridge code, AppDelegate, Info.plist privacy strings vs actual API usage, entitlements/capabilities, ATS exceptions, background modes, URL types, Release build settings (debug symbols, logging)", "Linux only; cross-check against docs/APP_STORE_SUBMISSION.md."),
    ("mac-xctest-adversary", "macOS division (execution — THE ONLY agent allowed to trigger a Mac run): write NEW adversarial XCTests for native/vision-core and native/swing-lab (empty clip, 1-frame clip, corrupted mp4, portrait/landscape, no person, 2 people, huge resolution, cancellation mid-extraction) on branch devin/attack-native-xctest, then run `scripts/mac-full-verify.sh --remote --ref devin/attack-native-xctest` ONCE and wait for it (may queue 1-3h behind other runs — wait, never start a second run); report the run URL and per-test results from the xcresult", "Craft clips with ffmpeg and commit small ones (<2MB) or generate them in the test at runtime. Never edit the workflow YAML or the runner."),
    ("ci-workflow-audit", "CI/CD audit: every workflow + verify script — can each fail? `|| true`, continue-on-error, swallowed exit codes, non-pinned actions, missing artifact retention, non-deterministic steps, secrets exposure in logs, fork PR safety of the Mac workflow", "Report each finding with file:line; test by intentionally breaking a stage in a scratch clone and confirming CI-equivalent scripts go red."),
    ("ci-verify-script-determinism", "Run scripts/verify-cloud.sh --tier full --start-services TWICE from clean states on BASE_SHA; diff summary.json stage statuses and timings; identify flaky/ordering-dependent tests (also run jest with --randomize / --seed and deno test with --shuffle)", "Report every test that changes outcome across runs with its seed."),
    ("release-readiness-manifest", "Release readiness: version triple (pbxproj MARKETING_VERSION/CURRENT_PROJECT_VERSION, apps/mobile/package.json, release-manifest.json, runtimeConfig APP_STORE_ID/bundle), pnpm release:check, PRELAUNCH_CHECKLIST walk (verified/human-only/BLOCKED per item), store-copy forbidden-terms scan of all user-facing strings", "Per .agents/skills/release-verification; no release action."),
    ("release-copy-policy-scan", "Store/user-facing copy policy: scan ALL user-visible strings in apps/mobile/src and legal.ts for forbidden terms (Android, Google Play, guest mode, Live Court, DUPR, competitors) and for accuracy %/superlative/AI-coach-equivalence claims; verify privacy/terms text consistency with actual data handling", "Report file:line per hit and whether it is user-visible."),
    ("static-health-mobile", "Static code health (apps/mobile): TODO/FIXME/HACK, swallowed catches, `as any`/unsafe casts, ignored promises, unbounded loops/timers without cleanup, dead exports (ts-prune style), stale feature flags", "Only findings with engineering value; provide file:line and why it matters."),
    ("static-health-edge-db", "Static code health (edge fn + migrations): 3247-line index.ts structure, error taxonomy consistency (tools/diagnostics/edge_error_taxonomy.ts), swallowed errors, 5xx leakage, unused RPCs, migration/grant drift vs code writes", "File:line findings; cross-check every client-side column write against column grants."),
    ("static-health-packages", "Static code health (packages/*, services/*, ml/): dead packages (nothing imports them?), duplicated logic, type escape hatches, circular deps (madge), unused deps (depcheck)", "Prove unused before calling dead; never delete."),
    ("failure-injection-backend", "Controlled failure injection (edge fn): Supabase auth down, DB error, storage error, Redis (Upstash) down, RevenueCat down/slow, malformed upstream JSON — user-visible error class and recoverability per route", "Deno harness with failing stubs; a 500 with detail leakage or a false 200 is a finding."),
    ("failure-injection-mobile", "Controlled failure injection (mobile): Keychain unavailable, SQLite open failure/disk full, camera unavailable, Vision provider throws, TTS unavailable, fetch throws synchronously, clock jumps", "Jest with module mocks; no infinite spinner, no silent failure, no crash out of a store."),
    ("data-integrity-orphans", "Data integrity: orphan/duplicate/cascade analysis across migrations — every FK, ON DELETE behaviour, nullability, unique constraints vs code assumptions (e.g. one permit per shot), pg_cron sweep correctness, deletion request expiry", "Throwaway Postgres; construct each bad state and show which constraint (if any) prevents it."),
    ("architecture-map-deps", "Architecture map & dependency graph: every app/package/service/native target/workflow/env var/secret dependency/feature flag/dataset/artifact; critical paths; single points of failure; unverifiable code; stale/duplicate systems (services/api vs edge fn, mac-smoke-test.yml vs mac-full-verify.yml)", "Produce docs-ready JSON + Mermaid uploaded as attachments; do not delete anything."),
]

# ---------------------------------------------------------------------------
# Shared prompt fragments
# ---------------------------------------------------------------------------

COMMON_RULES = f"""Repository: {REPO_TOKEN} (public GitHub monorepo; shipping product = iOS app `apps/mobile`, backend = Supabase Edge Function `supabase/functions/api`).
START STATE: `git fetch origin && git checkout {BASE_SHA}` (branch `{BASE_BRANCH}`). All work is relative to this commit; never push to `main`; never open a pull request (the coordinator integrates).
Read `AGENTS.md`, `REVIEW.md`, `docs/devin/OPERATING_SYSTEM.md`, `APP_STORE_SUBMISSION.md` and the skills in `.agents/skills/` first.
Environment: Node 20/22 + pnpm 10 are present. If `deno` is missing: `curl -fsSL https://deno.land/install.sh | sh` (adds ~/.deno/bin). `scripts/security-scan.sh` self-downloads a pinned gitleaks. Docker services: `docker compose up -d postgres postgres_test redis elasticmq` or pass `--start-services` to verify-cloud. apps/mobile uses npm (never pnpm inside it): `cd apps/mobile && npm ci`.
Execution planes (never claim results from a plane you did not run):
- cloud (Linux): `scripts/verify-cloud.sh --tier pr|full --start-services` → `artifacts/verify-cloud/<run>/summary.json`; mobile `cd apps/mobile && npx tsc --noEmit && npx jest --ci --silent`; edge `(cd supabase/functions/api/__wf__ && deno task test)`; RLS `./supabase/tests/run_rls_tests.sh`; ML `python3 -m unittest discover -s ml/scripts -p 'test_*.py'`.
- bench: `pnpm --filter @pickle/evaluation bench:regression --out-dir /tmp/cand --run-id cand` then `pnpm -s --filter @pickle/evaluation bench:compare datasets/reports/regression/baseline.json /tmp/cand/cand.json --json > /tmp/cand/compare.json` on a CLEAN commit. Never edit `regression.tolerances.json`, `datasets/`, or the baseline. Linux CV numbers are a replay proxy, not Apple device truth.
- mac (Apple truth): the self-hosted M4 runner is ONE physical machine and each run takes 1-2 hours. You MUST NOT run `scripts/mac-full-verify.sh --remote`, push any `ci/mac-*` branch, or touch `.github/workflows/mac-*.yml` unless your role text explicitly says you are the ONE agent allowed to. Everyone else reads Apple evidence from existing artifacts: `gh run download 33841813597` (baseline on {BASE_SHA[:8]}; if not finished, `gh run download 33829297073`, prior green run on the same Apple paths). Never claim Swift/Vision/iOS runtime behaviour from Linux.
Hard rules: never weaken/skip/delete tests, never add `|| true`, never fabricate labels/metrics/evidence, never touch production Supabase (project ucqnaiwqwjtgvlduiuib) or App Store Connect, never store or print secrets, never modify the Mac runner, never modify applied migrations (add a new one), never use pnpm inside apps/mobile, never use destructive git commands. User-facing copy must follow `APP_STORE_SUBMISSION.md` (no Android/Google Play/guest mode/Live Court/DUPR/competitor mentions; no accuracy %, superlatives or AI-coach-equivalence claims).
Evidence standard: every claim carries the exact command, exit code and artifact path. Label statements VERIFIED (you ran it) / INFERRED (read code) / UNKNOWN. Upload key artifacts (logs, summary.json, test output, screenshots, JSON tables) with the upload_attachment tool and return the URLs in `attachment_urls`. A skipped/unavailable stage is NOT a pass.
Findings format (one object each): {{"severity":"P0|P1|P2|P3","title":"<short>","files":["path:line",...],"repro":"<exact command or steps>","observed":"<what happened>","expected":"<what should happen>","evidence":"<attachment url or artifact path>","regression":"yes|no|unknown (vs main)"}}. P0 = data loss, security breach, auth bypass, crash on a core flow, fundamentally incorrect analysis, release blocker. P1 = major broken feature, serious reliability/performance/CV failure. P2 = important edge case, degraded UX, recoverability problem. P3 = polish. Report ONLY what you reproduced or can point to at file:line with a concrete failure mode; do not pad. An empty findings list with strong `verified_ok` evidence is a valid and valuable result."""

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

MAP_SCHEMA = {
    "type": "object",
    "properties": {
        "subsystem": {"type": "string"},
        "components": {"type": "array", "items": {"type": "string"}, "description": "file/module → one-line responsibility"},
        "invariants": {"type": "array", "items": {"type": "string"}},
        "existing_tests": {"type": "array", "items": {"type": "string"}},
        "weak_or_untested": {"type": "array", "items": {"type": "string"}},
        "unverifiable_on_linux": {"type": "array", "items": {"type": "string"}},
        "hotspots": {"type": "array", "items": {"type": "string"}, "description": "file:line risk hotspots with one-line reason"},
        "scenarios": {"type": "array", "items": {"type": "string"}, "description": "15-30 concrete adversarial scenarios specific to this subsystem"},
        "execution_commands": {"type": "array", "items": {"type": "string"}},
        "baseline_exit_codes": {"type": "array", "items": {"type": "string"}, "description": "'<command> → exit N' for each execution command you ran"},
        "attachment_urls": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
    },
    "required": ["subsystem", "components", "invariants", "existing_tests", "weak_or_untested", "hotspots", "scenarios", "execution_commands", "summary"],
}

AUDIT_SCHEMA = {
    "type": "object",
    "properties": {
        "findings": {"type": "array", "items": FINDING_ITEM},
        "verified_ok": {"type": "array", "items": {"type": "string"}, "description": "'<what held> — <command> → exit 0 — <artifact>'"},
        "scenarios_executed": {"type": "integer"},
        "tests_added": {"type": "integer"},
        "attack_branch": {"type": "string", "description": "pushed branch holding new tests/harnesses (empty if none)"},
        "attachment_urls": {"type": "array", "items": {"type": "string"}},
        "blocked_external": {"type": "array", "items": {"type": "string"}, "description": "things that need a human/credential/device — precise minimum action"},
        "summary": {"type": "string"},
    },
    "required": ["findings", "verified_ok", "scenarios_executed", "tests_added", "attack_branch", "attachment_urls", "blocked_external", "summary"],
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
                    "files": {"type": "array", "items": {"type": "string"}, "description": "repo-relative FILE paths (no :line) the fix will need to edit, tests included"},
                    "repro": {"type": "string"},
                    "expected": {"type": "string"},
                    "evidence": {"type": "string"},
                    "acceptance": {"type": "array", "items": {"type": "string"}, "description": "executable acceptance criteria for the fix"},
                    "merged_from": {"type": "array", "items": {"type": "string"}},
                },
            },
        },
        "rejected": {"type": "array", "items": {"type": "string"}, "description": "'<title> — why (not reproducible / pre-existing by design / duplicate of <id> / P3 defer)'"},
        "deferred_p3": {"type": "array", "items": {"type": "string"}},
        "blocked_external": {"type": "array", "items": {"type": "string"}},
        "status": {"type": "string", "enum": ["PASS", "FAIL", "DEGRADED", "UNVERIFIED", "BLOCKED"]},
        "status_reason": {"type": "string"},
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
        "acceptance_results": {"type": "array", "items": {"type": "string"}, "description": "one per criterion, in order: 'PASS|FAIL|UNKNOWN — <criterion> — <command + exit code>'"},
        "failing_test_first_commit": {"type": "string", "description": "sha of the commit where the new regression test FAILS on the unfixed code"},
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
        "test_fails_without_fix": {"type": "boolean", "description": "you reverted the fix (not the test) locally and the new test failed"},
        "summary": {"type": "string"},
    },
    "required": ["verdict", "blocking_issues", "acceptance_verified", "reverify_exit", "test_fails_without_fix", "summary"],
}

ADVERSARY_SCHEMA = {
    "type": "object",
    "properties": {
        "break_found": {"type": "boolean"},
        "breaks": {"type": "array", "items": {"type": "string"}, "description": "'<what broke> — <exact repro> — <observed vs expected>'"},
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


# The org allows 100 concurrent sessions shared with the stress workflow and
# manual fix/review sessions, so creation is throttled often; a throttled agent
# must wait as long as it takes (a lost reviewer/adversary rejects a whole fix
# candidate) and must NOT hold a slot while it sleeps.
MAX_CONCURRENT = int(os.environ.get("PS_AUDIT_CONCURRENCY", "40"))
THROTTLE_MAX_ATTEMPTS = int(os.environ.get("PS_AUDIT_THROTTLE_ATTEMPTS", "240"))
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
# Wave 1/2 — map each subsystem
# ---------------------------------------------------------------------------


async def map_subsystem(sub) -> dict | None:
    sid, title, plane, paths, howto = sub
    prompt = f"""{COMMON_RULES}

ROLE: ARCHITECTURE MAPPER (read-only; change no tracked file). Subsystem `{sid}` — {title}. Plane: {plane}.
Paths: {dump(paths)}. Execution hint: {howto}
1. Map every component, contract, state holder, resource lifecycle, error path, external integration (Supabase/RevenueCat/Apple/Google/Keychain/SQLite/Vision/AVFoundation), environment variable and feature flag in these paths, and how the rest of the repo depends on them (grep importers).
2. List the invariants the code claims (comments, AGENTS.md pins, tests) and which tests pin each; list what is weakly/not tested and what cannot be verified on Linux.
3. EXECUTE the existing tests/checks for this subsystem now (the commands in the hint plus anything else relevant) and record `<command> → exit N` in `baseline_exit_codes`; upload logs.
4. Produce 15-30 CONCRETE adversarial scenarios specific to this subsystem (malformed input, edge cases, concurrency/timing, cancellation, lifecycle transitions, permission denial, network interruption, stale sessions, duplicate/rapid actions, corrupted media/state) — each one sentence, executable by a later agent with the existing harnesses. Prefer scenarios that current tests do not cover.
Return the map as structured output; upload a Markdown version as an attachment too."""
    return await safe_agent(prompt, phase="map", schema=MAP_SCHEMA, label=f"map-{sid}", soft_time_limit_minutes=35)


# ---------------------------------------------------------------------------
# Waves 2-6 — three-pass audit per subsystem
# ---------------------------------------------------------------------------


def chunk(items: list[str], size: int, cap: int) -> list[list[str]]:
    items = sorted(items)
    out = [items[i : i + size] for i in range(0, len(items), size)]
    if len(out) > cap:
        # fold the tail into the last kept chunk deterministically
        head, tail = out[: cap - 1], out[cap - 1 :]
        head.append([s for c in tail for s in c])
        out = head
    return out or [[]]


async def structural(sub, m: dict, variant: int) -> dict | None:
    sid, title, plane, paths, _ = sub
    angle = (
        "Focus: contracts/types/state management/resource lifecycle/error handling/invariants — read every line in scope."
        if variant == 0
        else "Focus: dependencies, cross-module coupling, concurrency & timing assumptions, null/undefined assumptions, ignored errors, unsafe casts, TODO/FIXME/HACK, dead or stale code, docs/comments that contradict code. Independent of the other structural reviewer — do not coordinate."
    )
    prompt = f"""{COMMON_RULES}

ROLE: STRUCTURAL AUDITOR #{variant + 1} (PASS 1 of 3). Subsystem `{sid}` — {title} (plane {plane}). Scope paths: {dump(paths)}.
{angle}
Architecture map from the mapper (treat as hints, verify yourself): invariants={dump(m.get('invariants', []))}; hotspots={dump(m.get('hotspots', []))}; weak_or_untested={dump(m.get('weak_or_untested', []))}.
Method: read the code; for every suspected defect WRITE A TEST or a minimal script that demonstrates it (push to branch `devin/audit-{sid}-structural{variant + 1}` — new test files only, never modify existing tests), run it, and report it as a finding only if it fails on {BASE_SHA[:8]}. Also list what you verified holds (`verified_ok`). Change no production code."""
    return await safe_agent(prompt, phase="audit-structural", schema=AUDIT_SCHEMA, label=f"structural{variant + 1}-{sid}", soft_time_limit_minutes=50)


async def execution(sub, m: dict) -> dict | None:
    sid, title, plane, paths, howto = sub
    mac_note = (
        " This subsystem's runtime truth is Apple-only: download and READ the Mac artifacts (xcresult summaries, logs, launch summary, vision extract) instead of claiming runtime results; run what does exist on Linux (tsc/jest/static checks)."
        if plane == "mac"
        else ""
    )
    prompt = f"""{COMMON_RULES}

ROLE: EXECUTION TESTER (PASS 2 of 3). Subsystem `{sid}` — {title} (plane {plane}). Scope paths: {dump(paths)}. Execution hint: {howto}.{mac_note}
Mapper's execution commands and baseline exits: {dump(m.get('execution_commands', []))} / {dump(m.get('baseline_exit_codes', []))}.
Method: actually build/run/test every execution path in this subsystem: the full existing suites (with `--randomize`/`--shuffle` where the runner supports it, and twice to detect flakiness), each documented script, each CLI, each RPC/route with real services where Docker allows, exercising loading/success/failure/empty/stale/missing-data states. Inspect logs and outputs for warnings, swallowed errors, misleading success, non-determinism, resource leaks (open handles: `jest --detectOpenHandles`), and coverage gaps (`jest --coverage` for the scope files — report % per file). Every execution problem becomes a finding with exit code + log artifact. Push any harness you wrote to `devin/audit-{sid}-execution` (new files only). Change no production code."""
    return await safe_agent(prompt, phase="audit-execution", schema=AUDIT_SCHEMA, label=f"execution-{sid}", soft_time_limit_minutes=50)


async def adversarial(sub, m: dict, idx: int, scenarios: list[str]) -> dict | None:
    sid, title, plane, paths, howto = sub
    prompt = f"""{COMMON_RULES}

ROLE: ADVERSARIAL TESTER #{idx + 1} (PASS 3 of 3). Subsystem `{sid}` — {title} (plane {plane}). Scope paths: {dump(paths)}. Harness hint: {howto}.
Your assigned scenarios (execute EVERY one; add your own if you finish): {dump(scenarios)}
Method: for each scenario write an executable test/script (jest / deno test / psql / node script) that performs the attack against {BASE_SHA[:8]}, run it, and classify: BROKEN (finding with repro + observed/expected + artifact) or HELD (verified_ok entry). Use seeded randomness where useful and record seeds. Try the unusual: rapid repeats, interleavings, cancellation mid-flight, corrupt state, clock skew, unicode, huge inputs, permission denial, background/foreground. Compare with `origin/main` when unsure whether a break is pre-existing (still report it; mark `regression`). Push all tests to `devin/attack-{sid}-{idx + 1}` (new files only). Change no production code. Never trigger a Mac run."""
    return await safe_agent(prompt, phase="audit-adversarial", schema=AUDIT_SCHEMA, label=f"adversary{idx + 1}-{sid}", soft_time_limit_minutes=55)


async def cross_cutting(cc) -> dict | None:
    cid, title, instructions = cc
    prompt = f"""{COMMON_RULES}

ROLE: CROSS-CUTTING SPECIALIST `{cid}` — {title}.
Instructions: {instructions}
Method: this is an EXECUTION + ADVERSARIAL task, not a code-reading essay. Build the harness, run it at the stated scale, record seeds/inputs for every failure so it is replayable, and upload raw outputs (JSON tables, logs, heap numbers, matrices) as attachments. Push harnesses/tests to `devin/xc-{cid}` (new files only; never modify existing tests; never modify production code, tolerances, datasets or the baseline). Anything requiring a human, a credential, a physical device or the hosted Supabase platform goes in `blocked_external` with the precise minimum action — never mark it as passing. Never trigger a Mac run unless your role text above explicitly says you are the one agent allowed to."""
    limit = 60 if cid in ("mac-xctest-adversary", "ci-verify-script-determinism") else 55
    return await safe_agent(prompt, phase="audit-crosscutting", schema=AUDIT_SCHEMA, label=cid, soft_time_limit_minutes=limit)


# ---------------------------------------------------------------------------
# Adjudication (per subsystem / per cross-cutting group) — agent reproduces
# ---------------------------------------------------------------------------


def slim(report: dict | None, source: str) -> dict:
    if not report:
        return {"source": source, "findings": [], "verified_ok": [], "blocked_external": [], "summary": "agent failed / no output"}
    return {
        "source": source,
        "findings": report.get("findings", []),
        "verified_ok": report.get("verified_ok", []),
        "attack_branch": report.get("attack_branch", ""),
        "attachment_urls": report.get("attachment_urls", []),
        "blocked_external": report.get("blocked_external", []),
        "scenarios_executed": report.get("scenarios_executed", 0),
        "summary": report.get("summary", ""),
    }


async def adjudicate(area_id: str, area_title: str, reports: list[dict], scope_hint: list[str]) -> dict | None:
    prompt = f"""{COMMON_RULES}

ROLE: ADJUDICATOR for area `{area_id}` — {area_title}. Scope hint: {dump(scope_hint)}.
You receive the independent reports of several auditors (structural, execution, adversarial, cross-cutting). Do NOT trust them; your job is to deduplicate, REPRODUCE, and decide.
Reports: {dump(reports)}
Procedure:
1. Deduplicate findings (same root cause → one confirmed item with `merged_from` listing the source titles).
2. For every P0/P1/P2 candidate: check out {BASE_SHA[:8]}, fetch the auditor's attack branch if given, and reproduce it yourself. Confirm only what you reproduced (or what is an undeniable file:line defect such as a missing grant/policy). Reject with a reason otherwise (not reproducible, by design per AGENTS.md/APP_STORE_SUBMISSION.md, duplicate, pre-existing and accepted, or P3 → deferred_p3).
3. For each confirmed item set the final severity, the repo-relative FILES a fix will touch (production files + the test file(s) to add/extend; no `:line`), and 2-5 EXECUTABLE acceptance criteria (exact commands that must exit 0 / assertions that must hold) — a fixer will be judged only on these.
4. Set the area `status`: FAIL if any confirmed P0/P1; DEGRADED if only P2 confirmed or real flakiness; PASS if nothing confirmed AND the verified_ok evidence covers the subsystem's core paths on the relevant plane; UNVERIFIED if evidence is thin or the plane could not be run; BLOCKED if only an external/human action stands in the way. Explain in `status_reason`. Never convert UNVERIFIED into PASS.
Upload your reproduction logs as attachments. Change no production code; you may push reproduction tests to `devin/adjudicate-{area_id}`."""
    return await safe_agent(prompt, phase="adjudicate", schema=ADJUDICATE_SCHEMA, label=f"adjudicate-{area_id}", soft_time_limit_minutes=55)


# ---------------------------------------------------------------------------
# Clustering (deterministic code) — merge confirmed items that share files
# ---------------------------------------------------------------------------


def norm_file(f: str) -> str:
    f = f.strip().split(":")[0].strip()
    return f.lstrip("./")


def build_clusters(confirmed: list[dict]) -> list[dict]:
    """Cluster per adjudication area so cluster identity depends only on that
    area's confirmed items (stable across resumes while other areas are still
    pending). Cross-area file overlaps are resolved by the coordinator at
    integration."""
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
        # keep each implementer's job bounded: at most 3 defects per cluster.
        # Sub-clusters of one file-connected group may share files; the
        # coordinator resolves clerical merge conflicts at integration.
        parts = [members[i : i + 3] for i in range(0, len(members), 3)]
        for pi, part in enumerate(parts):
            sev = min(m["severity"] for m in part)  # 'P0' < 'P1' ...
            files = sorted({norm_file(f) for m in part for f in m.get("files", []) if f.strip()})
            cid = "+".join(m["id"] for m in part)
            clusters.append(
                {
                    "cluster_id": cid,
                    "severity": sev,
                    "files": files,
                    "items": part,
                    "shared_files_with_siblings": len(parts) > 1,
                    "competing": 2 if sev in ("P0", "P1") else 1,
                }
            )
    return clusters


# ---------------------------------------------------------------------------
# Fix loop: implement ×N → review ∥ adversary → judge (code)
# ---------------------------------------------------------------------------


def cluster_brief(cl: dict) -> str:
    return dump(
        [
            {k: it.get(k) for k in ("id", "severity", "title", "repro", "expected", "evidence", "acceptance", "files")}
            for it in cl["items"]
        ]
    )


async def implement(cl: dict, variant: int) -> dict | None:
    n = cl["competing"]
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", cl["cluster_id"])[:60].strip("-")
    variant_note = (
        f"You are implementer {variant + 1} of {n} working INDEPENDENTLY; the winner is chosen on evidence. Variant {variant + 1}: {'take the most direct root-cause fix' if variant == 0 else 'take a genuinely different approach (different layer or mechanism) from the obvious one and state it in `approach`'}."
        if n > 1
        else ""
    )
    criteria = [a for it in cl["items"] for a in it.get("acceptance", [])]
    prompt = f"""{COMMON_RULES}

ROLE: IMPLEMENTER. Fix cluster `{cl['cluster_id']}` (severity {cl['severity']}). {variant_note}
Confirmed defects (each was independently reproduced by an adjudicator): {cluster_brief(cl)}
Files you may edit (the ONLY paths; other fixers own everything else concurrently{' — sibling fixers may also touch some of these files: keep your diff minimal and localized' if cl.get('shared_files_with_siblings') else ''}): {dump(cl['files'])} — if a correct fix truly needs another file, add it, keep the addition minimal, and list it in `files_changed` with a justification in `summary`.
Acceptance criteria, in order (report one `acceptance_results` line per criterion): {dump(criteria)}
Required loop: REPRODUCE → write the regression test and commit it FAILING on the unfixed code (record that sha in `failing_test_first_commit`) → FIX the root cause (no workaround, no broad try/catch, no weakened assertion, no `|| true`) → test PASSES → run the full relevant suite(s) → `scripts/verify-cloud.sh --tier pr --start-services` (exit code → `cloud_pr_tier_exit`; run `--tier full` if you touched db/edge/rls) → bench plane changes also need `bench:compare` with 0 regressions (bump estimator/model version per docs/EVALUATION.md when behaviour changes). Migrations: NEW file only, plus grants sized to the writes. User-facing copy rules apply.
Branch `devin/fix-{slug}-v{variant + 1}` from {BASE_SHA[:8]}; commit, push (NO pull request), report `branch`, `head_sha`, `files_changed`. If a criterion cannot be met, report FAIL honestly."""
    return await safe_agent(prompt, phase="fix-implement", schema=IMPLEMENT_SCHEMA, label=f"fix-{slug}-v{variant + 1}", soft_time_limit_minutes=60)


async def review(cl: dict, cand: dict) -> dict | None:
    criteria = [a for it in cl["items"] for a in it.get("acceptance", [])]
    prompt = f"""{COMMON_RULES}

ROLE: INDEPENDENT REVIEWER. Do NOT trust the implementer; verify everything yourself.
Cluster `{cl['cluster_id']}` ({cl['severity']}): {cluster_brief(cl)}
Candidate branch `{cand['branch']}` at `{cand['head_sha']}`; implementer claims: {dump(cand.get('acceptance_results', []))}; claimed files: {dump(cand.get('files_changed', []))}.
Allowed files: {dump(cl['files'])}. Acceptance criteria: {dump(criteria)}.
1. `git diff {BASE_SHA[:8]}...{cand['branch']}` — every changed path must be inside the allowed files (or justified in the implementer's summary); unrelated changes, weakened/removed assertions, skipped tests, `|| true`, broad catches, copy-rule violations, migration edits to applied files, grant widening beyond the writes → blocking.
2. Apply `REVIEW.md` + `AGENTS.md` (auth/RLS/grants, error bodies, model versioning, Apple lifecycle, privacy, copy).
3. Re-run yourself on the candidate: the new regression test(s), the relevant suites, and `scripts/verify-cloud.sh --tier pr --start-services` (exit → `reverify_exit`). Then locally revert ONLY the production change (keep the test) and confirm the new test FAILS (`test_fails_without_fix`); restore afterwards. Bench-plane: re-run `bench:compare`.
4. One `acceptance_verified` line per criterion: 'VERIFIED|NOT VERIFIED — <criterion> — <how>'.
`approve` only if every criterion is VERIFIED, reverify_exit is 0, test_fails_without_fix is true, and there are no blocking issues. Do not edit the branch."""
    return await safe_agent(prompt, phase="fix-review", schema=REVIEW_SCHEMA, label=f"review-{cand['branch'][-40:]}", soft_time_limit_minutes=45)


async def adversary(cl: dict, cand: dict) -> dict | None:
    prompt = f"""{COMMON_RULES}

ROLE: ADVERSARIAL TESTER. Break candidate branch `{cand['branch']}` (at `{cand['head_sha']}`) which claims to fix cluster `{cl['cluster_id']}`: {cluster_brief(cl)}
Attack the FIX and its neighbourhood: does the original repro still fail in any variant (different ordering, concurrency, unicode, boundary sizes, cancellation mid-flight, stale/expired sessions, RLS/grant boundaries, background/foreground, clock skew)? Did the fix introduce a regression elsewhere (run the suites of every module that imports the changed files)? Compare behaviour with {BASE_SHA[:8]} — only regressions or bugs in the changed code count as breaks. Write NEW failing tests that expose real bugs on branch `devin/attack-fix-{cand['head_sha'][:8]}` and push it (`attack_branch`). Report `break_found` only with an exact repro and observed-vs-expected. Never modify the candidate branch. Never trigger a Mac run."""
    return await safe_agent(prompt, phase="fix-adversary", schema=ADVERSARY_SCHEMA, label=f"adversary-{cand['branch'][-40:]}", soft_time_limit_minutes=45)


_P3_BREAK = re.compile(r"^\W*(p3|severity\W*p3)\b", re.IGNORECASE)


def blocking_breaks(adv: dict) -> list[str]:
    """Breaks the adversary itself graded P3 (polish/maintainability, e.g. extra
    type diagnostics in a file that already has them) are follow-ups for the
    coordinator, not grounds to reject a fix that closes a confirmed P0-P2
    defect. Anything ungraded or graded P0-P2 blocks."""
    return [b for b in adv.get("breaks", []) if not _P3_BREAK.match(str(b))]


def judge(cl: dict, evaluated: list[tuple[dict, dict | None, dict | None]]) -> dict | None:
    eligible = []
    for cand, rev, adv in evaluated:
        if not rev or not adv:
            log(f"judge {cl['cluster_id']}: {cand['branch']} missing review/adversary output -> rejected")
            continue
        all_pass = bool(cand["acceptance_results"]) and all(r.strip().upper().startswith("PASS") for r in cand["acceptance_results"])
        blocking = blocking_breaks(adv)
        followups = [b for b in adv.get("breaks", []) if b not in blocking]
        # Per-candidate verify-cloud runs on child VMs share one remote with
        # hundreds of concurrently pushed audit branches; the gitleaks history
        # stage walks every fetched ref, so a non-zero exit there is not
        # attributable to the candidate. The coordinator's verify-cloud --tier
        # full on the INTEGRATED branch is the authoritative Linux gate, so
        # verify exits are recorded and used for ranking, not for rejection.
        verified_clean = cand["cloud_pr_tier_exit"] == 0 or rev["reverify_exit"] == 0
        ok = (
            all_pass
            and rev["verdict"] == "approve"
            and rev["test_fails_without_fix"]
            and not blocking
            and int(cand.get("bench_regressions", 0) or 0) == 0
        )
        cand["judge"] = {
            "verified_clean_on_child": verified_clean,
            "needs_integration_verify": not verified_clean,
            "adversary_p3_followups": followups,
        }
        log(
            f"judge {cl['cluster_id']}: {cand['branch']} impl_pass={all_pass} verify={cand['cloud_pr_tier_exit']} review={rev['verdict']}/{rev['reverify_exit']} "
            f"test_fails_without_fix={rev['test_fails_without_fix']} adversary_break={adv['break_found']} blocking_breaks={len(blocking)} p3_followups={len(followups)} "
            f"-> {'ELIGIBLE' if ok else 'rejected'}{'' if verified_clean else ' (verify pending at integration)'}"
        )
        if ok:
            eligible.append((cand, rev, adv))
    if not eligible:
        return None
    eligible.sort(
        key=lambda t: (
            0 if t[0]["judge"]["verified_clean_on_child"] else 1,
            len(blocking_breaks(t[2])),
            len(t[1]["blocking_issues"]),
            -int(t[2]["attacks_tried"]),
            len(t[0].get("files_changed", [])),
            t[0]["branch"],
        )
    )
    return eligible[0][0]


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

    # Round 2: the reviewer's blocking issues and the adversary's proven breaks
    # become extra acceptance criteria for ONE follow-up implementer who starts
    # from the strongest rejected candidate; then a fresh reviewer ∥ adversary
    # pair (who have not seen round 1) re-gate it.
    if not winner:
        base = pick_round2_base(evaluated)
        if base:
            cand, rev, adv = base
            r2 = await implement_round2(cl, cand, rev, adv)
            if r2:
                rev2, adv2 = await asyncio.gather(review(cl, r2), adversary(cl, r2))
                evaluated2 = [(r2, rev2, adv2)]
                winner = judge(cl, evaluated2)
                rounds.append([{"candidate": r2, "review": rev2, "adversary": adv2}])
    log(f"fix cluster {cl['cluster_id']}: winner = {winner['branch'] if winner else 'NONE (nothing proven)'} after {len(rounds)} round(s)")
    return {
        "cluster": cl,
        "winner": winner,
        "candidates": rounds[0],
        "rounds": rounds,
        "reason": "" if winner else "no candidate passed implementer+reviewer+adversary gates",
    }


def pick_round2_base(evaluated: list[tuple[dict, dict | None, dict | None]]):
    """Strongest rejected candidate: reviewed + attacked, fewest blocking breaks,
    then fewest reviewer blockers. Candidates whose review/adversary never ran
    give the follow-up implementer nothing to act on and are skipped."""
    usable = [(c, r, a) for c, r, a in evaluated if r and a]
    if not usable:
        return None
    usable.sort(
        key=lambda t: (
            len(blocking_breaks(t[2])),
            len(t[1]["blocking_issues"]),
            0 if t[1]["verdict"] == "approve" else 1,
            t[0]["branch"],
        )
    )
    return usable[0]


async def implement_round2(cl: dict, cand: dict, rev: dict, adv: dict) -> dict | None:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", cl["cluster_id"])[:60].strip("-")
    criteria = [a for it in cl["items"] for a in it.get("acceptance", [])]
    extra = [f"REVIEW BLOCKER: {b}" for b in rev.get("blocking_issues", [])] + [f"ADVERSARY BREAK: {b}" for b in blocking_breaks(adv)]
    prompt = f"""{COMMON_RULES}

ROLE: IMPLEMENTER (ROUND 2). Cluster `{cl['cluster_id']}` (severity {cl['severity']}): {cluster_brief(cl)}
Round-1 candidate `{cand['branch']}` at `{cand['head_sha']}` (approach: {cand.get('approach', 'n/a')}) was REJECTED by the independent gate. Its reviewer said: {dump(rev.get('summary', ''))}. Its adversary said: {dump(adv.get('summary', ''))}{(' — attack branch with failing tests: ' + adv['attack_branch']) if adv.get('attack_branch') else ''}.
Start from `{cand['branch']}` (branch `devin/fix-{slug}-r2` from it). Keep what was right; fix EVERY item below at the root cause (a proven regression means the round-1 approach was wrong there — change the approach, do not paper over it; if an adversary test is wrong, prove it with evidence in `summary`, otherwise adopt it as a regression test):
{dump(extra)}
Original acceptance criteria (still required, report one `acceptance_results` line per criterion, then one per extra item above): {dump(criteria)}
Allowed files: {dump(cl['files'])} plus files the round-1 candidate already changed; any other file must be justified in `summary`.
Required loop: REPRODUCE each item → failing test committed first (`failing_test_first_commit`) → fix → passing → full relevant suites → `scripts/verify-cloud.sh --tier pr --start-services` (exit → `cloud_pr_tier_exit`; `--tier full` if you touched db/edge/rls; if ONLY the security stage fails and gitleaks points at commits that are not ancestors of your HEAD, say so verbatim in `summary` and also run `scripts/security-scan.sh --history --log-opts {BASE_SHA[:8]}..HEAD` + `--tree` and report both exits). Bench plane: `bench:compare` with 0 regressions. No PR. Report `branch`, `head_sha`, `files_changed`; report FAIL honestly for anything unmet."""
    return await safe_agent(prompt, phase="fix-implement-r2", schema=IMPLEMENT_SCHEMA, label=f"fix-{slug}-r2", soft_time_limit_minutes=60)


# ---------------------------------------------------------------------------
# Per-subsystem pipeline
# ---------------------------------------------------------------------------


async def run_subsystem(sub) -> dict:
    sid, title, plane, paths, _ = sub
    m = await map_subsystem(sub)
    if not m:
        m = {"invariants": [], "hotspots": [], "weak_or_untested": [], "scenarios": [], "execution_commands": [], "baseline_exit_codes": []}
    save(f"map-{sid}.json", m)
    scen_chunks = chunk(m.get("scenarios", []) or [f"generic adversarial sweep of {title}"], 7, 4)
    log(f"{sid}: mapped; {len(m.get('scenarios', []))} scenarios → {len(scen_chunks)} adversaries")
    results = await asyncio.gather(
        structural(sub, m, 0),
        structural(sub, m, 1),
        execution(sub, m),
        *[adversarial(sub, m, i, sc) for i, sc in enumerate(scen_chunks)],
    )
    labels = ["structural1", "structural2", "execution"] + [f"adversary{i + 1}" for i in range(len(scen_chunks))]
    reports = [slim(r, lab) for r, lab in zip(results, labels)]
    save(f"audit-{sid}.json", reports)
    total_findings = sum(len(r["findings"]) for r in reports)
    log(f"{sid}: audit done — {total_findings} raw findings, {sum(r.get('scenarios_executed', 0) for r in reports)} scenarios executed")
    adj = await adjudicate(sid, title, reports, paths)
    save(f"adjudicate-{sid}.json", adj or {"status": "UNVERIFIED", "status_reason": "adjudicator failed", "confirmed": []})
    log(f"{sid}: status={adj['status'] if adj else 'UNVERIFIED'} confirmed={len(adj['confirmed']) if adj else 0}")
    return {"id": sid, "title": title, "plane": plane, "map": m, "reports": reports, "adjudication": adj}


CROSS_GROUPS = {
    "xc-matrix": "Scenario matrices (network/auth/server/media/visibility/behavioral/lifecycle/concurrency)",
    "xc-randomized-fuzz": "Randomized state machines + fuzzing",
    "xc-mutation": "Mutation testing / test-quality",
    "xc-journeys": "End-to-end user journeys",
    "xc-ux-a11y-i18n": "Per-screen UX, accessibility, internationalization",
    "xc-security": "Security: auth attacks, isolation, injection, secrets, dependencies, storage, rate limits",
    "xc-performance": "Performance & determinism",
    "xc-cv": "CV/AI evaluation (Linux proxy + Apple artifacts)",
    "xc-mac": "macOS/native division",
    "xc-ci-release-static": "CI/CD, release readiness, copy policy, static health, failure injection, data integrity, architecture map",
}


def group_of(cid: str) -> str:
    if cid.startswith("matrix-"):
        return "xc-matrix"
    if cid.startswith(("randomized-", "fuzz-")):
        return "xc-randomized-fuzz"
    if cid.startswith("mutation-"):
        return "xc-mutation"
    if cid.startswith("journey-"):
        return "xc-journeys"
    if cid.startswith(("screen-", "i18n-")):
        return "xc-ux-a11y-i18n"
    if cid.startswith("security-"):
        return "xc-security"
    if cid.startswith("perf-"):
        return "xc-performance"
    if cid.startswith("cv-"):
        return "xc-cv"
    if cid.startswith("mac-"):
        return "xc-mac"
    return "xc-ci-release-static"


async def run_cross_group(gid: str, members: list) -> dict:
    results = await asyncio.gather(*[cross_cutting(cc) for cc in members])
    reports = [slim(r, cc[0]) for r, cc in zip(results, members)]
    save(f"audit-{gid}.json", reports)
    log(f"{gid}: {len(members)} specialists done — {sum(len(r['findings']) for r in reports)} raw findings")
    adj = await adjudicate(gid, CROSS_GROUPS[gid], reports, [cc[0] for cc in members])
    save(f"adjudicate-{gid}.json", adj or {"status": "UNVERIFIED", "status_reason": "adjudicator failed", "confirmed": []})
    log(f"{gid}: status={adj['status'] if adj else 'UNVERIFIED'} confirmed={len(adj['confirmed']) if adj else 0}")
    return {"id": gid, "title": CROSS_GROUPS[gid], "reports": reports, "adjudication": adj}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


async def main():
    subs = sorted(SUBSYSTEMS, key=lambda s: s[0])
    ccs = sorted(CROSS_CUTTING, key=lambda c: c[0])
    groups: dict[str, list] = {}
    for cc in ccs:
        groups.setdefault(group_of(cc[0]), []).append(cc)
    n_sub = len(subs)
    await register_workflow(
        {
            "name": "pickle-sensei-production-readiness-audit",
            "description": f"Three-pass (structural/execution/adversarial) audit of every subsystem + cross-cutting matrices, randomized/fuzz/mutation, journeys, security, perf, CV, macOS, CI/release → per-area adjudication → clustered fixes with competing implementers, independent review and adversarial retest → evidence archive. Base {BASE_SHA[:8]} on {BASE_BRANCH}.",
            "product": "Pickle Sensei (RaunakGengiti2725/Pickle-Sensei)",
            "soft_time_limit_minutes": 50,
            "phases": [
                {"title": "map", "detail": "architecture map + baseline execution per subsystem", "labels": [f"map-{s[0]}" for s in subs]},
                {"title": "audit-structural", "detail": "two independent structural auditors per subsystem", "count": 2 * n_sub},
                {"title": "audit-execution", "detail": "execution tester per subsystem", "count": n_sub},
                {"title": "audit-adversarial", "detail": "adversarial testers per subsystem (scenario chunks)", "count": 3 * n_sub},
                {"title": "audit-crosscutting", "detail": "matrices, randomized, fuzz, mutation, journeys, screens, security, perf, CV, macOS, CI, release, static, failure injection", "labels": [c[0] for c in ccs]},
                {"title": "adjudicate", "detail": "dedupe + independent reproduction + area status", "labels": [f"adjudicate-{s[0]}" for s in subs] + [f"adjudicate-{g}" for g in sorted(groups)]},
                {"title": "fix-implement", "detail": "competing implementers per confirmed cluster (failing test first)"},
                {"title": "fix-review", "detail": "independent reviewer re-verifies + revert check"},
                {"title": "fix-adversary", "detail": "adversarial retest of each candidate"},
                {"title": "fix-implement-r2", "detail": "one follow-up implementer per rejected cluster, fed the reviewer blockers + proven adversary breaks; re-gated by a fresh reviewer ∥ adversary"},
            ],
        }
    )
    log(f"base {BASE_SHA} on {BASE_BRANCH}; {n_sub} subsystems, {len(ccs)} cross-cutting specialists in {len(groups)} groups; out={OUT_DIR}")

    sub_results, group_results = await asyncio.gather(
        asyncio.gather(*[run_subsystem(s) for s in subs]),
        asyncio.gather(*[run_cross_group(g, groups[g]) for g in sorted(groups)]),
    )

    scoreboard = {}
    confirmed: list[dict] = []
    blocked: list[str] = []
    for r in list(sub_results) + list(group_results):
        adj = r["adjudication"]
        scoreboard[r["id"]] = {
            "status": adj["status"] if adj else "UNVERIFIED",
            "reason": adj["status_reason"] if adj else "adjudicator produced no output",
            "confirmed": len(adj["confirmed"]) if adj else 0,
        }
        if adj:
            for c in adj["confirmed"]:
                c = dict(c)
                c["id"] = f"{r['id']}::{c.get('id') or c.get('title', 'x')}"
                c["area"] = r["id"]
                c.setdefault("severity", "P2")
                confirmed.append(c)
            blocked.extend(f"{r['id']}: {b}" for b in adj.get("blocked_external", []))
    save("scoreboard-pre-fix.json", scoreboard)
    save("confirmed-findings.json", confirmed)
    save("blocked-external.json", sorted(set(blocked)))
    log(f"adjudication complete: {len(confirmed)} confirmed findings; statuses={dump({k: v['status'] for k, v in scoreboard.items()})}")

    fixable = [c for c in confirmed if c.get("severity") in ("P0", "P1", "P2") and c.get("files")]
    clusters = build_clusters(fixable)
    save("fix-clusters.json", clusters)
    log(f"{len(fixable)} fixable findings → {len(clusters)} disjoint fix clusters ({sum(c['competing'] for c in clusters)} implementers)")

    fix_results = await asyncio.gather(*[fix_cluster(cl) for cl in clusters])
    save("fix-results.json", list(fix_results))
    winners = [f["winner"] for f in fix_results if f["winner"]]
    unfixed = [f["cluster"]["cluster_id"] for f in fix_results if not f["winner"]]
    save("winners.json", winners)
    log(f"fix loop complete: {len(winners)} proven fix branches; {len(unfixed)} clusters without a proven fix: {dump(unfixed)}")
    log("INTEGRATION is performed by the coordinator: merge winners.json branches onto the base, run verify-cloud full + bench:compare + mac-full-verify --remote, then run the final-review workflow.")


asyncio.run(main())
