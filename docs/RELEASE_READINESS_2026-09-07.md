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
- No distribution signing, production mutation, upload, submission, main merge
  or release has been performed in this session. Local simulator builds use
  Xcode ad-hoc signing so Keychain behavior can be tested.

## 2. Findings register

Statuses distinguish implementation from evidence. `BLOCKED_EXTERNAL` names
an owner action; it does not waive that gate. Unfinished software remains
`OPEN` or `IN_PROGRESS`. No owner risk acceptance has been assumed. All items
below are release-blocking until their required disposition is substantiated;
individual severity/refinement is recorded in the dated entries below.

| ID              | Implementation   | Evidence grade    | Finding / next proof                                                                                                                                                                                  |
| --------------- | ---------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-MOBILE       | IN_PROGRESS      | LOCAL_INTEGRATION | Baseline repaired to 307 suites / 5,807 tests passing; first frozen cloud run had one guarded child-process timeout. Whole-gate rerun required.                                                       |
| P0-EDGE         | FIXED            | LOCAL_INTEGRATION | 735 tests, 31 steps, zero failures/ignored with disposable PostgreSQL; frozen Deno and 227 crypto vectors pass.                                                                                       |
| P0-SQL          | FIXED            | LOCAL_INTEGRATION | Fresh install plus production, upstream and ordered upgrade histories pass, including stale billing lease/ticket rejection.                                                                           |
| P0-NATIVE       | OPEN             | SOURCE_VERIFIED   | Real Swift/macOS/iOS tests and Release build pass; unsigned launch exposed unusable Keychain. Xcode ad-hoc simulator correction reaches Welcome; final whole-gate rerun remains.                      |
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
| H05-NOTICES     | OPEN             | SOURCE_VERIFIED   | Fresh Release binary/map membership and bundled resources pass; final candidate rerun and owner font/splash rights evidence remain.                                                                   |
| H06-COPY        | OPEN             | SOURCE_VERIFIED   | Scan complete candidate diff and store copy for forbidden/unsupported claims.                                                                                                                         |
| H07-COLD-START  | OPEN             | SOURCE_VERIFIED   | Measure Edge served bundle and startup latency locally.                                                                                                                                               |
| H08-KILL-SWITCH | OPEN             | SOURCE_VERIFIED   | Implement/test denial of new authorizations and policy withdrawal; bounded offline leases cannot be instantly revoked.                                                                                |
| H09-DEAD-PATHS  | OPEN             | SOURCE_VERIFIED   | Decide ResultDetails entry and deliberately migrate tests for retired paths.                                                                                                                          |
| EXT-DEVICE      | BLOCKED_EXTERNAL | SOURCE_VERIFIED   | Owner runs physical iPhone matrix on small/older and current devices and provides dated results.                                                                                                      |
| EXT-STOREKIT    | BLOCKED_EXTERNAL | SOURCE_VERIFIED   | Owner runs sandbox purchase/restore/refund/transfer and RevenueCat delivery checks.                                                                                                                   |
| EXT-LEGAL-OPS   | BLOCKED_EXTERNAL | SOURCE_VERIFIED   | Owner approves age/assent, processor/legal terms, media rights, on-call ownership and production quotas/MFA.                                                                                          |
| EXT-ROLLOUT     | BLOCKED_EXTERNAL | SOURCE_VERIFIED   | Owner approves and performs coordinated production migration/Edge rollout, signing/upload/submission, merge/tag and release after reviewing final evidence.                                           |

### Evidence entries (append-only)

- **W06(E) public rescale removal, P1, FIXED / AUTOMATED_LOGIC:** Removed
  `duprEstimate.ts` and every public consumer, including accessibility labels.
  Historical mechanics and rank numbers no longer synthesize a benchmark.
  Result explicitly shows that a benchmark is unavailable; the replacement
  formatter permits only a validated interval matching independently supplied
  release lineage, uncertainty, width, support and boundary granularity. This
  predicate is shared with `isChargeableAnalysis`, not another numeric map.
  Superseded rescale assertions now reject scalar and unapproved output while
  preserving approved interval precision and native text-scaling assertions.
  Evidence: `w06-public-benchmark.json`, 10 mounted/pure suites, 237 tests,
  zero skipped; shared regression suite 302 tests passes. Residual: no approved
  scientific policy or benchmark model exists, and positive saved-outcome
  publication, release-authority integration, full comparability and native UI
  evidence remain open. This removes an invalid public number; it does not
  certify a replacement model.

- **Sequencing update, owner instruction:** Independent Phase 1 implementation
  proceeds while remaining Phase 0 failures are investigated. Acceptance gates,
  scientific requirements and human release boundaries are unchanged.
