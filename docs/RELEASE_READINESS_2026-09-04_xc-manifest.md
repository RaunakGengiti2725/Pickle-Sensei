# Release readiness — cross-cutting manifest audit (2026-09-04)

Commit audited: `4d812e1aa699014cc0521fd92fde66908043aaa8`
(branch `devin/1788500670-production-readiness`). Plane: Linux (Ubuntu,
Node v22.12.0, pnpm 9.15.1, Deno 2.9.6, Docker postgres:16). Role:
`release-readiness-manifest` — version triple, `pnpm release:check`,
PRELAUNCH_CHECKLIST walk, store-copy forbidden-terms scan.

**No release action was performed.** Nothing was archived, uploaded,
deployed, tagged, or changed in App Store Connect, RevenueCat, or the hosted
Supabase project. No Mac run was triggered.

Harnesses (new files only) live in `tools/release/xc-readiness/`:

| Harness                                                 | Purpose                                                                                                                    |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `version-triple.mjs`                                    | Cross-checks pbxproj / Info.plist / package.json / gradle / manifest / runtimeConfig / Appfile / dossier / built Mac plist |
| `forbidden-terms-scan.mjs`                              | TypeScript-AST scan of every string literal, template, JSX text, plist string and dossier line for the hard-rule terms     |
| `prelaunch-walk.mjs` + `prelaunch-status.4d812e1a.json` | Labels EVERY checklist item `verified` / `human-only` / `BLOCKED`; fails if one is missing                                 |
| `__tests__/xc-readiness-harness.test.mjs`               | `node --test` pins the classification behaviour of the three harnesses                                                     |

## Verdict

**NO-GO for App Store submission from this plane** — not because a Linux
gate failed (all executed gates passed), but because:

1. Same-SHA Apple evidence does not exist yet: Mac Full Verify run
   `33841813597` on `4d812e1a` was `queued` for the whole audit. The prior
   green run `33829297073` is on `4e4ae958` (prior SHA) — see §4.
2. Hard-rule copy violations exist in user-facing text (§3, findings F1/F2).
3. 9 checklist items are BLOCKED on the hosted platform / ASC / a device and
   12 are human-only (§5); none of them may be counted as passing.

## 1. Version triple

`node tools/release/xc-readiness/version-triple.mjs --json … --mac-plist <prior-run plist>` → exit 0
(`version-triple.log` / `version-triple.json`).

| Source                                                   | Marketing            | Build                                | Bundle                       | Other                                          |
| -------------------------------------------------------- | -------------------- | ------------------------------------ | ---------------------------- | ---------------------------------------------- |
| `apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj` | 1.0                  | 1                                    | com.picklesensei             | team H26U6W4K6V, iPhone-only, iOS 15.1         |
| `apps/mobile/ios/PickleSensei/Info.plist`                | $(MARKETING_VERSION) | $(CURRENT_PROJECT_VERSION)           | $(PRODUCT_BUNDLE_IDENTIFIER) | display name "Pickle Sensei"                   |
| `infra/release/release-manifest.json`                    | 1.0                  | 1                                    | —                            | production/staging apiOrigin `tbd`             |
| `apps/mobile/src/config/runtimeConfig.ts`                | 1.0 (`APP_VERSION`)  | —                                    | —                            | `APP_STORE_ID` 6806918402, iOS RC key `appl_…` |
| `apps/mobile/android/app/build.gradle`                   | 1.0                  | 1                                    | com.picklesensei             | not shipping                                   |
| `apps/mobile/ios/fastlane/Appfile`                       | —                    | —                                    | com.picklesensei             | team H26U6W4K6V                                |
| `docs/APP_STORE_SUBMISSION.md` §1                        | 1.0                  | "Build 3 was validated … 2026-09-03" | com.picklesensei             | Apple ID 6806918402, min iOS 15.1              |
| `apps/mobile/package.json`                               | **0.0.1**            | —                                    | —                            | RN template default                            |
| Built app plist (Mac run 33829297073, SHA 4e4ae958)      | 1.0                  | 1                                    | com.picklesensei             | MinimumOSVersion 15.1                          |

All 19 HARD checks agree. 5 SOFT disagreements (reported, not release
blockers by themselves — see F5/F6):

- `apps/mobile/package.json` version `0.0.1` ≠ `1.0`; `release:check` does
  not look at it.
- `release-manifest.json` / pbxproj build number `1` while the dossier says
  build **3** is the validated ASC build (fastlane assigns
  `latest_testflight_build_number + 1` at archive time, so the committed
  triple does not describe the build that ships).
- Manifest `environments.production.apiOrigin = "tbd"` and
  `development.mobileConfig = "all null"` while `runtimeConfig.ts` hardcodes
  the production Supabase origin.
