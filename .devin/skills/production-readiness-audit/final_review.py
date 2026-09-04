"""Pickle Sensei — Waves 11–12: independent final review + adversarial challenge
of the INTEGRATED tree (run via `run_workflow` after integration is frozen).

    per subsystem: final reviewer ∥ adversarial challenger      ─┐
    cross-cutting gate auditors (clean-clone verify, bench,       ├─► final-review.json
    security, RLS, e2e, release, Mac evidence, mutation, random)  ─┘   + health-scoreboard.json

Inputs (env): PS_FINAL_SHA (integration head to review), PS_FINAL_BRANCH,
PS_MAC_RUN (GitHub Actions run id whose artifacts are the Apple evidence for
PS_FINAL_SHA), PS_AUDIT_OUT (artifact dir). Nothing here trusts prose: a gate is
PASS only when the reviewer ran it and attached the artifact; challengers may
only claim a break with an exact repro on a pushed attack branch.

The runtime shim provides register_workflow/agent/pipeline/parallel/log and
WorkflowAgentError; do not import or define them.
"""

import asyncio
import json
import os
import re

REPO = "RaunakGengiti2725/Pickle-Sensei"
REPO_TOKEN = f"@{REPO}"
BRANCH = os.environ.get("PS_FINAL_BRANCH", "devin/1788500670-production-readiness")
SHA = os.environ["PS_FINAL_SHA"]
MAC_RUN = os.environ["PS_MAC_RUN"]
OUT_DIR = os.environ.get(
    "PS_AUDIT_OUT",
    os.path.expanduser("~/repos/Pickle-Sensei/artifacts/production-readiness/run-1788500670/final"),
)
MAX_CONCURRENT = int(os.environ.get("PS_AUDIT_CONCURRENCY", "40"))
THROTTLE_MAX_ATTEMPTS = int(os.environ.get("PS_AUDIT_THROTTLE_ATTEMPTS", "240"))
AUDIT_DIR = os.environ.get("PS_AUDIT_IN", os.path.expanduser("~/repos/Pickle-Sensei/artifacts/production-readiness/run-1788500670"))
LEDGER_CHUNK = int(os.environ.get("PS_LEDGER_CHUNK", "5"))


def _load_json(name: str, default):
    path = os.path.join(AUDIT_DIR, name)
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf8") as fh:
        return json.load(fh)


def _p01(findings: list) -> list:
    return [f for f in findings if (f.get("severity") or "").upper().strip()[:2] in ("P0", "P1")]


# Confirmed P0/P1 findings from the audit + stress campaigns (the artifact dir is NOT in git,
# so every agent gets its findings inline).
CONFIRMED_P01 = _p01(_load_json("confirmed-findings.json", []))
STRESS_P01 = _p01(_load_json("stress/confirmed-findings.json", []))
ALL_P01 = CONFIRMED_P01 + [f for f in STRESS_P01 if f.get("id") not in {g.get("id") for g in CONFIRMED_P01}]


def _finding_brief(f: dict) -> dict:
    return {k: f.get(k) for k in ("id", "severity", "title", "files", "repro", "expected", "acceptance") if f.get(k) is not None}

