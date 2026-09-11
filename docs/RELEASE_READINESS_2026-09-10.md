# Pickle Sensei 1.0 release-readiness packet — 2026-09-10

Evidence packet for the frozen 1.0 candidate produced by the production
program (`.devin/skills/production-program`). It records what was verified,
how, and what only the owner can do. It is not a release approval.

No release action was performed.

## 1. Frozen candidate

| Item              | Value                                                                  |
| ----------------- | ---------------------------------------------------------------------- |
| Branch            | `devin/1788854799-production-program-integration`                      |
| Frozen HEAD       | `6a04b8bd247d0cdbd953da53f3ff8778db24e58a`                             |
| Working tree      | clean (`dirty: false` in both Linux summaries)                         |
| Marketing version | `1.0` (`MARKETING_VERSION`, `CFBundleShortVersionString`, manifest)    |
| Build number      | `1` (`CURRENT_PROJECT_VERSION`, `CFBundleVersion`, manifest); fastlane |
|                   | assigns the uploaded build (`latest_testflight_build_number + 1`)      |
| Bundle id         | `com.picklesensei` (`CFBundleIdentifier` in the built Info.plist)      |
| App Store id      | `6806918402` (`apps/mobile/src/config/runtimeConfig.ts`)               |
| Minimum iOS       | 15.1 (`MinimumOSVersion` in the built Info.plist)                      |
| Base for the diff | `53de40d6` (merge-base with `origin/main`), 334 commits                |

Both W12 gates ran against this exact SHA, after the last integration merge
(W05-07 r11, `73d2e26d`) and the ledger commit that followed it.

## 2. Software verification (W12-01 + W12-02) — VERIFIED

### W12-01 Linux, `scripts/verify-cloud.sh --tier pr` — `ok: true`

`artifacts/verify-cloud/20260910T163653Z/summary.json`, `git_sha`
`6a04b8bd…`, host Linux x86_64, Node v24.19.0.

| Stage     | Result | Seconds | Note                                                   |
| --------- | ------ | ------- | ------------------------------------------------------ |
| deps      | passed | 1       |                                                        |
| format    | passed | 36      | root Prettier 3.9.6 is the authority                   |
| lint      | passed | 17      |                                                        |
| typecheck | passed | 28      | workspace `pnpm -r typecheck`                          |
| test      | passed | 168     | workspace unit tests (needs Postgres)                  |
| db        | passed | 2       | `@pickle/database` migrate/seed                        |
| mobile    | passed | 448     | `tsc --noEmit` + Jest: 337 suites, 6,839 tests, 1 skip |
| ml        | passed | 0       |                                                        |
| scripts   | passed | 22      | includes `test_wallet_persistence_check.sh` (W05-05)   |
| edge      | passed | 106     | 936 passed / 0 failed / 88 ignored (live-PG gated)     |
| rls       | passed | 32      | `./supabase/tests/run_rls_tests.sh` fresh + upgrades   |
| security  | passed | 14      | gitleaks / dependency policy                           |

### W12-01 Linux, `scripts/verify-cloud.sh --tier full` — `ok: true`

`artifacts/verify-cloud/20260910T165243Z/summary.json`, same `git_sha`.
All twelve PR stages passed again (mobile 6,839/0/1 skip; edge 936/0/88
ignored; rls 31 s) plus:

| Stage   | Result | Note                                                             |
| ------- | ------ | ---------------------------------------------------------------- |
| admin   | passed | Vite production build of `apps/admin-web`                        |
| e2e     | passed | Playwright admin smoke, 3/3                                      |
| release | passed | `tools/release/check-release-manifest.mjs`: manifest agrees with |
|         |        | iOS 1.0 / build 1; every irreversible action                     |
|         |        | `requiresHumanAuthorization`; no real staging/prod origin        |

The only mobile skip is the documented `importedRealFootageAnalysis.test.ts`
(needs real footage on disk).

### Live-PG Edge suite (closes the "88 ignored")

The canonical `edge` stage has no Postgres, so 88 `live PG:` tests are
ignored there. Run separately on the same SHA against a disposable
Postgres 16 with `XC_PG_URL`/`PICKLE_AUDIT_PG_URL` set:
`deno task test` in `supabase/functions/api/__wf__` → **1024 passed
(31 steps) / 0 failed / 0 ignored** (1m56s).

### W12-02 Apple, `scripts/mac-full-verify.sh --remote` — `ok: true`

Run: <https://github.com/RaunakGengiti2725/Pickle-Sensei/actions/runs/34503212469>
(trigger branch `ci/mac-w12-02-6a04b8bd`, a throwaway vehicle — never merge).
Artifacts: `artifacts/mac-full-verify/34503212469/`, `summary.json`
`git_sha` `6a04b8bd…`, host macOS 26.7 arm64, Xcode 26.4.1 (17E202).

