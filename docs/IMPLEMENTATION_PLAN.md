# IMPLEMENTATION PLAN

This is the forward plan from the current implementation. Completed infrastructure is listed in `IMPLEMENTATION_STATUS.md`; the target-product narrative in `SPEC_DIGEST.md` is not evidence that a capability ships.

## Completed foundations

- React Native product shell, premium navigation and account-aware state.
- Canonical auth/bootstrap/onboarding/progress APIs and account-scoped local SQLite/outbox data.
- Permit-bound analysis accounting with exactly two lifetime successful free ratings and an entitlement gate after them.
- iOS AVFoundation + Apple Vision and Android CameraX + MediaPipe native camera paths.
- Automatic motion-triggered short-clip capture with live real-pose skeleton and measured joint-motion visualization.
- Typed `unknown`/`awaiting_model` outcomes instead of sample stroke labels, scores, drills, or speed.
- v2 consent/provenance schemas, exact 61-technique taxonomy, explicit non-stroke/partial outcomes, and tested release-eligibility gates for future model-data collection.
- Saved-drill/training-plan persistence that accepts only real catalog records. No placeholder catalog is published.

## Stage 1 — Physical-device capture validation

- Validate orientation, mirroring, framing, lifecycle, permissions, memory, battery, and thermal behavior across representative iOS and Android devices.
- Measure motion-trigger precision/recall for capture only. A motion trigger is not a stroke classification.
- Preserve the current truth boundary: missing person/model/permission yields a visible typed state, never a generated result.

Exit: reliable private clip capture across the supported device matrix with documented measurements.

## Stage 2 — Rights-cleared data and content

- Collect consented, provenance-tracked, representative pickleball video across strokes, views, handedness, levels, bodies, environments, and devices.
- Obtain expert stroke/phase/checkpoint labels with adjudication and a frozen holdout.
- Produce or license human instruction media and coach-review drills before publishing them to the catalog.

Exit: legally usable training/evaluation sets and a reviewed content catalog. Public datasets are not assumed commercially usable.

## Stage 3 — Validated perception

- Train and validate paddle detection, temporal stroke classification, and phase segmentation.
- Keep automatic recognition in the camera path; do not reintroduce a manual stroke picker as a substitute for model quality.
- Add calibrated ball tracking only when it can support a measured trajectory. MPH remains absent until calibration and error bounds are validated.

Exit: frozen per-subsystem quality, fairness, false-trigger, and device-runtime gates pass.

## Stage 4 — Coach-calibrated scoring

- Extract observable biomechanics from validated pose/paddle/phase outputs.
- Calibrate targets and checkpoint weights with coaches; replace engineering hypotheses with a signed, versioned release bundle.
- Validate abstention, coach agreement, test/retest stability, camera perturbation, and subgroup parity.
- Emit a numeric score only above the release confidence threshold; otherwise return a useful abstention.

Exit: a successful rating can be produced, accepted with its full version vector, and legitimately consume one free rating.

## Stage 5 — Training and improvement loop

- Map verified diagnoses to reviewed drills and rights-cleared human instruction media.
- Support saving, completing, and revisiting drills with canonical account sync.
- Show progress only from server-accepted, version-compatible ratings across 7-day, 4-week, 3-month, and all-time ranges.

Exit: capture → trustworthy diagnosis → reviewed practice → later re-measurement demonstrates a version-valid change.

## Stage 6 — Live Court

- Connect validated repetition detection and scoring to the tested cue engine and native speech.
- Add thermal capability tiers, quiet/cooldown policy, session summary, and offline-first sync.
- Validate a full 30-minute session on representative devices before release.

Exit: measured repetition-to-cue performance passes every gate in `LIVE_COURT.md`.

## Stage 7 — Commerce release

- Configure App Store and Play receipt verification and server notifications.
- Verify restore, expiry, grace, cancellation, and cross-device entitlement behavior.
- Confirm that exactly two successful server-accepted ratings are free, the third rating attempt is hard-gated, and all abstentions/failures release their permits.

## Critical path

```
real capture → consented data → validated stroke/paddle/phases → coach-calibrated score
→ reviewed drill/content → repeat measurement → validated Live Court → commerce release
```