# (area id, scoreboard category, title, paths, execution hint)
AREAS = [
    ("mobile-auth-session", "AUTH", "authStore/sessionVault/sessionKeeper, bearer resolution, sign-out, tombstone fence", ["apps/mobile/src/auth", "apps/mobile/src/account"], "cd apps/mobile && npx jest --ci --silent; .agents/skills/test-authentication"),
    ("mobile-launch-onboarding", "RELIABILITY", "launch gate, Welcome/Onboarding/SignIn, pre-auth profile stash", ["apps/mobile/App.tsx", "apps/mobile/src/flow/launchGate.ts", "apps/mobile/src/navigation", "apps/mobile/src/screens/WelcomeScreen.tsx", "apps/mobile/src/screens/OnboardingScreen.tsx", "apps/mobile/src/screens/SignInScreen.tsx", "apps/mobile/src/state"], "cd apps/mobile && npx jest --ci --silent"),
    ("mobile-analyze-capture", "VIDEO", "Analyze screen, capture envelope, runCaptureAnalysis, pose-quality gate, permits", ["apps/mobile/src/screens/AnalyzeScreen.tsx", "apps/mobile/src/camera", "apps/mobile/src/analysis", "apps/mobile/src/vision", "apps/mobile/src/flow"], "cd apps/mobile && npx jest --ci --silent"),
    ("mobile-results-review", "RELIABILITY", "Result/ResultDetails/FormReview, review module, coaching copy", ["apps/mobile/src/screens/ResultScreen.tsx", "apps/mobile/src/screens/ResultDetailsScreen.tsx", "apps/mobile/src/screens/FormReviewScreen.tsx", "apps/mobile/src/review"], "cd apps/mobile && npx jest --ci --silent"),
    ("mobile-home-progress-library", "RELIABILITY", "Home/Progress/Library/Streak, progress + library modules", ["apps/mobile/src/screens/HomeScreen.tsx", "apps/mobile/src/screens/ProgressScreen.tsx", "apps/mobile/src/screens/LibraryScreen.tsx", "apps/mobile/src/progress", "apps/mobile/src/library"], "cd apps/mobile && npx jest --ci --silent"),
    ("mobile-settings-account", "RELIABILITY", "Settings/ManageAccount/Consent/Notifications, account deletion", ["apps/mobile/src/screens/SettingsScreen.tsx", "apps/mobile/src/screens/ManageAccountScreen.tsx", "apps/mobile/src/state/consentStore.ts", "apps/mobile/src/notifications"], "cd apps/mobile && npx jest --ci --silent"),
    ("mobile-billing-paywall", "RELIABILITY", "RevenueCat billing store, Paywall, entitlement gating", ["apps/mobile/src/billing", "apps/mobile/src/screens/PaywallScreen.tsx"], "cd apps/mobile && npx jest --ci --silent"),
    ("mobile-data-sync", "DATABASE", "SQLite db/repository, sync outbox/transport, offline, api client", ["apps/mobile/src/data"], "cd apps/mobile && npx jest --ci --silent"),
    ("mobile-live-court-voice", "LIVE COURT", "Live Court flow, cue engine, TTS — ordering, dedupe, interruptions, permission denial", ["apps/mobile/src/flow/liveCourt.ts", "apps/mobile/src/flow/liveSessionCoach.ts", "apps/mobile/src/audio", "packages/audio-coach-core"], "cd apps/mobile && npx jest --ci --silent; pnpm --filter @pickle/audio-coach-core test"),
    ("mobile-design-a11y", "ACCESSIBILITY", "components/design/walkthrough — a11y labels/roles, dynamic type, touch targets, reduced motion", ["apps/mobile/src/components", "apps/mobile/src/design", "apps/mobile/src/walkthrough"], "cd apps/mobile && npx jest --ci --silent"),
    ("mobile-ios-config", "RELEASE", "Info.plist privacy strings, entitlements, pbxproj versions, runtimeConfig, ATS, debug exclusion", ["apps/mobile/ios", "apps/mobile/src/config"], "read-only + Linux checks; Apple truth from the Mac run artifacts only"),
    ("edge-auth-cache-ratelimit", "AUTH", "Edge authenticate(), bootstrap/refresh/logout, revocation fence, session cache, rate limits", ["supabase/functions/api/cache.ts", "supabase/functions/api/rateLimit.ts", "supabase/functions/api/http.ts", "supabase/functions/api/index.ts"], "cd supabase/functions/api/__wf__ && deno task test"),
    ("edge-domain-routes", "DATABASE", "Edge domain routes: /v1/me/*, shots sync, permits, rank/progress, onboarding, drills, deletion, legal", ["supabase/functions/api"], "cd supabase/functions/api/__wf__ && deno task test"),
    ("edge-billing-webhook", "SECURITY", "RevenueCat webhook, entitlement re-verification, webhook_events audit, idempotency", ["supabase/functions/api/index.ts", "supabase/functions/api/__wf__/webhook.test.ts"], "cd supabase/functions/api/__wf__ && deno task test"),
    ("db-schema-migrations", "DATABASE", "migrations, FKs, constraints, triggers, RPCs, DB-01/DB-02 ledger + permit gate", ["supabase/migrations"], "./supabase/tests/run_rls_tests.sh; throwaway postgres:16"),
    ("db-rls-grants-isolation", "SECURITY", "RLS policies, grants, anon revokes, append-only ledgers, cross-user isolation matrix", ["supabase/tests"], "./supabase/tests/run_rls_tests.sh"),
    ("storage-media-worker", "STORAGE", "storage policies, drill media signing, media-worker lifecycle, SMW-01 requeue starvation", ["services/media-worker", "packages/queue", "packages/capture-envelope"], "scripts/verify-cloud.sh --only test --start-services"),
    ("pkg-vision-geometry", "CV", "vision-geometry: capture quality, offline stroke, numeric stability", ["packages/vision-geometry", "packages/vision-contracts"], "pnpm --filter @pickle/vision-geometry test"),
    ("pkg-analysis-pipeline", "CV", "analysis-pipeline: preAnalysisGate, segmentation, scoring, visibility matrix", ["packages/analysis-pipeline", "packages/scoring", "packages/swing-domain"], "pnpm --filter @pickle/analysis-pipeline test; pnpm --filter @pickle/scoring test"),
    ("pkg-swing-lab", "CV", "swing-lab: splits (SL-04), rights (SL-01), scratch isolation (SL-06), red-team cases", ["packages/swing-lab", "packages/model-registry"], "pnpm --filter @pickle/swing-lab test"),
    ("pkg-evaluation-bench", "CV", "evaluation runner: EVAL-BENCH-01/02 isolation, O_EXCL reservation, compare vs baseline", ["packages/evaluation", "datasets/reports", "regression.tolerances.json"], "pnpm --filter @pickle/evaluation test; bench:regression + bench:compare"),
    ("native-vision-core", "MACOS", "native/vision-core Swift: Vision pose extraction, frame lifecycle, memory", ["native/vision-core"], "Apple truth ONLY from the Mac run artifacts"),
    ("native-swing-lab-camera-engine", "MACOS", "native/swing-lab + camera-engine: AVFoundation, extraction CLI, Release build", ["native/swing-lab", "native/camera-engine"], "Apple truth ONLY from the Mac run artifacts"),
    ("ml-tooling-datasets", "CV", "ml/ scripts + datasets tooling: labels, splits, leakage, seeds", ["ml", "datasets/pickleball"], "python3 -m unittest discover -s ml/scripts -p 'test_*.py'"),
    ("services-api-admin-web", "CI", "legacy Fastify + admin-web + Playwright smoke", ["services/api", "apps/admin-web", "packages/database"], "scripts/verify-cloud.sh --only db,admin,e2e --start-services"),
    ("shared-packages-ops", "RELIABILITY", "shared-types, analytics, intake, hard-case-queue, incident-response, release-ops, rollout, slo", ["packages"], "pnpm -r typecheck; pnpm test"),
    ("ci-workflows-scripts", "CI", "workflows, verify-*.sh, security-scan.sh scope — determinism, no error hiding, artifact retention", [".github/workflows", "scripts", "tools/macos-ci"], "shellcheck; scripts/verify-cloud.sh --tier pr --start-services"),
    ("release-config-docs", "RELEASE", "release manifest, version triple, store-copy rules, privacy docs", ["infra/release", "tools/release", "APP_STORE_SUBMISSION.md", "docs"], "pnpm release:check; .agents/skills/release-verification"),
    ("security-secrets-deps", "SECURITY", "secret scan, dependency audit, lockfiles, insecure defaults, debug endpoints", [".gitleaks.toml", "package.json", "pnpm-lock.yaml", "apps/mobile/package-lock.json"], "scripts/security-scan.sh; pnpm audit --prod; cd apps/mobile && npm audit"),
]

