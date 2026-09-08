"""Deterministic builder for the production-program work-package manifest.

`python3 .devin/program/build_manifest.py` rewrites `manifest.json` from the
package table below. The JSON is the frozen input the per-package workflow
launchers read; regenerate and commit it deliberately — never hand-edit.

Every package is a testable unit of the binding scope in
docs/prompts/codex-production-readiness.md (Phase 0, W00–W12, Phase 2) and the
findings register in docs/RELEASE_READINESS_2026-09-07.md. Packages that need
owner-supplied inputs carry `external_blocker`; they are still tracked but not
launched.
"""

from __future__ import annotations

import hashlib
import json
import os

MANIFEST_VERSION = "2026-09-08.3"
REPO = "RaunakGengiti2725/Pickle-Sensei"
CONTINUATION_BRANCH = "codex/production-continuation-20260907"
HANDOFF_SHA = "c23d16013b9872cdba7541329c9151d23045090b"

# Serial groups: at most ONE active package per group at any time, because the
# group owns a shared contract / entry point / lockfile that cannot be edited by
# two writers. The wave scheduler enforces this in addition to `deps`.
SERIAL_GROUPS = {
    "edge-index": "supabase/functions/api/index.ts and the __wf__ suite share one Deno entry point",
    "sql": "supabase/migrations forward migrations + supabase/tests matrices (ordered timestamps)",
    "shared-types": "packages/shared-types public contract",
    "mobile-data": "apps/mobile/src/data (db/repository/sync/offlineCapabilities) shared runtime",
    "mobile-billing": "apps/mobile/src/billing + accessStore",
    "mobile-analysis": "apps/mobile/src/analysis (runCaptureAnalysis/runJournal) shared pipeline",
    "mobile-navigation": "apps/mobile/src/navigation + App.tsx + CeremonyHost",
    "native-pod": "apps/mobile/ios/LocalPods/PickleNative + Podfile/Podfile.lock",
    "native-managed-media": "native/managed-media Swift package",
    "release-identity": "apps/mobile/ios/fastlane, pbxproj versions, release manifest",
    "ci-scripts": "scripts/*.sh and .github/workflows",
    "docs-packet": "docs/RELEASE_READINESS_2026-09-07.md and readiness docs (integration writer only)",
}

# Path prefixes each serial group owns. A package may edit a file under one of
# these prefixes only if it holds that group; reviewers grade any other edit
# there as a scope violation even when it looks like harmless wiring.
SERIAL_GROUP_PATHS = {
    "edge-index": ["supabase/functions/api/index.ts"],
    "sql": ["supabase/migrations/", "supabase/tests/"],
    "shared-types": ["packages/shared-types/src/"],
    "mobile-data": ["apps/mobile/src/data/"],
    "mobile-billing": ["apps/mobile/src/billing/", "apps/mobile/src/state/accessStore.ts"],
    "mobile-analysis": ["apps/mobile/src/analysis/"],
    "mobile-navigation": ["apps/mobile/src/navigation/", "apps/mobile/App.tsx", "apps/mobile/src/flow/CeremonyHost.tsx"],
    "native-pod": ["apps/mobile/ios/LocalPods/", "apps/mobile/ios/Podfile", "apps/mobile/ios/Podfile.lock"],
    "native-managed-media": ["native/managed-media/"],
    "release-identity": ["apps/mobile/ios/fastlane/", "apps/mobile/ios/PickleSensei.xcodeproj/", "apps/mobile/scripts/release-identity.mjs"],
    "ci-scripts": ["scripts/", ".github/workflows/"],
    "docs-packet": ["docs/RELEASE_READINESS_2026-09-07.md"],
}
assert set(SERIAL_GROUP_PATHS) == set(SERIAL_GROUPS)

# Acceptance templates. `kind` tells the judge how to grade the record:
#   test    -> exit 0, executed > 0, failed == 0, skipped == 0
#   check   -> exit 0
#   regress -> reviewer must confirm the new test FAILS on base and PASSES on head
#   manual  -> reproducible manual procedure + artifact (screenshots etc.)
# A 4th tuple element lists `documented_skips`: the ONLY skips the judge tolerates for that
# criterion, each a documented Linux non-gate from docs/devin/TEST_MATRIX.md that needs
# Mac-generated (gitignored) artifacts. The record's note must name each one.
MAC_ARTIFACT_SKIP_MOBILE = ["importedRealFootageAnalysis.test.ts"]  # datasets/paddle-bench/runs/wm-volley-02 (Apple Vision, M4 only)
MAC_ARTIFACT_SKIPS_SWING_LAB = [  # packages/swing-lab/test/sessionEngine.test.ts replay describes (Apple Vision report.json, M4 only)
    "afn-sasebo-rally1: wrist-only batch", "afn-sasebo-rally1: streaming the series",
    "afn-sasebo-rally2: wrist-only batch", "afn-sasebo-rally2: streaming the series",
]
MOBILE_FULL_JEST = ("test", "cd apps/mobile && npx jest --ci --silent", "full mobile Jest suite: 0 failed; the only tolerated skip is the documented Mac-artifact suite", MAC_ARTIFACT_SKIP_MOBILE)
MOBILE_TSC = ("check", "cd apps/mobile && npx tsc --noEmit", "mobile TypeScript passes")
MOBILE_LINT = (
    "check",
    "npx eslint <changed apps/mobile files> && npx prettier --check <changed files>",
    "root ESLint + Prettier pass on every changed file",
)
EDGE_CHECK = (
    "check",
    "npx --yes deno@2.5.6 check --node-modules-dir=none --frozen --lock=deno.lock supabase/functions/api/index.ts",
    "frozen Deno 2.5.6 typecheck of the Edge entry point passes",
)
EDGE_TESTS = (
    "test",
    "cd supabase/functions/api/__wf__ && XC_PG_URL=<disposable postgres url> deno task test",
    "full Edge suite passes with a disposable PostgreSQL so no live-DB test is ignored (ignored == 0)",
)
RLS = (
    "test",
    "./supabase/tests/run_rls_tests.sh",
    "fresh-install + all historical-upgrade SQL security matrices pass",
)
SHARED_TYPES = (
    "test",
    "pnpm --filter @pickle/shared-types typecheck && pnpm --filter @pickle/shared-types test",
    "shared-types typecheck and tests pass",
)
ROOT_FMT = ("check", "pnpm format:check", "root Prettier check passes")


def mobile_jest(paths: str, what: str) -> tuple[str, str, str]:
    return ("test", f"cd apps/mobile && npx jest --ci --silent {paths}", what)


def regress(what: str) -> tuple[str, str, str]:
    return ("regress", "reviewer: check out BASE_SHA, copy ONLY the new test file(s) over, run them → must FAIL; run on HEAD → must PASS", what)


def manual(what: str, procedure: str) -> tuple[str, str, str]:
    return ("manual", procedure, what)


P: list[dict] = []


def _criterion(pkg_id: str, i: int, a: tuple) -> dict:
    assert len(a) in (3, 4), a
    kind, command, criterion = a[0], a[1], a[2]
    out = {"id": f"{pkg_id}-AC{i + 1}", "kind": kind, "command": command, "criterion": criterion}
    if len(a) == 4:
        assert kind in ("test", "regress") and a[3] and all(isinstance(s, str) and s for s in a[3]), a
        out["documented_skips"] = list(a[3])
    return out


def pkg(
    id: str,
    parent: str,
    title: str,
    objective: str,
    *,
    severity: str,
    source_ids: list[str],
    plane: str,
    write_paths: list[str],
    acceptance: list[tuple],
    deps: list[str] | None = None,
    serial_groups: list[str] | None = None,
    additive_shared_paths: list[str] | None = None,
    mode: str | None = None,
    competing: int = 1,
    external_blocker: str | None = None,
    invariants: list[str] | None = None,
    estimate_minutes: int = 60,
) -> None:
    assert plane in ("cloud", "mac", "bench", "docs", "external")
    assert severity in ("P0", "P1", "P2")
    assert all(g in SERIAL_GROUPS for g in (serial_groups or []))
    P.append(
        {
            "id": id,
            "parent": parent,
            "title": title,
            "objective": objective,
            "severity": severity,
            "source_ids": source_ids,
            "plane": plane,
            "deps": deps or [],
            "serial_groups": serial_groups or [],
            "write_paths": write_paths,
            "additive_shared_paths": additive_shared_paths or [],
            "acceptance": [_criterion(id, i, a) for i, a in enumerate(acceptance)],
            "invariants": invariants or [],
            "mode": mode,
            "competing": competing,
            "estimate_minutes": estimate_minutes,
            "external_blocker": external_blocker,
        }
    )


