# Adversarial pass 3 — `native/vision-core` (S22–S27)

Target commit: `4d812e1aa699014cc0521fd92fde66908043aaa8`. No production code is
touched; everything here is additive.

## What is where

| Path                                                               | Runs on                        | Purpose                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `native/vision-core/Tests/AttackPass3ApplePoseProviderTests.swift` | macOS + iOS Simulator (XCTest) | S22–S27 attacks against `ApplePoseProvider`. Picked up automatically by `swift test` and both `xcodebuild test` invocations in `scripts/mac-full-verify.sh` because it lives in the package's `Tests/` directory.                        |
| `native/vision-core/Tests/AttackPass3VisionSupport.swift`          | macOS + iOS Simulator          | Test-only helpers: seeded RNG, `mach_task_info` RSS/footprint, pixel-buffer construction, CoreGraphics compositing/rotation, upright clip reader (same `AVAssetReaderVideoCompositionOutput` path as swing-lab), JSON report writer.     |
| `tools/attack-pass3/compare_s27.py`                                | Linux                          | Diffs two S27 dumps (macOS vs iOS Simulator report JSON, or two swing-lab `pose.json` files with `--swing-lab`). Exit 1 when `modelVersion` differs.                                                                                     |
| `tools/attack-pass3/analyze_mac_artifacts.py`                      | Linux                          | Proxy checks over an existing `mac-full-verify` artifact bundle: S24 identity of `extractPose` vs `extractAllPoses` top person on the committed clip, zero-visibility sentinels, xcodebuild totals. Exit 1 when a proxy assertion fails. |

## Report output (Apple side)

Each XCTest process writes
`macos-ci-artifacts/attack-pass3-vision-core/<platform>-<host>-AttackPass3ApplePoseProvider-pid<N>.json`
when `macos-ci-artifacts/` exists at the repo root (the Mac workflow creates it),
otherwise the same file under the process temporary directory (path is printed
as `[attack-pass3] ... report written to ...`). Every record carries
`platform` (`macos` / `ios-simulator`), `seed` (`5eed000000000004`), the OS
version and the per-test observations (errors with domain/code, RSS samples,
hysteresis scores, per-frame landmarks).

Knobs: `PICKLE_ATTACK_S26_ITERATIONS` (default 1000), `PICKLE_ATTACK_S27_FRAMES`
(default 90).

## Linux usage

```sh
gh run download 33841813597 -D /tmp/mac-artifacts          # baseline on 4d812e1a
python3 tools/attack-pass3/analyze_mac_artifacts.py /tmp/mac-artifacts/mac-full-verify-3 --out /tmp/analyze.json
python3 tools/attack-pass3/compare_s27.py --swing-lab \
  /tmp/mac-artifacts/mac-full-verify-3/swing-lab-extract/pose.json \
  <other-run>/swing-lab-extract/pose.json --out /tmp/pose-diff.json
# after a Mac run that executed the new suite:
python3 tools/attack-pass3/compare_s27.py \
  macos-ci-artifacts/attack-pass3-vision-core/macos-*.json \
  macos-ci-artifacts/attack-pass3-vision-core/ios-simulator-*.json --out /tmp/s27-diff.json
```