- No `v1.0-build.3` tag exists (`git tag -l` → empty) although
  `RELEASE_OPERATIONS.md` requires a tag per uploaded build.

## 2. Static release gates (all VERIFIED, exit 0)

| Command                                                           | Exit                                                  | Artifact                                     |
| ----------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------- |
| `pnpm release:check`                                              | 0                                                     | `release-check.log`                          |
| `(cd apps/mobile && node scripts/check-ios-distribution.mjs)`     | 0                                                     | `check-distribution.log`                     |
| `scripts/verify-cloud.sh --only release,security`                 | 0                                                     | `verify-cloud-release-security/summary.json` |
| `rg -n "sk_live\|service_role\|AKIA…\|BEGIN … PRIVATE KEY\|sbp_"` | 0 (18 hits, all role names / PEM header literals)     | `secret-scan-rg.log`                         |
| `cd apps/mobile && npx tsc --noEmit`                              | 0                                                     | `mobile-tsc.log`                             |
| `cd apps/mobile && npx jest --ci --silent`                        | 0 — 247 suites, 2900 tests, 1 skipped                 | `mobile-jest.log`                            |
| `pnpm -r typecheck` (after `pnpm install --frozen-lockfile`)      | 0                                                     | `pnpm-typecheck.log`                         |
| `(cd supabase/functions/api/__wf__ && deno task test)`            | 0 — 127 passed, 6 ignored (live-DB cases, not passes) | `edge-tests.log`                             |
| `./supabase/tests/run_rls_tests.sh`                               | 0 — "SECURITY REGRESSION MATRIX: ALL CASES PASSED"    | `rls-tests.log`                              |
| `node --test tools/release/xc-readiness/__tests__/*.test.mjs`     | 0 — 5/5                                               | `harness-tests.log`                          |

## 3. Forbidden-terms scan

`node tools/release/xc-readiness/forbidden-terms-scan.mjs --json … --md …` →
**exit 1** — 155 files / 10 315 strings; HARD copy hits **9**, META 18
(rule text in the dossier), NON_IOS_BRANCH 6 (Android arms of
`Platform.OS` ternaries — never rendered on iOS), ATTRIBUTION 1
(`drillMedia.ts:103` YouTube channel "Selkirk TV"), REVIEW 24 (all
inspected: "Was this analysis accurate?", legal boilerplate, exit-survey
option — no accuracy-% / superlative / AI-coach-equivalence claim).

HARD copy hits (the finding list):

| Rule        | Location                                            | Text                                                                                           |
| ----------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| dupr        | `apps/mobile/src/progress/duprEstimate.ts:26`       | `(≈ DUPR ${…})` — rendered by Home, Progress, Result, PlayerRankCard/Banner, RankUpCelebration |
| dupr        | `apps/mobile/src/progress/duprEstimate.ts:31`       | "DUPR figure is a rough estimate — …" (PlayerRankCard, Progress, Result, Settings)             |
| dupr        | `apps/mobile/src/components/PlayerRankCard.tsx:127` | accessibility label "… estimated DUPR …"                                                       |
| dupr        | `apps/mobile/src/screens/ProgressScreen.tsx:1115`   | "…not a DUPR or verified match…"                                                               |
| dupr        | `apps/mobile/src/screens/SettingsScreen.tsx:524`    | "…not a verified DUPR or player…"                                                              |
| google_play | `supabase/functions/api/legal.ts:224`               | Privacy Policy §2G "Apple's App Store or Google Play processes purchases"                      |
| google_play | `supabase/functions/api/legal.ts:447`               | Privacy Policy "manage or cancel subscriptions through your App Store or Google Play"          |
| google_play | `supabase/functions/api/legal.ts:639`               | Terms §A "charged to your Apple App Store or Google Play account"                              |
| dupr        | `supabase/functions/api/legal.ts:533`               | Terms "…not an official league, tournament, DUPR, medical…"                                    |

ATTRIBUTION note: `drillMedia.ts:103` `creatorName: "Selkirk TV"` IS rendered to
users (`DrillLibraryScreen.tsx:421`, `DrillVideoPlayer.tsx:448`,
`training/components.tsx:41`). The dossier sanctions creator names on
attributed YouTube embeds (§71, §249 Content Rights, §878) and confines the
competitor ban to keywords/metadata (§602-604); the knowledge-base hard rule
reads "anywhere in user-facing copy". The scanner therefore reports it
separately as ATTRIBUTION (not COPY) and the conflict is left to the owner
(finding F7).