# ---------------------------------------------------------------------------
# Phase 0 — verification failures (diagnose, do not relax safeguards)
# ---------------------------------------------------------------------------
pkg(
    "P0-01", "P0", "Diagnose the cold Metro/ICNS config-load child timeout without relaxing the 5 s / 192 MB guard",
    "Reproduce the intermittent `apps/mobile` ICNS child-process config-load timeout on a cold cache using the committed bounded tracing (cba1eabf), identify the root cause (module graph / cache / IO), and fix the cause. Forbidden: raising the timeout, prewarming/reordering tests, retry-until-green.",
    severity="P0", source_ids=["P0-MOBILE"], plane="cloud",
    write_paths=["apps/mobile/scripts/", "apps/mobile/__tests__/", "apps/mobile/metro.config.js", "apps/mobile/jest.config.js"],
    acceptance=[
        mobile_jest("<the ICNS/metro config suites>", "ICNS/metro suites pass 5 consecutive COLD runs (rm -rf $TMPDIR/metro-* between runs) with executed>0, failed=0, skipped=0"),
        ("test", "cd apps/mobile && npx jest --ci --silent", "full mobile suite passes once COLD (rm -rf $TMPDIR/metro-* first) with the fix: 0 failed; the only tolerated skip is the documented Mac-artifact suite", MAC_ARTIFACT_SKIP_MOBILE),
        MOBILE_TSC, MOBILE_LINT,
    ],
    invariants=["timeout, memory and output-size guards unchanged or stricter"], estimate_minutes=60,
)
pkg(
    "P0-02", "P0", "Root-cause any mobile Jest suite failing on the continuation head",
    "Run the full mobile Jest suite on BASE_SHA, list every failing/erroring suite with cause, and fix real defects (not tests) for each. If a failure is environmental, prove it (exact env difference) instead of skipping.",
    severity="P0", source_ids=["P0-MOBILE"], plane="cloud",
    write_paths=["apps/mobile/src/", "apps/mobile/__tests__/", "apps/mobile/__harness__/"],
    acceptance=[MOBILE_FULL_JEST, MOBILE_TSC, MOBILE_LINT],
    estimate_minutes=60,
)
pkg(
    "P0-03", "P0", "Edge suite with disposable PostgreSQL: zero ignored tests on the continuation head",
    "Run the Edge __wf__ suite with XC_PG_URL pointing at a disposable postgres:16 container; make the 6 route-shot tests execute (not ignored) and fix any real failure.",
    severity="P0", source_ids=["P0-EDGE"], plane="cloud",
    write_paths=["supabase/functions/api/__wf__/"], serial_groups=["edge-index"],
    acceptance=[EDGE_TESTS, EDGE_CHECK],
)
pkg(
    "P0-04", "P0", "SQL security matrix: fresh + production + upstream + ordered upgrade histories on the continuation head",
    "Run ./supabase/tests/run_rls_tests.sh on BASE_SHA; if any history fails, fix the cause with a forward migration or test correction that keeps allowed AND denied paths asserted.",
    severity="P0", source_ids=["P0-SQL"], plane="cloud",
    write_paths=["supabase/tests/", "supabase/migrations/"], serial_groups=["sql"],
    acceptance=[RLS],
)
pkg(
    "P0-05", "P0", "Housekeeping: root format/lint/typecheck/workspace tests green on the continuation head",
    "Run pnpm format:check, pnpm lint, pnpm typecheck and DATABASE_URL_TEST=… pnpm test (with docker postgres_test) and fix every failure at its root.",
    severity="P1", source_ids=["P0-HOUSEKEEPING"], plane="cloud",
    write_paths=["packages/", "services/", "tools/", "apps/admin-web/"],
    acceptance=[ROOT_FMT, ("check", "pnpm lint", "root lint passes"), ("check", "pnpm typecheck", "workspace typecheck passes"), ("test", "docker compose up -d postgres_test elasticmq && SQS_ENDPOINT_TEST=http://localhost:9324 DATABASE_URL_TEST=postgres://pickle:pickle_test_password@localhost:5433/pickle_test pnpm test", "workspace tests pass with the SQS tests executing (ElasticMQ up); the only tolerated skips are the 4 documented swing-lab Apple-Vision replay tests", MAC_ARTIFACT_SKIPS_SWING_LAB)],
)

# ---------------------------------------------------------------------------
# W01 — joint chargeability at every decision point
# ---------------------------------------------------------------------------
pkg(
    "W01-01", "W01", "Forward migration: honest PARTIAL terminal permit outcome + tombstone, no charge",
    "Add a forward migration (timestamp later than 20260908020000) introducing an explicit partial terminal outcome for analysis permits (mechanics-only output without a validated benchmark) that releases the permit WITHOUT counting toward lifetime_scored_count(), preserving access_lock_key(), lifetime spent floor, late-linked identity inheritance and anti-reset behaviour. Do not relabel partial as low_confidence.",
    severity="P0", source_ids=["W01", "W06-SOFTWARE"], plane="cloud",
    write_paths=["supabase/migrations/20260908100000_permit_partial_terminal_outcome.sql", "supabase/tests/security_regression.sql", "supabase/functions/api/__wf__/db_migrations_rls_indexes.test.ts"],
    serial_groups=["sql"],
    acceptance=[RLS, regress("new SQL cases: partial outcome never increments lifetime_scored_count(); client role cannot forge scored"), EDGE_TESTS],
    invariants=["never edit applied migrations", "no client grant widening", "lifetime_scored_count() at every decision point"],
)
pkg(
    "W01-02", "W01", "Edge admission requires an ACTIVE, non-withdrawn release policy before a chargeable scored run",
    "In supabase/functions/api/index.ts, gate permit reservation and apply_synced_shot scored settlement on the release authority (releasePolicy.ts + RPC): missing/withdrawn/mismatched policy ⇒ admission returns a non-chargeable partial/abstain path with a typed error, never a 5xx and never a charge.",
    severity="P0", source_ids=["W01", "W04"], plane="cloud", deps=["W01-01"],
    write_paths=["supabase/functions/api/index.ts", "supabase/functions/api/releasePolicy.ts", "supabase/functions/api/__wf__/release_policy_admission.test.ts"],
    serial_groups=["edge-index"],
    acceptance=[EDGE_CHECK, EDGE_TESTS, regress("admission without active policy is denied and uncharged; with policy it proceeds")],
)
pkg(
    "W01-03", "W01", "Bind settlement receipts to owner/device/grant/ticket/operation/payload digest/policy lineage",
    "Extend the scored settlement path so the receipt and replay check cover owner, device, grant, ticket, operation id, canonical payload digest (canonicalDigest.ts) and the full policy lineage. Replay of an identical settlement returns the original receipt; a mismatched replay is rejected BEFORE any credit or sequence is consumed.",
    severity="P0", source_ids=["W01", "W04"], plane="cloud", deps=["W01-02"],
    write_paths=["supabase/functions/api/index.ts", "supabase/functions/api/canonicalDigest.ts", "supabase/functions/api/__wf__/settlement_receipt_binding.test.ts", "supabase/migrations/20260908110000_settlement_receipt_lineage.sql", "supabase/tests/security_regression.sql"],
    serial_groups=["edge-index", "sql"],
    acceptance=[EDGE_CHECK, EDGE_TESTS, RLS, regress("identical replay ⇒ same receipt, no second charge; mutated payload ⇒ rejected, zero credit consumed")],
)
pkg(
    "W01-04", "W01", "Shared joint-chargeability contract exercised by mobile, Edge and SQL fixtures",
    "Make packages/shared-types the single definition of when an outcome is chargeable (both mechanics AND benchmark independently validated AND durably delivered) and add contract fixtures consumed by mobile and Edge tests so the three planes cannot drift.",
    severity="P0", source_ids=["W01"], plane="cloud",
    write_paths=["packages/shared-types/src/analysisOutcome.ts", "packages/shared-types/src/chargeability.ts", "packages/shared-types/src/__tests__/", "packages/shared-types/fixtures/"],
    serial_groups=["shared-types"],
    acceptance=[SHARED_TYPES, regress("fixture table: every partial/failed/withheld/replayed outcome is non-chargeable")],
)
pkg(
    "W01-05", "W01", "Mobile: partial outcome never spends a free rating; Result shows honest partial state",
    "In runCaptureAnalysis/runJournal and accessStore, a partial outcome (mechanics without validated benchmark) must settle as non-chargeable, must not decrement the local free-rating view, and Result must render an explicit 'benchmark unavailable' state (no invented confidence).",
    severity="P0", source_ids=["W01", "W06-SOFTWARE"], plane="cloud", deps=["W01-04"],
    write_paths=["apps/mobile/src/analysis/", "apps/mobile/src/state/accessStore.ts", "apps/mobile/src/screens/ResultScreen.tsx", "apps/mobile/__tests__/w01PartialOutcome.test.tsx"],
    serial_groups=["mobile-billing", "mobile-analysis"],
    acceptance=[mobile_jest("__tests__/w01PartialOutcome.test.tsx __tests__/accessStore.test.ts __tests__/analyzeScreenFullFlowE2E.test.tsx", "partial-outcome suites pass"), regress("partial outcome leaves free-rating count unchanged"), MOBILE_TSC, MOBILE_LINT],
)
pkg(
    "W01-06", "W01", "Mobile fetches and caches the release policy; missing/withdrawn policy blocks new numerical output",
    "Add a mobile client for GET /v1/analysis/release-policy with bounded cache, canonical-bytes/SHA-256 verification (mirror releasePolicy.ts), and gate numerical publication on an active policy. Offline with a cached valid policy inside its validity window is allowed; no policy ⇒ mechanics-only partial.",
    severity="P0", source_ids=["W01", "W06-SOFTWARE"], plane="cloud", deps=["W01-05"],
    write_paths=["apps/mobile/src/analysis/releasePolicyClient.ts", "apps/mobile/src/data/api.ts", "apps/mobile/__tests__/releasePolicyClient.test.ts"],
    serial_groups=["mobile-data", "mobile-analysis"], additive_shared_paths=["apps/mobile/src/data/api.ts"],
    acceptance=[mobile_jest("__tests__/releasePolicyClient.test.ts", "policy client suite passes"), regress("tampered policy bytes rejected; withdrawn policy blocks numerical output"), MOBILE_TSC, MOBILE_LINT],
)

