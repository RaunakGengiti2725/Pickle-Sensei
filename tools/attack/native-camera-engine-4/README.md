# Adversarial pass — native-swing-lab-camera-engine #4 (pass 3/3)

Baseline: `4d812e1aa699014cc0521fd92fde66908043aaa8`. New files only; no
production code, no Mac runner/workflow files touched; no Mac run triggered.

```
tools/attack/native-camera-engine-4/
├── README.md                     this file
├── run-mac.sh                    coordinator/operator entry point (xcodebuild, sim|device)
├── static/static-invariants.mjs  Linux plane: file:line invariants + bounds-guard probes
├── device/SCENARIO-7-permission-denied.md      physical-device procedure (scenario 7)
├── device/SCENARIO-8-facetime-interruption.md  physical-device procedure (scenario 8)
└── xctest/                       SwiftPM package (iOS 15+) — XCTest for scenarios 1-6, 9
    ├── Package.swift
    ├── Sources/CameraEngineUnderTest/*.swift   SYMLINKS to the production sources
    └── Tests/CameraEngineAttackTests/*.swift
```

## Execution planes and what each proves

| plane         | command                                                                                     | proves                                                                                                                                                                                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux static  | `node tools/attack/native-camera-engine-4/static/static-invariants.mjs`                     | the production SOURCE at HEAD still has the guards/strings/orderings the tests rely on; models the `extract` bounds guard on the assigned arguments. Exit 0 = all invariants hold, no defect; 1 = harness stale; 2 = invariants hold AND a probe detected a defect. Report: `artifacts/attack/native-camera-engine-4/static/static-invariants.json`. |
| Linux parse   | `swiftc -frontend -parse <each test file>`                                                  | syntax only. It does NOT type-check (AVFoundation/XCTest for iOS are not available on Linux).                                                                                                                                                                                                                                                        |
| mac sim       | `tools/attack/native-camera-engine-4/run-mac.sh sim`                                        | every `test_sim_*` (no camera needed). `test_device_*` SKIP on the simulator — a skip is UNTESTED, never a pass.                                                                                                                                                                                                                                     |
| mac device    | `PICKLE_DEVELOPMENT_TEAM=<id> tools/attack/native-camera-engine-4/run-mac.sh device <udid>` | `test_device_*`, **if** the test host may use the camera (see below).                                                                                                                                                                                                                                                                                |
| device manual | `device/SCENARIO-7-*.md`, `device/SCENARIO-8-*.md`                                          | scenarios 7 and 8 (RN bridge + guided capture + system UI).                                                                                                                                                                                                                                                                                          |

Nothing in this directory was executed on Apple hardware by the author.
Every Apple-plane statement in the tester's report is INFERRED from source
(with file:line) or UNKNOWN.

## Scenario → test map

