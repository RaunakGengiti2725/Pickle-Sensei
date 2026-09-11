# Distribution — TestFlight Internal Builds

Honest boundary first: **everything that touches Xcode, code signing, or
App Store Connect requires a Mac and Apple credentials.** Neither exists in
the Linux CI/dev environment, so this repo validates every static
precondition it can (`npm run check:distribution` in `apps/mobile`) and
documents — never simulates — the Mac-only steps. No build, signing, or
upload result in this repo was produced on a Mac unless it says so with
evidence.

## What is validated on Linux

`apps/mobile$ npm run check:distribution` verifies:

- `project.pbxproj`: bundle id `com.picklesensei`, `MARKETING_VERSION`,
  `CURRENT_PROJECT_VERSION`, `DEVELOPMENT_TEAM`, entitlements wiring.
- `PickleSensei.entitlements`: Sign in with Apple capability declared
  (`com.apple.developer.applesignin` — required; without it every properly
  signed build rejects Apple sign-in with `auth.not_configured`).
- `Info.plist`: camera + microphone + photo-library usage strings, ATS arbitrary loads
  disabled, version keys sourced from build settings, export-compliance
  exemption (`ITSAppUsesNonExemptEncryption=false`).
- `PrivacyInfo.xcprivacy` accessed-API declarations present.
- `Podfile.lock` committed (deterministic pod resolution).
- fastlane `beta` (TestFlight-internal) and `release` (App Store binary-only,
  never auto-submits) lanes exist and contain no credentials; the Appfile
  team matches the Xcode project's `DEVELOPMENT_TEAM`.

Plus the normal JS gates: `npm ci && npx tsc --noEmit && npm test`.

## Release identity (version/build) is committed, never computed

The identity a build ships with is decided in git BEFORE any verification
runs, and it is the identity that ships — nothing between verification and
upload may change it. `infra/release/release-manifest.json`
(`versionScheme.marketingVersion` / `versionScheme.buildNumber`, validated by
root `pnpm release:check`) is the committed source of that identity; the
Xcode project (`MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` set in EVERY
configuration of the application target), the plist each configuration's
`INFOPLIST_FILE` really points at (`CFBundleShortVersionString` /
`CFBundleVersion` sourced from those build settings, never hardcoded),
`app.json` (the module `AppDelegate.swift` starts and the display name),
and `src/config/runtimeConfig.ts` (`APP_VERSION`) must agree with it.

Linux proves the agreement without a Mac:

```bash
cd apps/mobile
node scripts/release-identity.mjs --check
```

Exit 0 prints the identity; any drift is refused (exit 1, the differing file
and values on stderr). `--json` emits the identity as one JSON object.
`--require-committed` additionally refuses unless HEAD is readable and every
identity file is tracked and byte-identical to the blob HEAD commits for it
— a quiet `git status` is not proof (skip-worktree / assume-unchanged bits
silence it and ignored files never appear in it), and a git that cannot run
fails closed. Build numbers are compared exactly as decimal strings (the
manifest build must be a positive integer JSON represents exactly), so two
distinct builds can never round to the same value. Every flag may be given
once; repeated, unknown or malformed flags are refused rather than resolved.
`__tests__/w11ReleaseIdentity.test.ts` pins the refusals.

The Mac lanes run the same script at two gates, so fastlane can only ship
the verified identity or refuse:

1. `release_identity` — before archiving: `--check --require-committed
--json --latest-uploaded <n>`, where `<n>` is the newest build App Store
   Connect already holds (`latest_testflight_build_number`). A committed
   build that is not greater than `<n>` is refused; the lane never computes
   `<n> + 1` and never passes a build number into the archive. The identity
   JSON (version, build, HEAD sha) is captured here and carried through the
   build.
2. `verify_archive_identity` — after `build_app`, before any upload: reads
   `CFBundleVersion` / `CFBundleShortVersionString` from the produced
   `.xcarchive` and refuses unless both equal the identity captured at gate 1,
   then re-runs the script with `--require-committed --assert-build
--assert-version --assert-git-sha <captured sha> --latest-uploaded <n>` so
   every pre-build refusal is re-applied to the tree as it stands after the
   multi-minute archive. An archive whose `CURRENT_PROJECT_VERSION` differs
   from the verified manifest, a checkout that moved to another commit, or a
   build App Store Connect already holds is refused and nothing is uploaded.

When a refusal fires, the owner commits a new coherent identity (manifest +
`project.pbxproj` + every other identity file, in one commit) and re-runs
the gates from the start against that commit. No lane, script or check
increments, bumps or picks a version or build number.

