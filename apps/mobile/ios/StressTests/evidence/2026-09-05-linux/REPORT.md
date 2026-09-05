# native-ios-bridges — static-xctest stress report (Linux plane)

Unit: `apps/mobile/ios` native bridges (PickleNative LocalPod + vision-core it links).
Base: `1fb0efd7f3157060af4c61342f5102e068d2ddc5`. Branch: `devin/stress-native-ios-bridges-static-xctest`.
Toolchain: Swift 6.0.3 (`swift-6.0.3-RELEASE-ubuntu22.04`, x86_64-unknown-linux-gnu), Python 3.12, Node 22.23.2.
Plane: Linux only. Nothing here executes Vision / AVFoundation / UIKit / the iOS simulator.
Labels: VERIFIED = ran here; APPLE-HISTORICAL = read from run 33909637479 (base commit, not this branch);
UNVERIFIED-on-Linux = Apple runtime behaviour this branch asserts but could not execute.

## Baseline (existing checks, run first)

| command                                                                                            | exit |
| -------------------------------------------------------------------------------------------------- | ---- |
| `cd apps/mobile && npx tsc --noEmit`                                                               | 0    |
| `cd apps/mobile && npx jest --ci --silent` (286 suites passed / 1 skipped, 4028 tests / 7 skipped) | 0    |
| `cd apps/mobile && npm run check:distribution`                                                     | 0    |

APPLE-HISTORICAL (run 33909637479, base 1fb0efd7, Xcode 26.4.1 17E202, macOS 26.6 arm64): `ok: true`;
vision-core XCTest 56/56 on iOS Simulator and 56/56 on macOS; iOS app launched and stayed alive 25 s
with 0 crash reports / 0 fatal log lines; Apple Vision extraction 1286/1461 frames with pose.
These cover the BASE revision only — none of the XCTests on this branch have run on Apple hardware.

## What was built (new files only — no production source or existing test touched)

`apps/mobile/ios/StressTests/` — SwiftPM package compiling the CANONICAL Foundation-only production
sources through symlinks (`scripts/prepare-sources.sh`): `PoseReadinessEvaluator`, `SessionMotionStream`,
`TemporalStrokeDetector`, `PoseMotionTrail`, `CaptureEvidenceAccumulator`, `CaptureQualitySignals`,
`StrokeCompletionMonitor`, `VisionCoreContracts` (Linux: `import CoreVideo` stripped, opaque `CVPixelBuffer`).

- `StressRNG` (SplitMix64) → every iteration replayable: `stress-runner replay --scenario S --seed N`.
- 14 seeded scenarios (`StressScenarios.swift`): empty/1-frame, huge (up to 4096-landmark lists) + corrupt
  (NaN/Inf/out-of-range/negative/NaN visibility/empty/unknown/duplicate joint, dropped joints, NaN confidence),
  detector random streams, rapid reset storms, two people alternating as primary, exact evidence retention model,
  readiness state machine, duplicate landmark, motion stream + completion monitor, 4-thread monitor hammering,
  motion trail bounds, 60 000-frame memory-pressure loops (RSS measured), Int-extreme timestamps,
  imported-video extraction model (rebase/decimation/60 s cap/cancellation).
- `scripts/campaign.py` — one process per scenario, `started`/`outcome` JSONL so a Swift runtime trap is
  attributed to the exact seed; every failing seed replayed 10×; writes `seeds.json` + `summary.json`.
- 7 XCTest files / 30 tests in `Tests/PickleNativeStressTests` (`STRESS_ITER`, default 25). `MinimalReproTests`
  runs hand-minimized repros in child `stress-runner` processes so traps are assertions, not test-host crashes.

## Campaigns (VERIFIED)

| command                                                                                                             | exit | executed | held | violated | crashed | 10× reruns |
| ------------------------------------------------------------------------------------------------------------------- | ---- | -------- | ---- | -------- | ------- | ---------- |
| `python3 scripts/campaign.py --iter 25 --out …/campaign-iter25`                                                     | 3    | 302      | 238  | 14       | 50      | 640        |
| `python3 scripts/campaign.py --iter 200 --out …/campaign-iter200`                                                   | 3    | 2402     | 1902 | 100      | 400     | 5000       |
| `python3 scripts/campaign.py --iter 200 --scenario monitorConcurrent`                                               | 0    | 8        | 8    | 0        | 0       | 0          |
| `python3 scripts/campaign.py --iter 200 --scenario memoryPressureLoop`                                              | 0    | 8        | 8    | 0        | 0       | 0          |
| manual: `stress-runner repro --name nanWristPath…` 10× default + 10× `SWIFT_DETERMINISTIC_HASHING=1`                | —    | 20       |      |          |         |            |
| manual: `stress-runner replay --scenario detectorRandomStream --seed {49,162}` 10× default + 10× deterministic each | —    | 40       |      |          |         |            |