# ---------------------------------------------------------------------------
# W02 — durable journal/result/outbox
# ---------------------------------------------------------------------------
pkg(
    "W02-01", "W02", "Dependency-ordered outbox proof: parent rows always acknowledged before dependents",
    "Add real-SQLite (node:sqlite) tests proving the sync outbox never sends a dependent row before its parent is durably acknowledged, across crash-at-every-step injection, and fix any ordering defect found.",
    severity="P0", source_ids=["W02"], plane="cloud",
    write_paths=["apps/mobile/src/data/sync.ts", "apps/mobile/src/data/syncRuntime.ts", "apps/mobile/__tests__/w02OutboxDependencyOrder.test.ts"],
    serial_groups=["mobile-data"],
    acceptance=[mobile_jest("__tests__/w02OutboxDependencyOrder.test.ts __tests__/sync*.test.ts", "outbox ordering suites pass"), ("check", "reviewer: enumerate the outbox steps the suite kills at (>= 8, real node:sqlite); run ONLY the new suite on BASE_SHA and record its result in note — a defect fixed by the candidate must FAIL there; if it PASSES the candidate must contain no behavioural change to sync.ts/syncRuntime.ts (proof-only package)", "crash-at-every-step proof: either a reproduced+fixed ordering defect, or an honest proof-only result with no production change"), MOBILE_TSC, MOBILE_LINT],
)
pkg(
    "W02-02", "W02", "Owner-generation fencing adversarial matrix across account switch during in-flight analysis",
    "Add tests switching accounts at each stage of an in-flight analysis (capture, extraction, settlement, sync) and assert no row is written under the new owner, no result leaks, and original-owner recovery restores the pending result.",
    severity="P0", source_ids=["W02"], plane="cloud", serial_groups=["mobile-data"],
    write_paths=["apps/mobile/src/data/accountScope.ts", "apps/mobile/__tests__/w02OwnerFencingMatrix.test.ts"],
    acceptance=[mobile_jest("__tests__/w02OwnerFencingMatrix.test.ts", "owner fencing matrix passes"), regress("at least one stage leaks on base or the matrix documents existing coverage per stage"), MOBILE_TSC, MOBILE_LINT],
)
pkg(
    "W02-03", "W02", "Process-death recovery harness for journal/result/outbox on Linux (node:sqlite)",
    "Build a deterministic process-death harness that kills a child Node process between each journal step and asserts recovery on relaunch reproduces exactly one durable result and one outbox entry (no duplicates, no loss).",
    severity="P0", source_ids=["W02"], plane="cloud", serial_groups=["mobile-data"],
    write_paths=["apps/mobile/__harness__/processDeath/", "apps/mobile/__tests__/w02ProcessDeathRecovery.test.ts", "apps/mobile/src/data/api.ts"],
    acceptance=[mobile_jest("__tests__/w02ProcessDeathRecovery.test.ts", "process-death recovery suite passes with >= 8 kill points"), regress("unverified non-JSON 2xx finalize acknowledgement recorded as released, and 3xx redirects followed by the transport, fail on base"), MOBILE_TSC, MOBILE_LINT],
    invariants=["request() never follows redirects and never treats a non-JSON 2xx body as an acknowledgement"],
)
pkg(
    "W02-04", "W02", "Native force-quit recovery acceptance on the simulator (Mac plane)",
    "On the M4 runner (serialized), extend the ios-app stage evidence with a scripted force-quit during a mounted analysis and verify the durable result appears after relaunch (screenshot + log evidence). Physical-device evidence remains EXT-DEVICE.",
    severity="P1", source_ids=["W02", "P0-NATIVE"], plane="mac", deps=["W02-03"],
    write_paths=["tools/macos-ci/", "scripts/mac-full-verify.sh"], serial_groups=["ci-scripts"],
    acceptance=[manual("mac run shows force-quit → relaunch → result visible", "scripts/mac-full-verify.sh --remote (coordinator-owned Mac slot) → run.json + screenshots")],
    estimate_minutes=60,
)

# ---------------------------------------------------------------------------
# W03 — import
# ---------------------------------------------------------------------------
pkg(
    "W03-01", "W03", "Conservative import event admission (reject ambiguous/unsupported clips before extraction)",
    "Implement admission rules for imported clips: duration bounds, frame-rate/rotation/codec support, single-stroke plausibility; ambiguous clips are rejected with a precise reason and never reach charging.",
    severity="P0", source_ids=["W03"], plane="cloud", serial_groups=["mobile-analysis"],
    write_paths=["apps/mobile/src/camera/importAdmission.ts", "apps/mobile/src/analysis/runCaptureAnalysis.ts", "apps/mobile/__tests__/w03ImportAdmission.test.ts", "apps/mobile/__tests__/importedCaptureAnalysis.test.ts"],
    acceptance=[mobile_jest("__tests__/w03ImportAdmission.test.ts __tests__/importedCaptureAnalysis.test.ts", "import admission suites pass"), regress("ambiguous clip admitted on base"), MOBILE_TSC, MOBILE_LINT],
)
pkg(
    "W03-02", "W03", "Versioned time mapping between imported media timestamps and analysis frames",
    "Introduce a versioned time-mapping contract (media pts ↔ frame index ↔ analysis window) with round-trip tests, recorded in the run journal so a future mapping version cannot reinterpret stored results.",
    severity="P1", source_ids=["W03"], plane="cloud", serial_groups=["mobile-analysis"], deps=["W03-01"],
    write_paths=["apps/mobile/src/camera/timeMapping.ts", "apps/mobile/src/analysis/runJournalSchema.ts", "apps/mobile/__tests__/w03TimeMapping.test.ts"],
    acceptance=[mobile_jest("__tests__/w03TimeMapping.test.ts __tests__/runJournal*.test.ts", "time mapping suites pass"), MOBILE_TSC, MOBILE_LINT],
)
pkg(
    "W03-03", "W03", "Byte identity of imported originals (digest verified before and after processing)",
    "Ensure the imported original's byte digest is computed once, stored with the run, re-verified before retry, and any mismatch aborts the retry with a user-visible reason (nativeMediaIdentity.ts).",
    severity="P1", source_ids=["W03"], plane="cloud", serial_groups=["mobile-analysis"], deps=["W03-01"],
    write_paths=["apps/mobile/src/camera/nativeMediaIdentity.ts", "apps/mobile/src/analysis/originalAnalysisOperations.ts", "apps/mobile/__tests__/w03ByteIdentity.test.ts"],
    acceptance=[mobile_jest("__tests__/w03ByteIdentity.test.ts", "byte identity suite passes"), regress("mutated original accepted for retry on base"), MOBILE_TSC, MOBILE_LINT],
)
pkg(
    "W03-04", "W03", "Measured import resource bounds (memory/time) with an enforced budget",
    "Measure import extraction memory and wall time on committed fixtures, define an explicit budget, and enforce it with cancellation (bounded buffers/queues), recording the measurement method in docs/CAPTURE_EVIDENCE.md.",
    severity="P1", source_ids=["W03"], plane="cloud", serial_groups=["mobile-analysis"], deps=["W03-01"],
    write_paths=["apps/mobile/src/camera/importBudget.ts", "apps/mobile/src/analysis/runCaptureAnalysis.ts", "apps/mobile/__tests__/w03ImportBudget.test.ts", "docs/CAPTURE_EVIDENCE.md"],
    acceptance=[mobile_jest("__tests__/w03ImportBudget.test.ts", "budget enforcement suite passes"), MOBILE_TSC, MOBILE_LINT],
)

# ---------------------------------------------------------------------------
# W04 — server-authoritative offline grants
# ---------------------------------------------------------------------------
pkg(
    "W04-01", "W04", "Forward migration: device registry, offline grants, allocation ledger (append-only, API-only RLS)",
    "Create tables/RPCs for device registration, per-device offline grants with expiry, and an append-only allocation ledger where allocation ≠ consumption; conservation: allocated + consumed + released ≤ entitlement, never auto-reclaimed on disconnect.",
    severity="P0", source_ids=["W04"], plane="cloud", deps=["W01-01"],
    write_paths=["supabase/migrations/20260908120000_offline_device_grants.sql", "supabase/tests/security_regression.sql", "supabase/functions/api/__wf__/db_migrations_rls_indexes.test.ts"],
    serial_groups=["sql"],
    acceptance=[RLS, regress("conservation invariant cases and denied client writes"), EDGE_TESTS],
    invariants=["no automatic reclaim of a disconnected device allocation", "Pro lease ≤ 7 days and ≤ verified entitlement expiry"],
)
pkg(
    "W04-02", "W04", "Edge: device registration + grant issuance routes with signed grants (offlineSignature.ts)",
    "Add POST /v1/devices/register and POST /v1/offline/grants issuing signed grants bound to owner/device/entitlement expiry (≤7d), with per-user route budgets and audit logging.",
    severity="P0", source_ids=["W04"], plane="cloud", deps=["W04-01", "W01-03"],
    write_paths=["supabase/functions/api/index.ts", "supabase/functions/api/offlineSignature.ts", "supabase/functions/api/__wf__/offline_grants_routes.test.ts"],
    serial_groups=["edge-index"],
    acceptance=[EDGE_CHECK, EDGE_TESTS, regress("grant exceeding entitlement expiry or 7 days is refused; allowed AND denied paths asserted")],
)
pkg(
    "W04-03", "W04", "Edge: signing-key rotation with overlap window and receipt verification under old+new keys",
    "Implement key-id-tagged signatures, a rotation procedure with bounded overlap, and verification that accepts receipts signed under the previous key only inside the overlap.",
    severity="P0", source_ids=["W04"], plane="cloud", deps=["W04-02"],
    write_paths=["supabase/functions/api/offlineSignature.ts", "supabase/functions/api/offlineSignature.test.ts", "supabase/functions/api/__wf__/offline_key_rotation.test.ts", "docs/runbooks/offline-key-rotation.md"],
    serial_groups=["edge-index"],
    acceptance=[EDGE_CHECK, EDGE_TESTS, regress("receipt under retired key outside overlap rejected")],
)
pkg(
    "W04-04", "W04", "Edge: delayed receipt reconciliation (offline consumption reported later) with idempotent settlement",
    "Add POST /v1/offline/receipts accepting batches of signed consumption receipts; each settles at most once (bound to grant/ticket/operation/digest), out-of-order and duplicate batches are safe, and ambiguous receipts HOLD rather than refund/retry.",
    severity="P0", source_ids=["W04", "W01"], plane="cloud", deps=["W04-03"],
    write_paths=["supabase/functions/api/index.ts", "supabase/functions/api/__wf__/offline_receipt_reconciliation.test.ts", "supabase/migrations/20260908130000_offline_receipt_settlement.sql", "supabase/tests/security_regression.sql"],
    serial_groups=["edge-index", "sql"],
    acceptance=[EDGE_CHECK, EDGE_TESTS, RLS, regress("duplicate batch settles once; ambiguous receipt stays HOLD")],
)
pkg(
    "W04-05", "W04", "Mobile offline capability model consumes server grants (allocation ≠ consumption)",
    "Rework apps/mobile/src/data/offlineCapabilities.ts to hold a server-issued grant, decrement local allocation on consumption, queue receipts durably, and never assume reclaim on disconnect.",
    severity="P0", source_ids=["W04", "W05"], plane="cloud", deps=["W04-02"],
    write_paths=["apps/mobile/src/data/offlineCapabilities.ts", "apps/mobile/src/data/api.ts", "apps/mobile/__tests__/w04OfflineGrants.test.ts"],
    serial_groups=["mobile-data"], additive_shared_paths=["apps/mobile/src/data/api.ts"],
    acceptance=[mobile_jest("__tests__/w04OfflineGrants.test.ts __tests__/offline*.test.ts", "offline grant suites pass"), regress("disconnect does not reclaim allocation"), MOBILE_TSC, MOBILE_LINT],
)