App Store Connect was inspected again on 2026-09-11: builds 1, 2 and 3 of
version 1.0 are valid uploads, build 3 is the newest, and no further page of
builds was found. The owner selected **1.0 (4)**, greater than 3, for the next candidate. The
manifest, iOS project and Android version code now agree on build 4; fastlane
uploads that committed identity only after its verification gates pass. It
does not assign or increment build numbers. Build 4 has not been uploaded by
the preparation change. Re-read App Store Connect immediately before upload
so a concurrent upload cannot reuse the selected number.

## Signing model

- **Team**: `H26U6W4K6V` in `project.pbxproj` + `ios/fastlane/Appfile`.
  Confirmed 2026-08-30 as the PAID Apple Developer Program team (the former
  personal team kept its ID when the membership was purchased — Membership
  details shows this ID). Pre-purchase provisioning profiles on developer
  Macs are 7-day free-team profiles; Xcode replaces them on the next signed
  build.
- **Bundle id**: `com.picklesensei` — must exist as an App ID in the Apple
  Developer portal with an App Store Connect app record. With Xcode automatic
  signing, building once on the paid team registers the App ID and enables
  the Sign in with Apple capability from the entitlements file.
- **Method**: App Store distribution signing (`export_method: "app-store"`).
  Use Xcode automatic signing on the build Mac, or `fastlane match` later if
  a shared signing repo is introduced (not set up yet — deliberate: match
  needs a credentials repo decision).
- **Credentials**: an App Store Connect API key, provided ONLY via
  environment variables on the Mac (`APP_STORE_CONNECT_API_KEY_KEY_ID`,
  `APP_STORE_CONNECT_API_KEY_ISSUER_ID`, and either
  `APP_STORE_CONNECT_API_KEY_KEY` with the key content or
  `APP_STORE_CONNECT_API_KEY_KEY_FILEPATH` pointing at the .p8 file).
  Nothing credential-like is committed; `check:distribution` asserts this.
  The launch Mac's key (generated 2026-08-30, role App Manager; verified
  against the live App Store Connect app record):

  ```bash
  export APP_STORE_CONNECT_API_KEY_KEY_ID=PLHCZDTYYS
  export APP_STORE_CONNECT_API_KEY_ISSUER_ID=6d8a0594-f803-482c-8ccc-11c76c21c212
  export APP_STORE_CONNECT_API_KEY_KEY_FILEPATH=~/.appstoreconnect/AuthKey_PLHCZDTYYS.p8
  ```

  The .p8 private key lives only at that path (mode 600), never in the repo.

- **App ID capabilities**: `com.picklesensei` has IN_APP_PURCHASE and
  APPLE_ID_AUTH (Sign in with Apple, primary-app configuration; enabled
  2026-08-30 via the ASC API to match the entitlements file).

## App Store release lane

`bundle exec fastlane ios release` (Mac-only) verifies the committed release
identity (above), archives it, re-verifies the archive's bundle identity
against what was captured before the build, and uploads the binary to App
Store Connect. It NEVER uploads
metadata/screenshots and NEVER submits for review — attaching the build to a
version, the listing, and pressing "Submit for Review" stay manual,
deliberate steps in App Store Connect.

## Mac-only steps (external to this environment)

```bash
cd apps/mobile
npm ci
bundle install                 # installs cocoapods + fastlane (Gemfile)
cd ios
bundle exec pod install
bundle exec fastlane ios prep_signing  # optional explicit signing preflight
bundle exec fastlane ios beta  # verify committed identity → archive → verify archive → TestFlight internal
```

Signing model detail: every build lane runs `prep_signing` in the same lane
context before archiving. The archive step uses automatic signing with the ASC
key passed via `-authenticationKey…` xcargs. The export step re-signs with the
`Apple Distribution` certificate and the exact App Store profile returned by
`prep_signing`, using MANUAL signing. This matters when Apple adds a suffix to
a replacement profile because an expired profile still owns the canonical
name. Cloud-managed signing at export is deliberately not used because it
requires an Admin ASC key, and this repo's key is App Manager on purpose.
First upload (build 1.0/1) shipped 2026-08-30 this way; builds 2 and 3
followed (see "Release identity" above — those numbers are taken).

`beta` uploads to **internal testing only** (`distribute_external: false`);
external TestFlight distribution requires App Review and a conscious
decision to submit.

## What TestFlight builds are for

TestFlight internal builds exist to run the fresh-user evidence loop
(`docs/FRESH_USER_LOOP.md`): genuinely fresh users, real devices, real
courts, with consent-gated evaluation telemetry
(`apps/mobile/src/evaluation/trialCapture.ts`) feeding the evaluation
pipeline. A TestFlight build is **not** GATE B evidence by itself — GATE B
requires real-user end-to-end validation on a physical iPhone, observed and
recorded, which remains external until a device exists.
