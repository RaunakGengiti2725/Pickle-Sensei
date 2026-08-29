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
- `Info.plist`: camera + microphone usage strings, ATS arbitrary loads
  disabled, version keys sourced from build settings.
- `PrivacyInfo.xcprivacy` accessed-API declarations present.
- `Podfile.lock` committed (deterministic pod resolution).
- fastlane lanes exist, are internal-only, and contain no credentials.

Plus the normal JS gates: `npm ci && npx tsc --noEmit && npm test`.

## Signing model

- **Team**: `H26U6W4K6V` (set in `project.pbxproj` and `ios/fastlane/Appfile`).
- **Bundle id**: `com.picklesensei` — must exist as an App ID in the Apple
  Developer portal with an App Store Connect app record.
- **Method**: App Store distribution signing (`export_method: "app-store"`).
  Use Xcode automatic signing on the build Mac, or `fastlane match` later if
  a shared signing repo is introduced (not set up yet — deliberate: match
  needs a credentials repo decision).
- **Credentials**: an App Store Connect API key, provided ONLY via
  environment variables on the Mac (`APP_STORE_CONNECT_API_KEY_KEY_ID`,
  `APP_STORE_CONNECT_API_KEY_ISSUER_ID`, `APP_STORE_CONNECT_API_KEY_KEY`).
  Nothing credential-like is committed; `check:distribution` asserts this.

## Mac-only steps (external to this environment)

```bash
cd apps/mobile
npm ci
bundle install                 # installs cocoapods + fastlane (Gemfile)
cd ios
bundle exec pod install
bundle exec fastlane ios beta  # bump build number → archive → TestFlight internal
```

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