# Finding areas whose id differs from the review area that owns the same paths.
AREA_ALIASES = {"services-api-legacy-admin-web": "services-api-admin-web"}


def _finding_area(f: dict) -> str:
    return str(f.get("area") or str(f.get("id", "")).split("::")[0])


def _owned_by(area_id: str, area_paths: list, f: dict) -> bool:
    """A finding belongs to a review area by explicit area id, alias, or when one of its
    files lives under a path the area owns (cross-cutting `xc-*` findings have no area of
    their own and must still reach the reviewer of the code they touch)."""
    fa = _finding_area(f)
    if fa == area_id or AREA_ALIASES.get(fa) == area_id:
        return True
    files = [str(x).split(":")[0] for x in (f.get("files") or [])]
    return any(fp == p or fp.startswith(p.rstrip("/") + "/") for fp in files for p in area_paths)


def findings_for_area(area_id: str, area_paths: list) -> list:
    return [f for f in ALL_P01 if _owned_by(area_id, area_paths, f)]


def unrouted_p01() -> list:
    """P0/P1 findings that no reviewer would see — the run must not start with any."""
    return [f.get("id") for f in ALL_P01 if not any(_owned_by(a[0], a[3], f) for a in AREAS)]


# Cross-cutting gate auditors: (id, category, role text)
GATES = [
    ("gate-clean-clone-cloud-full", "BUILD", "From a FRESH clone (new directory, not a reused checkout) at the SHA, run `scripts/verify-cloud.sh --tier full --start-services`. Every stage must be passed (no skips). Attach summary.json and every stage log that is not passed. Also run `pnpm format:check && pnpm lint && pnpm typecheck` separately and record exit codes."),
    ("gate-mobile-clean", "TEST", "Fresh clone at the SHA: `cd apps/mobile && npm ci && npx tsc --noEmit && npx jest --ci --silent` (record counts: suites/tests passed, failed, skipped, todo). Then run jest a SECOND time with `--randomize` (or a shuffled seed if unsupported) and report any order-dependent failure with its seed."),
    ("gate-bench-compare", "CV", "At the SHA on a CLEAN checkout: `pnpm --filter @pickle/evaluation bench:regression --out-dir /tmp/final --run-id final` then `pnpm -s --filter @pickle/evaluation bench:compare datasets/reports/regression/baseline.json /tmp/final/final.json --json > /tmp/final/compare.json`. Report regressions/improvements/unchanged per metric, and every abstention. Run the regression twice and confirm the two summaries are metric-identical (determinism). Attach both summaries and compare.json."),
    ("gate-security", "SECURITY", "At the SHA: `scripts/security-scan.sh` (exit code, findings count, scope test `scripts/tests/security-scan-scope.sh`), `pnpm audit --prod --json`, `cd apps/mobile && npm audit --json`, `pip-audit` or `pip list --outdated` for ml/ if a requirements file exists. Classify every critical/high with whether it is reachable in production code paths. Never print secrets."),
    ("gate-rls-isolation", "SECURITY", "At the SHA: `./supabase/tests/run_rls_tests.sh` (attach output). Then on a throwaway postgres:16 with all migrations applied, write and run 10 NEW cross-user attempts not already in security_regression.sql (reads, writes, RPC calls with another user's ids, ledger tampering, direct scored INSERT without a permit, permit over-issuance under concurrency with two sessions) and report each as DENIED/ALLOWED with the SQLSTATE."),
    ("gate-edge-auth-outage", "AUTH", "At the SHA: `cd supabase/functions/api/__wf__ && deno task test` (counts). Then exercise the auth matrix with the harness: valid/expired/revoked/malformed bearer, refresh rotation, logout fence, GoTrue 5xx/timeout/malformed upstream (must NOT sign out or 500 with detail), rate limiting 429 + Retry-After. Report each cell VERIFIED/FAILED with the assertion."),
    ("gate-e2e-admin", "CI", "At the SHA: `scripts/verify-cloud.sh --only db,admin,e2e --start-services`; attach Playwright report. Then follow `.agents/skills/admin-web-manual-smoke` for the recorded golden path."),
    ("gate-release-config", "RELEASE", "At the SHA: `pnpm release:check`; verify the version triple (pbxproj MARKETING_VERSION/CURRENT_PROJECT_VERSION, apps/mobile/package.json, infra/release manifest, runtimeConfig APP_STORE_ID=6806918402 / bundle com.picklesensei) agree; scan ALL user-visible strings for forbidden terms (Android, Google Play, guest mode, Live Court, DUPR, competitors, accuracy %, superlatives, AI-coach-equivalence). Walk docs/PRELAUNCH_CHECKLIST.md: each item verified / human-only (EXTERNAL) / FAILED. Perform NO release action."),
    ("gate-mac-evidence", "MACOS", f"Apple evidence auditor. Do NOT trigger any Mac run. `gh run view {MAC_RUN}` and `gh run download {MAC_RUN}`: confirm the run's head SHA equals `{SHA}` (or state the exact SHA it ran and whether any commit between it and {SHA[:8]} touches native/, apps/mobile/ios/, Podfile*, *.swift, *.m, *.mm, *.pbxproj, *.plist, *.xcconfig, *.entitlements, .github/workflows/mac-*). Enumerate every job/step result, xcresult summaries (test counts, failures), simulator launch/screenshots, Release build/archive result, signing/entitlement checks, crash logs. Each Apple gate is PASS only if the artifact shows it; otherwise FAIL/UNVERIFIED with the reason."),
    ("gate-mutation-spotcheck", "TEST", f"Test-quality mutation spot-check. `git log 4d812e1a..{SHA[:8]} --oneline` lists the integrated fixes. Pick at least 12 production (non-test) changes across auth, edge, db migrations/RPC, mobile stores, swing-lab, evaluation. For each: revert ONLY the production hunk locally (keep tests), run the suite that owns it, and record whether a test FAILS (killed) or nothing fails (survived). Restore after each. Every survivor is a finding with the exact hunk."),
    ("gate-randomized-fresh-seeds", "RELIABILITY", "Randomized/property/stress with FRESH seeds at the SHA: locate every seeded/randomized suite (apps/mobile/__tests__/matrix, __tests__/xc, packages/*/test/*fuzz*|*property*|*random*|*matrix*, ml seeds) and run each with at least 3 new seeds (env/CLI as the suite documents; if a suite has no seed knob say so). Report total executed combinations and every failure with its seed + minimal repro. Run the concurrency-sensitive suites (EVAL-BENCH-02, sync outbox, sessionKeeper, permit reservation) 10× each and report flake counts."),
    ("gate-perf-budgets", "PERFORMANCE", "Measure at the SHA: bench:regression wall-clock per bench (3 runs, min/median), edge auth hot-path with the deno harness (p50/p95 per route class, cache hit vs miss), mobile jest total time, `tools/loadtest` k6 script dry-run against the local legacy api if runnable. Compare with the baseline artifacts under artifacts/production-readiness/run-1788500670/ and artifacts/verify-cloud/ (earliest run) and flag any >25% regression with evidence."),
]