- **W02 sync recovery, P1, FIXED / LOCAL_INTEGRATION:** The production outbox
  finds session parents beyond its fifty-row batch, durably rotates attempted
  batches to prevent starvation, reconstructs missing sessions only from the
  original owner's valid metadata, and holds unrecoverable reads for explicit
  repair. The actual scored and unscored Result routes offer owner-generation-
  fenced “Retry saving”; original media/results remain intact. Entire shot/trial
  acknowledgements must be complete, unique and disjoint before any receipt or
  deletion; conflicting duplicate identities are held across batch boundaries.
  The retired F5 invalid-ACK exception was removed and former endless-orphan
  assertions replaced with stronger preservation/recovery checks.
  `artifacts/readiness-20260907-baseline/w02-focused-final.json`: 13 suites,
  684 tests pass, zero skipped, including mounted full analysis flows, journal,
  original retry, runtime storms and 31 real SQLite recovery cases. Red evidence:
  `w02-sync-red.json` (10 failures), `w02-ui-red.json` (4),
  `w02-recovery-red.json` (3 further defects). Mobile typecheck, owned ESLint,
  Prettier and diff checks pass. Residual: physical process-death/native UI
  proof and the same-final-commit full product gates remain required; W02's
  overall device acceptance is not complete.

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

- **P0-MOBILE/P0-NATIVE frozen attempt, P1, IN_PROGRESS:** candidate
  `1b70eddc0d66835a44633ccab659eb2e39812a43` began clean. Command:
  `scripts/verify-all.sh --cloud-args '--tier full --fresh-deps'`.
  `phase0-full-cloud/summary.json` records 14/15 stages passing. The sole
  failure was the five-second subprocess deadline in the Metro ICNS guard
  test; 5,806 other mobile tests passed. Four diagnostic subprocesses then
  rejected the bytes immediately after 135–242 ms startup, and the unchanged
  focused suite passed. The separate Mac fresh install reran all 307 suites /
  5,807 tests successfully. This does not erase the cloud failure or prove
  its timing cause. Entire combined run remains FAILED.
  `phase0-full-mac/summary.json` records all three Mac stages passing:
  Vision 105 and managed-media 37 tests on both platforms, real pose
  extraction, Release app build, and 25-second crash-free launch.
  **Visual review invalidated a healthy-launch interpretation:**
  `launch/launch-settled.png` showed secure-storage-unavailable and its log
  recorded OSStatus -34018 (missing simulator entitlements). The previous
  gate detected crashes only. No auth safeguard was relaxed.
  CocoaPods also normalized comments/empty sections in the Xcode project;
  commit that generated output before the next clean candidate run.
- **H05-NOTICES, P1, IN_PROGRESS / LOCAL_INTEGRATION:** fresh built Release
  app passed `generate-third-party-notices.mjs --check-app` with explicit
  source-map path and both expected SHA-256 hashes. Evidence:
  `artifacts/readiness-20260907-baseline/phase0-binary-notices.log`.
  Bundle hash `8745c4c9bd8c72cb7d4657d64183aa0cdf0d314b7ddcb4b1ed3ad304713214ad`;
  map hash `e41672168e2123d16987c9ba091440d9674b48a2b32d3bbf1673dbed5831bf39`.
  This proves membership/resource delivery for that pair, not rights,
  distribution signing or App Store clearance. Recheck the final binary.

- **P0-NATIVE launch verification, P1, FIXED / LOCAL_INTEGRATION:** Xcode's
  explicit ad-hoc simulator build restores the simulated application identity
  without a distribution certificate, provisioning update or archive. The
  unchanged Release app reaches Welcome with its primary and returning-user
  actions, stays alive 25 seconds, and logs zero Keychain entitlement errors.
  Evidence: `keychain-xcode-probe.xcresult`,
  `keychain-xcode-launch-verified/launch-settled.png` and
  `keychain-xcode-launch-verified/launch-summary.txt` under the baseline
  artifact directory. The canonical launch gate now fails missing Keychain
  entitlements and failed screenshots; relative artifact paths are resolved
  before invoking simctl. The orchestration regression requires a simulator
  destination and explicit certificate-free identity. Self-test log:
  `mac-launch-runtime-selftest.log`. Residual: this is fresh signed-out launch
  evidence, not physical sign-in/restore or complete native screen acceptance.
  The corrected whole gate must still run on a clean committed tree.