# ---------------------------------------------------------------------------
# W05 — native wallet / secure storage / trusted time
# ---------------------------------------------------------------------------
pkg(
    "W05-01", "W05", "Native wallet Swift module: Keychain-backed grant/receipt storage with atomic writes",
    "Add PickleOfflineWallet to LocalPods/PickleNative: stores signed grants and unsent receipts in Keychain (AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY), atomic replace, tamper detection, and a JS bridge with typed errors.",
    severity="P0", source_ids=["W05"], plane="mac",
    write_paths=["apps/mobile/ios/LocalPods/PickleNative/Sources/PickleOfflineWallet.swift", "apps/mobile/ios/LocalPods/PickleNative/Sources/PickleOfflineWalletBridge.m", "native/vision-core/Tests/OfflineWalletTests.swift"],
    serial_groups=["native-pod"],
    acceptance=[manual("XCTest for wallet passes on iOS Simulator via mac-full-verify swift-native stage", "scripts/mac-full-verify.sh --remote (coordinator Mac slot)"), ("check", "cd apps/mobile && npx tsc --noEmit", "TS bridge types compile")],
)
pkg(
    "W05-02", "W05", "Trusted time source for lease expiry (monotonic + last-known server time, tamper-resistant)",
    "Implement a trusted-time module combining server time from authenticated responses, monotonic uptime and Keychain-persisted anchors; a backwards wall-clock jump cannot extend a lease.",
    severity="P0", source_ids=["W05"], plane="cloud", serial_groups=["mobile-data"],
    write_paths=["apps/mobile/src/data/trustedTime.ts", "apps/mobile/__tests__/w05TrustedTime.test.ts"],
    acceptance=[mobile_jest("__tests__/w05TrustedTime.test.ts", "trusted time suite passes"), regress("clock rollback extends lease on base"), MOBILE_TSC, MOBILE_LINT],
)
pkg(
    "W05-03", "W05", "Wallet crash recovery: receipts survive process death and are never double-submitted",
    "JS-side wallet store with write-ahead journal, idempotent receipt submission keyed by receipt id, and recovery tests through the process-death harness.",
    severity="P0", source_ids=["W05"], plane="cloud", deps=["W04-05", "W02-03"],
    write_paths=["apps/mobile/src/data/offlineWallet.ts", "apps/mobile/__tests__/w05WalletRecovery.test.ts"],
    serial_groups=["mobile-data"],
    acceptance=[mobile_jest("__tests__/w05WalletRecovery.test.ts", "wallet recovery suite passes"), MOBILE_TSC, MOBILE_LINT],
)
pkg(
    "W05-04", "W05", "Complete offline user journey UI: allocation display, offline analysis, reconciliation states",
    "Analyze/Result/Settings surface honest offline states: remaining allocation, lease expiry (trusted time), pending receipt reconciliation, and a HOLD state for ambiguous receipts; copy per APP_STORE_SUBMISSION.md.",
    severity="P0", source_ids=["W05", "W09"], plane="cloud", deps=["W05-03", "W05-02"],
    write_paths=["apps/mobile/src/screens/AnalyzeScreen.tsx", "apps/mobile/src/screens/SettingsScreen.tsx", "apps/mobile/src/components/OfflineAllocationCard.tsx", "apps/mobile/__tests__/w05OfflineJourney.test.tsx"],
    acceptance=[mobile_jest("__tests__/w05OfflineJourney.test.tsx __tests__/analyzeScreen*.test.tsx", "offline journey suites pass"), MOBILE_TSC, MOBILE_LINT],
)
pkg(
    "W05-05", "W05", "Native acceptance: wallet + secure storage on simulator (launch, store, kill, restore)",
    "On the Mac plane, prove wallet store → force-quit → restore with Keychain entitlement working under ad-hoc signing; capture logs/screenshots.",
    severity="P1", source_ids=["W05", "P0-NATIVE"], plane="mac", deps=["W05-01", "W05-03"],
    write_paths=["tools/macos-ci/"], serial_groups=["ci-scripts"],
    acceptance=[manual("simulator evidence of wallet persistence across kill", "scripts/mac-full-verify.sh --remote")],
)

# ---------------------------------------------------------------------------
# W06 — release authority + scoring comparability
# ---------------------------------------------------------------------------
pkg(
    "W06-01", "W06", "Nine-component scoring-definition comparability: shared canonical definition + version",
    "Define the canonical scoring definition (all nine components, weights, abstention rules) once in packages/shared-types with a version id, and add golden fixtures so mobile, Edge and SQL rank computations can be checked against identical inputs.",
    severity="P0", source_ids=["W06-SOFTWARE"], plane="cloud",
    write_paths=["packages/shared-types/src/scoringDefinition.ts", "packages/shared-types/src/playerRank.ts", "packages/shared-types/fixtures/scoring/", "packages/shared-types/src/__tests__/"],
    serial_groups=["shared-types"],
    acceptance=[SHARED_TYPES, regress("golden fixtures pin the definition version")],
)
pkg(
    "W06-02", "W06", "Edge rank/progress computation matches the shared definition on golden fixtures",
    "Make the Edge rank/progress path compute through the shared definition (or a byte-identical port with fixture parity tests) and tag responses with the definition version.",
    severity="P0", source_ids=["W06-SOFTWARE"], plane="cloud", deps=["W06-01"],
    write_paths=["supabase/functions/api/index.ts", "supabase/functions/api/scoringDefinition.ts", "supabase/functions/api/__wf__/scoring_parity.test.ts"],
    serial_groups=["edge-index"],
    acceptance=[EDGE_CHECK, EDGE_TESTS, regress("fixture parity: Edge output == shared fixture output for all cases")],
)
pkg(
    "W06-03", "W06", "SQL rank aggregates match the shared definition (fixture-driven SQL tests)",
    "Add SQL tests feeding the golden fixtures through the rank/progress SQL functions and asserting identical outputs; fix drift with a forward migration; never reinterpret historical rows under a new version.",
    severity="P0", source_ids=["W06-SOFTWARE"], plane="cloud", deps=["W06-01"],
    write_paths=["supabase/migrations/20260908140000_scoring_definition_version.sql", "supabase/tests/scoring_parity.sql", "supabase/tests/run_rls_tests.sh"],
    serial_groups=["sql"],
    acceptance=[RLS, regress("SQL parity cases fail without the migration")],
)
pkg(
    "W06-04", "W06", "Mobile Home/Library/Progress partition scored vs partial vs abstain using the shared definition",
    "Mobile rank/progress views compute via the shared definition, show the definition version in ResultDetails, and never blend partial outcomes into rank.",
    severity="P0", source_ids=["W06-SOFTWARE"], plane="cloud", deps=["W06-01", "W01-05"],
    write_paths=["apps/mobile/src/progress/", "apps/mobile/src/screens/ProgressScreen.tsx", "apps/mobile/src/screens/HomeScreen.tsx", "apps/mobile/__tests__/w06MobileParity.test.tsx"],
    acceptance=[mobile_jest("__tests__/w06MobileParity.test.tsx __tests__/progress*.test.ts*", "mobile parity suites pass"), MOBILE_TSC, MOBILE_LINT],
)
pkg(
    "W06-05", "W06", "Approved-output publication wiring: positive saved outcome only when release-bound interval matches",
    "Wire the existing release-bound interval predicate/formatter so a benchmark is shown ONLY when the run's policy lineage matches an approved output; otherwise 'benchmark unavailable'. Synthetic approvals appear only in isolated tests.",
    severity="P0", source_ids=["W06-SOFTWARE"], plane="cloud", deps=["W01-06"],
    write_paths=["apps/mobile/src/components/StrokeResult.tsx", "apps/mobile/src/components/strokeResultModel.ts", "apps/mobile/__tests__/w06ApprovedPublication.test.tsx"],
    acceptance=[mobile_jest("__tests__/w06ApprovedPublication.test.tsx __tests__/strokeResult*.test.tsx", "publication suites pass"), regress("unapproved lineage shows a number on base"), MOBILE_TSC, MOBILE_LINT],
)
pkg(
    "W06-06", "W06", "Scientific validation protocol package: consent/metadata/blinded-review schemas and validators (no labels)",
    "Add the annotation/consent/metadata schemas, validators and a runner that would compute the validation report from owner-supplied blinded reviews; ship with zero labels and a report that prints BLOCKED_EXTERNAL until inputs exist.",
    severity="P1", source_ids=["W06-SCIENCE"], plane="cloud",
    write_paths=["ml/scripts/validation_protocol.py", "ml/scripts/test_validation_protocol.py", "docs/EVALUATION.md"],
    acceptance=[("test", "python3 -m unittest discover -s ml/scripts -p 'test_*.py'", "ML unit tests pass"), ("check", "python3 ml/scripts/validation_protocol.py --report", "report states BLOCKED_EXTERNAL with the exact missing inputs")],
    external_blocker="Owner must supply consented footage, verified metadata, qualified blinded reviewers and adjudication",
)