scenarios_executed = 2720 campaign iterations + 5640 ten-fold reruns + 60 manual replays = **8420**
(≈5.37 M ingest/observe operations). Exit 3 = an invariant was violated; every violation/crash is one of the
four findings below. `swift test` (default `STRESS_ITER=25`): exit 1, 30 tests, 6 failing test cases / 10 assertion
failures, all attributable to findings F1–F4 (`swift-test-default.log.txt`). The assertions state the DESIRED
invariants and are left red on purpose (the task forbids production fixes; weakening them is forbidden too).

Regression vs `origin/main`: all four implicated production files are byte-identical between
`1fb0efd7` and `origin/main` (`git diff --quiet origin/main HEAD -- <file>` → same) ⇒ `regression: no` (pre-existing).

## Findings (BROKEN — reproduced with a seed, minimized)

### F1 · P2 · Non-finite landmark coordinate propagates into completion telemetry / clip payload

- files: `native/vision-core/Sources/SessionMotionStream.swift:61` (speed from raw deltas, no `isFinite` guard);
  `apps/mobile/ios/LocalPods/PickleNative/Sources/StrokeCompletionMonitor.swift:214,266` (peak/samples carry it);
  `apps/mobile/ios/LocalPods/PickleNative/Sources/ClipMediaStore.swift:208,350,374` (payload + pose sidecar).
- repro: `.build/debug/stress-runner replay --scenario hugeAndCorruptInputs --seed 14` (also seed 1; 98/200 seeds,
  each 10/10 deterministic); minimized: `stress-runner repro --name infiniteWristCoordinateInPayload` (2 frames).
- observed (VERIFIED): one `x = +inf` wrist → `SessionMotionStream` emits speed `inf` → `Telemetry.peakMotionValue = inf`,
  `postCompletionMotion` sample `inf` → `JSONSerialization.isValidJSONObject(StrokeCompletionMonitor.payload) == false`.
  Sidecar shape check: a document with one NaN/Inf landmark is refused by `JSONSerialization` (13 corruption
  kinds tried; exactly the 3 non-finite ones fail) — in production that throw is caught by the clip finalizer,
  which deletes the clip (`ClipMediaStore.swift:229-231`, INFERRED from source).
- expected: non-finite landmarks are dropped at the provider boundary or by the stream/monitor; the payload and
  sidecar are always valid JSON.
- reachability: `ApplePoseProvider` forwards `VNRecognizedPoint.location` unchecked; whether Vision ever emits a
  non-finite point is UNVERIFIED-on-Linux. Any `PoseProviding` implementation can.
- evidence: `campaign-iter200/seeds.json` (scenario hugeAndCorruptInputs), `swift-test-default.log.txt`.

### F2 · P3 · `PoseReadinessEvaluator.ingest` traps the process on a duplicate visible landmark name

- files: `native/vision-core/Sources/PoseReadinessEvaluator.swift:118` (`Dictionary(uniqueKeysWithValues:)`).
- repro: `stress-runner replay --scenario readinessDuplicateLandmark --seed 1` (200/200 seeds, 10/10 each);
  minimized: `stress-runner repro --name duplicateVisibleLandmarkName` (one frame, two visible `right_hip`).
- observed (VERIFIED): `Fatal error: Duplicate values for key: 'right_hip'`, SIGILL (exit -4).
- expected: a malformed frame is rejected (`corruptedMedia`/ignored), never a runtime trap in the capture path.
- reachability: `ApplePoseProvider.jointMap` keys are unique joints (INFERRED) so Vision cannot produce this; the
  public `PoseProviding` contract does not forbid it.
- evidence: `campaign-iter200/readinessDuplicateLandmark.log.head`, `swift-test-default.log.txt`.

### F3 · P3 · `StrokeCompletionMonitor.observeFrame` overflows `anchorMs + safetyMaxMs`

- files: `apps/mobile/ios/LocalPods/PickleNative/Sources/StrokeCompletionMonitor.swift:237,240`.
- repro: `stress-runner replay --scenario timestampExtremes --seed 1` (200/200, 10/10 each);
  minimized: `stress-runner repro --name observeFrameNearIntMax` (arm at `Int.max - 10`, observe next frame).
