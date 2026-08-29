# Capture Evidence Contract

Automatic capture is driven by on-device body pose and a temporal wrist-motion
trigger. The capture result may describe only what that pipeline actually
observed. It is not a stroke classification, technique score, contact detector,
power estimate, or ball-speed measurement.

The trigger may include `peakMotionMs`, the timestamp of its highest observed
camera-relative wrist/paddle motion. It must never be labeled as ball contact.

## Pose capture evidence v1

`captureEvidence` is required for a newly created
`automatic_pose_trigger` clip and forbidden for `imported_video` clips. Legacy
local rows can have no evidence payload; the product labels those rows as
evidence not recorded by that app version instead of reconstructing values.

The v1 payload contains:

- `schemaVersion: 1`
- `window: detected_motion`
- pose-provider, pose-model, and trigger-algorithm versions
- `motionUnit: normalized_image_units_per_second`
- analyzed-input, usable-pose, and missing-pose counts
- the duration between the first and last usable pose observation
- canonical-joint visibility and coverage aggregates
- the number of frames in which all 12 canonical joints were visible
- sparse, per-joint observed motion sample counts, means, and peaks

The canonical joints are the left/right shoulders, elbows, wrists, hips, knees,
and ankles. A joint is visible at confidence `>= 0.35`. Motion compares the same
joint in consecutive usable pose observations only when both endpoints are
visible and `0 < dt <= 250ms`.

All aggregates are restricted to the inclusive detected-motion interval. An
analyzed input is a frame submitted to pose inference, not every camera or movie
frame. The invariant is:

```text
analysisInputFrameCount = poseFrameCount + poseMissingFrameCount
```

Normalized-image motion changes with framing, perspective, occlusion, sampling,
and pose jitter. It must be labeled camera-relative movement. It must never be
converted to MPH or presented as body power, muscle activation, injury risk,
paddle velocity, ball velocity, or form quality.

## Ball-speed state

Every captured clip carries a discriminated `ballSpeed` state.

Until a validated calibrated ball tracker is connected, automatic clips return:

```json
{
  "status": "unavailable",
  "reason": "calibrated_ball_tracker_unavailable"
}
```

Imports that have not been analyzed return `analysis_not_run`. Other unavailable
reasons are camera calibration, frame rate, track length, out-of-plane motion,
or confidence failures.

A future `measured` value is accepted only with all of the following provenance:

- calibrated-monocular-ball-track source
- a calibration identifier and tracker-model version
- measurement frame rate and tracked point count
- observed distance and duration
- confidence and reprojection error
- mutually consistent metres-per-second and MPH values

No UI may render an MPH number from pose, wrist, paddle, trigger, clip duration,
or nominal camera frame rate.

## Privacy and retention

Capture evidence is motion-derived personal data. It follows the clip's owner
scope and lifecycle. Deleting, exporting, or isolating the clip must apply to its
evidence payload as well. Evidence from the guest owner is never claimed by a
later signed-in account.