| #   | scenario                                                                                                           | test(s)                                                                                                                                                                                                                               | plane         |
| --- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 1   | extract (500,500) / (-1,10) → invalidBounds, queue untouched                                                       | `S1ExtractBoundsTests.test_device_emptyWindow_*`, `test_device_negativeStart_*` (+ `test_sim_*` guard-order, 500 seeded rapid repeats, seed `0x4d812e1a00000004`)                                                                     | device / sim  |
| 2   | runtime error without `AVCaptureSessionErrorKey` → `.failed("The camera session failed.")`                         | `S2S3SessionNotificationTests.test_device_runtimeError_withoutErrorKey_*` (+ non-Error value, NSError, unconfigured/foreign-session isolation)                                                                                        | device / sim  |
| 3   | interruption on the engine's session → `.interrupted(reason)` then `.interruptionEnded`; `object: nil` ignored     | `test_device_interruption_multipleForegroundApps_thenEnded_objectNilIgnored` (+ unknown reasons, 50 rapid pairs)                                                                                                                      | device        |
| 4   | pre-existing file removed before recording starts                                                                  | `S4S6S9RecordingTests.test_device_preExistingFile_removedBeforeRecordingStarts` (+ `test_sim_notRunning_*`: not-running guard has NO file side effects; Unicode/long/invalid URLs)                                                    | device / sim  |
| 5   | two coordinators, release one → `active(withId:)` nil, `anyActive()` true                                          | `S5CoordinatorRegistryTests.test_sim_releaseOne_*` (+ release both, stop-unregisters, hostile ids, 300-step seeded churn seed `0x4d812e1a00000005`)                                                                                   | sim           |
| 6   | `maximumObservationSeconds=2`, record 3 s → `.success`, file kept                                                  | `test_device_maxDurationReached_isSuccessWithValidFile` (+ `test_sim_delegate_*`: the delegate driven directly with synthesized `maximumDurationReached` errors — key true/NSNumber(1)/false/missing/nil-error, suppression one-shot) | device / sim  |
| 7   | permission denied → `camera.permission_denied`, no `Captures/*.mov`, re-grant recovers                             | `device/SCENARIO-7-permission-denied.md`                                                                                                                                                                                              | device manual |
| 8   | FaceTime during guided recording → `camera.interrupted` / `camera_interrupted`, spool removed, idle timer restored | `device/SCENARIO-8-facetime-interruption.md`                                                                                                                                                                                          | device manual |
| 9   | double `startContinuousRecording` → second `.recordingAlreadyActive`, first keeps recording                        | `test_device_doubleStart_secondRefused_firstKeepsRecordingAndFile`, `test_device_twentyRapidStarts_exactlyOneRecording` (+ `test_sim_doubleStart_notRunning_*`)                                                                       | device / sim  |
| +   | engine lifecycle ordering, error copy, preview-layer binding, failed-configure idempotence                         | `EngineLifecycleTests`                                                                                                                                                                                                                | sim           |

## Camera permission for the xctest host (device plane)

`CameraEngine.requestPermissionAndConfigure()` calls
`AVCaptureDevice.requestAccess` when the status is `.notDetermined`. A
process whose Info.plist lacks `NSCameraUsageDescription` is killed by TCC at
that point. Xcode's generic test runner for a SwiftPM package has no such key,
so `AttackSupport.guardCameraPermissionPrompt` SKIPS every `test_device_*`
until the status is decided. To actually run them on an iPhone, host the test
bundle in an app that declares the key — the simplest route is adding
`xctest/Tests/CameraEngineAttackTests` as a unit-test target of
`apps/mobile/ios/PickleSensei.xcworkspace` (host app: PickleSensei, which
already has the key and the same sources through the PickleNative pod). That
integration is the coordinator's call; it is deliberately not done here
because it would touch the app project.

## Design notes

- **Private state via `Mirror`.** `CameraEngine.session`/`movieOutput` and
  `SessionCaptureCoordinator.engine`/`extractionQueue` are `private`. The
  scenarios require the real objects (notification `object:` scoping, queue
  occupancy), so `AttackSupport.storedProperty` reads them through `Mirror`.
  Read-only; nothing mutates production state behind the API.
- **Synchronous-rejection oracle.** `extract` completes every guard rejection
  BEFORE returning and every accepted request FROM the extraction queue.
  `ExtractCompletionRecorder.arrivedSynchronously` is therefore the exact
  "did it touch the queue" signal; the queue timing probe is corroboration.
- **Expected failure = finding.** `test_device_negativeStart_isInvalidBounds_withoutTouchingQueue`
  encodes the ASSIGNMENT's expectation. The source (`SessionCaptureCoordinator.swift:204`,
  guard `eventEndMs > eventStartMs` only) predicts it fails: `(-1, 10)` is
  accepted and dispatched with `absoluteStartMs = base - 1`. The static
  harness reports the same as a BROKEN probe (exit 2).
- **Skips are not passes.** `requireCamera` converts the engine's honest
  `configurationFailed`/`permissionDenied` into `XCTSkip` on camera-less
  destinations; `run-mac.sh` greps `skipped` into `summary.txt` so the
  coordinator can see UNTESTED explicitly.
- **Trap probe is opt-in.** `test_device_intMaxBounds_trapProbe` needs
  `PICKLE_ATTACK_ALLOW_TRAP=1` because a confirmed Int overflow at
  `base + eventStartMs` kills the xctest runner (and every later test with it).
