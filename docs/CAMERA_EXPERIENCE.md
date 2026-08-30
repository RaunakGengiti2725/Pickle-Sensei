# Guided camera experience

The camera is a hands-free capture instrument, not a decorative AI screen. Its
visuals and copy may describe only state produced by the live native camera,
pose provider, readiness evaluator, motion trigger, and clip store.

## State story

Only one primary state is shown at a time:

1. `STARTING` — camera and pose runtime are opening.
2. `POSITIONING` — no usable full-body read; the instruction names the actual
   framing problem reported by the readiness evaluator.
3. `LOCKING` — enough joints are visible and the evaluator is accumulating a
   stable interval.
4. `BODY LOCKED` — the stable full-body gate and recording pre-roll have both
   passed; a single finite lock transition and haptic may run.
5. `MOTION CAPTURED` — the temporal detector found a supported motion window
   with enough persisted pose evidence. This does not imply a stroke label or
   score.
6. `SAVING` — the real pre/post motion window is being exported into private app
   storage.

If a required joint disappears after lock, the experience returns immediately
to the appropriate positioning state. It never leaves a success state visible
after the underlying evidence is lost.

## Overlay contract

- The camera preview is full-bleed. A centered status pill, matched 48-point
  close target, restrained framing corners, and one bottom evidence label are
  the only persistent chrome.
- The athlete renders as a BODY HEAT MAP instead of a stick figure: soft
  additive glows are drawn only at landmarks returned by the current pose
  observation at visibility `>= 0.35`, and along the straight line between
  two such observed landmarks (intensity linearly interpolated between the
  endpoints' measured values). Glow color and size follow each joint's
  measured normalized movement speed on a fixed cool-to-hot ramp (teal at
  rest → mint → volt → flame at the display ceiling). The heat is a MOTION
  visualization; it must not imply muscle activation, injury risk, power,
  form quality, paddle speed, or ball speed.
- Joint trails are short, bounded histories of timestamped observed positions.
  Missing or stale landmarks break a trail. Trail opacity, width, and color may
  respond to measured camera-relative displacement, under the same
  no-implied-diagnosis rule as the heat map.
- Framing progress comes from canonical-joint coverage and the real stability
  interval. It is not a simulated loading indicator.
- There is no looping scan line, ambient celebration, or infinite success
  animation. The heat map is never a free-running effect: with no fresh
  measured movement it settles to the cool observed-presence base, and lock
  and capture transitions stay finite and reversible.
- A missing pose clears the heat map and motion history. The overlay must not
  reconstruct or interpolate a person the model did not observe.

The persisted measurement rules are defined in
[CAPTURE_EVIDENCE.md](./CAPTURE_EVIDENCE.md). In particular, normalized-image
movement can never be converted to MPH.

## Interaction and accessibility

- Selecting **Auto Analyze** enters the guided camera directly; there is no
  stroke picker or second launch confirmation.
- Status changes are exposed as live-region/accessibility announcements without
  announcing every inference frame.
- Close remains centered, reachable, and enabled until clip preparation starts.
- Decorative transition motion follows the platform reduced-motion/animator
  setting. The measured trajectory itself remains visible because it is data,
  not decoration.
- Color is never the only indication of readiness: text and geometry change
  with the state.

## Runtime acceptance checks

- Pose inference and trail collection remain off the UI thread.
- Drawing uses fixed-size buffers and bounded paths; there is no perpetual
  redraw when camera evidence is unchanged.
- A physical-device pass must verify center-crop coordinate mapping, portrait
  and rotation behavior, thermal stability, occlusion recovery, VoiceOver/TalkBack
  announcements, and low-light abstention on representative iOS and Android
  hardware.

## Reference decisions

- [Noom full-body lock](https://mobbin.com/screens/047026d6-2957-4053-b44b-a4cab362dfac)
  informed the evidence-gated body rendering and unmistakable locked state.
- [Equinox+ Focus Areas](https://mobbin.com/screens/c88d72a7-774f-4eed-89ad-cc8623380fab)
  and [Peloton Strength+ target muscles](https://mobbin.com/screens/fc404a31-09fb-4061-bc52-8fd0096cea8f)
  informed the premium dark-surface luminous body treatment of the heat map;
  [Garmin Connect muscle intensity coding](https://mobbin.com/screens/7f48330e-af42-43c3-a208-7fa4e3927c08)
  informed the cool-to-hot intensity ramp (recolored to this app's tokens and
  re-grounded in measured motion rather than planned muscle groups).
- [CLEAR camera alignment](https://mobbin.com/screens/ffed3855-6062-4a43-a98f-f5cc21d7070a)
  informed the sparse framing corners and single corrective instruction.
- [Pliability out-of-frame state](https://mobbin.com/screens/df180f34-d2f5-4f02-9fad-3e3921b0da70)
  informed the finite positioning-to-countdown hierarchy.
- [Opal immersive session](https://mobbin.com/screens/b7a85dff-8e86-4211-9dec-73f5bf2ac492)
  informed the full-screen focus and removal of competing cards.
- [Apple Vision body-pose guidance](https://developer.apple.com/documentation/Vision/detecting-human-body-poses-in-images)
  supports confidence-gated joints, full-body framing, and normalized image
  coordinates.
- [MediaPipe Pose Landmarker](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker)
  supports timestamped live-stream landmarks and presence/tracking thresholds.
- [Onform athlete capture](https://onform.com/video-analysis-for-athletes/)
  informed the hands-free capture-to-concise-clip workflow.