`GET /privacy` and `GET /terms` are the URLs entered in App Store Connect and
linked from the paywall and Settings, so they are both user-facing copy and
store metadata. The in-app DUPR label is acknowledged in the dossier
(§2 "Optional … consider renaming … in a later build") as a low-probability
5.2.1 risk — the knowledge-base hard rule is stricter ("anywhere in
user-facing copy"). All hits are present on `origin/main` too (regression: no).

## 4. Apple evidence (provenance)

- Run `33841813597` (Mac Full Verify, head `4d812e1a`): `gh run view` →
  `queued`, no conclusion, at every check during this audit. **UNKNOWN** —
  not a pass. This role may not trigger or cancel it.
- Run `33829297073` (head `4e4ae958`, prior SHA): `summary.json ok=true`,
  stages environment/swift-native/ios-app passed, Xcode 26.4.1; built plist
  `1.0 (1)` `com.picklesensei` `MinimumOSVersion 15.1`; launch
  `alive_after_25s=1 crash_reports=0 fatal_log_lines=0`. `git diff
4e4ae958..4d812e1a --name-only` touches no version/identity file, but
  that is INFERRED — it does not make this run same-SHA evidence.

## 5. PRELAUNCH_CHECKLIST walk

`node tools/release/xc-readiness/prelaunch-walk.mjs --status
tools/release/xc-readiness/prelaunch-status.4d812e1a.json` → exit 0 (complete
walk; 50 items). Full table with per-item evidence / minimum action:
`prelaunch-walk.md`.

| §                       | verified | human-only | BLOCKED |
| ----------------------- | -------- | ---------- | ------- |
| 1 Secrets & key hygiene | 4        | 1          | 0       |
| 2 Database security     | 6        | 0          | 2       |
| 3 API security          | 6        | 0          | 1       |
| 4 Payments              | 3        | 2          | 1       |
| 5 Accounts & privacy    | 2        | 2          | 0       |
| 6 Scale & performance   | 5        | 0          | 2       |
| 7 Mobile app QA         | 2        | 5          | 0       |
| 8 Store & operations    | 1        | 2          | 3       |
| **total**               | **29**   | **12**     | **9**   |

"verified" for §2/§3/§6 means the migration set and edge function behave as
claimed on a LOCAL postgres / Deno test run; hosted-project state is BLOCKED
throughout.

## 6. Findings

| #   | Sev | Title                                                                                                                                                                                                      | Where                                                                                             |
| --- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| F1  | P2  | "Google Play" ×3 and "DUPR" ×1 in the public Privacy Policy / Terms served at the ASC URLs                                                                                                                 | `supabase/functions/api/legal.ts:224,447,533,639`                                                 |
| F2  | P3  | In-app "DUPR" estimate label/notes on six screens (dossier-acknowledged 5.2.1 risk; violates the stricter hard rule)                                                                                       | `apps/mobile/src/progress/duprEstimate.ts:26,31` and call sites                                   |
| F3  | P3  | Checklist §1 claims `.env*` is gitignored; `.env.production` / `.env.staging` / `.env.development` are not                                                                                                 | `.gitignore:7-9`, `docs/PRELAUNCH_CHECKLIST.md:14`                                                |
| F4  | P3  | Checklist §7 QA sweep still lists "Live Court", a screen that does not exist                                                                                                                               | `docs/PRELAUNCH_CHECKLIST.md:128`                                                                 |
| F5  | P3  | Committed build number 1 (manifest + pbxproj) vs validated ASC build 3; no build tag                                                                                                                       | `infra/release/release-manifest.json:6`, `docs/APP_STORE_SUBMISSION.md:52`                        |
| F6  | P3  | `apps/mobile/package.json` version 0.0.1 is outside the release checker                                                                                                                                    | `apps/mobile/package.json:3`, `tools/release/check-release-manifest.mjs`                          |
| F7  | P3  | Competitor name "Selkirk TV" rendered as drill-video creator attribution — dossier §71/§249 permits attribution, knowledge-base hard rule forbids competitor names in any user-facing copy; owner decision | `supabase/functions/api/drillMedia.ts:103`, `apps/mobile/src/components/DrillVideoPlayer.tsx:448` |

## 7. Blocked / human-only (minimum actions)

See §5 table in `prelaunch-walk.md`; headline items:

- Same-SHA Mac Full Verify: wait for run 33841813597 and read its
  `summary.json` (owner/coordinator; do not re-trigger).
- `supabase secrets list` on `ucqnaiwqwjtgvlduiuib` (REVENUECAT__,
  APPLE_SIGN_IN__, APPLE_TOKEN_ENCRYPTION_KEY, UPSTASH_*).
- `supabase db push` then `supabase functions deploy api --no-verify-jwt`,
  then `curl $BASE/healthz`, `/privacy`, invalid-token 401 check.
- RevenueCat webhook + offering configuration; sandbox purchase/restore/
  cancel/lapse on a physical iPhone.
- ASC privacy labels vs `legal.ts`; counsel review; monitored support
  mailbox; PITR/backups; uptime monitor; screenshots; DSA trader status.
- k6 load test against a staging origin (none exists — manifest `tbd`).
