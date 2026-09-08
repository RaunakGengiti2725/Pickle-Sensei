# Pickle Sensei production-readiness working packet — 2026-09-07

This is an active findings register, not a release approval. The scope is
`docs/prompts/codex-production-readiness.md` §§4–9, expressly adopted by the
owner after the initial attachment review. Historical production claims are
not current evidence for this candidate.

## 1. Candidate identity

- Branch: `codex/production-continuation-20260907`.
- Session starting commit: `a089aee3`; inherited implementation: `5e2e0052`.
- Final candidate SHA, clean-tree identity, lockfile hashes and gate summaries:
  pending completion. Intermediate focused runs do not certify a final SHA.
- Current source version/build: iOS `1.0` / `1`; release manifest also records
  build `1` and placeholder environments. This needs reconciliation with
  previously uploaded builds before an archive can be submitted.
- No signing, production mutation, upload, submission, main merge or release
  has been performed in this session.

## 2. Findings register

Statuses distinguish implementation from evidence. `BLOCKED_EXTERNAL` names
an owner action; it does not waive that gate. Unfinished software remains
`OPEN` or `IN_PROGRESS`. No owner risk acceptance has been assumed. All items
below are release-blocking until their required disposition is substantiated;
individual severity/refinement is recorded in the dated entries below.

| ID              | Implementation   | Evidence grade    | Finding / next proof                                                                                                                                                                                  |
| --------------- | ---------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-MOBILE       | IN_PROGRESS      | LOCAL_INTEGRATION | Full baseline: 41 failing suites, 524 failing tests. Fixture reconciliation and genuine auth/profile fixes underway.                                                                                  |
| P0-EDGE         | FIXED            | LOCAL_INTEGRATION | 735 tests, 31 steps, zero failures/ignored with disposable PostgreSQL; frozen Deno and 227 crypto vectors pass.                                                                                       |
| P0-SQL          | FIXED            | LOCAL_INTEGRATION | Fresh install plus production, upstream and ordered upgrade histories pass, including stale billing lease/ticket rejection.                                                                           |
| P0-NATIVE       | OPEN             | SOURCE_VERIFIED   | Merged app/native sources have not yet passed the canonical Apple gate in this session.                                                                                                               |
| P0-HOUSEKEEPING | IN_PROGRESS      | AUTOMATED_LOGIC   | Focused changed-file checks pass; full canonical checks remain.                                                                                                                                       |
| W00             | IN_PROGRESS      | SOURCE_VERIFIED   | Program adopted after owner explicitly requested completion for App Store publication; iPhone 2D scope and human release boundary preserved.                                                          |
| W01             | OPEN             | SOURCE_VERIFIED   | Shared joint chargeability contract exists; every production charging boundary still needs integration verification.                                                                                  |
| W02             | IN_PROGRESS      | LOCAL_INTEGRATION | Real SQLite journal and 54 mounted full-flow scenarios pass; dependency outbox proof and physical force-quit matrix remain.                                                                           |
| W03             | IN_PROGRESS      | LOCAL_INTEGRATION | Original retry and byte-boundary logic verified locally; import admission/time mapping, Library entry and native acceptance remain.                                                                   |
| W04             | OPEN             | AUTOMATED_LOGIC   | 227 crypto vectors pass; offline backend grants, allocation accounting, reconciliation and key rotation integration remain.                                                                           |
| W05             | OPEN             | SOURCE_VERIFIED   | Native wallet/trusted time and complete offline product flow require implementation.                                                                                                                  |
| W06-SOFTWARE    | OPEN             | SOURCE_VERIFIED   | Remove synthesized benchmark numbers; full scoring-definition comparability and enforceable release policy remain.                                                                                    |
| W06-SCIENCE     | BLOCKED_EXTERNAL | SOURCE_VERIFIED   | Qualified coach registry is empty. Owner must supply consented evaluation footage, verified metadata, qualified blinded reviews/adjudication and ratified protocol. No numerical validation asserted. |
| W07             | IN_PROGRESS      | LOCAL_INTEGRATION | Ordered billing/lease tests pass; fulfillment UI, management entry and complete transfer/renewal paths still under review.                                                                            |
| W08             | IN_PROGRESS      | LOCAL_INTEGRATION | Auth race and corrupt-profile recovery being fixed; deletion foundation/media wiring and owner cleanup remain.                                                                                        |
| W09             | IN_PROGRESS      | AUTOMATED_LOGIC   | 471 UI tests pass against current accessible overlays/Library states; complete surface and native screen matrix remains.                                                                              |
| W10             | OPEN             | SOURCE_VERIFIED   | Diagnostics stay disabled; native envelope scrubbing, buffer bounds and release tags remain.                                                                                                          |
| W11             | OPEN             | SOURCE_VERIFIED   | Auth/NAT/cron/degraded Redis, policy operator path, rollout compatibility and real candidate manifest remain.                                                                                         |
| W12             | OPEN             | SOURCE_VERIFIED   | All gates must run again on the final candidate; no final acceptance claimed.                                                                                                                         |
| H01-ROLLBACK    | OPEN             | SOURCE_VERIFIED   | Rehearse schema-compatible Edge rollback and document migration-specific forward recovery.                                                                                                            |
| H02-BACKUP      | BLOCKED_EXTERNAL | SOURCE_VERIFIED   | Owner must authorize dashboard backup access and restore the latest backup into a disposable project; then run the security matrix.                                                                   |
| H03-LOAD        | OPEN             | SOURCE_VERIFIED   | Disposable load dry run and Retry-After/degraded Redis evidence required.                                                                                                                             |
| H04-ADVISORIES  | OPEN             | SOURCE_VERIFIED   | Fresh workspace/mobile dependency audit and reachability assessment required.                                                                                                                         |
| H05-NOTICES     | OPEN             | SOURCE_VERIFIED   | Actual Release binary and fresh bundle-map notice check required; font/splash rights need owner evidence.                                                                                             |
| H06-COPY        | OPEN             | SOURCE_VERIFIED   | Scan complete candidate diff and store copy for forbidden/unsupported claims.                                                                                                                         |
| H07-COLD-START  | OPEN             | SOURCE_VERIFIED   | Measure Edge served bundle and startup latency locally.                                                                                                                                               |
| H08-KILL-SWITCH | OPEN             | SOURCE_VERIFIED   | Implement/test denial of new authorizations and policy withdrawal; bounded offline leases cannot be instantly revoked.                                                                                |
| H09-DEAD-PATHS  | OPEN             | SOURCE_VERIFIED   | Decide ResultDetails entry and deliberately migrate tests for retired paths.                                                                                                                          |
| EXT-DEVICE      | BLOCKED_EXTERNAL | SOURCE_VERIFIED   | Owner runs physical iPhone matrix on small/older and current devices and provides dated results.                                                                                                      |
| EXT-STOREKIT    | BLOCKED_EXTERNAL | SOURCE_VERIFIED   | Owner runs sandbox purchase/restore/refund/transfer and RevenueCat delivery checks.                                                                                                                   |
| EXT-LEGAL-OPS   | BLOCKED_EXTERNAL | SOURCE_VERIFIED   | Owner approves age/assent, processor/legal terms, media rights, on-call ownership and production quotas/MFA.                                                                                          |
| EXT-ROLLOUT     | BLOCKED_EXTERNAL | SOURCE_VERIFIED   | Owner approves and performs coordinated production migration/Edge rollout, signing/upload/submission, merge/tag and release after reviewing final evidence.                                           |

