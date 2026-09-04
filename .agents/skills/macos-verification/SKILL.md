---
name: macos-verification
description: Prove Apple-side behaviour of Pickle Sensei (Swift packages, Apple Vision pose extraction, XCTest on macOS + iOS Simulator, the real Xcode app build and simulator launch) on the self-hosted Apple Silicon M4 runner via scripts/mac-full-verify.sh. Use whenever a change touches native/, apps/mobile/ios/, CocoaPods/SwiftPM deps, Vision/CoreML/AVFoundation code, or when a claim about iOS runtime behaviour must be backed by evidence.
---

# macOS / M4 verification

Linux (Devin Cloud) cannot compile Swift, run XCTest, run Apple Vision, or
build the Xcode workspace. Every Apple claim must come from a run of
`scripts/mac-full-verify.sh` on the existing self-hosted runner
(labels `self-hosted`, `macOS`, `ARM64` — the user's physical M4 MacBook).
Never register, re-register, or reconfigure that runner.

## What runs (all real, on the Mac)

| stage | what it proves | key artifacts (`macos-ci-artifacts/`) |
|---|---|---|
| `environment` | macOS/Xcode/Swift/SDK/simulator inventory; actual workspace `apps/mobile/ios/PickleSensei.xcworkspace`, scheme `PickleSensei`, SwiftPM layout of `native/vision-core` and `native/swing-lab` | `environment.txt` |
| `swift-native` | `swift build` + `swift test` of `native/vision-core` (xunit XML); `xcodebuild test` on macOS and on an iOS Simulator (`.xcresult` each); `native/swing-lab` Release build and a REAL Vision pose extraction over the committed clip `datasets/pickleball/fresh-candidates/va-O1dLhGGPErc.mp4` (fails if 0 poses) | `vision-core-xunit.xml`, `vision-core-macos.xcresult`, `vision-core-ios-simulator.xcresult`, `swift-native-xcresult-summary.txt`, `swing-lab-extract/{extract-meta.json,pose.json}`, `swing-lab-extract-summary.txt` |
| `ios-app` | `npm ci`, CocoaPods (`tools/macos-ci/pod-install.sh` → `bundle exec pod install`), SwiftPM resolve, `xcodebuild build` Release for arm64 iOS Simulator (unsigned), asserts `PickleSensei.app` + embedded `main.jsbundle`, then installs + launches on a simulator and checks the process survives with no crash report / `RCTFatal` / `Unhandled JS Exception` | `xcodebuild-build.log`, `PickleSensei-build.xcresult`, `PickleSensei-Info.plist`, `app-size.txt`, `launch/` (screenshots, system log, `launch-summary.txt`) |

`summary.json` (`ok`, per-stage status/seconds, Xcode version, git sha) is
the machine-readable verdict. The app target is iOS-only
(`SUPPORTED_PLATFORMS = iphoneos iphonesimulator`); "macOS" coverage is the
Swift package layer, exercised natively.

## Procedure from a Devin Cloud (Linux) session

1. Commit. The Mac builds a pushed commit, never your working tree.
2. Dispatch and wait (typically 30–90 min; the runner is a single machine):
   ```bash
   cd /home/ubuntu/repos/Pickle-Sensei
   scripts/mac-full-verify.sh --remote          # or: --remote --ref <branch>
   ```
   What it does: pushes HEAD to the trigger branch `ci/mac-<branch>` (a
   throwaway vehicle — never merge it), polls for the `Mac Full Verify` run
   with your exact SHA, `gh run watch`es it, and downloads artifacts to
   `artifacts/mac-full-verify/<run-id>/` (+ `run.json`).
   Devin's GitHub App token cannot call `workflow_dispatch` (HTTP 403) nor
   cancel runs — the push trigger is the on-demand path; humans can still use
   the Actions tab.
3. Check the verdict:
   ```bash
   RUN=artifacts/mac-full-verify/<run-id>
   python3 -m json.tool $RUN/mac-full-verify-*/summary.json
   cat $RUN/mac-full-verify-*/swift-native-xcresult-summary.txt
   cat $RUN/mac-full-verify-*/launch/launch-summary.txt
   ```
   `ok: true` and every stage `passed` is the only pass. Link the run URL
   (`run.json`) in the PR.
4. If the run is still queued after a long time, another Mac run is
   occupying the runner (`gh run list --workflow mac-full-verify.yml`). Wait;
   do not open a second trigger branch for the same change.

## Procedure on the Mac itself (rare — only if you are executing there)

```bash
scripts/mac-full-verify.sh                     # all stages
scripts/mac-full-verify.sh --only swift-native # subset
scripts/mac-full-verify.sh --skip-launch       # build without simulator launch
scripts/mac-full-verify.sh --clean             # wipe DerivedData/SwiftPM caches (~/Library/Caches/PickleSensei-CI)
```

## Reading failures

- `swift-native` — open `vision-core-swift-test.log` / the `.xcresult`
  summary for the failing test; `swing-lab-extract-summary.txt` says
  "0 detected poses" when Vision found nobody (real regression in the
  perception pipeline or a broken clip; the clip is committed — check
  `git lfs`/size first).
- `ios-app` — `xcodebuild-build.log` (search `error:`); `pod-install.log`
  for CocoaPods; `launch/launch-summary.txt` + `launch/*.log` for crash or
  JS fatal on launch. `main.jsbundle missing` means the RN bundle phase did
  not run (`ios/.xcode.env*`, node path).
- `environment` failures mean the runner itself changed (Xcode update,
  missing simulator runtime) — report to the user; do not attempt to
  install Xcode or runtimes from a session.

## Forbidden

- Concluding anything about Swift/Vision/iOS from Linux (`tsc`/`jest`
  passing says nothing about the native build).
- Touching the runner's registration, Keychain, signing identities,
  provisioning profiles, or any file outside the checkout and
  `~/Library/Caches/PickleSensei-CI`.
- Adding a `pull_request` trigger to `mac-full-verify.yml` (public repo,
  personal machine — fork PRs must never execute there).
- Signing or archiving for distribution in CI; the script builds unsigned
  for the simulator on purpose. Release archives are a human step
  (`docs/APP_STORE_SUBMISSION.md`).
- Merging or building on `ci/mac-*` branches.