# ---------------------------------------------------------------------------
# W07 — billing lifecycle
# ---------------------------------------------------------------------------
pkg(
    "W07-01", "W07", "Provider reconciliation accepts numeric transaction ids and RevenueCat-only ids",
    "Update pendingFulfilment/Edge reconciliation to normalise numeric iOS transaction ids and match lifetime purchases via RevenueCat purchase identity when Apple transaction id is absent; missing data stays pending, never terminal.",
    severity="P0", source_ids=["W07"], plane="cloud",
    write_paths=["supabase/functions/api/index.ts", "supabase/functions/api/__wf__/billing_provider_shapes.test.ts"],
    serial_groups=["edge-index"],
    acceptance=[EDGE_CHECK, EDGE_TESTS, regress("numeric id and lifetime-without-apple-id fixtures stay pending or fulfil; never refund/expire from absence")],
)
pkg(
    "W07-02", "W07", "Renewal replaces latest transaction: reconciliation follows the subscription, not the id",
    "Handle a renewal that replaces the latest transaction so the original pending purchase is fulfilled against the subscription lineage; add post-renewal fixtures.",
    severity="P0", source_ids=["W07"], plane="cloud", deps=["W07-01"],
    write_paths=["supabase/functions/api/index.ts", "supabase/functions/api/__wf__/billing_renewal_lineage.test.ts"],
    serial_groups=["edge-index"],
    acceptance=[EDGE_CHECK, EDGE_TESTS, regress("post-renewal pending purchase stuck on base")],
)
pkg(
    "W07-03", "W07", "Forward migration: billing recovery queue + transfer source/destination reconciliation",
    "Create the durable transfer queue and verification barrier (source loses, destination gains only after provider confirmation) with append-only audit and API-only RLS.",
    severity="P0", source_ids=["W07"], plane="cloud", deps=["W01-01"],
    write_paths=["supabase/migrations/20260908150000_billing_recovery_transfer.sql", "supabase/tests/security_regression.sql"],
    serial_groups=["sql"],
    acceptance=[RLS, regress("transfer barrier cases: destination not premium before confirmation")],
)
pkg(
    "W07-04", "W07", "Edge transfer reconciliation + webhook TRANSFER handling with durable recovery",
    "Implement transfer handling in webhook and reconciliation routes using W07-03 tables; retryable incomplete webhooks; ordered verification preserved.",
    severity="P0", source_ids=["W07"], plane="cloud", deps=["W07-03", "W07-02"],
    write_paths=["supabase/functions/api/index.ts", "supabase/functions/api/__wf__/billing_transfer.test.ts"],
    serial_groups=["edge-index"],
    acceptance=[EDGE_CHECK, EDGE_TESTS, regress("transfer webhook then crash then replay converges")],
)
pkg(
    "W07-05", "W07", "Mobile pending-fulfilment UI + Manage subscription entry with truthful states",
    "Settings/Paywall show pending, fulfilled, grace, expired and HOLD states from server truth; add Manage subscription (opens App Store subscriptions) — never invents entitlement or price.",
    severity="P0", source_ids=["W07", "W09"], plane="cloud", deps=["W07-01"],
    write_paths=["apps/mobile/src/billing/", "apps/mobile/src/screens/PaywallScreen.tsx", "apps/mobile/src/screens/paywallCopy.ts", "apps/mobile/src/screens/SettingsScreen.tsx", "apps/mobile/__tests__/w07MembershipStates.test.tsx"],
    serial_groups=["mobile-billing"],
    acceptance=[mobile_jest("__tests__/w07MembershipStates.test.tsx __tests__/billing*.test.ts __tests__/paywall*.test.tsx", "membership suites pass"), MOBILE_TSC, MOBILE_LINT],
)
pkg(
    "W07-06", "W07", "Owner inventory pagination completes (no silent 16-page cap)",
    "Replace the page cap with cursor-driven pagination that either completes or reports INCOMPLETE explicitly; deletion/cleanup consumers must treat INCOMPLETE as not-done.",
    severity="P0", source_ids=["W07", "W08"], plane="cloud",
    write_paths=["supabase/functions/api/accountDeletionOperations.ts", "supabase/functions/api/__wf__/inventory_pagination.test.ts"],
    serial_groups=["edge-index"],
    acceptance=[EDGE_CHECK, EDGE_TESTS, regress("17+ pages truncated silently on base")],
)
pkg(
    "W07-07", "W07", "Mobile billing lifecycle adversarial suite: restore/refund/renewal/transfer/grace ordering",
    "Add an ordered lifecycle test matrix on the mobile billing store covering restore, refund, renewal, transfer-out, grace and expiry with interleaved network failures; fix defects found.",
    severity="P0", source_ids=["W07"], plane="cloud", deps=["W07-05"],
    write_paths=["apps/mobile/src/billing/lifecycle.ts", "apps/mobile/__tests__/w07LifecycleMatrix.test.ts"],
    serial_groups=["mobile-billing"],
    acceptance=[mobile_jest("__tests__/w07LifecycleMatrix.test.ts __tests__/billingLifecycle.test.ts", "lifecycle matrix passes"), MOBILE_TSC, MOBILE_LINT],
)

# ---------------------------------------------------------------------------
# W08 — deletion + managed media
# ---------------------------------------------------------------------------
pkg(
    "W08-01", "W08", "Wire the deletion operation into ManageAccount shipping path (idempotent, redirect-rejecting transport)",
    "ManageAccountScreen uses deletionOperation/deletionOperationTransport end-to-end with fetchNoRedirect, idempotent re-entry, and honest pending/failed/completed states; unknown state never renders as deleted.",
    severity="P0", source_ids=["W08"], plane="cloud",
    write_paths=["apps/mobile/src/screens/ManageAccountScreen.tsx", "apps/mobile/src/account/deletion.ts", "apps/mobile/__tests__/w08ManageAccountDeletion.test.tsx"],
    acceptance=[mobile_jest("__tests__/w08ManageAccountDeletion.test.tsx __tests__/accountDeletion.test.ts __tests__/deletionOperation*.test.ts", "deletion suites pass"), MOBILE_TSC, MOBILE_LINT],
)
pkg(
    "W08-02", "W08", "Signed native upload rejects redirects at the native layer",
    "Native upload/transport in PickleNative must fail on any 3xx (no follow), and the JS layer must surface a typed error; add a Linux contract test and a Swift unit test.",
    severity="P0", source_ids=["W08"], plane="mac",
    write_paths=["apps/mobile/ios/LocalPods/PickleNative/Sources/PickleSignedUpload.swift", "apps/mobile/ios/LocalPods/PickleNative/Sources/PickleSignedUploadBridge.m", "native/vision-core/Tests/SignedUploadRedirectTests.swift", "apps/mobile/__tests__/w08SignedUploadContract.test.ts"],
    serial_groups=["native-pod"], deps=["W05-01"],
    acceptance=[mobile_jest("__tests__/w08SignedUploadContract.test.ts", "JS contract suite passes"), manual("Swift redirect test passes on Mac", "scripts/mac-full-verify.sh --remote"), MOBILE_TSC],
)
pkg(
    "W08-03", "W08", "Managed media pod wiring: ClipMediaStore uses native/managed-media contracts",
    "Integrate native/managed-media (ManagedMediaStore/FileSystem) into LocalPods ClipMediaStore.swift so per-owner namespaces, backup exclusion and inventory are the shipping path.",
    severity="P0", source_ids=["W08"], plane="mac", deps=["W08-02"],
    write_paths=["apps/mobile/ios/LocalPods/PickleNative/Sources/ClipMediaStore.swift", "apps/mobile/ios/LocalPods/PickleNative/PickleNative.podspec", "apps/mobile/ios/Podfile", "native/managed-media/"],
    serial_groups=["native-pod", "native-managed-media"],
    acceptance=[manual("managed-media XCTests + ios-app Release build pass", "scripts/mac-full-verify.sh --remote")],
)
pkg(
    "W08-04", "W08", "Owner cleanup purges every owner namespace + managed media inventory on deletion/sign-out-of-deleted-account",
    "Account deletion completion triggers native inventory purge for the owner only (other owners untouched) and SQLite owner-scoped rows; restart recovery finishes an interrupted purge.",
    severity="P0", source_ids=["W08"], plane="cloud", deps=["W08-01"],
    write_paths=["apps/mobile/src/account/ownerCleanup.ts", "apps/mobile/src/data/repository.ts", "apps/mobile/__tests__/w08OwnerCleanup.test.ts"],
    serial_groups=["mobile-data"],
    acceptance=[mobile_jest("__tests__/w08OwnerCleanup.test.ts", "owner cleanup suite passes"), regress("other owner's rows removed or interrupted purge lost on base"), MOBILE_TSC, MOBILE_LINT],
)
pkg(
    "W08-05", "W08", "Per-clip deletion in Library (UI + repository + media) with referenced-original protection",
    "Library exposes delete-clip; repository deletes only when no pending operation references the original; media removal goes through the managed store; undo not offered (truthful).",
    severity="P1", source_ids=["W08", "W09"], plane="cloud", deps=["W08-04"],
    write_paths=["apps/mobile/src/screens/LibraryScreen.tsx", "apps/mobile/src/library/", "apps/mobile/__tests__/w08PerClipDeletion.test.tsx"],
    acceptance=[mobile_jest("__tests__/w08PerClipDeletion.test.tsx __tests__/library*.test.ts*", "library deletion suites pass"), MOBILE_TSC, MOBILE_LINT],
)
pkg(
    "W08-06", "W08", "Edge account deletion: complete owner inventory + external revocation + retention disclosure parity",
    "Ensure the Edge deletion operation completes all namespaces (with W07-06 pagination), revokes Apple token, and legal.ts/support copy match the retained free-rating ledger behaviour.",
    severity="P0", source_ids=["W08"], plane="cloud", deps=["W07-06"],
    write_paths=["supabase/functions/api/accountDeletionOperations.ts", "supabase/functions/api/legal.ts", "supabase/functions/api/__wf__/account_deletion_complete.test.ts"],
    serial_groups=["edge-index"],
    acceptance=[EDGE_CHECK, EDGE_TESTS],
)