### Evidence entries (append-only)

- **P0-MOBILE baseline, P1:** `artifacts/readiness-20260907-baseline/mobile.json`
  and `mobile-failures.md`: 266 passing suites, 41 failing suites; 5,260 passed,
  524 failed, 6 preexisting skipped tests. Run used Node 22.22.0 and two workers.
  The failing-suite list was shared before changes. Status: IN_PROGRESS.
- **P0-SQL, P1, FIXED / LOCAL_INTEGRATION:** commit `cac7f3a1` changes only
  `supabase/tests/security_regression.sql`. Updated concurrency fixtures to
  carry claimed lease tokens; added stale lease/begin/persist/complete and
  cross-ticket denial assertions. `rls-lease-fencing.log` passes fresh,
  `production_20260906`, `upstream_20260906`, and `ordered_20260907` histories.
  Residual: production rollout remains owner-controlled; no migration edited.
- **P0-EDGE, P1, FIXED / LOCAL_INTEGRATION:** commit `2ecb72e4` updates 13
  Edge test/harness files to ordered tickets, lease fencing, uncached session
  checks, categorical logs and foreign-credential preservation. Full database
  run: 735 passed, 31 steps, zero ignored. Frozen Deno 2.5.6 checks and 227
  crypto vectors pass. Exact changed files/hashes and logs:
  `artifacts/readiness-20260907-baseline/edge-completion.json`.
  Residual: no live Supabase/RevenueCat evidence; final candidate rerun required.
- **W09/P0-MOBILE UI fixture reconciliation, P2, FIXED / AUTOMATED_LOGIC:**
  commit `2e4c5b12`, 18 mobile test files. Current overlay host, measured layout,
  uncapped text, Library error/retry and all pending rows replace superseded
  assumptions. 471 tests pass, ESLint/Prettier pass; evidence:
  `mobile-ui-final.json`, `mobile-ui-lint.log` in the baseline artifact folder.
  Residual: renderer tests do not prove native geometry or VoiceOver order.