| Stage        | Result | Seconds | Evidence                                               |
| ------------ | ------ | ------- | ------------------------------------------------------ |
| environment  | passed | 10      | `environment.txt`                                      |
| swift-native | passed | 102     | vision-core 165/165 (macOS + iOS Simulator), managed-  |
|              |        |         | media 37/37 (macOS + iOS Simulator), swing-lab extract |
| ios-app      | passed | 557     | `pod install`, Release simulator build (69 MB .app),   |
|              |        |         | Info.plist 1.0 / 1 / com.picklesensei, launch check:   |
|              |        |         | alive 25 s, `crash_reports=0`, `fatal_log_lines=0`,    |
|              |        |         | Keychain wallet contents survived force-quit           |

A second Mac run on the previous head `2d66f694` (run 34503007013) also
passed; it is superseded by the frozen-SHA run above and is not the evidence.

### Version consistency (read-only)

`MARKETING_VERSION = 1.0`, `CURRENT_PROJECT_VERSION = 1`,
`infra/release/release-manifest.json` `marketingVersion 1.0` / `buildNumber 1`,
built Info.plist `1.0` / `1`, `APP_STORE_SUBMISSION.md` marketing version 1.0.
`apps/mobile/package.json` is `0.0.1` (workspace-internal, not shipped).
`APP_STORE_SUBMISSION.md` §Build number records that build 3 was already
validated on 2026-09-03; fastlane assigns the next build number at upload,
so the committed `1` is not a conflict.

### Store-copy safety scan

`git diff 53de40d6..HEAD -- apps/mobile/src docs/APP_STORE_SUBMISSION.md`
grep for Android / Google Play / guest mode / Live Court / DUPR / competitor
names / accuracy %: three hits, all non-user-visible — the bundle filename
`index.android.bundle` and two `/** … */` doc comments in
`src/flow/liveSessionSummary.ts` and `src/data/repository.ts`. No forbidden
term in user-facing or store copy (H06-01 store-copy scan is also ACCEPTED
and on the branch).

### Secret hygiene scan

`rg "sk_live|service_role|AKIA…|BEGIN … PRIVATE KEY|sbp_"` outside tests,
migrations and docs: three hits, all non-secrets — a comment naming the
`service_role` grant (`index.ts`), the diagnostics scrub regex
(`scrub.ts`), and the PEM-header strip in `externalAccounts.ts`.

## 3. What is on the frozen SHA (1.0 packages, all ACCEPTED and merged)

Every package below passed implementer → independent reviewer ‖ adversary →
deterministic evidence judge on its exact candidate SHA before integration,
and every integration was re-verified (mobile tsc + Jest, DB-backed Edge
suite, RLS matrix).

Court-offline chain (1.0 amendment):

- W04-01 device registry + signed offline grants + allocation ledger
- W04-02 `POST /v1/devices/register`, `POST /v1/offline/grants` (≤7 d,
  owner + device bound); W04-06 truthful issuance to unattested installs
- W04-03 signing-key rotation with overlap
- W04-04 `POST /v1/offline/receipts` — idempotent, HOLD on ambiguity,
  durable verdict before any freeze short-circuit, Pro/no-ticket shot
  persistence, byte-bounded batches, replays never spend the decision budget
- W04-05 mobile grant hold / local decrement / durable receipt queue
- W05-01 PickleOfflineWallet Keychain module; W05-02 trusted time;
  W05-03 wallet crash recovery; W05-04 honest offline copy in
  Analyze/Result/Settings; W05-05 simulator acceptance (M4); W05-06 the
  shipping app registers and pulls a grant after every successful sync
- W05-07 court-offline scored read (r7 `389bfbf7` + r11 `9702c7cf`): a
  scored run with no live permit consumes exactly one local allocation,
  retains `{ receipt, grant, output }` evidence, reconciles idempotently;
  lease revalidated at spend; corrupt grant/receipt never starves the drain;
  Pro lease selected before a free ticket; durable paid replay survives
  cancel; low-confidence abstention spends nothing and loads as final;
  refusal codes bounded to protocol codes
- W11-03 pg_cron must not eat unused offline allocations

Billing, deletion, chargeability, sync, policy:

- W07-01, W07-02 (renewal follows the subscription), W07-03 (recovery queue
  - transfer reconciliation), W07-05 (truthful membership UI), W07-06
    (owner inventory pagination), W07-07 (lifecycle suite)
- W08-01 deletion in ManageAccount (idempotent, redirect-rejecting);
  W08-06 Edge deletion completeness + revocation + retention disclosure
- W01-01..04, W01-05 (partial outcome never spends a free rating), W01-06
  (cached release policy; missing/withdrawn policy blocks new scores)
- W02-01/02/03 outbox, journal, owner fencing
- W11-01 per-identity auth-failure budgets behind NAT; W11-08
- H04-01, H05-01, H06-01, H07-01, H09-01, P0-01/03/04/05 (P0-03/04 were
  verification-only, no diff), W06-01, W09-01/02/08, W10-01/03

Accepted before the launch-slice directive but intentionally NOT merged
(held for 1.0.1): W06-03, W09-03, W09-04.