# ---------------------------------------------------------------------------
# W09 — screens / interaction / accessibility
# ---------------------------------------------------------------------------
pkg("W09-01", "W09", "Accessible Form Review playback seeking (slider with adjustable role, VoiceOver, reduced motion)",
    "FormReviewPlayer gets an accessible seek control (accessibilityRole adjustable, increment/decrement actions), keeps playback in foreground, honours reduced motion.",
    severity="P0", source_ids=["W09", "H09-DEAD-PATHS"], plane="cloud",
    write_paths=["apps/mobile/src/review/FormReviewPlayer.tsx", "apps/mobile/src/review/FormReviewOverlay.tsx", "apps/mobile/__tests__/w09AccessibleSeek.test.tsx"],
    acceptance=[mobile_jest("__tests__/w09AccessibleSeek.test.tsx __tests__/formReview*.test.ts*", "form review suites pass"), MOBILE_TSC, MOBILE_LINT])
pkg("W09-02", "W09", "ResultDetails routing decision implemented (reachable from Result/Library, tests migrated deliberately)",
    "Decide and implement the ResultDetails entry (Result → details, Library → details) with typed params; migrate any tests for retired paths deliberately rather than deleting coverage.",
    severity="P1", source_ids=["W09", "H09-DEAD-PATHS"], plane="cloud",
    write_paths=["apps/mobile/src/screens/ResultDetailsScreen.tsx", "apps/mobile/src/screens/ResultScreen.tsx", "apps/mobile/src/navigation/params.ts", "apps/mobile/__tests__/w09ResultDetailsRouting.test.tsx"],
    serial_groups=["mobile-navigation"],
    acceptance=[mobile_jest("__tests__/w09ResultDetailsRouting.test.tsx __tests__/result*.test.tsx", "result routing suites pass"), MOBILE_TSC, MOBILE_LINT])
pkg("W09-03", "W09", "Early notification tap before navigation ready is queued and replayed once",
    "Notification presses arriving before RootNavigator is ready are queued (bounded, deduped) and dispatched exactly once after ready; cold-start and warm-start covered.",
    severity="P0", source_ids=["W09"], plane="cloud",
    write_paths=["apps/mobile/src/notifications/service.ts", "apps/mobile/src/notifications/useNotificationBootstrap.ts", "apps/mobile/src/navigation/RootNavigator.tsx", "apps/mobile/__tests__/w09EarlyNotificationTap.test.tsx"],
    serial_groups=["mobile-navigation"], deps=["W09-02"],
    acceptance=[mobile_jest("__tests__/w09EarlyNotificationTap.test.tsx __tests__/notification*.test.ts*", "notification suites pass"), regress("early tap dropped or double-dispatched on base"), MOBILE_TSC, MOBILE_LINT])
pkg("W09-04", "W09", "Overlay/ceremony arbiter: one modal surface at a time, focus restored, VoiceOver announcements",
    "CeremonyHost arbitrates rank-up, permissions, paywall and error overlays so only one is presented, focus returns to the trigger, and announcements are made once.",
    severity="P0", source_ids=["W09"], plane="cloud", serial_groups=["mobile-navigation"],
    write_paths=["apps/mobile/src/flow/CeremonyHost.tsx", "apps/mobile/src/flow/ceremonyRequest.ts", "apps/mobile/__tests__/w09OverlayArbiter.test.tsx"],
    acceptance=[mobile_jest("__tests__/w09OverlayArbiter.test.tsx __tests__/ceremonyArbitration.test.tsx", "overlay arbiter suites pass"), MOBILE_TSC, MOBILE_LINT])
pkg("W09-05", "W09", "Bottom tab bar and headings at largest Dynamic Type: no clipped labels, 44pt targets",
    "PremiumTabBar and screen headings adapt to accessibility text sizes (allowFontScaling bounds, multi-line, minimum 44pt targets); StreakCalendar heading readable.",
    severity="P1", source_ids=["W09"], plane="cloud",
    write_paths=["apps/mobile/src/navigation/PremiumTabBar.tsx", "apps/mobile/src/screens/StreakCalendarScreen.tsx", "apps/mobile/src/design/", "apps/mobile/__tests__/w09DynamicType.test.tsx"],
    serial_groups=["mobile-navigation"], deps=["W09-03"],
    acceptance=[mobile_jest("__tests__/w09DynamicType.test.tsx", "dynamic type suite passes"), MOBILE_TSC, MOBILE_LINT])
pkg("W09-06", "W09", "Camera permission denied → Settings deep link; capture screen empty/error/recovery states",
    "AnalyzeScreen camera-denied state offers Open Settings (Linking.openSettings), permission re-check on foreground, and honest error/recovery copy.",
    severity="P1", source_ids=["W09"], plane="cloud",
    write_paths=["apps/mobile/src/screens/AnalyzeScreen.tsx", "apps/mobile/src/camera/CaptureGuidancePanel.tsx", "apps/mobile/__tests__/w09CameraDenied.test.tsx"],
    deps=["W05-04"],
    acceptance=[mobile_jest("__tests__/w09CameraDenied.test.tsx", "camera denied suite passes"), MOBILE_TSC, MOBILE_LINT])
pkg("W09-07", "W09", "Consent screen restoring/offline copy + ManageAccount idempotent re-entry",
    "ConsentSettingsScreen shows restoring/offline states truthfully; ManageAccountScreen re-entry after backgrounding does not duplicate operations.",
    severity="P1", source_ids=["W09"], plane="cloud", deps=["W08-01"],
    write_paths=["apps/mobile/src/screens/ConsentSettingsScreen.tsx", "apps/mobile/src/state/consentStore.ts", "apps/mobile/__tests__/w09ConsentStates.test.tsx"],
    acceptance=[mobile_jest("__tests__/w09ConsentStates.test.tsx __tests__/consent*.test.ts*", "consent suites pass"), MOBILE_TSC, MOBILE_LINT])
pkg("W09-08", "W09", "Try again handoff bounded stack + stale handoff rejection",
    "tryAgainHandoff keeps a bounded navigation stack, rejects stale handoffs across owner generation changes, and preserves the original clip retry entry.",
    severity="P1", source_ids=["W09", "W03"], plane="cloud",
    write_paths=["apps/mobile/src/screens/tryAgainHandoff.ts", "apps/mobile/__tests__/w09TryAgainStack.test.ts"],
    acceptance=[mobile_jest("__tests__/w09TryAgainStack.test.ts __tests__/h27.tryAgainStaleHandoff.test.ts", "try-again suites pass"), MOBILE_TSC, MOBILE_LINT])
pkg("W09-09", "W09", "Result guide sync receipt + 'Retry saving' states verified across offline/online transitions",
    "ResultScreen shows saved/saving/retry states from durable sync receipts; offline→online transition auto-completes without duplicate rows.",
    severity="P1", source_ids=["W09", "W02"], plane="cloud", deps=["W02-01"],
    write_paths=["apps/mobile/src/screens/ResultScreen.tsx", "apps/mobile/__tests__/w09ResultSyncStates.test.tsx"],
    acceptance=[mobile_jest("__tests__/w09ResultSyncStates.test.tsx", "result sync state suite passes"), MOBILE_TSC, MOBILE_LINT])