COMMON = f"""Repository: {REPO_TOKEN} (public GitHub monorepo; shipping product = iOS app `apps/mobile`, backend = Supabase Edge Function `supabase/functions/api`).
START STATE: `git fetch origin && git checkout {SHA}` (branch `{BRANCH}`). This is the FINAL integrated tree under review; never push to `main`; never open a pull request; never modify the branch under review.
Read `AGENTS.md`, `REVIEW.md`, `docs/devin/OPERATING_SYSTEM.md`, `APP_STORE_SUBMISSION.md` and `.agents/skills/` first. `git log 4d812e1a..{SHA[:8]}` is the full list of changes made by the audit; `artifacts/production-readiness/run-1788500670/` holds the audit's confirmed findings, fix results and baseline scoreboard.
Environment: Node 20/22 + pnpm 10. If `deno` is missing: `curl -fsSL https://deno.land/install.sh | sh`. Docker: `docker compose up -d postgres postgres_test redis elasticmq` or `--start-services`. apps/mobile uses npm (never pnpm inside it): `cd apps/mobile && npm ci`.
Planes: cloud (Linux) — verify-cloud, jest, deno, RLS, ML; bench — evaluation regression/compare on a clean commit (Linux CV numbers are a replay proxy, not Apple truth); mac — the M4 runner is ONE machine: NEVER run `scripts/mac-full-verify.sh --remote`, push `ci/mac-*` branches, or edit `.github/workflows/mac-*.yml`. Apple evidence = artifacts of GitHub Actions run {MAC_RUN} (`gh run download {MAC_RUN}`). Never claim Swift/Vision/iOS runtime behaviour from Linux.
Hard rules: never weaken/skip/delete tests, never add `|| true`, never fabricate evidence, never touch production Supabase (project ucqnaiwqwjtgvlduiuib) or App Store Connect, never store/print secrets, never modify applied migrations, never use destructive git commands.
Evidence standard: every claim carries the exact command, exit code and artifact path; label VERIFIED (you ran it) / INFERRED / UNKNOWN. Upload key artifacts with upload_attachment and return URLs in `attachment_urls`. A skipped/unavailable stage is NOT a pass; UNVERIFIED is never PASS.
Findings format: {{"severity":"P0|P1|P2|P3","title":"<short>","files":["path:line"],"repro":"<exact>","observed":"","expected":"","evidence":"<url or path>","regression":"yes|no|unknown (vs 4d812e1a)"}}. P0 = data loss, security breach, auth bypass, crash on a core flow, fundamentally incorrect analysis, release blocker; P1 = major broken feature / serious reliability, performance or CV failure; P2 = important edge case / degraded UX / recoverability; P3 = polish."""

