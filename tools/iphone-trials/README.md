# iphone-trials — physical-iPhone E2E trial harness (GATE B)

Everything needed to run, record, validate, and report real-user trials on
physical iPhones — **except the device itself, which does not exist in this
program**. No number in this package is a measurement; the harness exists so
that when hardware appears, ONLY the device evidence itself remains external.

## What is BLOCKED_EXTERNAL (and stays that way until hardware exists)

- Every latency number, FPS number, thermal/battery/memory series, and
  correctness verdict a trial would produce. None exist. None may be quoted.
- The `run-iphone-trial.sh` execution path past its precondition checks: it
  fails fast on Linux and on any Mac without a paired physical iPhone, and has
  never been executed with a device.
- Tier coverage in `device-matrix.json`: every device is `NOT_ACQUIRED`.

## What IS validated on Linux (unit-tested; `pnpm --filter @pickle/iphone-trials test`)

- `pickle.iphone-device-matrix.v1` (`src/deviceMatrix.ts` + `device-matrix.json`):
  older/mid/recent/flagship tiers, explicit acquisition state per device.
- `pickle.iphone-trial.v1` (`src/trialSchema.ts`): per-trial context (device,
  iOS version/build, app build + configuration, live model/contract versions,
  thermal/battery/storage state, camera settings) and the full metric set —
  app launch, permission flow, camera start, capture FPS, target acquisition
  (lock correctness / time-to-lock / persistence / identity switches), stroke
  trigger, event recall + bounds, paddle/ball tracking verdicts, contact
  timing, phase validity, stroke classification, Auto Detect quality,
  adaptive completion, clip correctness, analysis latency, Result
  correctness/rendering, Try Again, crash/memory/thermal/battery. Every
  metric is measured-with-value or unmeasured-with-reason; silent absence and
  fabricated zeros are schema violations.
- The primary GATE B metric: **TRUE-MOVEMENT-COMPLETION → RESULT-INTERACTIVE**.
  The movement-completion instant must be human frame-marked on a
  synchronized reference recording (`markerSource` is enforced) — the app's
  own completion detector is part of the system under test and may not mark
  its own ground truth.
- Frozen targets (`src/latencyTargets.ts`, `iphone-latency-targets-v1`,
  frozen 2026-08-29 before any device measurement exists): judged at P95 —
  ≤2000ms IDEAL, ≤3000ms STRONG, ≤5000ms MAX, else FAIL.
- Report generation (`src/generateReport.ts`, `iphone-trial-report-v1`):
  P50/P75/P90/P95 cold/warm for the primary metric, tier coverage vs the
  matrix, per-metric coverage tallies. Verified behaviors: an EMPTY trials
  directory yields a valid `BLOCKED_EXTERNAL_NO_DEVICE_TRIALS` report;
  `SAMPLE_FIXTURE_NOT_A_MEASUREMENT` files exercise the pipeline but are
  named, excluded from every statistic, and cannot flip the verdict; invalid
  files and unmanifested devices are listed loudly, never skipped.

## The one command (macOS + physical iPhone only)

```
tools/iphone-trials/run-iphone-trial.sh --device-id <matrix-deviceId>
```

Fails fast with a precise message on Linux, on a Mac without Xcode/devicectl,
on an unknown device id, and when no physical iPhone is paired. With a device
it builds Release onto it, walks the operator checklist (thermal nominal,
battery, brightness, reference recording), runs the scripted real-user
session, and points at validation + reporting:

```
pnpm --filter @pickle/iphone-trials report -- [--trials <dir>] [--out <file>]
```

## iOS compatibility process (`ios-compat-matrix.json` + checklist harness)

`pickle.ios-compat-matrix.v1` (`src/compatMatrix.ts`) is the versioned
compatibility matrix: one entry per supported device + iOS-major combination,
each tracking a validation state for every user-facing capability — camera,
permissions, frameTiming, thermal, memory, modelRuntime, envelope,
targetLock, eventTrigger, result, tryAgain, session, import.

Process rules (validator-enforced, not conventions):

- **New device/OS enters YELLOW.** `admitDeviceOs` is the only admission
  path and produces an all-YELLOW entry; there is no code path that admits a
  combination at GREEN or RED.
- **GREEN/RED require device evidence.** A non-YELLOW cell must cite
  `evidenceTrialIds` (DEVICE_MEASUREMENT trials for the SAME device and iOS
  major), a `validatedAtIso` timestamp, and a human-written `evidenceNote`.
  The checklist harness cross-checks the citations and fails the report on
  any that do not resolve (`integrityFailures`).
- **YELLOW must explain itself.** Every YELLOW cell carries a nonempty
  reason. The committed matrix is honestly ALL-YELLOW: no physical iPhone
  exists in this program, so no cell has ever been validated
  (BLOCKED_EXTERNAL).

The runnable checklist harness (`src/compatChecklist.ts`,
`ios-compat-checklist-report-v1`) emits the operator steps per capability and
derives an evidence status per device/OS/capability cell from the same trial
files the trial report consumes: `BLOCKED_EXTERNAL_NO_DEVICE_TRIALS`,
`DEVICE_TRIALS_PRESENT_METRIC_UNMEASURED`, `DEVICE_EVIDENCE_PRESENT`, or
`MANUAL_EVIDENCE_REQUIRED` (session/import have no per-trial metric yet and
need a human evidence note). Run it with:

```
pnpm --filter @pickle/iphone-trials compat -- \
  [--trials <dir>] [--matrix <file>] [--compat <file>] [--out <file>]
```

An empty trials directory is a VALID state producing an all-BLOCKED_EXTERNAL
checklist (exit 0); invalid trial files or unresolved GREEN/RED evidence exit
1 loudly.

## Relationship to existing harnesses

- `tools/mac-bench` measures the perception pipeline on a Mac; this package
  measures the real user experience on the phone. The on-device
  thermal/fps/memory recorder contract already exists
  (`apps/mobile/src/camera/deviceBench.ts`, `pickle.device-bench.v1`) and each
  trial references its export rather than duplicating it.
- Human frame-marking of the reference recording supplies ground truth for
  movement completion, contact, events, and stroke identity (factual
  forehand/backhand — NOT technique quality, which stays coach-gated under
  GATE A).