pkg("W09-10", "W09", "Long localized prices, keyboard/safe areas on Paywall and SignIn",
    "Paywall renders long localized prices (e.g. de-DE, ja-JP) without truncation; SignIn/Paywall respect safe areas and keyboard avoidance.",
    severity="P2", source_ids=["W09"], plane="cloud", deps=["W07-05"],
    write_paths=["apps/mobile/src/screens/PaywallScreen.tsx", "apps/mobile/src/screens/SignInScreen.tsx", "apps/mobile/__tests__/w09LocalizedPrices.test.tsx"],
    acceptance=[mobile_jest("__tests__/w09LocalizedPrices.test.tsx", "localized price suite passes"), MOBILE_TSC, MOBILE_LINT])
pkg("W09-11", "W09", "Native screen-matrix acceptance on simulator (XCUITest smoke over the original screen matrix)",
    "Add an XCUITest smoke target executed by mac-full-verify covering Welcome→SignIn(mock)→Home→Analyze(denied camera)→Library→Settings→Paywall with large Dynamic Type and VoiceOver enabled; screenshots per screen.",
    severity="P1", source_ids=["W09", "P0-NATIVE"], plane="mac", deps=["W09-04", "W09-05"],
    write_paths=["apps/mobile/ios/PickleSenseiUITests/", "apps/mobile/ios/PickleSensei.xcodeproj/", "scripts/mac-full-verify.sh", "tools/macos-ci/"],
    serial_groups=["ci-scripts", "release-identity"],
    acceptance=[manual("XCUITest smoke passes with per-screen screenshots", "scripts/mac-full-verify.sh --remote")], estimate_minutes=60)

# ---------------------------------------------------------------------------
# W10 — diagnostics
# ---------------------------------------------------------------------------
pkg("W10-01", "W10", "Native crash envelope scrubbing (paths, emails, tokens, media ids) with tests",
    "Implement a native + JS scrubber for diagnostic envelopes with a deny-list of PII/media identifiers and allow-list of fields; transport stays disabled.",
    severity="P0", source_ids=["W10"], plane="cloud",
    write_paths=["apps/mobile/src/diagnostics/privacy.ts", "apps/mobile/src/diagnostics/scrub.ts", "apps/mobile/src/diagnostics/sentry.ts", "apps/mobile/src/diagnostics/__tests__/"],
    acceptance=[mobile_jest("src/diagnostics", "diagnostics suites pass"), regress("PII sample survives scrubbing on base"), MOBILE_TSC, MOBILE_LINT])
pkg("W10-02", "W10", "Bounded offline diagnostic retention (size/age caps, oldest-first eviction)",
    "Diagnostic buffer on disk has hard size and age caps with deterministic eviction and corruption tolerance; never blocks the UI thread.",
    severity="P1", source_ids=["W10"], plane="cloud", deps=["W10-01"],
    write_paths=["apps/mobile/src/diagnostics/retention.ts", "apps/mobile/src/diagnostics/__tests__/"],
    acceptance=[mobile_jest("src/diagnostics", "diagnostics suites pass"), MOBILE_TSC, MOBILE_LINT])
pkg("W10-03", "W10", "Release identity tags for diagnostics derived from the immutable candidate (no runtime increment)",
    "Diagnostics envelope carries version/build/commit from a generated release identity file produced at build time; transport remains disabled by default and gated by explicit approval flags.",
    severity="P1", source_ids=["W10", "W11"], plane="cloud", deps=["W11-08", "W10-01"],
    write_paths=["apps/mobile/src/diagnostics/sentry.ts", "apps/mobile/src/config/releaseIdentity.ts", "apps/mobile/src/diagnostics/__tests__/"],
    acceptance=[mobile_jest("src/diagnostics", "diagnostics suites pass"), MOBILE_TSC, MOBILE_LINT])

# ---------------------------------------------------------------------------
# W11 — backend/operations
# ---------------------------------------------------------------------------
pkg("W11-01", "W11", "Auth failure budgets behind NAT: per-identity buckets, liveness 401 not counted as attack",
    "rateLimit.ts distinguishes liveness 401 from credential failures and shards auth-failure budgets so one NAT egress cannot lock out a venue; tests for both.",
    severity="P0", source_ids=["W11"], plane="cloud",
    write_paths=["supabase/functions/api/rateLimit.ts", "supabase/functions/api/__wf__/rateLimit_nat_budget.test.ts"],
    serial_groups=["edge-index"],
    acceptance=[EDGE_CHECK, EDGE_TESTS, regress("NAT lockout reproduced on base")])
pkg("W11-02", "W11", "Legacy provider-token bearer branch retired behind a compatibility gate with telemetry",
    "authenticate() only accepts raw provider tokens when a versioned compatibility flag allows it; counts usage; documents the removal criterion.",
    severity="P1", source_ids=["W11"], plane="cloud", deps=["W11-01"],
    write_paths=["supabase/functions/api/index.ts", "supabase/functions/api/__wf__/auth_legacy_bearer_gate.test.ts", "docs/runbooks/legacy-bearer-retirement.md"],
    serial_groups=["edge-index"],
    acceptance=[EDGE_CHECK, EDGE_TESTS])
pkg("W11-03", "W11", "pg_cron permit/lease sweeps preserve offline allocations and settled receipts",
    "Forward migration adjusting cron sweeps so offline-allocated permits are never swept as stale and settled receipts are retained; tests in the SQL matrix.",
    severity="P0", source_ids=["W11", "W04"], plane="cloud", deps=["W04-04"],
    write_paths=["supabase/migrations/20260908160000_cron_offline_allocation_safe.sql", "supabase/tests/security_regression.sql"],
    serial_groups=["sql"],
    acceptance=[RLS, regress("sweep reclaims offline allocation on base")])
pkg("W11-04", "W11", "Degraded Redis: fail-closed rate limits, Retry-After, cache bypass without 5xx storms",
    "cache.ts/rateLimit.ts behave deterministically when Upstash is unreachable (bounded timeouts, per-isolate fallback, Retry-After) with a load-style test.",
    severity="P0", source_ids=["W11", "H03-LOAD"], plane="cloud", deps=["W11-02"],
    write_paths=["supabase/functions/api/cache.ts", "supabase/functions/api/rateLimit.ts", "supabase/functions/api/__wf__/degraded_redis.test.ts"],
    serial_groups=["edge-index"],
    acceptance=[EDGE_CHECK, EDGE_TESTS])
pkg("W11-05", "W11", "Operator kill switch: deny new authorizations + withdraw release policy (owner-only SQL procedures)",
    "Forward migration adding operator procedures to deny new offline grants/permits and withdraw the active release policy; API-only RLS; runbook.",
    severity="P0", source_ids=["W11", "H08-KILL-SWITCH"], plane="cloud", deps=["W11-03"],
    write_paths=["supabase/migrations/20260908170000_operator_kill_switch.sql", "supabase/tests/security_regression.sql", "docs/runbooks/kill-switch.md"],
    serial_groups=["sql"],
    acceptance=[RLS, regress("client role cannot call operator procedures; denial blocks new grants")])
pkg("W11-06", "W11", "Edge honours kill switch: new authorizations denied, existing bounded leases documented",
    "Edge routes read the operator state and refuse new grants/permits with a typed 503-free response; documentation states disconnected leases expire at their bound.",
    severity="P0", source_ids=["W11", "H08-KILL-SWITCH"], plane="cloud", deps=["W11-05", "W11-04"],
    write_paths=["supabase/functions/api/index.ts", "supabase/functions/api/__wf__/kill_switch_routes.test.ts", "docs/RELEASE_OPERATIONS.md"],
    serial_groups=["edge-index"],
    acceptance=[EDGE_CHECK, EDGE_TESTS])
pkg("W11-07", "W11", "Compatibility matrix: old app build × new Edge, new app × old Edge (contract tests)",
    "Add contract tests asserting the Edge responses remain parseable by the previous mobile client shape and the new client tolerates the previous Edge shape (feature-detect, no crash).",
    severity="P0", source_ids=["W11", "H01-ROLLBACK"], plane="cloud", deps=["W11-06"],
    write_paths=["supabase/functions/api/__wf__/compat_matrix.test.ts", "apps/mobile/__tests__/w11EdgeCompat.test.ts", "packages/shared-types/fixtures/compat/"],
    serial_groups=["edge-index"],
    acceptance=[EDGE_TESTS, mobile_jest("__tests__/w11EdgeCompat.test.ts", "mobile compat suite passes")])
pkg("W11-08", "W11", "Immutable release identity: build number frozen before verification; Fastlane cannot increment post-verify",
    "Fastfile builds from an explicit, committed release identity (version/build) and refuses to upload if CURRENT_PROJECT_VERSION differs from the verified manifest; docs/DISTRIBUTION.md updated. Preserve historical builds 1–3 note; do NOT choose the final build number (owner action).",
    severity="P0", source_ids=["W11", "W10"], plane="cloud",
    write_paths=["apps/mobile/ios/fastlane/Fastfile", "apps/mobile/scripts/release-identity.mjs", "apps/mobile/__tests__/w11ReleaseIdentity.test.ts", "docs/DISTRIBUTION.md"],
    serial_groups=["release-identity"],
    acceptance=[mobile_jest("__tests__/w11ReleaseIdentity.test.ts", "release identity suite passes"), ("check", "cd apps/mobile && node scripts/release-identity.mjs --check", "manifest/pbxproj/app.json agree"), MOBILE_TSC, MOBILE_LINT])
pkg("W11-09", "W11", "Rollout/rollback plan: schema-compatible Edge rollback rehearsal script + migration forward-recovery notes",
    "Add a disposable-environment rehearsal script that applies migrations, deploys the previous Edge bundle shape (local emulation), runs the compat tests, and documents per-migration forward recovery.",
    severity="P0", source_ids=["W11", "H01-ROLLBACK"], plane="cloud", deps=["W11-07"],
    write_paths=["scripts/rehearse-rollback.sh", "docs/runbooks/rollback-rehearsal.md", "docs/RELEASE_OPERATIONS.md"],
    serial_groups=["ci-scripts"],
    acceptance=[("check", "scripts/rehearse-rollback.sh --disposable", "rehearsal exits 0 with compat tests executed")])

