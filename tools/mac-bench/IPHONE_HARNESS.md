# iPhone benchmark harness — SPEC (device evidence: BLOCKED_EXTERNAL)

No physical iPhone exists in this program yet. This document specifies the
harness so it becomes ONE procedure the day hardware appears; the export
contract it feeds (`pickle.device-bench.v1`) is already implemented and
jest-tested on Linux in `apps/mobile/src/camera/deviceBench.ts` /
`apps/mobile/__tests__/deviceBench.test.ts`. Nothing below has been executed
on a device — every number this harness would produce is currently
unmeasured, and must never be quoted as measured until it is.

## What it measures

Per benchmark session (a scripted sequence of captures on the real app):

1. **Thermal** — `ProcessInfo.processInfo.thermalState` transitions
   (`nominal|fair|serious|critical`), pushed on every
   `thermalStateDidChangeNotification`.
2. **Camera FPS** — frames delivered per 1s window from the capture
   pipeline's frame callback (the same feed that computes motion samples).
3. **Memory** — `task_info` `phys_footprint` polled every 5s (the metric
   iOS jetsam uses).
4. **Per-capture telemetry** — already emitted today by the capture
   pipeline: `CaptureCompletionTelemetryV1` and `TargetLockTelemetryV1`
   (`apps/mobile/src/camera/capture.ts`); the export references each clip
   plus the schema names rather than duplicating records.

## Existing mobile-side hooks this wires into

- `startSessionCapture` / `stopSessionCapture` /
  `extractSessionEventClip` (`apps/mobile/src/flow/sessionNative.ts`
  bridge surface) — session boundaries define recorder start/stop.
- The capture pipeline's clip finalization (capture.ts) — each finalized
  clip pushes a `DeviceBenchCaptureRefV1`.
- The camera frame callback — FPS windows.

New native work required on-device (NOT yet built): a thin bridge module
publishing thermal-state changes and `phys_footprint` to JS. Until it exists
those series export empty WITH `unavailableReason` set — the contract forbids
silent absence and fabricated zeros (see `validateDeviceBenchExport`).

## Procedure (when hardware appears)

1. Build the app (Release configuration — Debug throttles differently) onto
   the device via Xcode; device plugged into a Mac running the mac-bench
   host, screen at fixed brightness, Low Power Mode OFF; record device
   model/OS in the export init.
2. Start from thermal `nominal` (idle until it reads nominal).
3. Run the scripted session: 10 captures of the committed bundle clips
   played back on a monitor (same footage as the Mac bench, so device and
   Mac evidence describe the same scenes), ~6 minutes.
4. `DeviceBenchRecorder.finalize()` → write
   `deviceBenchExportFilename(startedAtIso)` into the app's Documents dir;
   pull via Finder/`xcrun devicectl` onto the Mac.
5. Validate: any script that loads the JSON and runs
   `validateDeviceBenchExport` — must return `[]`.
6. Store the export under `datasets/experiments/<wave>/device-bench/` and
   reference it from the wave summary. Compare across runs by diffing
   thermal time-to-`serious`, fps P50 (compute from samples), and peak
   footprint — same honesty rules as mac-bench comparisons.

## Acceptance for "harness done" (on hardware)

- One session produces one valid `pickle.device-bench.v1` JSON with all
  three series non-empty (bridge built) and ≥10 capture refs.
- Two back-to-back sessions produce comparable exports (same device, same
  script) whose fps/memory series differ by noise, not structure.
