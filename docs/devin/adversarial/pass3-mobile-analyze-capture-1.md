# Adversarial pass 3 — `mobile-analyze-capture` (tester #1)

Baseline: `4d812e1aa699014cc0521fd92fde66908043aaa8` (branch
`devin/1788500670-production-readiness`). Plane: cloud (Linux). No production
file changed; three new Jest suites under `apps/mobile/__tests__/` perform the
attacks. Regression status was measured by running the same suites unchanged on
`origin/main` (`7c034aa00ea3c4ff0e63c3b84b548cec8d62c96f`) in a worktree.

Labels: **VERIFIED** = the command below was run and exited as stated;
**INFERRED** = read from code, not executed on hardware.

## Suites

| Suite                                        | Scenarios                                                                                                                                                                          | Result on 4d812e1a                                      |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `adversarialSessionFlowRaces.test.ts`        | end()+late sample+late provider; 5-event out-of-order (seeds 1, 7, 42, 20260904, 3735928559); late native sample; late provider failure vs terminal event; hostile native payloads | 9/9 pass, exit 0                                        |
| `adversarialAccessStoreStaleBilling.test.ts` | clear during purchase / post-purchase sync / sync / restore / refresh / initialize / reset; next-account leak; double-tap purchase; seeded interleaving (seed 20260904, 40 rounds) | 12/12 pass, exit 0                                      |
| `adversarialAnalyzeScreenAttempts.test.tsx`  | C1 double/N-tap Start (seed 20260904); C2 late attempt-1 quality/readiness; C3 stale import completion; C4 hostile progress payloads + clock skew                                  | 7/9 pass, **2 fail by design** (findings below), exit 1 |

Commands (run from `apps/mobile`, npm toolchain):

```
npx jest --ci --verbose __tests__/adversarialSessionFlowRaces.test.ts __tests__/adversarialAccessStoreStaleBilling.test.ts   # exit 0, 21 passed
npx jest --ci __tests__/adversarialAnalyzeScreenAttempts.test.tsx                                                        # exit 1, 2 failed / 7 passed
npx jest --ci --silent                                                                                                     # exit 1: 2 failed (the two attacks), 2928 passed, 1 skipped (pre-existing), 249 suites passed
npx tsc --noEmit                                                                                                           # exit 0
```

Root: `npx prettier --check <3 files>` exit 0, `npx eslint <3 files>` exit 0.

## Findings

### F1 — P2 — Stale `import_pose_extraction{completed}` from a foreign pass is adopted as the current run's id: bar jumps to 100% and the real pass is ignored

- Files: `apps/mobile/src/screens/AnalyzeScreen.tsx:693-720` (first `captureId`
  seen is adopted as `run.nativeCaptureId`; `completed` ⇒ fraction 1),
  `apps/mobile/src/screens/AnalyzeScreen.tsx:797-803` (run armed before the
  native call, so the window between arming and native's first `extracting`
  event is open), `apps/mobile/ios/LocalPods/PickleNative/Sources/PickleVideoCapture.swift:565-581`
  (`cancel()` covers guided/picker/`operation` only — INFERRED: the
  `extractImportedPoseSequence` pass at `:189-423` has no cancel path and keeps
  emitting its `captureId`-stamped events after the screen that started it is
  gone).
- Repro: `cd apps/mobile && npx jest --ci __tests__/adversarialAnalyzeScreenAttempts.test.tsx -t "stale completed event arriving BEFORE"`
- Observed (VERIFIED): after the foreign `completed` event the bar reads `100%`
  (`accessibilityValue.now = 100`); the current pass's own `extracting 0.1` and
  `0.5` events are then ignored (still `100%`, no ETA).
- Expected: a `completed` for an id the run never saw must not drive the bar;
  the run's own events must still show `10%`, `50% · ~2s left`.
- Regression vs main: **no** (identical failure on `origin/main`).

### F2 — P3 — `readiness` / `capture_quality` events are attributed to the current attempt regardless of their `captureId`

- Files: `apps/mobile/src/screens/AnalyzeScreen.tsx:648-672` (no `captureId`
  check before `noteReadiness` / `noteQuality`),
  `apps/mobile/src/camera/captureEnvelope.ts:265-275`.
- Repro: `cd apps/mobile && npx jest --ci __tests__/adversarialAnalyzeScreenAttempts.test.tsx -t "late attempt-1 capture_quality"`
- Observed (VERIFIED): a `capture_quality` + `readiness` pair stamped with
  attempt 1's `captureId`, delivered after attempt 2's `beginAttempt()`, makes
  attempt 2's stored envelope report `brightness`, `motion_blur`,
  `camera_motion`, `player_visibility` = `SUPPORTED` although attempt 2's live
  window emitted nothing.
- Expected: those four dimensions `NOT_MEASURED` for attempt 2.
- Exposure (INFERRED): no native `capture_quality` emitter exists in this build
  (`apps/mobile/src/camera/capture.ts` contract comment;
  `native/vision-core/Sources/CaptureQualitySignals.swift` is contract-only).
  `readiness` IS emitted natively and carries `captureId`; a straggler can only
  land after the user starts attempt 2, i.e. seconds later, so the practical
  window is small. The JS contract gap is real; severity kept at P3.
- Regression vs main: **no**.

## Held (VERIFIED)

- `LiveSessionFlow.end()` rejects late `pushSample` (throws), late provider
  resolutions update the completed registry exactly once per outcome, duplicate
  `end()` idempotent — `adversarialSessionFlowRaces.test.ts` A1.
- 5 events with provider promises released in seeded random order: progression
  points strictly ordered by emission index, every seed — A2.
- Native feed after `end()`: listener removed, late sample not applied — A3.
- Late provider failure cannot rewrite a ready event; unresolved failures
  abstain honestly — A4.
- Native boundary rejects NaN/±Infinity/negative/string/bigint/array/null
  samples (counted, not coerced); 600-char emoji/umlaut session id and
  `Number.MAX_SAFE_INTEGER` timestamp do not crash — A5.
- `clearAccessStoreConfiguration()` during purchase, post-purchase sync, sync,
  restore (store and backend phase), refresh, initialize; `reset()` mid-flight;
  same-object reconfigure; leak into the NEXT configured account; double-tap
  purchase → one StoreKit call; 40-round seeded interleaving — all 12 pass.
- Double/N-tap Start → exactly one `captureStrokeVideo()`, guard resets after a
  cancel, taps during `savePendingCapture` ignored, unmount cancels once — C1.
- Stale import `completed`/`failed` for a foreign id AFTER the current pass
  identified itself is ignored; nothing lands after extraction settled — C3b/c.
- NaN / −5 / 42 / ∞ fractions, backwards clock, epoch and year-2999 timestamps,
  unparsable ISO string: bar stays 0–100, no `NaN`/`Infinity` text, ETA ≥ 1s — C4.

## Blocked external (Apple plane)

- (M4 only) Cancel a guided capture during post-roll; prove the partial clip +
  sidecar are deleted and `AVCaptureSession` stops. Linux cannot execute
  `GuidedCaptureViewController.cancelFromBridge()` / `CameraEngine.stop()`.
  Code reading (INFERRED, not evidence): `cancelFromBridge()` is a no-op while
  `processingClip` is true; `finishFailure` removes the observation file only
  when `!recordingStarted`; `CameraEngine.stop()` stops recording and the
  session asynchronously on `sessionQueue`. The existing Mac Full Verify run
  `33841813597` (success, head `4d812e1a`) contains no test named for post-roll
  cancellation. Minimum action: an XCTest on the M4 runner that cancels during
  the post-roll window and asserts file removal + `session.isRunning == false`.