FINDING_ITEM = {
    "type": "object",
    "properties": {k: ({"type": "array", "items": {"type": "string"}} if k == "files" else {"type": "string"}) for k in ["severity", "title", "files", "repro", "observed", "expected", "evidence", "regression"]},
}
EVIDENCE_ITEM = {"type": "object", "properties": {"command": {"type": "string"}, "exit_code": {"type": "integer"}, "artifact": {"type": "string"}, "note": {"type": "string"}}, "required": ["command", "exit_code"]}

REVIEW_SCHEMA = {
    "type": "object",
    "properties": {
        "area": {"type": "string"},
        "gate_status": {"type": "string", "description": "PASS|FAIL|DEGRADED|UNVERIFIED|BLOCKED"},
        "agrees_production_ready": {"type": "boolean", "description": "true only if this area has no unresolved P0/P1 and every claimed gate was re-run by you"},
        "evidence": {"type": "array", "items": EVIDENCE_ITEM},
        "integrated_fixes_verified": {"type": "array", "items": {"type": "string"}, "description": "'<sha> <title> — VERIFIED|NOT VERIFIED — <how>' for each audit commit touching this area"},
        "unresolved_findings": {"type": "array", "items": FINDING_ITEM},
        "external_blockers": {"type": "array", "items": {"type": "string"}},
        "attachment_urls": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
    },
    "required": ["area", "gate_status", "agrees_production_ready", "evidence", "integrated_fixes_verified", "unresolved_findings", "summary"],
}

CHALLENGE_SCHEMA = {
    "type": "object",
    "properties": {
        "area": {"type": "string"},
        "break_found": {"type": "boolean"},
        "breaks": {"type": "array", "items": FINDING_ITEM},
        "attack_branch": {"type": "string"},
        "attacks_tried": {"type": "integer"},
        "seeds_used": {"type": "array", "items": {"type": "string"}},
        "attachment_urls": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
    },
    "required": ["area", "break_found", "breaks", "attacks_tried", "summary"],
}

GATE_SCHEMA = {
    "type": "object",
    "properties": {
        "gate": {"type": "string"},
        "gate_status": {"type": "string", "description": "PASS|FAIL|DEGRADED|UNVERIFIED|BLOCKED"},
        "evidence": {"type": "array", "items": EVIDENCE_ITEM},
        "metrics": {"type": "object", "additionalProperties": True},
        "findings": {"type": "array", "items": FINDING_ITEM},
        "external_blockers": {"type": "array", "items": {"type": "string"}},
        "attachment_urls": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
    },
    "required": ["gate", "gate_status", "evidence", "findings", "summary"],
}


def dump(obj) -> str:
    return json.dumps(obj, sort_keys=True, ensure_ascii=False)


def save(name: str, obj) -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, name), "w", encoding="utf8") as fh:
        json.dump(obj, fh, indent=2, sort_keys=True, ensure_ascii=False)


_SEM: asyncio.Semaphore | None = None


def sem() -> asyncio.Semaphore:
    global _SEM
    if _SEM is None:
        _SEM = asyncio.Semaphore(MAX_CONCURRENT)
    return _SEM


def _is_throttle(msg: str) -> bool:
    return "429" in msg or "concurrent session limit" in msg or "could not create session" in msg or "Too Many Requests" in msg


async def safe_agent(prompt, **kwargs):
    for attempt in range(THROTTLE_MAX_ATTEMPTS):
        throttled = False
        async with sem():
            try:
                return await agent(prompt, **kwargs)
            except WorkflowAgentError as err:
                msg = str(err)
                if _is_throttle(msg):
                    throttled = True
                else:
                    log(f"agent {kwargs.get('label')} FAILED: {err}")
                    return None
        if throttled:
            # semaphore released before sleeping so a throttled slot does not block others
            log(f"agent {kwargs.get('label')}: throttled (attempt {attempt + 1}/{THROTTLE_MAX_ATTEMPTS}); backing off")
            await asyncio.sleep(min(600, 120 + 30 * attempt))
    log(f"agent {kwargs.get('label')} FAILED: gave up after repeated throttling")
    return None


