# Scenario 7 — camera permission denied, then granted without restart

Plane: **mac device** (physical iPhone, development build). Cannot be proven on
Linux or the iOS Simulator (TCC + a real camera are required). Status on
4d812e1a from the Linux plane: **UNKNOWN**.

## What the code says (INFERRED, file:line on 4d812e1a)

| Step                    | Production path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RN `capture()` → native | `apps/mobile/ios/LocalPods/PickleNative/Sources/PickleVideoCapture.swift:42-92`                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| permission probe        | `native/camera-engine/Sources/CameraEngine.swift:134-149` — `.denied`/`.restricted` → `EngineError.permissionDenied` **before** any session configuration, so no `AVCaptureMovieFileOutput` exists and no file can be written                                                                                                                                                                                                                                                                                                             |
| rejection               | `PickleVideoCapture.swift:69-80` → event `{type:"permission",state:"denied"}` then `reject("camera.permission_denied", "Allow camera access in Settings to analyze a stroke.")`                                                                                                                                                                                                                                                                                                                                                           |
| RN mapping              | `apps/mobile/src/screens/AnalyzeScreen.tsx:1034-1055` — the rejection message becomes `phase = {kind:'error', stage:'capture', recovery:'retry'}` and `stabilitySlo` records `camera_startup_failed / guided_capture_error`; only messages containing "cancel" are treated as abandonment                                                                                                                                                                                                                                                 |
| Captures dir            | `apps/mobile/ios/LocalPods/PickleNative/Sources/ClipMediaStore.swift` — `Application Support/PickleSensei/Captures/*.mov` are written only by the clip export after a stroke; spools live in `tmp/PickleSensei-Observation/`                                                                                                                                                                                                                                                                                                              |
| re-grant                | `PickleVideoCapture.capture` builds a **new** `CameraEngine()` per call (line 48) and re-reads `AVCaptureDevice.authorizationStatus` — nothing is cached across calls, so a grant in Settings takes effect on the next tap. iOS is expected (INFERRED from platform behaviour, confirm on device) to terminate an app whose camera authorization changes in Settings while it runs; "without app restart" therefore means _the user does not have to force-quit_, and whether the system relaunched the app must be recorded as observed. |

## Procedure

Prereqs: iPhone on iOS 17+, development build of `apps/mobile` installed
(`cd apps/mobile/ios && bundle exec pod install`, then Xcode run), device
paired for `xcrun devicectl`. Note the app's bundle id `com.picklesensei`.

```sh
UDID=$(xcrun devicectl list devices --json-output /dev/stdout | python3 -c 'import json,sys; d=json.load(sys.stdin)["result"]["devices"]; print(d[0]["hardwareProperties"]["udid"])')
OUT=artifacts/attack/native-camera-engine-4/device/s7; mkdir -p "$OUT"
# Start a device log stream filtered to the app + camera before touching the UI.
xcrun devicectl device process launch --device "$UDID" --console com.picklesensei > "$OUT/app-console.log" 2>&1 &
```

1. Settings → Pickle Sensei → Camera → **off**. Foreground the app (it will
   relaunch — expected).
2. Analyze tab → **Auto Analyze** (the shutter / "Analyze a stroke" CTA).
3. Assert (RN side, via the Metro console or the JS event log):
   - `PickleCameraEvent {type:"permission", state:"requesting"}` then
     `{type:"permission", state:"denied"}`;
   - the `capture()` promise rejects with `code === "camera.permission_denied"`
     and message `Allow camera access in Settings to analyze a stroke.`;
   - the Analyze screen shows the error state with the native message
     verbatim and a retry affordance; no camera sheet is presented.
4. Assert no capture file was created:
   ```sh
   xcrun devicectl device copy from --device "$UDID" --domain-type appDataContainer \
     --domain-identifier com.picklesensei \
     --source "Library/Application Support/PickleSensei/Captures" --destination "$OUT/captures-after-deny"
   find "$OUT/captures-after-deny" -name '*.mov' | tee "$OUT/captures-after-deny.txt"   # must be empty
   xcrun devicectl device copy from --device "$UDID" --domain-type appDataContainer \
     --domain-identifier com.picklesensei --source tmp/PickleSensei-Observation \
     --destination "$OUT/observation-after-deny"
   find "$OUT/observation-after-deny" -name '*.mov' | tee "$OUT/observation-after-deny.txt" # must be empty
   ```
5. Settings → Pickle Sensei → Camera → **on**. Return to the app (system
   relaunch expected; record whether it happened in `notes.txt`).
6. Analyze tab → **Auto Analyze** again. Assert:
   - `{type:"permission", state:"granted"}` then `{type:"session",
state:"configured"}`, `starting`, `composing` (`GuidedCaptureViewController.swift:1257-1287`);
   - the guided camera sheet is up with the outline, REC chip hidden
     (nothing records until the shutter).
7. Tap ✕ to leave. Assert the promise rejects with `camera.cancelled` /
   `Guided capture was canceled.` (`GuidedCaptureViewController.swift:752`),
   the screen returns to `ready` (AnalyzeScreen.tsx:1036-1040), and
   `Captures/` is still empty.

## Attacks to layer on

- Toggle Camera **off → on → off** in Settings while the app sits on the
  Analyze screen, then tap Auto Analyze once: exactly ONE rejection, code
  `camera.permission_denied`, no `camera.busy` (the `begin()` guard at
  `PickleVideoCapture.swift:652-665` only trips if a previous operation is
  still open).
- Double-tap Auto Analyze fast with permission denied: second promise may
  reject `camera.busy` — record which; both must settle.
- Screen Time → Content & Privacy → Camera **Don't Allow** (`.restricted`):
  same `camera.permission_denied` copy (CameraEngine.swift:142).

## Evidence to upload

`$OUT/app-console.log`, `captures-after-deny.txt`, `observation-after-deny.txt`,
a screenshot of the permission state on the Analyze screen, and `notes.txt`
(iOS version, build SHA, whether iOS relaunched the app after the toggle).
Classify HELD only when steps 3, 4 and 6 all hold; anything else is a finding
with the console excerpt as the artifact.