# ---------------------------------------------------------------------------
# Phase 2 hardening (H*)
# ---------------------------------------------------------------------------
pkg("H03-01", "H03", "Disposable-environment load test: k6 against local Edge emulation with Retry-After assertions",
    "Extend tools/loadtest with a k6 scenario against a locally served Edge function (supabase functions serve or in-process handler), asserting 429 Retry-After and no 5xx under degraded Redis.",
    severity="P1", source_ids=["H03-LOAD"], plane="cloud", deps=["W11-04"],
    write_paths=["tools/loadtest/", "docs/runbooks/load-test.md"],
    acceptance=[("check", "tools/loadtest/run-local.sh", "k6 run exits 0 with thresholds met; report saved")])
pkg("H04-01", "H04", "Fresh dependency advisory review with reachability analysis (workspace + mobile + Deno)",
    "Run npm/pnpm audit and deno lock review; for each advisory determine reachability in shipping code; upgrade where safe (published ≥7 days), document accepted risk otherwise.",
    severity="P1", source_ids=["H04-ADVISORIES"], plane="cloud",
    write_paths=["docs/security/ADVISORIES_2026-09-08.md"],
    acceptance=[("check", "pnpm audit --json > artifacts/advisories/pnpm.json; (cd apps/mobile && npm audit --json > ../../artifacts/advisories/mobile.json)", "audits executed and every advisory has a disposition")])
pkg("H05-01", "H05", "Third-party notices verified against a Release bundle + source map (script)",
    "Add a script that builds the Release JS bundle + source map on Linux, enumerates bundled packages and diffs against THIRD_PARTY_NOTICES; Mac binary membership recorded as a Mac-plane follow-up.",
    severity="P1", source_ids=["H05-NOTICES"], plane="cloud",
    write_paths=["apps/mobile/scripts/verify-notices.mjs", "apps/mobile/__tests__/h05Notices.test.ts", "apps/mobile/THIRD_PARTY_NOTICES.md"],
    acceptance=[("check", "cd apps/mobile && node scripts/verify-notices.mjs", "notices match bundle membership"), mobile_jest("__tests__/h05Notices.test.ts", "notices suite passes")])
pkg("H06-01", "H06", "Store copy and unsupported-claims audit script over app copy + APP_STORE_SUBMISSION.md",
    "Add a test scanning all user-facing strings and store copy for forbidden terms (Android, Google Play, guest mode, Live Court, DUPR, competitors, accuracy %, superlatives) and fix violations.",
    severity="P0", source_ids=["H06-COPY"], plane="cloud",
    write_paths=["apps/mobile/__tests__/h06ForbiddenClaims.test.ts", "apps/mobile/src/**/copy*.ts", "APP_STORE_SUBMISSION.md"],
    acceptance=[mobile_jest("__tests__/h06ForbiddenClaims.test.ts", "forbidden-claims scan passes"), MOBILE_TSC, MOBILE_LINT])
pkg("H07-01", "H07", "Edge served-bundle size and cold-start measurement script",
    "Add a script bundling the Edge function (deno bundle equivalent / esbuild) to measure served size and cold-start with `supabase functions serve` locally; record method + numbers in docs/OBSERVABILITY.md.",
    severity="P2", source_ids=["H07-COLD-START"], plane="cloud",
    write_paths=["tools/diagnostics/edge_cold_start.ts", "docs/OBSERVABILITY.md"],
    acceptance=[("check", "deno run -A tools/diagnostics/edge_cold_start.ts", "measurement produced with reproducible method")])
pkg("H09-01", "H09", "Dead/unreachable path resolution: liveCourt, 3D remnants, guest entry — deliberately retired or documented",
    "Enumerate unreachable paths (liveCourt.ts etc.), retire code that is out of v1 scope with tests migrated deliberately, and record the decision in docs/DECISIONS.md.",
    severity="P1", source_ids=["H09-DEAD-PATHS"], plane="cloud",
    write_paths=["apps/mobile/src/flow/liveCourt.ts", "apps/mobile/src/flow/liveSessionCoach.ts", "apps/mobile/src/flow/liveSessionSummary.ts", "apps/mobile/__tests__/liveCourt.test.ts", "apps/mobile/__tests__/liveSessionCoach.test.ts", "docs/DECISIONS.md"],
    acceptance=[MOBILE_FULL_JEST, MOBILE_TSC, MOBILE_LINT])

# ---------------------------------------------------------------------------
# W12 — integration acceptance (integration writer)
# ---------------------------------------------------------------------------
pkg("W12-01", "W12", "Integrated acceptance: same-candidate verify-cloud pr + full and mac-full-verify --remote",
    "Coordinator-only: on the frozen integration SHA run all three gates, read summary.json/run.json, and record evidence rows.",
    severity="P0", source_ids=["W12"], plane="docs", deps=["W01-03", "W04-04", "W07-04", "W08-04"],
    write_paths=["docs/RELEASE_READINESS_2026-09-07.md", ".devin/program/ledger/"],
    serial_groups=["docs-packet", "ci-scripts"],
    acceptance=[("check", "scripts/verify-cloud.sh --tier pr", "PR tier passes"), ("check", "scripts/verify-cloud.sh --tier full", "full tier passes"), ("check", "scripts/mac-full-verify.sh --remote", "Mac gate passes with screenshots reviewed")])
pkg("W12-02", "W12", "Final readiness packet with ledger, evidence register, verdicts and owner actions",
    "Coordinator-only: update the release readiness packet with candidate identity, findings register, gate table, ledger and separate verdicts; end with 'No release action was performed.'",
    severity="P0", source_ids=["W12", "W00"], plane="docs", deps=["W12-01"],
    write_paths=["docs/RELEASE_READINESS_2026-09-07.md", ".devin/program/"],
    serial_groups=["docs-packet"],
    acceptance=[("check", "pnpm format:check", "docs formatted")])

# ---------------------------------------------------------------------------
# External-only items (tracked, not launched)
# ---------------------------------------------------------------------------
for ext_id, title, blocker in [
    ("EXT-DEVICE", "Physical iPhone matrix (small/older + current): capture, force-quit, secure storage, attestation", "Owner runs on physical devices and supplies dated results"),
    ("EXT-STOREKIT", "StoreKit sandbox purchase/restore/refund/renewal/transfer + real webhook delivery", "Owner runs sandbox flows with real Apple IDs and RevenueCat"),
    ("EXT-LEGAL-OPS", "Age/assent, processor terms, media rights, on-call ownership, production quotas/MFA", "Owner approvals"),
    ("EXT-ROLLOUT", "Production migration/Edge rollout, signing, archive, upload, submission, merge/tag, release", "Owner performs after reviewing final evidence"),
    ("H02-BACKUP", "Authorized backup restoration into a disposable project + security matrix", "Owner authorizes dashboard backup access"),
    ("EXT-ASC-METADATA", "App Store product metadata, review screenshots, build > 3 selection", "Owner completes App Store Connect metadata"),
]:
    pkg(ext_id, "EXT", title, "Owner action; engineering prepares the exact procedure only.", severity="P0", source_ids=[ext_id], plane="external", write_paths=[], acceptance=[manual("owner-supplied dated evidence attached to the packet", "owner procedure in docs/RELEASE_READINESS_2026-09-07.md")], external_blocker=blocker)


def validate(packages: list[dict]) -> None:
    ids = [p["id"] for p in packages]
    assert len(ids) == len(set(ids)), "duplicate package id"
    idset = set(ids)
    for p in packages:
        for d in p["deps"]:
            assert d in idset, f"{p['id']} depends on unknown {d}"
            assert d != p["id"]
        assert p["acceptance"], p["id"]
        if p["plane"] != "external":
            assert p["write_paths"], p["id"]
    # dependency graph must be acyclic
    seen: dict[str, int] = {}
    bymap = {p["id"]: p for p in packages}

    def visit(i: str, stack: tuple[str, ...]) -> None:
        if seen.get(i) == 2:
            return
        assert i not in stack, f"cycle: {stack + (i,)}"
        seen[i] = 1
        for d in bymap[i]["deps"]:
            visit(d, stack + (i,))
        seen[i] = 2

    for i in ids:
        visit(i, ())


def main() -> None:
    validate(P)
    body = {
        "manifest_version": MANIFEST_VERSION,
        "repo": REPO,
        "continuation_branch": CONTINUATION_BRANCH,
        "handoff_sha": HANDOFF_SHA,
        "serial_groups": SERIAL_GROUPS,
        "serial_group_paths": SERIAL_GROUP_PATHS,
        "packages": sorted(P, key=lambda p: p["id"]),
    }
    canonical = json.dumps(body, sort_keys=True, ensure_ascii=False, indent=2) + "\n"
    body["manifest_sha256"] = hashlib.sha256(canonical.encode("utf8")).hexdigest()
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "manifest.json")
    with open(out, "w", encoding="utf8") as fh:
        fh.write(json.dumps(body, sort_keys=True, ensure_ascii=False, indent=2) + "\n")
    launchable = [p for p in P if p["plane"] not in ("external", "docs")]
    print(f"{len(P)} packages ({len(launchable)} launchable) -> {out} sha256={body['manifest_sha256'][:12]}")


if __name__ == "__main__":
    main()