- **P0 second frozen attempt, P1, IN_PROGRESS / LOCAL_INTEGRATION:**
  candidate `c71ff6e05a2ce2860daba0ccb7c3f421449dca0a`, same complete fresh-deps
  command. Cloud again passed 14/15 stages; mobile had two failures / 5,805
  passes. Mac environment and native packages passed; its mobile rerun had
  one failure / 5,806 passes, so this run did **not** reach app build/launch.
  Both planes rejected the CocoaPods-omitted optional packageReferences list;
  cloud also repeated the ICNS subprocess timeout. Summary/log hashes:
  `artifacts/readiness-20260907-baseline/phase0-r2-completion.json`.
  Guard diagnostics remain an investigation: normal warm probes and the Mac
  pass do not identify why the cloud subprocess exceeded its unchanged
  five-second total deadline.
- **P0 native project fixture, P2, FIXED / AUTOMATED_LOGIC:**
  `flow-app-store-compliance-ios-config.test.ts` now accepts an absent empty
  optional package-reference list, as CocoaPods emits. All independent
  package-object, product-reference, framework-link and empty-lockfile
  assertions remain. Focused 32 tests, owned ESLint/Prettier pass.
  Evidence: `cocoapods-project-normalization-test.json` and sibling logs.
  Residual: new whole candidate gate required.
- **W11 / submission inventory, P1, OPEN / LIVE_SERVICE:** read-only App
  Store Connect API inspection at `2026-09-08T05:16:15Z` confirms uploaded
  builds 1, 2 and 3 are VALID; build 3 is newest and the list has no next
  page. Version 1.0 is PREPARE_FOR_SUBMISSION with MANUAL release. Source
  build 1 cannot be reused for the new candidate; commit a coherent next
  build identity and recheck uploaded builds before the human archive.
  Evidence: `asc-readonly-inventory.json` in the baseline artifact directory.
- **W07 / submission product metadata, P1, OPEN / LIVE_SERVICE:** the same
  read-only API inventory confirms one subscription group with monthly
  `pickle_sensei_pro_monthly` and annual `pickle_sensei_pro_yearly`, plus
  non-consumable `pickle_sensei_pro_lifetime`. All three are MISSING_METADATA;
  each review-screenshot endpoint returns HTTP 200 with null data. English
  localizations are present; Family Sharing is false. Prepare actual final
  paywall review screenshots, complete the draft product records and recheck
  readiness. This is not evidence of purchase/restore/refund success.
  Evidence: `asc-readonly-store-metadata.json` and
  `asc-readonly-product-completeness.json`. No listing, price, territory,
  product, release or submission mutation was made.
- **W02/W09 source follow-up, P1/P2, OPEN / SOURCE_VERIFIED:** confirmed
  cross-batch session starvation, unchecked ACK retry exhaustion, missing
  ResultDetails entry, inaccessible review seek control and pre-navigation
  notification press loss. The exact boundaries and proposed regressions
  are captured in `w02-sync-implementation-plan.md`,
  `server-response-exception-audit.md` and the native baseline
  `audits/w09-native-accessibility-audit.md`. Existing native harnesses are
  historical references until rerun against this candidate. Draft real
  SQLite tests are prepared under ignored artifacts and have not run.

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

The owner requested a GitHub checkpoint for continuation in Devin cloud on
2026-09-08. Continue from the branch and handoff below. This changes the working
environment, not the acceptance criteria or human release boundaries.

No release action was performed.

## 11. Devin cloud continuation checkpoint — 2026-09-08

Checkout `codex/production-continuation-20260907`. Read `AGENTS.md`, `REVIEW.md`,
`docs/prompts/codex-production-readiness.md` and this packet before continuing.
The owner's scope is completing production readiness, including substantial
end-to-end Phase 1 implementation while investigating remaining Phase 0 failures.
The current checkpoint deliberately includes unfinished implementation. It is
**NO-GO for release**, not a completed release candidate. Earlier findings above
are chronological evidence; this section records the latest continuation state.

The shipping backend is `supabase/functions/api/` (Deno), not the older Fastify
service. Use root pnpm 10.15.1 / Node 20.x according to `package.json`, and npm /
Node 22.x inside `apps/mobile`; do not run pnpm there. Local ignored `artifacts/`
and credentials are not part of the GitHub handoff. Test counts below summarize
those local logs; Devin must regenerate evidence on its own final candidate.

### Completed changes to preserve

- `bf366f51`: W02 sync dependency recovery, strict complete/disjoint/unique ACKs,
  fair durable batches, original-owner session reconstruction, duplicate identity
  conflict holds, owner-generation fencing and real Result “Retry saving”.
  Thirteen focused suites / 684 tests passed, including 31 real SQLite cases;
  mobile typecheck, owned lint and formatting passed. Physical process-death and
  native UI acceptance remain outstanding.