async def final_review(area) -> dict | None:
    aid, cat, title, paths, howto = area
    prompt = f"""{COMMON}

ROLE: INDEPENDENT FINAL REVIEWER for area `{aid}` ({cat}) — {title}. Paths: {dump(paths)}. Execution: {howto}.
You did not write any of this code. Assume the audit's fixes are wrong until you have re-run the evidence yourself.
1. `git log --oneline 4d812e1a..{SHA[:8]} -- {' '.join(paths)}` → for EVERY commit: read the diff, find its regression test, run it, then locally revert ONLY the production hunk and confirm the test FAILS (restore afterwards). Record one `integrated_fixes_verified` line per commit.
2. Run the area's full suite(s) and every other suite that imports the changed files; record exact commands/exit codes/counts in `evidence`.
3. Apply `REVIEW.md` + `AGENTS.md` invariants (auth durability, RLS/grants, append-only ledgers, permit gating, model versioning, Apple lifecycle, copy rules) to the final code, not just the diffs.
4. The audit's confirmed P0/P1 findings for this area are listed below (the artifact dir is not in git). Every one must be either fixed on this tree (prove it: run its acceptance criteria / repro, record the command + exit code in `evidence`) or listed in `unresolved_findings`.
CONFIRMED P0/P1 FOR THIS AREA (by area id or because a finding's files live under this area's paths): {dump([_finding_brief(f) for f in findings_for_area(aid, paths)])}
`gate_status` = PASS only if all suites pass, every audit fix is VERIFIED, and no P0/P1 remains; DEGRADED if only P2/P3 remain; FAIL if any P0/P1 remains or a suite fails; UNVERIFIED if you could not execute the plane (say why); BLOCKED for external-only blockers. `agrees_production_ready` must be consistent with that."""
    return await safe_agent(prompt, phase="final-review", schema=REVIEW_SCHEMA, label=f"final-review-{aid}", soft_time_limit_minutes=60)


async def challenge(area) -> dict | None:
    aid, cat, title, paths, howto = area
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", aid)[:50].strip("-")
    prompt = f"""{COMMON}

ROLE: ADVERSARIAL CHALLENGER for area `{aid}` ({cat}) — {title}. Paths: {dump(paths)}. Execution: {howto}.
Your job is to INVALIDATE the production-readiness conclusion for this area. Do not repeat the audit's existing tests; hunt for what they missed.
Attack the integrated fixes (`git log 4d812e1a..{SHA[:8]} -- {' '.join(paths)}`) and their neighbourhood with: malformed input, unicode/boundary sizes, concurrency and ordering (run the flaky-prone suites 10×), cancellation mid-flight, stale/expired/revoked sessions, duplicate and rapid actions, background/foreground and lifecycle transitions, network interruption/5xx/timeout/malformed upstream, permission denial, corrupted media/metadata, clock skew, RLS/grant boundaries, state restoration from malformed persisted data, resource leaks over repetition, fresh random seeds (record every seed in `seeds_used`).
Write NEW failing tests only for REAL bugs, commit them on branch `devin/final-attack-{slug}` from {SHA[:8]} and push it (`attack_branch`); never modify `{BRANCH}`. Report `break_found` only with an exact repro and observed-vs-expected; grade each break P0–P3 honestly (P3 polish is not a break of readiness). Aim for ≥40 distinct attacks; report the count in `attacks_tried`."""
    return await safe_agent(prompt, phase="final-challenge", schema=CHALLENGE_SCHEMA, label=f"final-attack-{aid}", soft_time_limit_minutes=60)


LEDGER_SCHEMA = {
    "type": "object",
    "properties": {
        "gate": {"type": "string"},
        "gate_status": {"type": "string", "description": "PASS if every finding is RESOLVED; FAIL otherwise"},
        "ledger": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "status": {"type": "string", "description": "RESOLVED|OPEN|UNVERIFIED|EXTERNAL"},
                    "fix_commits": {"type": "array", "items": {"type": "string"}},
                    "acceptance_results": {"type": "array", "items": {"type": "string"}, "description": "one 'PASS|FAIL — <criterion> — <command> exit <code>' per acceptance criterion"},
                    "repro_on_final": {"type": "string", "description": "what the original repro does on the final SHA"},
                    "revert_check": {"type": "string", "description": "which test fails when the production fix is reverted locally (or 'no fix found')"},
                    "note": {"type": "string"},
                },
                "required": ["id", "status", "acceptance_results", "repro_on_final"],
            },
        },
        "evidence": {"type": "array", "items": EVIDENCE_ITEM},
        "findings": {"type": "array", "items": FINDING_ITEM},
        "external_blockers": {"type": "array", "items": {"type": "string"}},
        "attachment_urls": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
    },
    "required": ["gate", "gate_status", "ledger", "evidence", "findings", "summary"],
}

