---
name: release-verification
description: Release-readiness gate for a Pickle Sensei build — full Linux verification, real Mac verification, release-manifest coherence, and the human checklist — WITHOUT performing any release action. Use when asked whether a build/branch is ready to ship, before a TestFlight/App Store archive, or when running the !release-gate playbook.
---

# Release verification (evidence only — no release actions)

This skill produces a go/no-go with artifacts. It never archives, uploads,
submits, deploys migrations or edge functions, or touches App Store Connect.
Those are human steps with explicit approval (`docs/APP_STORE_SUBMISSION.md`
is the authoritative dossier for store copy/config; `docs/RELEASE_OPERATIONS.md`
and `docs/RELEASE_PLAN_V1.md` for operations).

## Procedure

1. Confirm the release candidate commit (`git rev-parse HEAD`) is pushed and
   is what the PR/branch under review contains.
2. Linux — everything, not just the PR tier:
   ```bash
   set -o pipefail
   scripts/verify-cloud.sh --tier full 2>&1 | tee /tmp/verify-full.log; echo "exit=${PIPESTATUS[0]}"
   ```
   Adds `admin` (Vite production build of `apps/admin-web`) and `release`
   (`node tools/release/check-release-manifest.mjs`: `infra/release/release-manifest.json`
   agrees with the committed iOS version/build numbers, monitoring lines from
   RELEASE_PLAN_V1 §6 present, every irreversible action flagged
   `requiresHumanAuthorization`, no real staging/prod origin committed early).
3. Apple — the real app build + launch + Vision path on the M4 runner
   (see `macos-verification`):
   ```bash
   scripts/mac-full-verify.sh --remote
   ```
   Required: `summary.json` `ok: true`; `PickleSensei-Info.plist` shows the
   intended `CFBundleShortVersionString` / `CFBundleVersion`; launch summary
   shows no crash / fatal JS.
4. Version consistency (read-only):
   ```bash
   grep -E 'MARKETING_VERSION|CURRENT_PROJECT_VERSION' apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj | sort -u
   node -e 'console.log(require("./apps/mobile/package.json").version)'
   node -e 'const m=require("./infra/release/release-manifest.json");console.log(m.versionScheme)'
   grep -n "APP_STORE_ID\|BUNDLE" apps/mobile/src/config/runtimeConfig.ts
   ```
   All must agree with each other and with `docs/APP_STORE_SUBMISSION.md`.
5. Walk `docs/PRELAUNCH_CHECKLIST.md` sections 1–8 and, for every item,
   record one of: `verified (command/artifact)`, `human-only`, `BLOCKED`.
   Do not tick an item you did not execute or observe.
6. Store-copy safety scan of anything user-facing that changed since the
   last release (hard rules from the project Knowledge): no Android / Google
   Play / guest mode / Live Court / DUPR / competitor names; no accuracy
   percentages, "AI coach equivalence", or superlatives.
   ```bash
   git diff <last-release-tag>..HEAD -- apps/mobile/src docs/APP_STORE_SUBMISSION.md \
     | grep -niE 'android|google play|guest mode|live court|dupr|swingvision|pb vision|selkirk|joola|[0-9]{2}% accura' || echo "no forbidden terms in diff"
   ```
   (Matches in code identifiers such as `Platform.OS === 'android'` are
   fine; the rule is about user-visible/store copy — inspect each hit.)

## Output

A release-readiness note (e.g. `docs/RELEASE_READINESS_<date>.md`, following
the existing one) listing: commit, both verification run URLs/artifacts,
version triple, checklist table, open BLOCKED items, and the explicit
sentence "No release action was performed."

## Stop conditions

- Any verification stage failed → NO-GO; do not proceed to checklist theatre.
- Version triple disagrees → NO-GO until fixed in a normal PR.
- A checklist item needs production access or Dashboard visibility you do
  not have → mark BLOCKED with the exact minimal human action.

## Forbidden

- `xcodebuild archive`/`-exportArchive`, `altool`/`notarytool`, TestFlight
  uploads, `supabase db push`, `supabase functions deploy`, RevenueCat or
  App Store Connect changes, tagging a release — all require explicit human
  go-ahead in the session and are performed by the human unless told
  otherwise.
- Enabling Family Sharing, Made for Kids, or external TestFlight testing.
- Editing `release-manifest.json` origins to "make the check pass".