- `0c29e54a`: W06(E) removed the unvalidated public benchmark rescale everywhere,
  including accessibility labels. Ten focused suites / 237 tests passed.
  The shared release-bound interval predicate and formatter exist; approved
  positive saved-outcome publication is not wired. No replacement model or
  scientific validation has been approved.
- `cdd77d73`: W07 verified billing grace and longest recognized alias access
  (including lifetime). Eight added cases first reproduced six failures;
  158 billing/adversarial/ordering regressions then passed, with frozen Deno
  typecheck and owned lint/format passing.
- `949288cb`: the simulator launch gate now rejects a dead logger, incomplete
  observation and a dead app PID; owned logger shutdown is bounded. Fourteen
  launch-helper fixtures passed on Bash 5 and stock macOS Bash 3.2.
- `cba1eabf`: bounded Metro module-load tracing preserves the ICNS child's
  existing five-second, 192 MB, output-size and kill safeguards. It is diagnostic
  instrumentation; the intermittent config-load timeout is not yet explained.

### Work in progress included in this checkpoint

**W01/W04 release authority:** `analysisReleasePolicy.ts` in shared types defines
immutable policy bytes, independent mechanics/benchmark approval metadata,
supported observed inputs and complete output lineage without a self-hash cycle.
The new migration `20260908020000_analysis_release_authority.sql` adds immutable
policy storage, append-only decisions, separate output approval, activation,
irreversible withdrawal and default denial of new authorizations. Mutations are
database-owner-only; the service role can only read through the dedicated RPC.
No policy has been installed or approved in production. Edge
`releasePolicy.ts` checks canonical bytes, SHA-256, document and control state;
the authenticated `GET /v1/analysis/release-policy` route exposes that authority.

Evidence: 28 new shared policy tests, 302 shared tests total, nine frozen Deno
policy tests, a focused real PostgreSQL authority/privilege/immutability test,
and frozen Deno `index.ts` typecheck passed locally. The SQL test used a disposable
clone; the final CHECK refinement and the newly wired fresh/all-history RLS
matrix still need a complete run. The new HTTP route needs real-handler tests.
Root and function-local import resolution must both continue to work; dependency
versions and lockfiles were not changed for this work.

**This does not yet enforce production charging.** Admission, mobile policy
fetch, atomic result/receipt/charge settlement, offline grants, allocation
accounting, native wallet, trusted time, key rotation and delayed receipt
reconciliation remain to implement. Preserve these integration constraints:

- Existing raw `scored` counts must not charge mechanics-only partial outputs.
  Change accounting prospectively while preserving the lifetime spent floor,
  late-linked identities and deletion/recreation anti-reset behavior. Use
  `lifetime_scored_count()` at decision points; preserve `access_lock_key()`.
- Bind receipts and replay checks to owner/device/grant/ticket/operation/result,
  canonical payload digest and full policy lineage. Existing ID-only replay is
  insufficient. Check replay before spending fresh sequence or credit.
- Add an honest partial terminal outcome through permit lifecycle guards and
  tombstones; do not relabel partial output as low confidence to fit an old enum.
  Preserve API-only RLS and security-invoker user RPCs. Never automatically
  reclaim a disconnected device's offline allocation.
- Relevant effective SQL is in `20260907100000_permit_settled_no_delete.sql`,
  `20260907000000_permit_terminal_client_role.sql`,
  `20260906140000_permit_lifecycle_null_safe.sql`, and
  `20260907110000_api_audit_integration.sql`. Add forward migrations after this
  checkpoint; do not modify committed migration history.

**W07 purchase fulfilment:** mobile pending journal schema 2 stores bounded
transaction identifiers/date, with schema 1 compatibility. Each reconciliation
binds a fresh attempt ID, pending record and transaction. Matched provider
fulfilment or terminal expiry/refund can clear pending state; ambiguous absence
stays pending. The Edge handler suppresses terminal verdicts from superseded
ordered tickets. Four focused mobile suites / 122 tests and mobile typecheck
passed locally. The final focused Edge run passed 169 billing, adversarial and
ordering tests, including the 19-case recovery suite. These use controlled
provider fixtures and do not cover the real-provider mismatch below.

