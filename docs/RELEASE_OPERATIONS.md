# RELEASE OPERATIONS (Wave I, i32-release-operations)

> Operational companion to `docs/RELEASE_PLAN_V1.md` (staged rollout, GO/NO-GO
> criteria) and `docs/DISTRIBUTION.md` (Mac-only TestFlight mechanics). This
> document prepares release operations; it performs **no** release. Every
> irreversible action below is marked `HUMAN AUTHORIZATION REQUIRED` and is
> also encoded machine-readably in `infra/release/release-manifest.json`
> (validated by `pnpm release:check`).
>
> Standing preconditions from RELEASE_PLAN_V1 apply unchanged: the external
> claim gate is FAIL (`docs/CLAIM_REVIEW.md`), coach-validated surfaces are
> RELEASE_BLOCKED by frozen gates, and the only approved external language is
> "Pickle Sensei is still being validated." Nothing here weakens those gates.

## 1. Version & build numbering scheme

One scheme across iOS, Android, and backend images; the release manifest
(`infra/release/release-manifest.json`) is the single source of truth and
`pnpm release:check` verifies the mobile projects agree with it.

- **Marketing version (`MAJOR.MINOR.PATCH`)** — iOS `MARKETING_VERSION`
  (project.pbxproj), Android `versionName` (app/build.gradle), and
  `APP_VERSION` in `apps/mobile/src/config/runtimeConfig.ts` MUST all be the
  same string for a given release.
  - MAJOR: reserved; stays 1 until a deliberate product decision.
  - MINOR: any release that changes user-visible behavior or analysis output.
  - PATCH: fix-forward releases with no behavior change beyond the fix.
  - Current: `1.0` (two-component form is accepted for the pre-release line;
    the first tagged release normalizes to `1.0.0`).
- **Build number** — assigned by fastlane, not by the committed project. The
  `beta` and `release` lanes archive with
  `CURRENT_PROJECT_VERSION = latest_testflight_build_number + 1` (xcargs), so
  the shipped number is monotonically increasing across App Store Connect,
  never reused, never reset when the marketing version changes. The committed
  iOS `CURRENT_PROJECT_VERSION` / Android `versionCode` (`1`) is a **floor**
  that never ships through those lanes; the manifest records it as
  `versionScheme.buildNumber` and records the last build actually uploaded as
  `versionScheme.lastShippedBuildNumber` (currently `3`, from
  `docs/APP_STORE_SUBMISSION.md` §1). `pnpm release:check` asserts the floor
  matches both projects, that it is `<= lastShippedBuildNumber`, and that
  §1 of the dossier records that build. Bump `lastShippedBuildNumber` (and
  the dossier) after every upload. A manual `fastlane ios build` without
  `build_number` archives the committed floor — never upload such an archive.
  Android bumps are manual until an Android pipeline exists.
- **Git tags** — the only shipping state so far is **internal TestFlight**
  (builds 1 and 3 of 1.0); internal builds record the SHA in the build notes
  and do **not** require a tag, so the repository has no release tags yet
  (`git ls-remote --tags origin` is empty by design). Every store-submitted or
  TestFlight-external build is built from a tag
  `v<MAJOR.MINOR.PATCH>-build.<BUILD>` on an audited SHA (the RC record pins
  the SHA; the tag must match it); the first such tag is created by the
  release owner at that GO decision, not before.
- **Backend images** — tagged with the git SHA (existing convention,
  RELEASE_PLAN_V1 §2). The release manifest records which image SHA pairs
  with which mobile version.

## 2. Environment separation

Three environments; no shared state between them. Encoded in the manifest
under `environments`.

| Aspect              | development                                                            | staging                                     | production                                                              |
| ------------------- | ---------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------- |
| API origin          | local / none (`apiBaseUrl` null)                                       | staging origin (TBD, not yet provisioned)   | `https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api` (committed) |
| Database            | local docker-compose Postgres                                          | staging DB, migration rehearsals here first | production DB, forward-fix only (§4 of RELEASE_PLAN_V1)                 |
| Media bucket        | local / none                                                           | staging bucket (TBD)                        | none — video never leaves the device                                    |
| Mobile build config | `runtimeConfig.ts` with `API_BASE_URL` nulled locally (not-configured) | staging values injected at build time       | committed public values in `runtimeConfig.ts`                           |
| Consent records     | synthetic only                                                         | synthetic + team accounts                   | real user consent — protected, append-only                              |

Rules:

