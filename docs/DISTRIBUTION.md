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

`bundle exec fastlane ios release` (Mac-only) bumps the build number,
archives, and uploads the binary to App Store Connect. It NEVER uploads
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
bundle exec fastlane ios beta  # bump build number → archive → TestFlight internal
```

Signing model detail: every build lane runs `prep_signing` in the same lane
context before archiving. The archive step uses automatic signing with the ASC
key passed via `-authenticationKey…` xcargs. The export step re-signs with the
`Apple Distribution` certificate and the exact App Store profile returned by
`prep_signing`, using MANUAL signing. This matters when Apple adds a suffix to
a replacement profile because an expired profile still owns the canonical
name. Cloud-managed signing at export is deliberately not used because it
requires an Admin ASC key, and this repo's key is App Manager on purpose.
Build history (internal TestFlight, no git tags — see `docs/RELEASE_OPERATIONS.md`
§1): build 1.0/1 shipped 2026-08-30 this way; build 1.0/3 was validated and
attached to version 1.0 on 2026-09-03 (`docs/APP_STORE_SUBMISSION.md` §1 is the
single source for the current build; `infra/release/release-manifest.json`
`versionScheme.lastShippedBuildNumber` mirrors it and `pnpm release:check`
asserts they agree).

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