**Known provider integration blocker:** the current implementation accepts only
a string `store_transaction_id` and requires an exact matching transaction in
RevenueCat v1 subscriber data. The official
[customer info model](https://www.revenuecat.com/docs/api-v1/customer-info-model)
shows numeric iOS subscription transaction IDs; its non-subscription example
has RevenueCat's own ID but no Apple transaction ID. A renewal also replaces
the latest subscription transaction. Consequently valid purchases, especially
lifetime purchases, can remain pending indefinitely. Complete verified provider
reconciliation and add realistic numeric-ID, lifetime and post-renewal cases;
do not infer a refund/expiry from absence or use product identity alone as
terminal transaction evidence. The durable transfer queue and source/destination
verification barrier are also unimplemented. The proposed billing-recovery
migration does not exist. Preserve retryable incomplete webhooks, authenticated
reconciliation, ordered verification, live-session checks and billing isolation.

### Phase 0 and remaining dependencies

The third full run on `4f26e5f7504097805105b818cebd202d2bc0bbba` failed overall:
cloud passed 13/15 stages; lint found an ignored local diagnostic script issue
(subsequently corrected) and mobile hit the ICNS child timeout (5,808/5,809
passed). All three Apple stages passed: native Swift suites (105 Vision + 37
managed-media tests per platform, zero skipped), real Vision extraction, fresh
mobile Jest (307 suites / 5,809 tests), Pods, actual Release build and ad-hoc
simulator launch. The app survived the 25-second observation with zero crash,
fatal or Keychain errors. Screenshots have not been visually reviewed.

A fourth `scripts/verify-all.sh --cloud-args '--tier full --fresh-deps'` run was
started in an isolated clean checkout of
`0c29e54a85d77ad35ce4fdcbba49d3395095f8c9`. At handoff preparation, dependencies,
format, lint, typecheck, workspace tests and database stages had passed; mobile
was running. This older snapshot excludes the unfinished billing/release-policy
checkpoint, so even a later pass would not certify the final handoff SHA.
Local logs are `artifacts/readiness-20260907-baseline/phase0-r4-*`; rerun the
canonical full gates on the final integrated commit in Devin, with real Mac
verification for native claims. Do not relax the ICNS timeout or prewarm/reorder
tests to conceal the unresolved cold config-load failure.

Prioritize charging/release enforcement and its offline/native dependencies,
complete billing recovery, and shipping account/media deletion. For W08, the
standalone managed-media package is not yet the shipping native pod integration;
account cleanup must purge every owner namespace and managed media inventory.
Inventory pagination must not silently truncate at the current 16-page cap.
Signed native uploads must reject redirects; React Native fetch follows them.
W03 import still needs conservative event admission, verified timing and byte
identity (the Library original-operation retry entry already exists). W06 full
nine-component comparability across mobile/Edge/SQL rank remains open. W09 still
needs ResultDetails routing, an accessible review seek control, notification
press handling before navigation is ready, and native ceremony/focus proof.
W10 diagnostics must stay disabled until native envelope scrubbing and bounded
disk retention are implemented and verified. W11 still needs auth/NAT failure
budget fixes, legacy provider-token retirement, compatible rollout/rollback and
a final immutable build identity: current Fastlane increments after verification
would make the verified and uploaded candidates differ.

### Human requirements that remain open

Read-only App Store Connect inspection found app ID `6806918402`, version 1.0
in PREPARE_FOR_SUBMISSION and newest uploaded VALID build 3. Choose a source
build greater than 3 and recheck before the human archive. Monthly/yearly are
in one subscription group; all three products are MISSING_METADATA with no
review screenshot. US configured prices are $7.99 / $59.99 / $159.99; no store
metadata, pricing, territory, Family Sharing or release setting was changed.
Real sandbox purchase/restore/refund/transfer and webhook evidence is absent.

The coach registry has no qualified entries or countable reviews. Numerical
release needs consented footage, verified metadata, blinded qualified ratings,
adjudication and the approved validation protocol. Protected holdouts
`wm-dink-01` and `afn-vic-rally1` must not be used for development. Physical
small/older and current iPhone tests, attestation, legal/age/assent/media rights,
backup restoration, operational readiness and production rollout remain open.
Request only the necessary human input while continuing independent work.
Production database/Edge/secrets/dashboard changes, distribution signing,
archive/upload/TestFlight/submission, main merge/tag and release retain their
existing human approval boundaries. A GitHub checkpoint authorizes none of them.

### Checkpoint verification

After formatting the saved work with root Prettier, changed-source ESLint,
mobile TypeScript, frozen Deno 2.5.6 `index.ts` typecheck and `git diff --check`
all passed. Gitleaks 8.30.1 found no leaks in the commit-eligible working tree
or all 568 commits in the pre-checkpoint HEAD history. This is a continuation
checkpoint; the full product gates have not passed on its final SHA.
