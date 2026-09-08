# Pickle Sensei — Codex production-readiness execution prompt

> Paste this entire file into Codex as the opening instruction. Work in the
> repository at branch `codex/production-continuation-20260907`, starting
> commit `5e2e0052`. Read this whole document, then `AGENTS.md` (in full),
> then `REVIEW.md`, before changing any code.

Written 2026-09-07 by the integrating session. Everything below was verified
against the repository at that commit unless it is explicitly labelled as a
claim from an earlier session's log (`recorded`), a hypothesis (`verify`), or
an action only a human can perform (`HUMAN`).

---

## 0. Your role and the definition of "done"

You are the accountable engineering lead for shipping the **iPhone 2D
Pickle Sensei app** to production. Your job has three layers, in this order:

1. **Stabilize** the merged continuation branch until every automated gate in
   §5 passes on the exact commit you intend to ship.
2. **Complete** the approved production-readiness program (§6) — the work an
   earlier session (`panoramic-sloth`) planned, partially implemented, and
   left unfinished — plus the additional hardening in §7.
3. **Produce a go/no-go packet** (§9) with evidence, and hand the human the
   exact irreversible actions that remain theirs (§8).

"Done" means: the candidate commit passes every automated gate, every
finding in §6/§7 has an evidence-backed disposition (`FIXED`, `DISPROVED`,
`ACCEPTED_RISK` with owner sign-off, or `BLOCKED_EXTERNAL` naming the human
action), and the go/no-go packet is written. **Done does not mean released.**
Submission and release are human decisions; a finished code tree with green
gates is the input to that decision, not the decision itself.

The owner wants production **today**. Treat that as urgency about the order
and pace of work, never as permission to lower a gate, skip a stage, weaken a
test, or describe unverified behaviour as verified. A launch date cannot
change whether a check passed.

---

## 1. Repository state you are inheriting (verified 2026-09-07)