LEDGER_CHUNKS = [ALL_P01[i : i + LEDGER_CHUNK] for i in range(0, len(ALL_P01), LEDGER_CHUNK)]


async def ledger(idx: int, chunk: list) -> dict | None:
    gid = f"gate-p1-ledger-{idx + 1}"
    prompt = f"""{COMMON}

ROLE: P0/P1 LEDGER AUDITOR `{gid}`. The audit confirmed the P0/P1 findings below (each with its original repro and acceptance criteria). For EACH finding, on the final SHA {SHA[:8]}:
1. Run the original `repro` exactly (adapt only paths/branch names that no longer exist and say so). It must no longer reproduce.
2. Run EVERY `acceptance` criterion as an executable check (the listed commands/assertions; if a criterion is prose, translate it into a concrete command or SQL/jest/deno assertion and run it). Record 'PASS|FAIL — <criterion> — <command> exit <code>' per criterion.
3. Identify the fix commit(s) in `git log 4d812e1a..{SHA[:8]}` for the finding's files; locally revert ONLY the production hunk (keep tests), run the owning suite, record which test fails (`revert_check`), then restore.
4. status = RESOLVED only if the repro no longer reproduces AND every acceptance criterion passes AND a revert check fails a test; OPEN if the defect still reproduces or any criterion fails; UNVERIFIED if you could not execute (say exactly why — an unavailable plane is not a pass); EXTERNAL only for criteria that genuinely require Apple/human action.
`gate_status` = PASS only if every finding is RESOLVED (EXTERNAL criteria allowed only when the executable criteria all pass). Put every OPEN finding also into `findings` with the observed vs expected.
FINDINGS: {dump([_finding_brief(f) for f in chunk])}"""
    return await safe_agent(prompt, phase="final-ledger", schema=LEDGER_SCHEMA, label=gid, soft_time_limit_minutes=60)


async def gate(g) -> dict | None:
    gid, cat, role = g
    prompt = f"""{COMMON}

ROLE: RELEASE GATE AUDITOR `{gid}` ({cat}). {role}
Report `gate_status` strictly from what you executed (PASS|FAIL|DEGRADED|UNVERIFIED|BLOCKED), every command with exit code in `evidence`, numeric results in `metrics`, and each defect in `findings`. Do not modify `{BRANCH}`; scratch work goes in /tmp or a `devin/final-gate-{gid}` branch if tests must be committed."""
    return await safe_agent(prompt, phase="final-gate", schema=GATE_SCHEMA, label=gid, soft_time_limit_minutes=60)


def sev_rank(s: str) -> int:
    return {"P0": 0, "P1": 1, "P2": 2, "P3": 3}.get((s or "").upper().strip()[:2], 9)


def scoreboard(reviews: list, challenges: list, gates: list) -> dict:
    cats: dict[str, dict] = {}

    def upd(cat: str, status: str, src: str) -> None:
        entry = cats.setdefault(cat, {"status": "PASS", "sources": []})
        entry["sources"].append(f"{src}={status}")
        order = ["PASS", "DEGRADED", "UNVERIFIED", "BLOCKED", "FAIL"]
        if order.index(status if status in order else "UNVERIFIED") > order.index(entry["status"]):
            entry["status"] = status if status in order else "UNVERIFIED"

    for area, rep in zip(AREAS, reviews):
        upd(area[1], (rep or {}).get("gate_status", "UNVERIFIED"), f"review:{area[0]}")
    for area, ch in zip(AREAS, challenges):
        if ch is None:
            upd(area[1], "UNVERIFIED", f"challenge:{area[0]}")
        elif any(sev_rank(b.get("severity", "")) <= 1 for b in ch.get("breaks", [])):
            upd(area[1], "FAIL", f"challenge:{area[0]}")
        else:
            upd(area[1], "PASS", f"challenge:{area[0]}")
    for g, res in zip(GATES, gates):
        upd(g[1], (res or {}).get("gate_status", "UNVERIFIED"), f"gate:{g[0]}")
    return cats


