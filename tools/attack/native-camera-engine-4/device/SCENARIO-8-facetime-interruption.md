# Scenario 8 — incoming FaceTime call during a guided recording

Plane: **mac device** (two iPhones or an iPhone + a Mac that can place a
FaceTime call). Cannot be proven on Linux or the iOS Simulator (there is no
camera to interrupt). Status on 4d812e1a from the Linux plane: **UNKNOWN**.

## What the code says (INFERRED, file:line on 4d812e1a)

| Step                 | Production path                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| interruption source  | `native/camera-engine/Sources/CameraEngine.swift:610-648` — `.AVCaptureSessionWasInterrupted` scoped to the engine's session → `emit(.interrupted(String(describing: reason)))`; an unknown/missing reason maps to `"unknown"`                                                                                                                                                                                                                                   |
| guided handler       | `apps/mobile/ios/LocalPods/PickleNative/Sources/GuidedCaptureViewController.swift:1265-1271` → event `{type:"session", state:"interrupted", reason}` then `finishFailure(code:"camera.interrupted", message:"Camera capture was interrupted. Try again when the camera is available.", abstention:"camera_interrupted")`                                                                                                                                         |
| terminal path        | `GuidedCaptureViewController.swift:2078-2099` — `terminal = true`, timers invalidated, `{type:"abstained", reason:"camera_interrupted"}`, `engine.stop()`; the spool is removed directly only when **no recording was active**; with a live recording the movie output's delegate owns the file (`CameraEngine.swift:321-331`, `recordingFinished` line 1916-1919 removes a `.success` artifact once terminal; a `.failure` is deleted by the engine at 733/739) |
| dismissal + promise  | `PickleVideoCapture.swift:680-689` — `dismiss(animated:)` then `reject("camera.interrupted", …)`                                                                                                                                                                                                                                                                                                                                                                 |
| idle timer           | `GuidedCaptureViewController.swift:709-722` — disabled in `viewDidAppear`, restored in `viewWillDisappear` to `SessionCaptureCoordinator.anyActive()` (false when no session capture is live → auto-lock re-enabled)                                                                                                                                                                                                                                             |
| `.interruptionEnded` | line 1272-1273 only emits an event; by then the VC is terminal, so recovery is a new tap, never automatic                                                                                                                                                                                                                                                                                                                                                        |

### Race worth observing (INFERRED)

AVFoundation ends the movie file when the session is interrupted, so the
recording delegate may fire **before** the interruption notification reaches
`handleSessionEvent`. In that order `recordingFinished` runs non-terminal with
`.success(artifact)` and no `pendingStroke` → `no_stroke_detected` →
`startRecording(.restart)` (lines 1952-1969) → a fresh spool URL and a
`startContinuousRecording` on an interrupted session → then the interruption
arrives and `finishFailure` removes that URL (recordingStarted is false at
that point, line 2095) while `engine.stop()` stops whatever the movie output
managed to start. Expected end state is still "no spool file", but the event
log will show `recording_stopped/no_stroke_detected`, `recording_started/
spool_restart`, then `interrupted` — record the exact order.

## Procedure

Same prereqs and `$UDID`/`$OUT` setup as SCENARIO-7 (`OUT=…/device/s8`).
Sign the test iPhone into FaceTime; have a second device that can call it.

1. Analyze → Auto Analyze → grant camera → wait for `composing`.
2. Tap the shutter. Assert `{type:"session", state:"recording_started",
reason:"shutter"}` and the REC chip; snapshot the spool dir:
   ```sh
   xcrun devicectl device copy from --device "$UDID" --domain-type appDataContainer \
     --domain-identifier com.picklesensei --source tmp/PickleSensei-Observation \
     --destination "$OUT/observation-during-recording"
   find "$OUT/observation-during-recording" -name 'observation-*.mov' | tee "$OUT/spool-during.txt"  # exactly one
   ```
3. From the second device place a **FaceTime video** call to the test iPhone
   while it is still recording (within the 20 s spool).
4. On the test iPhone the incoming-call UI appears. Do **not** answer for
   ~5 s, then decline.
5. Assert, in order, from the console/JS event log:
   - `{type:"session", state:"interrupted", reason:<R>}` — record `<R>`
     (`videoDeviceNotAvailableWithMultipleForegroundApps`,
     `videoDeviceInUseByAnotherClient`, `videoDeviceNotAvailableInBackground`,
     or `audioDeviceInUseByAnotherClient`; anything else, including
     `unknown`, is a finding);
   - `{type:"abstained", reason:"camera_interrupted", message:"Camera capture was interrupted. Try again when the camera is available."}`;
   - `{type:"session", state:"stopped"}`;
   - the RN `capture()` promise rejects with `code === "camera.interrupted"`;
   - the guided sheet is dismissed; the Analyze screen shows the error state
     with that message (`AnalyzeScreen.tsx:1049-1054`).
6. Assert the spool file is gone:
   ```sh
   xcrun devicectl device copy from --device "$UDID" --domain-type appDataContainer \
     --domain-identifier com.picklesensei --source tmp/PickleSensei-Observation \
     --destination "$OUT/observation-after-interrupt"
   find "$OUT/observation-after-interrupt" -name 'observation-*.mov' | tee "$OUT/spool-after.txt"   # must be empty
   xcrun devicectl device copy from --device "$UDID" --domain-type appDataContainer \
     --domain-identifier com.picklesensei --source "Library/Application Support/PickleSensei/Captures" \
     --destination "$OUT/captures-after-interrupt"
   find "$OUT/captures-after-interrupt" -name '*.mov' | tee "$OUT/captures-after.txt"                # unchanged
   ```
7. Assert the idle timer is re-enabled: leave the phone untouched on the
   Analyze screen for the Auto-Lock interval (Settings → Display & Brightness
   → Auto-Lock → 30 s beforehand). The screen must lock. A screen that stays
   awake means `isIdleTimerDisabled` is still true (finding, P2).
8. Tap Auto Analyze again without relaunching: `composing` must be reached
   (fresh engine per call, `PickleVideoCapture.swift:48`).

## Attacks to layer on

- **Answer** the call instead of declining (app goes to background):
  `appEnteredBackground` (`GuidedCaptureViewController.swift:701-706`) and
  the interruption race both fire — assert exactly ONE `abstained` event and
  ONE promise settlement (`terminal` guard, line 2080), spool removed.
- Interrupt during **composing** (before the shutter): same
  `camera.interrupted`, no spool ever existed, `Captures/` unchanged.
- Interrupt in the ~150 ms `recordingAlreadyActive` retry window (tap the
  shutter the instant `composing` shows, call immediately): assert no
  `startContinuousRecording` lands after `terminal` (the retry at line
  1934-1943 checks `isRecordingRequested` only — record whether a
  `recording_started` event follows `abstained`; that would be a finding).
- Rotate to landscape / Control Center pull-down during recording: these are
  NOT interruptions and must not end the session.

## Evidence to upload

`$OUT/app-console.log`, `spool-during.txt`, `spool-after.txt`,
`captures-after.txt`, a screenshot of the error state, `notes.txt` with iOS
version, build SHA, observed `<R>`, and whether the screen auto-locked.
HELD requires steps 5, 6 and 7 to all hold.