| Item                             | Value                                                                                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Working branch                   | `codex/production-continuation-20260907`                                                                                                                                                                                  |
| Starting commit                  | `5e2e0052` (one squash commit on top of `origin/main` `53de40d6`)                                                                                                                                                         |
| `main`                           | `53de40d6` — untouched by this work; includes merged security PR #14 (CSP/X-Frame-Options/HSTS at Edge egress)                                                                                                            |
| Preserved history                | `devin/codex-handoff-20260907` — `6971e7e2` (raw checkpoint of the paused session) and `d3d237ef` (the conflict resolution against main). Never delete or rewrite; it is the audit trail for how conflicts were resolved. |
| Parked, out of scope             | `codex/3d-analysis-v2` at `3616560` (worktree `/Users/raunakgengiti/Pickle-Sensei-3d-v2`). **Do not merge, import, or enable any 3D estimator, viewer, storage, route or Debug entry point.**                             |
| Other worktrees                  | `Pickle-Sensei-astra-20260904`, `Pickle-Sensei-first-swing`, `Pickle-Sensei-v1-ui-merge` (already merged into main), `/private/tmp/pickle-ui-baseline-20260905-0205ea7`. Leave them alone.                                |
| Generated evidence not committed | `artifacts/` (gitignored on main), `/private/tmp/pickle-verification.1u9lbS/*` (earlier session's machine-readable handoffs — read-only reference, may be absent on a fresh machine)                                      |

### 1.1 What the continuation commit contains

Two histories were merged by hand, file by file, preserving both sides'
invariants (no wholesale ours/theirs):

- **From the paused readiness session (`98bc9b7e` → `6971e7e2`):**
  owner-generation fencing (`DataOwnerContext.generation`), the durable
  analysis run journal (`analysis_run_journal` + attempt tables), atomic
  result/practice-set/outbox commit, saved-technique-confirmation and
  original-clip retry (`originalAnalysisOperations.ts`,
  `savedTechniqueConfirmation.ts`, `AnalyzeScreen` retry UI, Library cold
  loader), auth-owned billing lifecycle (`billing/lifecycle.ts`,
  `pendingFulfilment.ts`), Keychain-backed session migration/suppression
  (`auth/sessionMigration.ts`, `authStore.ts`), `CeremonyHost` overlay
  arbitration (`flow/CeremonyHost.tsx`), full-width large-type
  `ScreenHeader`, geometry v2 (`phase-geometry-2`, `features-geometry-2`),
  ordered billing verification and durable account-deletion operations
  (Edge + migrations `20260906233000`, `20260907001500`), offline
  authorization cryptographic foundation (`offlineSignature.ts`,
  `canonicalDigest.ts`, shared `offlineAuthorization.ts`), disabled-by-default
  Sentry foundation (`src/diagnostics/*`), third-party notice generator and
  vendor privacy bundle, standalone managed-media Swift package and mobile
  deletion-operation foundation (unwired), benchmark release-gate evaluator
  (`packages/evaluation/src/benchmarkRelease.ts`).
- **From `origin/main` (151 commits, 2026-09-06/07):** canonical
  verification scripts (`scripts/verify-cloud.sh`, `scripts/mac-full-verify.sh`,
  `scripts/verify-all.sh`, `scripts/security-scan.sh` + `.gitleaks.toml`),
  the v1 restrained UI, first-swing trigger `temporal-stroke-heuristic-5`
  with `captureWithOptions({ handedness })`, classifier `stroke-heuristic-9`
  and `fusion-2`, sessionKeeper 30-second post-success floor, exact
  `camera.cancelled` classification, pose-quality pre-analysis gate,
  malformed-outbox `json_valid` guard, typed/bounded Auth transport with
  revocation tombstones and generation-fenced caches, many security
  migrations (`20260904000000` … `20260907120000`), production monitor
  workflow, Devin operating docs, PR #14 browser hardening headers.
- **Merge-specific additions:** forward migration
  `supabase/migrations/20260907133000_ordered_api_merge_integration.sql`
  (reconciles the local ordered-ticket billing protocol with main's
  webhook-reservation/`processed_at` protocol; re-revokes obsolete direct
  DML; lease-fenced claims); `scripts/verify-cloud.sh` mobile stage now also
  runs the notice-generator tests and `--check`, and the edge stage runs the
  frozen offline-crypto vectors; `supabase/functions/api/deno.json` combines
  the crypto imports with main's `nodeModulesDir`/`lock` settings; root
  `deno.lock` reconciled to `@supabase/supabase-js@2.112.4` + `jose@6.2.10`
  - `canonicalize@4.0.0`; `GuidedCaptureViewController.init(engine:
operation:handedness:)`; `TemporalStrokeDetector.strongestEvent` honours
    handedness through `completedEvents`; registry test expects
    `phase-geometry-2`, `features-geometry-2`, `stroke-heuristic-9`,
    `fusion-2`, iOS trigger v5, Android trigger v4.

### 1.2 What was verified on the continuation tree before handoff

| Check                                                                                                                                  | Result                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `apps/mobile` `tsc --noEmit` (Node 22.22.0)                                                                                            | pass, 0 diagnostics                                                  |
| Edge frozen-lock typecheck `deno check --node-modules-dir=none --frozen --lock=deno.lock supabase/functions/api/index.ts` (Deno 2.5.6) | pass                                                                 |
| `deno test` offline crypto vectors (`offlineSignature.test.ts`, `canonicalDigest.test.ts`)                                             | pass                                                                 |
| Edge `http_test.ts`                                                                                                                    | 34 passed                                                            |
| `pnpm -r test` (all 27 workspace packages, disposable Postgres 16)                                                                     | pass (SQS tests self-skip without ElasticMQ; drawtext fixture skips) |
| `pnpm --filter @pickle/analysis-pipeline test` / `@pickle/model-registry test`                                                         | 130 / 34 passed                                                      |
| `swift test` `native/vision-core`                                                                                                      | 105 passed                                                           |
| `prettier --check .`                                                                                                                   | pass after formatting merged files                                   |
| Gitleaks (staged tree, `.gitleaks.toml`)                                                                                               | no leaks                                                             |
| `__tests__/savedTechniqueConfirmationRoute.test.tsx`                                                                                   | 60 passed                                                            |
| notice generator `node --test` + `--check`                                                                                             | pass                                                                 |

### 1.3 What was NOT verified — treat as red until you run it

- **Full mobile Jest** on the merged tree. Known/likely failures are listed
  in §4.1. The last full green mobile run (262 suites / 3,667 tests) was on
  the pre-merge checkpoint, not on this tree.
- **Full Edge `deno task test`** in `__wf__/`. Known fixture debt in §4.2.
- **SQL security matrix** `./supabase/tests/run_rls_tests.sh` against the
  new forward migration `20260907133000` — **never executed**. §4.3.
- **`scripts/verify-cloud.sh --tier pr`** as a whole, and `--tier full`.
- **`scripts/mac-full-verify.sh`** (Swift/Vision/Xcode/simulator) on the
  merged native sources — the native app was not built after the merge.
- Physical-device, StoreKit sandbox, live Supabase, scientific validation:
  never verified by any session (§8).

---

## 2. Non-negotiable rules (enforced by tests, review, and the owner)

These come from `AGENTS.md` and `REVIEW.md`. Violating one is a bug in your
work even if a test goes green.

**Process**

- Never edit an applied migration; add a new `YYYYMMDDHHMMSS_description.sql`.
  Production already has `20260905190106_api_only_database_access`; do not
  renumber anything. New migrations must sort after `20260907133000`.
- Never "fix" a failing gate with `--skip`, `|| true`, `.only`/`.skip`,
  deleting a test, widening to `any`, `@ts-ignore`, `eslint-disable`, or
  editing `.gitleaks.toml`/security policy to pass. If a test pins behaviour
  that the merge deliberately superseded, change the assertion **to the new
  contract with an equal or stronger check**, and say so in the commit.
- Use `npm` inside `apps/mobile` (never pnpm there); `pnpm` everywhere else.
  Root prettier 3.9.6 is the formatting authority; `apps/mobile` pins the
  same version. Mobile verification needs Node 22 (`node:sqlite` fixtures);
  root workspace uses Node 20; Edge uses Deno **2.5.6** exactly.
- New dependencies: pinned, ≥ 7 days old, justified in the commit.
- Do not add documentation files beyond this prompt's outputs (§9) and
  updates to existing living docs (`AGENTS.md`, `docs/PRELAUNCH_CHECKLIST.md`,
  `docs/RELEASE_OPERATIONS.md`, `docs/APP_STORE_SUBMISSION.md`).
- Commit in small reviewable increments on this branch. Do not push to
  `main`, force-push, or rewrite `devin/codex-handoff-20260907`.
- Keep background work bounded (this machine's IDE renderer crashed once on
  2026-09-07 under heavy parallel load): serialize native builds, cap Jest
  workers, keep tool output compact, write evidence to files not chat.

**Product invariants (every one has a pinning test — find it before touching)**

- Onboarding before sign-in and non-skippable (`launchGate.test.ts`,
  `onboardingScreen.test.tsx`). Name required (preferred name/nickname OK).
- Durable sign-in: only refresh token + descriptor in Keychain; access and
  provider tokens never persisted; the ONLY implicit sign-out is the server
  refusing the refresh token (401/403). DB/Keychain failure must never look
  like revocation (`authDurableSession.test.ts`).
- Long-lived clients resolve bearer per request via `bearerTokenFor(...)`;
  never reconfigure stores on token rotation.
- Free ratings: two lifetime, counted through `public.lifetime_scored_count()`
  (identity ledger); `count(*) from public.shots` in a decision point is a bug.
- Billing: only the two paywall buttons reach StoreKit; no automatic
  restore/sync; `billing_entitlements` written only by the Edge fn via
  service role; entitlement `pickle_sensei_pro` (alias `premium`); prices
  are store-returned only; `effectivePremium()` respects `expires_at`.
- Edge: every non-public route calls `authenticate()` **and** the uncached
  `is_api_session_active()` check after the user rate limit; public routes
  are exactly `GET /healthz`, `/privacy`, `/terms`, `/support`,
  `POST /webhooks/revenuecat`, plus the pre-auth capability-only
  account-deletion status route. 5xx bodies generic; free text through
  `sanitizeUserText`; body reader starts at a fixed 8 KiB; webhook payloads
  never trusted for entitlements.
- API-only RLS: keep the RESTRICTIVE `api_requests_only` policy; user RPCs
  stay SECURITY INVOKER; never convert to DEFINER to bypass the gate.
- Analysis: abstention paths survive; any output-changing change bumps the
  relevant version and includes before/after benchmark evidence; return-to-
  ready is never inferred from clip end; missing phases omit dependent
  metrics; classifier confidence is never scientific approval.
- Camera: user-initiated record button; detection never gated on framing;
  no start-spot tap; preserve gesture-recognizer touch ownership; thread
  ownership on `visionQueue`; Core Animation-only overlay.
- Copy: no Android / Google Play / guest mode / Live Court / DUPR (as a
  product claim) / competitor names / accuracy percentages / superlatives in
  user-facing or store copy (`docs/APP_STORE_SUBMISSION.md`). Typography
  from `src/design/tokens.ts` roles only; restrained v1 visual language (no
  glows, particles, gradients, mascots as filler).
- Diagnostics: Sentry stays **disabled** (`runtimeConfig.diagnostics.*`
  all false, `dsn: null`) until provider, disclosure, native-privacy and
  release-identity gates are approved by the owner. No `Sentry.wrap`, no
  auto native collection, no upload token.
- Live Court, guest mode, Android production launch: out of scope.

---

## 3. How to run things (exact commands)

```sh
# Repo root. Node 20 + pnpm 10.15.1 for the workspace; Node 22 for apps/mobile.
git switch codex/production-continuation-20260907 && git pull --ff-only

# Local services (docker-compose) or a disposable initdb cluster:
docker compose up -d postgres postgres_test redis elasticmq
#   — if Docker is absent, initdb a throwaway cluster and export
#     DATABASE_URL / DATABASE_URL_TEST pointing at it (see verify-cloud.sh header).

# THE gate (byte-for-byte what CI runs):
set -o pipefail
scripts/verify-cloud.sh --tier pr 2>&1 | tee /tmp/verify-pr.log; echo "exit=${PIPESTATUS[0]}"
#   stages: deps format lint typecheck test db mobile ml scripts edge rls security
#   read artifacts/verify-cloud/<UTC>/summary.json — every stage must be "passed";
#   "skipped"/"unavailable" is NOT a pass.

# Full tier adds admin (Vite build), e2e (Playwright), release (manifest check):
scripts/verify-cloud.sh --tier full

# Apple side — the merged tree touched native/ and apps/mobile/ios, so this is mandatory:
scripts/mac-full-verify.sh                 # on the Mac
scripts/mac-full-verify.sh --remote        # from Linux: pushes HEAD to ci/mac-<branch>, waits, downloads artifacts
#   never merge ci/mac-* branches; never touch runner registration/Keychain/signing.

# Fast inner loops
(cd apps/mobile && npx tsc --noEmit && npx jest --ci --silent)          # whole mobile
(cd apps/mobile && npx jest --runInBand __tests__/<file>)               # one suite
(cd supabase/functions/api/__wf__ && deno task test)                     # edge suite
npx --yes deno@2.5.6 check --node-modules-dir=none --frozen --lock=deno.lock supabase/functions/api/index.ts
./supabase/tests/run_rls_tests.sh                                        # SQL matrix (Docker or initdb)
swift test --package-path native/vision-core                             # 105 tests
swift test --package-path native/managed-media                           # standalone media package
(cd apps/mobile && node --test scripts/generate-third-party-notices.test.mjs && node scripts/generate-third-party-notices.mjs --check)
scripts/security-scan.sh                                                 # gitleaks tree + history of HEAD
pnpm release:check                                                       # release manifest coherence

# Repeated keeper-fuzz runs: keep machine reports out of the tree
XC_OUT=/tmp/xc-out npx jest --ci __tests__/xc/xcMatrixNetworkAuth2.keeper.test.ts
```

Useful skills already in the repo (`.agents/skills/`): `pre-pr-verification`,
`full-product-verification`, `macos-verification`, `test-authentication`,
`release-verification`, `admin-web-manual-smoke`. Follow them literally.

---

## 4. PHASE 0 — Stabilize the merge (do this first, nothing else until green)

Goal: `scripts/verify-cloud.sh --tier pr` and `scripts/mac-full-verify.sh`
both `ok: true` on one commit of this branch. Every item below was
identified during the merge; each is a real, known gap.

### 4.1 Mobile Jest — known incompatibilities from the merge

Run the full suite first (`npx jest --ci --silent`), then work the list.

1. **Auth cold-restore semantics conflict.** `src/auth/authStore.ts`
   (~lines 1112–1421) now restores Keychain first and keeps a live session
   usable when SQLite fails, BUT it still honours the SQLite-backed
   suppression/replacement-generation gate (an explicitly signed-out or
   replaced credential must never resurrect). Incoming tests in
   `__tests__/authDurableSession.test.ts` (~line 632) and the
   `authHydrateMatrix.xc.test.ts` matrix assume an unconditional cold
   restore. **Resolve explicitly:** when the suppression gate is unreadable,
   restoration is _recoverably unavailable_ (retry surface, credentials kept,
   no sign-out) — not "restore anyway" and not "sign out". Update the tests
   to assert exactly that three-way distinction. Do not bypass suppression.
2. **Overlay host assumptions.** Incoming tests still assume a native
   `Modal` / padding on the old root: `__tests__/firstRunWalkthrough.test.tsx`
   (~375, 513, 529, 533), `__tests__/streakCelebration.test.tsx` (~346, 378),
   `__tests__/wf/RankUpCelebration.buttons.test.tsx` (~259). Adapt to
   `FullWindowOverlay` + `CeremonyHost` dismissal and the measured
   callout/safe-content layout; keep every accessibility assertion.
3. **Permit/fault matrices** (`__tests__/xcBehavioral/permitLifecycleMatrix.test.ts`
   and siblings, `__tests__/attack*/`, `__tests__/audit/`) predate the run
   journal. They likely need journal-aware real-SQLite fixtures
   (`testSupport/sqlite.ts`), an authenticated owner/service context, UUID
   operation ids, and the pose-quality gate. The compile-level outcome union
   was already updated; runtime behaviour was not exercised. Where an
   incoming test asserted the OLD unconditional `finally` refund on
   ambiguous commit, the NEW contract is HOLD/recover (`recovery_pending`),
   never refund — assert that instead.
4. **Malformed outbox JSON.** `originalAnalysisOperations.ts` (~390) and
   `runJournalSchema.ts` (~194, 207) now fail closed (block eligibility) on
   corrupt outbox rows; main's `db.ts` `json_valid` guard is also present.
   Make sure the new tests assert "held, not refunded, not executed".
5. Re-run `__tests__/xc/xcMatrixNetworkAuth2.keeper.test.ts` (1,500 seeds,
   25 per batch) with `XC_OUT` set; it must stay under its budget without
   any timeout inflation.

### 4.2 Edge `__wf__` — billing fixture debt (parsing passes; semantics do not)

The ordered-ticket protocol (`begin_billing_verification` →
`persist_billing_verdict` → `complete_billing_webhook`, lease-fenced by
`20260907133000`) replaced direct table writes. These fixtures still expect
the old protocol:

- `webhook.test.ts` (~187, 256, 443, 504): direct-table reservation
  expectations, deleted-row expectations, an FK-only "user missing" success.
- `adjudicate_webhook.test.ts` (~130, 198, 304): FK absence must require
  authoritative proof (ticket RPC's locked Auth-row absence or Auth admin
  `user_not_found`); fault injection still targets retired table writes.
- `attack_fix3_billing.test.ts` (~164, 603), `attack_fix5_billing.test.ts`
  (~402, 431, 472–476): update faults/lease-expiry fixtures; a stale worker
  must never receive fabricated success.
- `fix4_billing_webhook.test.ts` (~219, 283), `fix6_billing.test.ts`
  (~140–193, 313, 386): use atomic RPC snapshots and ticket ordering, not
  retired GET re-reads or provider-clock authority. Keep the
  `REVENUECAT_CLOCK_MAX_AHEAD_MS`/`_BEHIND_MS` clamp semantics and the
  `billing_entitlements_keep_newest_verdict` rule (newest
  `verification_order`, then `verified_at`).
- `xc_concurrency_harness.ts` (~704–739): still lacks the billing RPC model.

Invariants to preserve while fixing: a webhook audit row with `processed_at`
is a completion marker; a claim without `processed_at` is a pending
reservation; transient persistence failure returns retryable 503 with no
completion marker; historical "poisoned" markers are preserved for approved
reconciliation, never bulk-deleted; `BillingVerdict.verifiedAt` is normalized
before the strict RPC; client-wire dates are strict UTC `Z`, DB timestamps may
carry offsets (two validators, not one).

### 4.3 SQL — the forward migration was never executed

`20260907133000_ordered_api_merge_integration.sql` (460 lines) was written
and type-reviewed but **not applied anywhere**. Run
`./supabase/tests/run_rls_tests.sh` (it applies every migration in order,
installs hosted-like default privileges, and asserts allowed AND denied
paths, including `supabase/tests/account_deletion_operations.sql`). Expect
to iterate on: `api_private.billing_webhook_claims` lease columns,
`billing_verification_tickets.webhook_lease_token`, moved private-core
functions and their revoked EXECUTE, the `manual_action_required` Apple
credential checkpoint, and every assertion in `security_regression.sql`
that still encodes the reservation-era grants from
`20260907110000_api_audit_integration.sql`. Also verify the runner's
"upgrade from both historical states" path (`run_rls_tests.sh` ~18–53).

### 4.4 Native / Xcode

- `bundle exec pod install` in `apps/mobile/ios` (Gemfile.lock pins
  CocoaPods 1.15.2), then `scripts/mac-full-verify.sh`. Never run Debug and
  Release Xcode builds concurrently against the same Pods directory.
- Confirm the merged `GuidedCaptureViewController.init(engine:operation:handedness:)`
  and `PickleVideoCapture.presentGuidedCapture(engine:handedness:guidedId:)`
  compile and that the string-ID `ClipMediaOperation` fencing still rejects
  stale callbacks (source pins: `__tests__/nativeImportSafety.test.ts`,
  `__tests__/nativeMediaIdentity.test.ts`).
- Preserve iOS 15.1 deployment target and the approved removal of the unused
  Supabase SwiftPM products (`Package.resolved` has empty pins). Do not re-add
  them to silence a warning.
- `native/managed-media`: `swift test` must pass on macOS **and** the
  iOS-simulator run; the earlier session recorded 8/13 protection assertions
  passing and 232 preservation checks unable to observe protection metadata
  on the simulator — investigate before claiming device protection.

### 4.5 Housekeeping on this branch

- Confirm `pnpm format:check`, `pnpm lint`, `pnpm typecheck` are clean.
- Delete nothing under `artifacts/`; it is gitignored on this branch.
- Update `AGENTS.md` only with durable facts you actually verified.

**Exit criterion for Phase 0:** `verify-cloud.sh --tier pr` `ok:true` AND
`mac-full-verify.sh` `ok:true` on the same SHA, logs saved. Then open a PR
from this branch to `main` with the two summary tables in the body
(`REVIEW.md` evidence bar). Do not merge it yourself unless the owner says
so; CI + Devin Review must be green first.

---

## 5. Automated gates that must be green on the release SHA

| Gate                | Command                                                                                                                                                                    | Pass condition                                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| G-Lint/Format/Types | `scripts/verify-cloud.sh --tier pr` stages `format lint typecheck`                                                                                                         | all `passed`                                                                                                                                         |
| G-Workspace tests   | stage `test` (+`db`) with Postgres and ElasticMQ up                                                                                                                        | `passed`; the 3 SQS tests actually ran (not self-skipped)                                                                                            |
| G-Mobile            | stage `mobile` (tsc + jest + notice generator)                                                                                                                             | `passed`, 0 skipped suites                                                                                                                           |
| G-ML                | stage `ml`                                                                                                                                                                 | `passed`                                                                                                                                             |
| G-Scripts           | stage `scripts` (verify-cloud self-tests incl. bash 3.2 contract)                                                                                                          | `passed`                                                                                                                                             |
| G-Edge              | stage `edge` (deno task test + frozen check + crypto vectors)                                                                                                              | `passed`; the 7 opt-in DB tests run against a disposable Postgres via `PICKLE_AUDIT_MATRIX_PG_URL` or Docker                                         |
| G-RLS               | stage `rls`                                                                                                                                                                | `passed`, fresh install + both upgrade histories                                                                                                     |
| G-Security          | stage `security` (`security-scan.sh` tree + HEAD history)                                                                                                                  | `passed` — see note below                                                                                                                            |
| G-Admin/E2E/Release | `--tier full` stages `admin e2e release`                                                                                                                                   | `passed`; e2e authenticated-panel test ran (dev DB up)                                                                                               |
| G-Apple             | `scripts/mac-full-verify.sh`                                                                                                                                               | `summary.json ok:true`; xcresult shows intended tests executed, 0 skipped, 0 failed; swing-lab extract > 0 poses; launch summary no crash/`RCTFatal` |
| G-Distribution      | `cd apps/mobile && npm run check:distribution`                                                                                                                             | pass                                                                                                                                                 |
| G-Version triple    | `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION` in pbxproj == `APP_VERSION` in `runtimeConfig.ts` == `infra/release/release-manifest.json` == `docs/APP_STORE_SUBMISSION.md` | agree                                                                                                                                                |

**Security-scan note.** Commit `98bc9b7e` (on `devin/codex-handoff-20260907`
only, not on this branch's ancestry) contains a synthetic test constant in
`supabase/functions/api/__wf__/auth_ip_forwarding.test.ts` whose prefix
matches the custom `supabase-secret-api-key` rule. On this continuation
branch the file was reconciled with main's version; verify
`scripts/security-scan.sh` passes on HEAD's ancestry. If the fixture still
trips, rename the fixture value to a non-matching shape (it is a test
constant, not a credential);
**do not** add an allowlist entry for a real-looking key shape.

---

## 6. PHASE 1 — Complete the approved production-readiness program

This is the earlier session's approved plan (workstreams W00–W12) with
current status. Statuses: `DONE` (verified on this tree), `PARTIAL`
(software exists, not integrated/verified), `OPEN`, `BLOCKED_EXTERNAL`.
Owner decisions recorded 2026-09-06 are binding (§6.0).

### 6.0 Owner-approved product decisions (binding)

- iPhone 2D app only. No 3D, Live Court, guest entry, Android launch.
- Uncertain Auto Detect → preserve clip, ask the player to confirm the exact
  technique on the SAME capture; never substitute a drive rubric.
- Keep the 0–10 mechanics score as a separately validated output.
- Technique benchmark: ONE unified swing/form benchmark on the 2.0–8.0 DUPR
  skill scale is a launch requirement; it describes technique resemblance,
  not an official DUPR rating. **Numerical output is blocked until the
  validation gates in §6.6 pass.** Supported subsets may launch; everything
  else abstains. The old `duprEstimate.ts` linear rescale (`1 + score*0.6`)
  must be removed as a source of public numbers, not replaced by another
  linear map (§6.6 E).
- Rating-type metadata recorded for confound analysis only; no separate
  singles/doubles scores; never used at runtime.
- Offline: full on-device scoring for previously verified accounts with a
  valid local authorization. Pro lease ≤ 7 days and ≤ verified entitlement
  expiry (lifetime purchases also 7 days). Free credits preallocated to the
  device within the two-lifetime identity budget; allocation ≠ consumption;
  strict accounting — ambiguous/lost-device allocations are never auto-
  reclaimed.
- Charging: one free credit is spent only when BOTH a validated mechanics
  score AND a validated numerical benchmark range are durably delivered.
  Partial/failed/withheld results spend nothing; retries never double-charge;
  legacy spent counts stay spent.
- Local media: per-clip deletion + deletion of that account's referenced
  media on confirmed account deletion; never another owner's media.
- Diagnostics: Sentry with minimization/redaction/symbolication; no replay,
  screenshots, raw video. Disabled until approvals.
- App Store Connect listing is owner-reported ready; changed behaviour/SDK
  data/screenshots require a deliberate listing update and a new tested
  binary.

### 6.1 W01 Shared contracts — `DONE` (software), verify integration

`packages/shared-types/src/{analysisOutcome,techniqueBenchmark,offlineAuthorization,binomialBounds}.ts`
exist with tests (216+ shared tests). `isChargeableAnalysis` requires
independently verified eligibility for both outputs. **Task:** confirm every
client and Edge charging decision goes through this contract (grep for
`resultKind === 'scored'`, `overallScore !== null` used as chargeability —
those are bugs). Partial mechanics results must not trigger the legacy
scored-row charging rule anywhere: `access_state()`,
`reserve_analysis_permit()`, `apply_synced_shot()` backstop, mobile
`accessStore`.

### 6.2 W02 Lifecycle / atomic persistence / permit recovery — `DONE` (local SQLite), device `OPEN`

Run journal, owned transactions, committed marker in the result
transaction, same-operation replay, owner/origin-bound recovery, dependency-
aware outbox drain. **Tasks:** (a) after Phase 0, run the full-flow suites
(`analyzeScreenFullFlowE2E`, `runCaptureJournalIntegration`,
`originalAnalysisRetry`, `runJournal`) and keep them green; (b) physical
force-quit/relaunch evidence during scoring on a real iPhone (§8);
(c) verify the outbox drains `session.create` before `shot.sync` across
batch boundaries and that orphan `session_not_found` surfaces a repair
state rather than endless retries.

### 6.3 W03 Analysis correctness / capture evidence / import bounds — `PARTIAL`

Done: needs-technique-confirmation + saved retry UI; geometry v2 (observed
phases, no clip-end recovery, real aspect ratio); manual-stop recorded-window
evidence; import preflight/budgets; cancellable copy/extraction with
operation ids; streaming SHA-256 identity for new media; guided export
carries the cancellable operation.
**Open:** (1) conservative single-event admission for imports — expose all
fresh `TemporalStrokeDetector.completedEvents`, abstain on zero or on
multiple comparable events (or offer explicit segment selection); never pick
the loudest motion silently; (2) media-time mapping receipt (event window vs
display window vs contact proxy) versioned as `imported-…-2` rather than
silently upgrading v1 inputs; (3) durable original-clip retry entry from
Library for failed originals (only the Analyze error state has it today);
(4) iOS runtime acceptance of the byte-identity boundary; (5) device limits
for import size/pixels/frames published from measurement, keep the 60 s cap.
Acceptance tests listed in the original plan: padding invariance, FPS/rotation/
compression variants, walking/fidget/empty, multi-person/multi-stroke,
dink vs drive, wrong declared technique, manual stop after covering the
phone, >60 s import, low disk, cancel mid-copy, relocated container,
absent/corrupt sidecar.

### 6.4 W04 Server-authoritative offline grants — `PARTIAL` (crypto only)

Done: ES256 envelope verification (`offlineSignature.ts`, 152 tests),
RFC 8785 digests (`canonicalDigest.ts`, 75 tests), shared contracts and API
surface constants (`OFFLINE_AUTHORIZATION_API`: `/v1/offline/devices/challenge`,
`/v1/offline/devices/register`, `/v1/offline/wallet`, `/v1/offline/reconcile`;
results via existing `/v1/shots:sync`).
**Open — implement in this order, each with tests before code:**

1. Forward migration(s): `device registrations`, `offline allocations/
leases`, `redeemed result receipts`, `release-policy approvals`; RLS on,
   service-only mutation via narrowly granted RPCs, identity-scoped budget
   that counts legacy used + online reservations + outstanding offline
   allocations atomically under the existing `access_lock_key(uid)`.
2. Edge routes: challenge/register (bind to live account session; prefer
   Apple App Attest on physical devices, explicit `unsupported`/`simulator`
   /`transient` outcomes — never treat unverified registration as attested);
   wallet issue/refresh (Pro lease = `min(issued+7d, verified expiry)`; never
   while billing verification pending; known revocation invalidates on
   contact); reconcile (receipt binds owner/device/grant/ticket/operation/
   result digest/model+policy versions; replay returns same outcome;
   conflicting reuse rejected; receipt verification + canonical insert +
   charge in ONE transaction; do not reject valid completed work merely
   because the lease expired before upload; never reapply the 24 h online-
   permit expiry to offline results).
3. Signing keys: purpose-scoped, server-only private material (Supabase
   secret), versioned public keys with a rotation test; never in app code,
   logs, Redis, or responses.
4. SQL matrix cases: two-device races, legacy+offline budget conservation,
   spend/return races, duplicate/conflicting receipts, deletion/recreation,
   key replacement, unknown alg, bad signature, wrong aud/owner/device,
   policy mismatch, expiry, deferred sync, role/grant denials.
   Every protected route still runs the user rate limit and uncached
   `is_api_session_active()`.

### 6.5 W05 Native wallet, trusted time, offline product flow — `OPEN`

New `PickleOfflineAuthorization.swift` + RN bridge in the local pod; a
distinct `THIS_DEVICE_ONLY` Keychain service (never the session vault, SQLite
kv, or AsyncStorage); signature + owner/device/policy binding verified before
use; server time anchor + monotonic device time (`mach_continuous_time`),
explicit handling of suspend/restart/reboot/clock rollback/corrupt storage/
lost key → require online reconciliation, keep history, never sign out;
serialized wallet state machine `available → claimed(op) → spent(digest) →
acknowledged` with safe cancel only when nothing committed; crash injection at
EVERY SQLite↔wallet boundary recovers the same result or an unspent retryable
op; one shared access selector (online-authorized / offline-authorized /
downloading / expired-verification / reserved-elsewhere / upgrade-required /
unsupported-model / signed-out); zero network on the critical offline
capture→pose→mechanics→benchmark→result path; update
`src/data/offlineCapabilities.ts` (`analysis.strokeScoring` is still
`unavailable_offline`) and its tests to the real behaviour; no auto
StoreKit restore to prepare a wallet. Acceptance list in the original plan
(airplane-mode launch, 7-day boundary, lifetime lease, reboot/clock tamper,
two taps, two devices, reinstall/lost key, secure-write failure, crash at
each phase, offline account switch, delayed sync).

### 6.6 W06 Real data, unified benchmark, numerical release gates — `PARTIAL` software, `BLOCKED_EXTERNAL` science

Done: `packages/evaluation/src/benchmarkRelease.ts` evaluator with 13 gates
(`independent_evidence`, `coach_agreement`, `primary_error`,
`proxy_rating_validity`, `range_coverage`, `useful_width`,
`selective_coverage`, `gross_error`, `probability_calibration`,
`rating_type_confounding`, `perturbations`, `subgroups`,
`frozen_mechanics_fault_drill_gates`), all currently `NOT_EVALUABLE`;
inventory shows **zero qualified coaches, zero countable reviews, zero
verified DUPR observations** (`datasets/coach-review/coaches.json`).
**Software tasks you CAN do:**

- (E) Remove the public numerical DUPR rescale: `src/progress/duprEstimate.ts`
  and every consumer (Result, Home, Progress, Settings, `PlayerRankBanner`,
  `PlayerRankCard` incl. accessibility text, `RankUpCelebration`, copy
  audits). Historical records with no validated benchmark show **no**
  synthesized number. Replace with the `TechniqueBenchmark` variant display
  (`blocked_validation | unsupported | insufficient_evidence |
validated_range`) — honest, range-only, never a point estimate.
- Partition mechanics rank/progress/bests/practice sets by full scoring-
  definition comparability across SQL (`playerRank` migration), shared
  `packages/shared-types/src/playerRank.ts`, Edge `GET /v1/rank` fallback,
  Home/Library/Progress. Geometry v2 changed score meaning → new definition.
- Actual release-policy allowlist/certificate consumed by mobile AND Edge
  (`analysisReleasePolicy.ts` or similar): binds pipeline, scoring definition,
  benchmark, preprocessing, calibration, dataset/report hashes, supported
  input domain, output granularity, approvers. Missing/withdrawn policy blocks
  new numerical output; offline leases bind the policy.
- Only joint validated results spend a credit; partial results stored and
  labelled explicitly.
  **External (§8):** consented rights-cleared footage, ≥2 qualified blinded
  coaches + adjudicator, ratified protocol, frozen cohorts, then evaluation.
  Do not fabricate, do not use protected holdouts `wm-dink-01` /
  `afn-vic-rally1`, do not relabel swings with player ratings.

### 6.7 W07 Billing fulfilment and access recovery — `PARTIAL`

Done: owner-bound pending-fulfilment journal, bounded requests, backend-only
reconciliation with backoff, honest membership UI, ordered server
verification, lease-fenced webhook completion, `effectivePremium()`.
**Open:** (a) Phase 0 §4.2 fixture reconciliation; (b) renewal/expiry/refund/
grace/cancellation/transfer reconciliation end-to-end (verify both sides of a
lifetime transfer; a null-expiry old row cannot stay premium); (c) "Manage
subscription" reachable for active members outside the deletion dialog;
(d) Paywall explicit verification/pending/offline/upgrade states — never a
second purchase as recovery; (e) sandbox evidence for initial purchase,
backend failure after charge, force quit, eventual verification, renewal,
expiry, refund, restore/reinstall, transfer (§8 HUMAN on device).

### 6.8 W08 Auth restoration, deletion, consent, media lifecycle — `PARTIAL`

Done: Keychain-first restore with suppression gate, versioned replacement
generations, durable logout intent, live-session persistence retry, protected
returning-user routing, captured deletion scope, durable deletion operations
(server: request/confirm helpers, leases, authoritative Auth-delete receipt,
pre-auth capability-only status route; mobile: standalone foundation modules
`deletionOperation*.ts`, `deletionCapabilityVault.ts` — **unwired**),
standalone `native/managed-media` package — **unwired**.
**Open:** (1) §4.1 auth conflict resolution; (2) wire the mobile deletion
foundation into `ManageAccountScreen`/`deletion.ts` behind an explicit
`fetchNoRedirect` adapter, trusted origin generation, and an original-owner
maintenance coordinator that never uses `setActiveDataOwner(A)`; (3) per-clip
deletion UI (Library) + owner-bound asset inventory → journal/tombstone →
native deletion validating the Captures root (no traversal/symlink/foreign
owner) → idempotent row cleanup; crash/locked-file/low-storage leaves a
retryable journal; (4) confirmed account deletion reconciles media cleanup on
next launch even after auth is gone; ambiguous legacy files reported, never
bulk-deleted; (5) exclude new raw capture assets from cloud backup via an
approved migration; (6) update deletion confirmation, Settings storage copy,
Support/Privacy/Terms together; (7) resolve the draft 24 h capability /
7-day retention policy with the owner before deploy; (8) consent state
isolated per owner; late A responses never appear in B.

### 6.9 W09 Screen and interaction quality — `PARTIAL`

Done: local-first Home/Progress, Library error/retry + newest-load fencing,
Welcome reflow, civil-date calendar, reminder rescheduling, `CeremonyHost`
arbitration, large-type headers, rank line reflow (`7.02 /10` on one line),
paywall truthful copy, preferred-name onboarding copy, native SE3 acceptance
of ceremonies/walkthrough at normal/XXXL/AXXXXL.
**Open (from the plan's surface table + recorded findings):** largest-text
bottom-tab labels truncate; calendar heading/caption at largest text;
Result guide compact sync receipt/pending/error + report-problem access
(`ResultDetails` is registered but unreachable — decide: legacy-only or a
deliberate secondary entry); Form Review playback state on foreground,
accessible seek, controls visible at large text; Try-again bounded route
stack/players over repeated cycles; Paywall states (§6.7 d); Settings
membership row distinguishing used / device-reserved / other-device
reserved / pending fulfilment / offline-Pro until-date; Consent
restoring/offline copy; ManageAccount idempotent status + findable
management; Notifications cold-start press queued until gates ready;
overlay collision arbiter incl. review ask and native menu dismissal;
camera-denied → open Settings. Test 44 pt targets, labels/roles, VoiceOver
order, escape, safe areas, text scaling, reduced motion, contrast, long
prices, keyboard overlap. Renderer tests are not native proof — pair with
simulator XCUITest runs (harness pattern from the earlier session:
dedicated simulator, dedicated Metro port, RN ScrollView testID wraps an
`Other` node whose child is the native scroll view).

### 6.10 W10 Sentry — `PARTIAL` (foundation, disabled)

Done: `@sentry/react-native@8.24.0` pinned; strict event/envelope
minimization (`src/diagnostics/privacy.ts`), preserved RN handlers, root-
boundary hook, owner scope reset, local-only source-map composition, vendor
`SentryPrivacy.bundle`, `NSPrivacyAccessedAPITypes` DiskSpace reason
`E174.1`, Metro integration composed with `pickleAliases`.
**Open:** native-crash scrubbing proof (JS `beforeSend` does not intercept
native envelopes — use the pinned SDK's native filtering and a seeded
sensitive marker test); offline buffering bounds; actual symbolication in
an approved test project; release identity tags (bundle id, marketing
version, build number, SHA, environment, model/policy version — no user
info); Privacy/Support/Terms + App Store privacy answers + Data & consent
copy updated **before** enabling. Enabling transport, creating a Sentry
project/DSN, and uploading maps/dSYMs are HUMAN approvals (§8).

### 6.11 W11 Backend hardening, operations, compatibility, release artifacts — `PARTIAL`

Done: API-only RLS gate, uncached liveness, bounded 8 KiB body reader,
categorical Edge logging (no messages/stacks/bodies/headers/ids), typed
bounded Auth transport, `sb-forwarded-for` IP forwarding with secret key,
Redis-backed rate limits (`UPSTASH_*` set 2026-09-06), `supabase/config.toml`
pinning `verify_jwt = false`, browser hardening headers (PR #14), request
ids + access log, production monitor workflow (readiness probe gated by
`PRODUCTION_MONITOR_READINESS`).
**Open:** shared-NAT auth-failure collateral throttling (separate absent/
malformed auth from expensive invalid tokens; test a club Wi-Fi cohort with
one failing client); liveness-401 accounting; legacy provider-token
`authenticate()` branch retirement criteria (it must be REMOVED once no old
builds are in the field — define the gate); cron success/terminal permit
consistency; offline allocations modelled so stale-online-permit sweeps
cannot reclaim them; Redis degraded operation verified; actual model/scoring
release approval enforced in the Edge path (§6.6); staged additive rollout
plan for `20260906233000` + `20260907001500` + `20260907133000` + Edge
(drain old writers → migrate → deploy → PostgREST reload; never one half
alone; `supabase db push --dry-run --include-all` first); replace release-
manifest placeholders (`production=tbd`, static build 1) with the real
candidate relationship so `pnpm release:check` validates evidence, not
strings; reconcile stale docs/tests asserting superseded auth/offline/
scoring behaviour; keep archived reports labelled historical.

### 6.12 W12 Final acceptance matrix — `OPEN`

Everything in §5 green on the release SHA, plus the physical-device matrix
in §8, plus the go/no-go packet in §9.

---

## 7. PHASE 2 — Additional hardening for a launch that does not come back to bite

Beyond the inherited plan, do these before calling the candidate ready:

1. **Rollback rehearsal.** Capture a known-good Edge artifact and the
   schema-compatible predecessor; document (in `docs/RELEASE_OPERATIONS.md`)
   the exact rollback for each of the three unapplied migrations. A rollback
   must not drop RLS, rewrite ledgers, erase consent, or reinterpret results.
2. **Backup/restore proof.** `BLOCKED_EXTERNAL` until the owner grants
   dashboard access; write the exact minimal human steps (create a disposable
   project, restore latest backup, run the RLS matrix against it).
3. **Load test dry run** against a disposable project only
   (`tools/loadtest/`, k6): bootstrap/refresh/permit/sync/rank at the
   expected launch concurrency; confirm 429/Retry-After behaviour and Redis
   fallback. Never against production without written approval.
4. **Dependency advisories.** Re-run `npm audit`/`pnpm audit` and record
   reachability per finding (the earlier audit: 9 high / 11 moderate labels
   across 4 packages, none attacker-reachable in the released app, none from
   Sentry). No forced downgrade or override without justification.
5. **Third-party notices for the actual binary.** After the final Release
   build, run `node scripts/generate-third-party-notices.mjs --check-app
<PickleSensei.app> --bundle-map <fresh Release source map>`; the committed
   `ThirdPartyNotices.txt` is source-coverage evidence, not binary clearance.
   Font OFL and splash MP4 rights evidence are HUMAN items.
6. **Store-copy scan** (release-verification skill §6): grep the diff since
   the last release for forbidden terms; inspect each hit.
7. **Edge cold-start budget.** Measure `index.ts` bundle size and cold-start
   latency on `supabase functions serve`; the file grew by ~1.5k lines this
   merge. Split modules if cold start regresses materially.
8. **Kill switch.** Implement the operator path to deny new online
   authorizations/renewals and withdraw release policies (already required by
   W11; make it real and test it) — offline leases stay bounded but not
   instantly revocable, and the docs must say so.
9. **Remove dead paths** that are now unreachable by design only if their
   tests are migrated deliberately (e.g. `ResultDetails` decision in §6.9).

---

## 8. HUMAN-only actions (never do these yourself; list them precisely in the packet)

- Apply migrations to `ucqnaiwqwjtgvlduiuib` (`supabase db push --include-all`),
  deploy the Edge function (`supabase functions deploy api --no-verify-jwt`),
  set/rotate secrets, change Auth dashboard settings.
- Create/configure Sentry project, DSN, retention, region, alerts; upload
  source maps/dSYMs; approve enabling diagnostics transport and native
  collection; approve the revised privacy disclosures.
- Provision TestFlight builds (`bundle exec fastlane beta`), App Store archive
  (`fastlane release`), App Review submission, release, territory changes,
  Family Sharing/Made for Kids/external TestFlight (all forbidden to enable).
- StoreKit sandbox purchase/restore/refund/transfer runs with Sandbox Apple
  Accounts; RevenueCat webhook delivery tests; RevenueCat dashboard changes.
- Physical iPhone matrix (small/older + current device, min/current OS):
  fresh Apple/Google sign-in incl. private relay, returning restore, camera
  front/rear + zoom + tripod framing, auto trigger, manual stop after walking
  to the phone, ≥10 capture→result→replay→try-again cycles with thermal/
  memory observation, offline previously-verified launch, force-quit during
  scoring, per-clip and account deletion, notifications, VoiceOver, largest
  Dynamic Type.
- Scientific program: recruit/provision qualified coaches, acquire consented
  rights-cleared footage with verified rating metadata, ratify the protocol,
  approve the supported subset. No coach, label, or metric may be invented.
- Legal/ops: age-eligibility policy (Terms say 13+, no age assurance),
  Terms-version assent, DPAs, processor custody, incident on-call owner,
  backup/restore drill, Supabase plan/quotas/MFA, DUPR non-affiliation wording,
  font/splash rights evidence.
- Merging the PR to `main` and tagging `v<MAJOR.MINOR.PATCH>-build.<BUILD>`.

When you hit one of these, stop that thread, record `BLOCKED_EXTERNAL` with
the exact minimal human step, and continue independent work.

---

## 9. Required outputs

Keep a **findings register** (append-only, in your PR description or in
`docs/RELEASE_READINESS_<date>.md` following the existing
`docs/RELEASE_READINESS_2026-09-03.md` format): every item in §4, §6, §7
with `status`, severity, source, reproduction or disproof, changed files,
regression tests, residual risk, evidence path. Two fields per item —
implementation status (`OPEN | IN_PROGRESS | FIXED | DISPROVED |
ACCEPTED_RISK | BLOCKED_EXTERNAL`) and evidence grade (`SOURCE_VERIFIED |
AUTOMATED_LOGIC | LOCAL_INTEGRATION | PHYSICAL_DEVICE | LIVE_SERVICE |
SCIENTIFIC_VALIDATION`). Never promote a grade you did not earn.

**Go/no-go packet** (final deliverable) must contain, in this order:

1. Candidate identity: commit SHA, dirty-tree status, app version/build,
   `Podfile.lock` + `Package.resolved` + `deno.lock` hashes, Edge version,
   migration list, model/scoring/policy versions.
2. Full findings register with no missing IDs.
3. Gate table (§5) with the `summary.json` stage rows and the Mac run URL.
4. Device screen/flow matrix — what ran on a simulator vs a physical device,
   with artifact paths (no private footage or identities).
5. Financial/offline conservation and failure-recovery evidence.
6. Scientific status: honest `BLOCKED_EXTERNAL` with the acquisition plan, or
   the report if data arrived.
7. Privacy/security/Sentry/backup/webhook/rollback evidence + remaining
   operator actions.
8. Updated living docs and the list of historical documents that are NOT
   current proof (`docs/HANDOFF_V3.md`, `docs/STATUS_BOARD.md`,
   `docs/SECURITY_CERTIFICATION_2026-08-30.md`, `docs/prompts/astra-*.md`).
9. Six separate verdicts: software completion, scientific validation, device
   readiness, operational readiness, submission readiness, public-release
   readiness.
10. The exact next owner-approved action. End with the sentence:
    **"No release action was performed."**

---

## 10. Working style

- Reproduce or measure → root cause → focused change → verify the failure is
  gone and legitimate behaviour still works → review the diff. Write the
  failing test first where the infrastructure exists.
- Prefer editing existing modules over new files; when a new boundary is
  justified (§6.4–6.8), name it like its neighbours.
- Preserve existing code comments; do not add narrative comments.
- Bounded parallelism: at most two background workers, exclusive file
  ownership per worker, one integrator (you) owns shared contracts and the
  final packet. Serialize anything that touches Xcode or the simulator.
- Brief progress notes at each workstream boundary: what changed, exact
  files, tests + results, evidence grade, blockers, decisions needed.
- If a requirement here conflicts with `AGENTS.md`, `AGENTS.md` wins for
  product invariants and this document wins for sequencing; say so when it
  happens and record the decision.

Start now with Phase 0 §4.1: run the full mobile Jest suite on
`codex/production-continuation-20260907` and post the failing-suite list
before changing anything.
