# Camera-engine adversarial harness (pass 3)

Adversarial XCTests for `native/camera-engine` (`CameraEngine`,
`SessionCaptureCoordinator`) and the `PickleSessionPreviewView` bridge view,
written against `4d812e1aa699014cc0521fd92fde66908043aaa8`. New files only —
the production sources are compiled unmodified through repository-relative
symlinks in `Sources/PickleCameraEngineUnderTest/` (the same pattern the
`PickleNative` pod uses in `Sources/Core/`). `Sources/ReactShim/` is a
compile-only stand-in for the two React Native symbols the preview view
touches (`RCTDirectEventBlock`, `RCTViewManager`).

## Execution planes

| plane                                     | what it proves                                                                                                                                                                                                                                                                                     |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux (`linux-proxy/`)                    | static pins of the source facts the attacks rely on, symlink integrity, `swiftc -parse` of every file, manifest evaluation, and a Foundation-only scheduling MODEL of scenario 7. **Not Apple runtime truth.**                                                                                     |
| iOS Simulator (`xcodebuild test`)         | every `[any destination]` test: delegate-driven suppression leak (S1), preview attach/detach (S2), recording-before-start (S3), immediate extract errors (S4), observer silence on unconfigured engines (S5), start-before-configure (S6), registry hygiene and delegate failure branches (extra). |
| iPhone with camera access already granted | the `[device only]` tests: real recording after an idle arm (S1), configured-engine observer cleanup (S5), five extracts past the readable edge (S7), stop while extracts are queued (S7). They `XCTSkip` anywhere else and never raise the TCC prompt.                                            |

Run on a Mac (the only plane whose result may be quoted as Apple truth):

```bash
cd tools/attack/native-camera-engine-xctest
xcodebuild test -scheme PickleCameraEngineAttack \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  -resultBundlePath /tmp/camera-engine-attack-3.xcresult
```

Run the Linux-side checks (safe anywhere; writes to
`artifacts/attack/native-camera-engine-3/`):

```bash
tools/attack/native-camera-engine-xctest/linux-proxy/run.sh
```

## Expected outcomes at 4d812e1a

- `S1SuppressionOneShotLeakTests.testArmedWhileIdleSuppressionSwallowsTheNextRealFinish`
  and `S7SerializedCoverageTimeoutTests.testFiveExtractsPastReadableEdgeAreBoundedByOneCoverageTimeout`
  are written to the scenario's _expected_ behaviour and are therefore
  expected RED at this revision (see the findings in the pass-3 report).
- `S2PreviewAttachDetachTests.testWindowRoundTripKeepsPoseSubscription` is a
  candidate finding (pose callback dropped on `willMove(toWindow: nil)` and not
  re-established on re-add); expected RED.
- Everything else is expected GREEN.

Seed for all randomised interleavings: `AttackSeed.value = 0x5EED_CA3E_4D81_2E1A`
(SplitMix64, `Tests/AttackSupport.swift`).
