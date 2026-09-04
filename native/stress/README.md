# native/stress — seeded stress harness for swing-lab + camera-engine

Additive stress coverage for `native/swing-lab`, `native/camera-engine` and the
pure-logic stages of `native/vision-core` they feed. Nothing here modifies
production code or the existing test targets; production sources are pulled in
by symlink so the stress packages always test the checked-in implementation.

Every loop is seeded (SplitMix64). Common knobs, identical across packages:

| env                  | meaning                                                        | default                 |
| -------------------- | -------------------------------------------------------------- | ----------------------- |
| `STRESS_ITER`        | iterations per campaign (keep the default small in the suite)  | `3`                     |
| `STRESS_SEED`        | replay exactly one seed (the value printed in a failure / row) | unset                   |
| `STRESS_BASE_SEED`   | re-base the derived seed sequence                              | `0x5EED_0000_0001`      |
| `STRESS_RESULTS_DIR` | where the `seed → outcome` JSON tables are written             | `$TMPDIR/pickle-stress` |

`camera-engine-xctest` has no derived sequence (its loops are one long seeded
walk), so there `STRESS_SEED` re-bases directly.

## Packages

| path                                                  | plane       | what it exercises                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `linux-harness/` (Vitest)                             | Linux       | pose-wire mutation fuzz against `@pickle/swing-domain`'s parser (empty / 1-frame / huge / corrupt sequences, the swing-lab `fps == 0` fallback model), a static scan of the Swift sources (locks, `CVPixelBuffer` lock/unlock pairing, `try?`, force unwraps, `Thread.sleep`, sync hops), and a cross-check of the downloaded Mac artifacts (`artifacts/mac-run-<id>/…`). `./run.sh` |
| `linux-swift-logic/` (SwiftPM, swift-corelibs-xctest) | Linux       | the Foundation-only vision-core stages (`TemporalStrokeDetector`, `SessionMotionStream`, `CaptureEvidenceAccumulator`, …) under the seeded two-person / degenerate-frame suite. `swift test` with a Linux toolchain. Says nothing about Vision / AVFoundation.                                                                                                                       |
| `vision-stress-xctest/` (SwiftPM)                     | macOS / iOS | `ApplePoseProvider` buffer stress (zero-sized, 1×1, 4096×4096, foreign pixel formats, corrupt planes, memory loops, concurrent extraction), the two-person suite against the real provider, and `swing-lab` as a subprocess (empty / corrupt / truncated / one-frame / huge / rotated media, malformed overlay JSON, cancellation mid-extraction).                                   |
| `camera-engine-xctest/` (SwiftPM, iOS only)           | iOS         | `CameraEngine` lifecycle: configure failures, rapid start/stop, concurrent lifecycle calls, recording before/without a session, zoom fuzzing, flip + spool restart, preview-layer and deinit loops. Physical-camera races are gated on a device being present.                                                                                                                       |

The Apple packages were authored on Linux (syntax-parsed with `swiftc -parse`)
and must be run through the Mac plane (`scripts/mac-full-verify.sh`) for any
runtime claim — see `.agents/skills/macos-verification/SKILL.md`.