- **W02/W03 focused mounted flow, P1, IN_PROGRESS / LOCAL_INTEGRATION:**
  54 full-flow tests pass after fixing stale accessibility selectors and the
  gated sidecar read fixture. Evidence: `full-flow-fixtures.json`. These tests
  exercise actual SQLite and analysis code behind typed native seams; native
  camera/device behavior remains unverified here.
- **W02/P0-MOBILE permit recovery, P1, FIXED / LOCAL_INTEGRATION:**
  commit `da337019` reconciles eight permit suites and the shared capture
  harness with original-operation recovery and actual SQLite transactions.
  All 192 tests pass. Exact files and hashes:
  `artifacts/readiness-20260907-baseline/permit-mobile-completion.json`.
  Residual: physical process-death and offline wallet boundaries remain open.
- **W08/P0-MOBILE auth and profile recovery, P1, FIXED / LOCAL_INTEGRATION:**
  commit `cd58d072` coalesces one live auth restoration across the startup
  deadline and prevents queued hydration from undoing explicit sign-out.
  Malformed local profiles recover through pending answers or canonical data;
  failed replacement retains the original bytes and pending intent.
  Nineteen distinct suites / 482 tests and 8,021 matrix rows pass; no known-
  deviation allowlists remain in these auth/store/launch matrices. Manifest:
  `artifacts/readiness-20260907-auth/completion-manifest.json`.
  Commit `a6147928` further rejects blank answers, unsupported handedness and
  unknown checkpoints, with five reproduced-before/fixed-after regressions
  and additional corrupt-domain seeds. The supported checkpoint fixtures
  replace invalid historical strings while retaining server-owned focus.
  Evidence: `profile-domain-before.json`, `profile-cleanup-final.json`
  (101 tests, including store and launch matrices). Residual: physical session
  restoration and account deletion integration still require separate proof.
- **W02/W03/P0-MOBILE capture and locale regressions, P1/P2, FIXED /
  LOCAL_INTEGRATION:** commit `050e7add` updates eleven test/harness files to
  current durable original operations. The actual pipeline commits session,
  result and outbox in one SQLite transaction even when the screen leaves
  before publication; retired screens cannot navigate or start another
  owner's sync. Extracted valid guided-media fixture is shared with the 54
  full-flow cases. Timezone assertions now run in actual child-process zones
  on every invocation, replacing six conditional skips. Intermediate full
  mobile evidence: `mobile-full-fixed.json`, 307 suites / 5,807 tests, zero
  failures or skips. Two renderer teardown warnings were then fixed and
  verified absent in `profile-cleanup-final.log`. Mobile typecheck and owned
  ESLint pass. Residual: this intermediate run is not the frozen candidate
  gate; historical billing-recovery findings outside fixture scope remain.

## 3. Canonical gates

Full PR/full/Apple gate summaries on one candidate are pending. Individual
focused successes above must not be reported as a whole-product pass.

## 4. Screen and flow evidence

Renderer/logic evidence is listed above. Dedicated simulator and physical
matrices are pending; no physical-device grade has been earned.

## 5. Financial/offline conservation and recovery

Online journal and billing evidence exists locally. Full offline allocations,
native wallet, policy binding and delayed-receipt reconciliation remain open.

## 6. Scientific validation

No qualified-coach registry entries were present at the session baseline.
No scientific validation or countable coach review was fabricated. The owner
has been asked for external dataset/review locations. Numerical benchmark
release remains blocked until the specified protocol and gates pass.

## 7. Privacy, security and operator evidence

The local SQL security matrix passes. Diagnostics remain disabled. Native
privacy, backup restoration, live webhook/device evidence, and coordinated
rollout approval are still required.

## 8. Living documents and historical evidence

Updates to release operations, prelaunch checklist, store submission and
AGENTS.md will follow verified changes. `docs/HANDOFF_V3.md`,
`docs/STATUS_BOARD.md`, `docs/SECURITY_CERTIFICATION_2026-08-30.md`,
`docs/prompts/astra-*.md`, and `docs/RELEASE_READINESS_2026-09-03.md` are
historical context, not proof of this candidate.

## 9. Separate verdicts

| Area                     | Current verdict  |
| ------------------------ | ---------------- |
| Software completion      | IN PROGRESS      |
| Scientific validation    | BLOCKED_EXTERNAL |
| Device readiness         | NOT VERIFIED     |
| Operational readiness    | NOT VERIFIED     |
| Submission readiness     | NO-GO            |
| Public-release readiness | NO-GO            |

## 10. Next action

Continue authorized software stabilization and integration. The final packet
will name the exact owner-approved rollout/submission action only after the
candidate and remaining external gates are concrete and reviewable.

No release action was performed.