async def main():
    await register_workflow(
        {
            "name": "pickle-sensei-final-review",
            "description": f"Waves 11-12: independent final reviewer + adversarial challenger per area, plus clean-clone/bench/security/RLS/auth/e2e/release/Mac-evidence/mutation/randomized/perf gate auditors on integrated tree {SHA[:8]}; emits final-verdict.json + scoreboard.",
            "product": "Pickle Sensei (RaunakGengiti2725/Pickle-Sensei)",
            "soft_time_limit_minutes": 90,
            "phases": [
                {"title": "final-review", "detail": "independent reviewer per area (re-runs every fix's test + revert check)", "labels": [f"final-review-{a[0]}" for a in AREAS]},
                {"title": "final-challenge", "detail": "adversarial challenger per area (fresh seeds, new attacks)", "labels": [f"final-attack-{a[0]}" for a in AREAS]},
                {"title": "final-gate", "detail": "release gate auditors", "labels": [g[0] for g in GATES]},
                {"title": "final-ledger", "detail": f"P0/P1 ledger auditors: {len(ALL_P01)} confirmed findings re-executed on the final SHA", "labels": [f"gate-p1-ledger-{i + 1}" for i in range(len(LEDGER_CHUNKS))]},
            ],
        }
    )
    unrouted = unrouted_p01()
    if unrouted:
        raise RuntimeError(f"P0/P1 findings not routed to any review area: {unrouted}")
    routing = {a[0]: [f.get("id") for f in findings_for_area(a[0], a[3])] for a in AREAS}
    log(f"final review of {SHA} on {BRANCH}; mac run {MAC_RUN}; {len(AREAS)} areas x2 + {len(GATES)} gates + {len(LEDGER_CHUNKS)} ledger auditors over {len(ALL_P01)} P0/P1; out={OUT_DIR}")
    save("inputs.json", {"sha": SHA, "branch": BRANCH, "mac_run": MAC_RUN, "areas": [a[0] for a in AREAS], "gates": [g[0] for g in GATES], "p01_ids": [f.get("id") for f in ALL_P01], "p01_routing": routing})
    reviews, challenges, gates, ledgers = await asyncio.gather(
        asyncio.gather(*(final_review(a) for a in AREAS)),
        asyncio.gather(*(challenge(a) for a in AREAS)),
        asyncio.gather(*(gate(g) for g in GATES)),
        asyncio.gather(*(ledger(i, ch) for i, ch in enumerate(LEDGER_CHUNKS))),
    )
    save("final-reviews.json", [{"area": a[0], "report": r} for a, r in zip(AREAS, reviews)])
    save("final-challenges.json", [{"area": a[0], "report": c} for a, c in zip(AREAS, challenges)])
    save("final-gates.json", [{"gate": g[0], "report": r} for g, r in zip(GATES, gates)])
    save("final-ledger.json", [{"gate": f"gate-p1-ledger-{i + 1}", "ids": [f.get("id") for f in ch], "report": r} for i, (ch, r) in enumerate(zip(LEDGER_CHUNKS, ledgers))])

    p01 = []
    ledger_open = []
    for i, (ch, r) in enumerate(zip(LEDGER_CHUNKS, ledgers)):
        if r is None:
            ledger_open.extend({"id": f.get("id"), "status": "UNVERIFIED", "note": "ledger auditor produced no report"} for f in ch)
            continue
        for row in r.get("ledger", []):
            if (row.get("status") or "").upper() != "RESOLVED":
                ledger_open.append(row)
        for f in r.get("findings", []):
            if sev_rank(f.get("severity", "")) <= 1:
                p01.append({"source": f"gate-p1-ledger-{i + 1}", **f})
    for a, r in zip(AREAS, reviews):
        for f in (r or {}).get("unresolved_findings", []):
            if sev_rank(f.get("severity", "")) <= 1:
                p01.append({"source": f"review:{a[0]}", **f})
    for a, c in zip(AREAS, challenges):
        for f in (c or {}).get("breaks", []):
            if sev_rank(f.get("severity", "")) <= 1:
                p01.append({"source": f"challenge:{a[0]}", "attack_branch": c.get("attack_branch"), **f})
    for g, r in zip(GATES, gates):
        for f in (r or {}).get("findings", []):
            if sev_rank(f.get("severity", "")) <= 1:
                p01.append({"source": f"gate:{g[0]}", **f})
    board = scoreboard(reviews, challenges, gates)
    for i, r in enumerate(ledgers):
        upd_status = (r or {}).get("gate_status", "UNVERIFIED")
        board.setdefault("RELIABILITY", {"status": "PASS", "sources": []})
        entry = board["RELIABILITY"]
        entry["sources"].append(f"gate-p1-ledger-{i + 1}={upd_status}")
        order = ["PASS", "DEGRADED", "UNVERIFIED", "BLOCKED", "FAIL"]
        if order.index(upd_status if upd_status in order else "UNVERIFIED") > order.index(entry["status"]):
            entry["status"] = upd_status if upd_status in order else "UNVERIFIED"
    missing = [a[0] for a, r in zip(AREAS, reviews) if r is None] + [g[0] for g, r in zip(GATES, gates) if r is None] + [f"gate-p1-ledger-{i + 1}" for i, r in enumerate(ledgers) if r is None]
    disagree = [a[0] for a, r in zip(AREAS, reviews) if r is not None and not r.get("agrees_production_ready")]
    verdict = {
        "sha": SHA,
        "mac_run": MAC_RUN,
        "unresolved_p0_p1": p01,
        "p01_ledger_not_resolved": ledger_open,
        "reviewers_disagreeing": disagree,
        "agents_without_report": missing,
        "scoreboard": board,
        "all_gates_pass": all(v["status"] == "PASS" for v in board.values()) and not p01 and not ledger_open and not missing and not disagree,
        "external_blockers": sorted({b for r in list(reviews) + list(gates) for b in (r or {}).get("external_blockers", [])}),
    }
    save("final-verdict.json", verdict)
    log(f"FINAL: all_gates_pass={verdict['all_gates_pass']} p0p1={len(p01)} ledger_not_resolved={len(ledger_open)} disagree={disagree} missing={missing} board={ {k: v['status'] for k, v in board.items()} }")
    return verdict


asyncio.run(main())