- `apps/mobile/src/config/runtimeConfig.ts` commits the **public**
  production configuration: `API_BASE_URL` (the Supabase Edge Function
  origin above), `APP_STORE_ID` (`6806918402`), RevenueCat public SDK keys
  and OAuth client ids. None of these are secrets; the shipping build is the
  default build. Secrets (service-role keys, App Store Connect API keys,
  RevenueCat secret key, Apple `.p8`) are never committed — they live in
  Supabase secrets or on the build Mac as env vars (§4).
- The manifest `environments.production.apiOrigin` and top-level
  `appStoreId` MUST equal the committed `API_BASE_URL` / `APP_STORE_ID`;
  `pnpm release:check` reads `runtimeConfig.ts` and fails if `API_BASE_URL`
  is null, if the two origins differ, or if the App Store ids differ.
- A build whose `apiBaseUrl` is null talks to no backend (explicit
  not-configured state, used for local-first development); such a build is
  never uploaded.
- A binary built with staging config must never be promoted to production
  distribution; rebuild from the tag with production config instead.
- Feature-flag state per environment must match the RC record on every
  deploy (flag-drift check, RELEASE_PLAN_V1 §6 — encoded as a monitoring
  hook in the manifest).
- Staging is not yet provisioned — BLOCKED_EXTERNAL; the manifest marks its
  origin/bucket `"tbd"` and `release:check` accepts `"tbd"` or an https
  origin distinct from production.

## 3. Privacy disclosures (App Store) & usage descriptions

Usage descriptions shipped in `apps/mobile/ios/PickleSensei/Info.plist`
(checked by `npm run check:distribution`):

- `NSCameraUsageDescription` — guided automatic capture / on-device analysis.
- `NSMicrophoneUsageDescription` — optional court audio in local recordings.
- `NSPhotoLibraryUsageDescription` — video import. The import path uses
  `PHPickerViewController` (out-of-process; no library grant needed for
  picking), so this string exists for honesty and for any future Photos-level
  access; it makes no claim of background library access.

Android parallels live in the app manifest (CAMERA / RECORD_AUDIO; imports
use the system picker).

App Privacy ("nutrition label") answers for App Store Connect — the
authoritative row-by-row questionnaire is `docs/APP_STORE_SUBMISSION.md`
(the questionnaire itself is submitted in App Store Connect, not in this
repo):

- The default build **enables the backend** (`apiBaseUrl` is the committed
  production origin, §2), so the app collects account, coaching-profile,
  analysis-result and membership data. `PrivacyInfo.xcprivacy` declares the
  **11 collected data types** that the questionnaire discloses (email, name,
  user ID, fitness, other data types, other user content, browsing history,
  purchase history, other usage data, product interaction, advertising
  data), each linked to the user, none used for tracking, with
  `NSPrivacyTracking` false. That list is pinned by
  `apps/mobile/__tests__/wf/fix-9-privacyManifestCollectedData.test.ts`,
  which fails if a category is added, removed, or marked as tracking without
  updating the test (and therefore the questionnaire).
- Video, camera frames, pose landmarks and imported clips are **not**
  collected — they never leave the device (no storage bucket, no upload
  endpoint).
- Any change to what the backend collects MUST update the questionnaire,
  `PrivacyInfo.xcprivacy` and the pinning test together before submission.
  This is a release-blocking step in the manifest (`privacy_disclosure_sync`),
  not an afterthought.
- Tracking (ATT): none. No ad SDKs, no cross-context tracking
  (`docs/PRIVACY.md` prohibitions). If that ever changes it is a MAJOR
  product decision, not a release-ops toggle.
- Training consent remains separate from analysis consent
  (`ml_training_consent`, OFF by default) — no App Store copy may imply
  video is used for model training by default.

## 4. Signing checklist (Mac-only; nothing here runs on Linux)

Identity is committed (team `H26U6W4K6V`, bundle id `com.picklesensei`);
credentials are never committed. Before any archive:

1. [ ] Confirm the App ID `com.picklesensei` and the App Store Connect app
       record exist (portal — human).
2. [ ] App Store Connect API key present ONLY as env vars
       (`APP_STORE_CONNECT_API_KEY_KEY_ID/_ISSUER_ID/_KEY`) on the build Mac.
3. [ ] Xcode automatic signing resolves a valid Apple Distribution
       certificate + App Store provisioning profile for the team (or a
       `fastlane match` decision is made and documented — not set up yet).