- observed (VERIFIED): `Swift runtime failure: arithmetic overflow`, SIGILL.
- expected: saturating/guarded arithmetic (timestamps are `Int` ms derived from `CMTime`; an unclamped or
  rebased-negative clock must not trap).
- evidence: `campaign-iter200/timestampExtremes.log.head`.

### F4 · P3 · `TemporalStrokeDetector` completion is dictionary-order dependent when one wrist path is NaN

- files: `native/vision-core/Sources/TemporalStrokeDetector.swift:203,311,329` (`wristPaths[key] += distance`;
  `wristPaths.values.max()`; `Double.max` with a NaN operand depends on iteration order).
- repro: `stress-runner repro --name nanWristPathMakesStrokeCompletionOrderDependent` — default hashing
  10 runs: 2 violated / 8 held (earlier samples 3/12 and 5/10); `SWIFT_DETERMINISTIC_HASHING=1` 10 runs: 10/10 violated.
  Natural occurrence in the campaign: `detectorRandomStream` seeds 49 (rate 0.8 over 10) and 162 (0.7) — both
  streams contain NaN frames (`nonFiniteFrames` metric 2 and 1); with `SWIFT_DETERMINISTIC_HASHING=1` both are 10/10
  held. Same input, two fresh detectors in ONE process disagree.
- observed (VERIFIED): a finite right-wrist swing that clears `minWristPathBodyHeights` completes or does not
  complete depending on per-process/per-instance hash seeding once the off-hand path is NaN.
- expected: NaN never enters `wristPaths` (or the gate ignores it); identical frames ⇒ identical decision.
- evidence: `nan-wristpath-order-dependence.log.txt`, `detectorRandomStream-seed49-162-reruns.log.txt`,
  `campaign-iter200/summary.json` (scenarios.detectorRandomStream.reruns).

## HELD (verified_ok, Linux)

- emptyAndSingleFrame 225/225 seeds; hugeLandmarkList (4096 landmarks) stays linear, no trap.
- detectorRapidReset 225/225: no history leaks across `reset()`, no event with < minimum history.
- twoPeopleAlternating 225/225: a bystander alternating as primary never spoofs a stroke event.
- evidenceRetentionExact 225/225 against an independent window model; readinessRandom 225/225 state-machine invariants.
- motionStreamAndMonitor 225/225 (finite streams): decisions inside `[anchor, anchor+safetyMaxMs]`, telemetry ≤ `recordedSampleCap`.
- monitorConcurrent 9/9 (4 threads × ingest/observe/arm/telemetry): no deadlock, no torn telemetry.
- memoryPressureLoop 9/9 × 60 000 frames: RSS growth ≤ 0.7 MB per loop (max 712 704 B), accumulators bounded.
- motionTrailRandom 225/225: trail bounded and inside the frame.
- importExtractionModel 225/225: first kept PTS rebased to 0, strictly increasing, ≤ 60 s cap, ~61 fps decimation,
  cancellation after the loop starts is ignored by the loop (matches `PickleVideoCapture.swift` — no cancel check
  inside the reader loop; INFERRED contract), replay identical.
- XCTest: 24/30 pass (`CompletionMonitorStressTests` 3/3, `DetectorLifecycleStressTests` 7/7,
  `ImportExtractionStressTests` 7/7, `MemoryPressureStressTests` 2/2, plus 4 of 6 `BufferShapeStressTests` + 1 of 5 `MinimalReproTests`).

## UNVERIFIED-on-Linux (authored, not executed on Apple)

Everything about CVPixelBuffer/CMSampleBuffer lifetimes, `AVCaptureSession` start/stop storms,
`GuidedCaptureViewController` preview-layer force unwraps, Vision request cancellation mid-`perform`, and whether
Apple Vision can emit non-finite or duplicate landmarks. The package builds the full vision-core on Darwin
(`prepare-sources.sh` links `ApplePoseProvider.swift` there) but that path has not been compiled or run.

## blocked_external

- Apple execution of this branch's 30 XCTests (`cd apps/mobile/ios/StressTests && scripts/prepare-sources.sh && swift test`
  on the M4 runner) — forbidden this session (no Mac run / no `ci/mac-*` push).
- Physical-device / simulator capture-session start/stop and memory behaviour under real `CMSampleBuffer` pressure.