Dropped per owner rule: W03-01 conservative import admission (round 8
failed; import already works — not a 1.0 blocker). Deferred to 1.0.1
(`DEFERRED_V1_1` in the ledger, not implemented): W06-02/04/05/06, W08-02..05,
W09-05..07/09..11, W10-02, W11-02/04..07/09, H03-01, W02-04, INT-_, EXT-_.

## 4. Physical iPhone checks — HUMAN-ONLY, NOT VERIFIED

The Cloud + M4 planes prove the Release simulator build, native Vision
tests and the Keychain wallet across force-quit. They cannot prove a
physical device. Owner runs on a current and an older/small iPhone:

1. Sign in (Apple, Google); force-quit; relaunch stays signed in.
2. Online: record a swing, get a score; Settings shows the offline allocation
   / lease end.
3. Airplane mode on court: record and score a swing; exactly one allocation
   decrements; Result shows the offline-receipt state; force-quit and relaunch
   keeps the result and the queued receipt.
4. Reconnect: receipt settles once; allocation and free-rating count agree
   with the server; repeating sync charges nothing further.
5. Camera / photo-library permission denial and recovery; low storage; import
   of a real clip.

Minimum owner action: run this matrix and record dated results.

## 5. StoreKit checks — HUMAN-ONLY, NOT VERIFIED

RevenueCat/StoreKit paths are covered by W07-* suites against recorded
provider records; the live sandbox was not exercised from the Cloud.
Owner, with a Sandbox Apple Account: purchase monthly / yearly / lifetime,
restore, refund, renewal, transfer to a second Apple ID, grace period —
confirm the membership screen shows only true states and the server
entitlement follows the subscription. Minimum owner action: run these in
sandbox and record results.

## 6. Scientific validation — BLOCKED_EXTERNAL, NOT CLAIMED

No numerical accuracy, coach-equivalence or benchmark claim is made
anywhere in the app or store copy; ratings use "being validated" /
"validated" / "server-accepted" / "estimate" language. The
`external_accuracy_or_latency_claim` action is flagged
`requiresHumanAuthorization` in the release manifest. Validation
(W06-06) requires owner-supplied consented footage, verified metadata,
qualified blinded reviews and a ratified protocol. Not a 1.0 blocker by
owner decision; it remains a blocker for any future accuracy claim.

## 7. App Store metadata — HUMAN-ONLY

`APP_STORE_SUBMISSION.md` is the authoritative dossier; the owner reported
the submission as already prepared. Owner confirms in App Store Connect:
version 1.0, the build to attach, screenshots, description free of the
forbidden terms, privacy nutrition labels (on-device pose, no video upload,
account data, purchases), age rating, and that Family Sharing / Made for
Kids / external TestFlight stay off.

## 8. Legal — HUMAN-ONLY

`GET /privacy` and `GET /terms` (`legal.ts`) disclose free-rating ledger
retention past deletion (§7/§8) and match the in-app deletion confirmation.
Owner confirms: age/assent policy, processor terms (Supabase, RevenueCat,
Apple, Google), media/font/splash rights (H05-01 notices pass), and the
support address is live.

## 9. Backup / operations — HUMAN-ONLY / BLOCKED_EXTERNAL

- Production Supabase (`ucqnaiwqwjtgvlduiuib`) was not touched. Pending
  migrations must be inspected with `supabase migration list` and
  `supabase db push --dry-run --include-all` before an approved rollout;
  the RLS runner verifies fresh install and both historical upgrade paths.
- Edge function deploy order: deploy `api` before shipping the app build.
- Secrets to confirm set: `REVENUECAT_SECRET_API_KEY`,
  `REVENUECAT_WEBHOOK_AUTH`, `APPLE_SIGN_IN_*`, `APPLE_TOKEN_ENCRYPTION_KEY`,
  optionally Upstash Redis.
- H02-BACKUP: owner authorizes dashboard backup access and a restore
  rehearsal into a disposable project.
- Monitoring lines from `RELEASE_PLAN_V1.md` §6 are present in the manifest;
  live wiring is verified by the owner after deploy.
- The M4 runner must stay awake (`caffeinate -dims`) for any future
  `ci/mac-*` run.

## 10. Public-release approval — NOT GRANTED

| Area                      | Verdict                                         |
| ------------------------- | ----------------------------------------------- |
| Software (W12-01, W12-02) | VERIFIED on `6a04b8bd` — both `ok: true`        |
| Court-offline chain       | ACCEPTED and merged; simulator-verified; device |
|                           | run pending (§4)                                |
| Physical iPhone           | NOT VERIFIED (human-only)                       |
| StoreKit sandbox          | NOT VERIFIED (human-only)                       |
| Scientific validation     | BLOCKED_EXTERNAL, no claim made                 |
| App Store metadata        | owner-prepared, owner confirms                  |
| Legal                     | owner confirms                                  |
| Backup / operations       | owner action required                           |
| Public release            | requires explicit owner approval                |

Owner-only steps, in order, none performed here: approve and run the
coordinated production migration + `supabase functions deploy api`;
archive and sign `6a04b8bd`; upload; attach the build in App Store Connect;
submit; merge the integration branch to `main` and tag.

No release action was performed.