4. [ ] `npm run check:distribution` green at the release SHA (Linux-checkable
       preconditions: pbxproj identity, usage strings, ATS, privacy manifest,
       lockfiles, credential-free lanes).
5. [ ] Build from the pinned tag/SHA only; record SHA + build number in the
       release manifest entry for the build.
6. [ ] Entitlements diff reviewed — any new entitlement requires human
       sign-off (it changes the app's capability surface).
7. [ ] Certificate/profile expiry dates checked (> 30 days remaining) —
       expiring signing assets are a release-ops page, not a surprise.

## 5. TestFlight pipeline

Mechanics in `docs/DISTRIBUTION.md` and `apps/mobile/ios/fastlane/Fastfile`
(`beta` lane: bump build number → archive → upload, internal-only). Pipeline
stages and their authorization levels:

| Step                                                                                                                                 | Reversible?                                      | Authorization                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | --------------------------------------------------------------------------- |
| Linux static checks (`release:check` + `check:distribution` via `scripts/verify-cloud.sh --only release`; tsc, jest via `--tier pr`) | yes                                              | none (automated)                                                            |
| Mac archive + signing (`fastlane ios build`)                                                                                         | yes (local artifact)                             | build operator                                                              |
| TestFlight **internal** upload (`fastlane ios beta`)                                                                                 | mostly (builds expire; ≤ ~10 team testers)       | release owner                                                               |
| TestFlight **external** distribution                                                                                                 | NO — goes through App Review, reaches real users | HUMAN AUTHORIZATION REQUIRED (explicit GO, D-number in `docs/DECISIONS.md`) |
| App Store submission / phased release                                                                                                | NO — a shipped binary cannot be un-shipped       | HUMAN AUTHORIZATION REQUIRED (GO per RELEASE_PLAN_V1 §7)                    |

The `beta` lane is deliberately `distribute_external: false`; changing that
flag is itself an irreversible-class change and must not be made without the
GO decision above. There is no CI job that uploads builds — uploads happen
only from a human-operated Mac, on purpose.

## 6. Release notes

Every build (internal TestFlight included) ships notes from
`docs/RELEASE_NOTES_TEMPLATE.md`. Hard rule inherited from the claim gate:
notes must not claim validated accuracy, coach-equivalent feedback, or
latency numbers; "still being validated" language is mandatory until the
claim gate passes.

## 7. Monitoring & rollback hooks

The monitoring plan (RELEASE_PLAN_V1 §6) and rollback procedures (§3/§4) are
encoded as structured hooks in `infra/release/release-manifest.json`:

- `monitoringHooks[]` — each pre-Stage-1 monitoring line with id, signal,
  alarm condition, and severity (P0 lines page the release owner). The
  manifest is the checklist the release owner walks before enabling any
  user traffic; `pnpm release:check` verifies every mandatory line from the
  plan is present and none has been deleted.
- `rollbackHooks[]` — the concrete rollback lever per subsystem (mobile:
  pause phased release + expedited resubmission; backend: redeploy previous
  SHA-tagged image; server-side kill switch: typed maintenance errors on
  analysis endpoints; DB: forward-fix only, snapshot-restore constrained by
  consent-integrity rules). Each hook carries
  `requiresHumanAuthorization: true` where the action is irreversible or
  touches real user data.

No hook here executes anything. They are the pinned, reviewable definitions
that a human release owner acts on after an explicit GO/HALT decision.

## 8. Irreversible actions — authorization matrix

| Action                                               | Why irreversible                                                               | Required authorization                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------- |
| App Store submission / phased-release start          | shipped binaries cannot be un-shipped                                          | Release owner GO + D-number                           |
| TestFlight external distribution                     | real external users, App Review record                                         | Release owner GO + D-number                           |
| Production DB migration                              | forward-fix-only policy; consent ledger append-only                            | Release owner + fresh pre-migration snapshot verified |
| Production snapshot restore                          | may discard consent writes — prohibited once real consent exists in the window | Release owner + privacy owner, written rationale      |
| Deleting/rotating signing certificates               | invalidates distribution pipeline                                              | Release owner                                         |
| Changing `distribute_external` / review-facing flags | converts internal pipeline into external release                               | Release owner GO + D-number                           |
| Any external accuracy/latency claim                  | claim gate is FAIL                                                             | Blocked entirely until the claim gate passes          |

Everything else (builds, staging deploys, internal uploads, monitoring
changes) is reversible and needs only the operator noted in §5.
