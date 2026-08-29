# PERCEPTION — the research loop that makes the models real

This document covers the intelligence-building layer added on top of the
platform architecture: the desktop research harness (`swing-lab`), the
capture-quality and evidence policies, and the data/benchmark pipeline that
turns real footage into ground truth. For the runtime architecture see
`docs/ML_SYSTEM.md`; for scoring math see `docs/SCORING.md`.

Ground rule, same as everywhere in this repo: **measured or absent.** Every
gate below either produces a measured value with provenance or an explicit
reason string. Nothing is interpolated into existence.

## 1. swing-lab: video in → verdict + overlay out

Two halves, one loop:

```
native/swing-lab (Swift, macOS)                 packages/swing-lab (TS)
  extract <video> --out <dir>                     analyze:video <video>
    AVAssetReader (upright frames)                  parsePoseSequence   ← same parser as the phone
    ApplePoseProvider                ← SAME          evaluateCaptureQuality
      class the phone runs                          detectOfflineStrokeWindow
    VNDetectTrajectoriesRequest                     resolveBallModality (gates below)
    → pose.json (pickle.pose-sequence.v1)           estimateContact (evidence fusion)
    → ball.json (trajectory candidates)             analyzeCapture      ← same fusion engine as the phone
    → extract-meta.json                             → analysis.json + debug.json + report.json + printed report
  overlay <video> --pose --analysis --out          frame <video> --ms → PNG still
    skeleton + wrist trail + ball candidates
    + phase bands + contact marker + playhead
```

- `pnpm lab:analyze <video> [--stroke X] [--overlay] [--reuse-extract]`
- The Swift side depends on `native/vision-core` — the pose provider on the
  desktop is byte-for-byte the class compiled into the app, so desktop
  findings transfer to the phone.
- The overlay video is the honesty instrument: every claim in the analysis
  (window, phases, contact, ball candidates) is drawn on the actual frames
  where a human can falsify it.

Verified end-to-end on real footage (animated demo clip): pose extraction
151/151 frames, quality gate passed, window detected, contact estimated from
wrist peak, ball candidates correctly rejected as scene noise (729
trajectories/s), scorer abstained at analysisConfidence 0.62 < 0.65 — the
correct verdict for that clip, with every reason printed.

## 2. Capture-quality gate (`evaluateCaptureQuality`)

Decided BEFORE scoring, from measured pose data only. Specific reason codes:
`too_few_pose_frames`, `insufficient_fps`, `low_pose_confidence`,
`body_not_fully_visible`, `player_too_small_in_frame`,
`player_too_close_or_cropped`, `tracking_dropout_gap`, `torso_not_measured`.

Checks we cannot make yet are NOT faked — the report carries
`notEvaluated: [camera_motion, paddle_visibility, lighting_failure]` until
the signals that would power them exist.

## 3. Offline stroke window + contact evidence

- `detectOfflineStrokeWindow` finds the swinging wrist's speed peak in a full
  video (replayed footage has no capture-time trigger). It abstains on idle
  motion (`offline_trigger.no_distinct_stroke`) rather than inventing a swing.
- `estimateContact` fuses whatever evidence exists — wrist speed peak (pose),
  ball direction change and ball–wrist proximity (only when a ball track
  exists) — and reports every contributing signal in `supportingEvidence`.
  One signal alone caps confidence at 0.45; signals disagreeing by >250ms
  force abstention. Contact is never presented as measured fact; it is an
  estimate with named evidence.

## 4. Ball candidates (`resolveBallModality`)

Apple's `VNDetectTrajectoriesRequest` fires on ANY parabolic mover and
assumes a stationary camera. The gate turns candidates into an honest
modality:

1. **Scene noise**: > 12 trajectories/second ⇒ the stationary-camera
   assumption is broken ⇒ `unavailable(trajectory_noise_scene_or_camera_motion)`
   and candidates are also excluded from contact evidence.
2. **Window support**: best candidate needs ≥ 35% window coverage and ≥ 6
   points, else `unavailable(trajectory_support_insufficient)`.

Only a surviving candidate becomes a measured `BallTrack` (provider
`ball.apple-vision-trajectories`, with the linear point-timing approximation
recorded in the artifact).

## 5. Dataset pipeline (consent → labels → manifest → splits)

- **Bundles**: one directory per capture — `capture.json` (with
  `TrainingConsent`), `player.json` (pseudonymous `playerId`), `clip.mp4`,
  `pose.json`, `annotation/<annotatorId>.json`.
- **Annotation bench** (`pnpm lab:annotate <dir>`): local-only server with
  frame stepping and a structured form — stroke, handedness, analyzability,
  four phase-boundary marks, per-checkpoint 0–100 scores, faults with
  severity, annotator confidence. One file per annotator; disagreement is
  preserved, revisions append to `history`.
- **Exporter** (`pnpm lab:export <dir> <dataset-id>`): the consent gate.
  `consent.state !== "granted"` (including `not_asked`) ⇒ skipped, reported,
  no override flag. Cases are keyed by SHA-256 of the exact video and
  sidecar bytes.
- **Splits**: `splitForPlayer` — deterministic hash of (datasetId, playerId),
  grouped by PLAYER so no person appears in both train and test. Growing the
  dataset never moves an existing player between splits.
- **Real vs synthetic**: `RealBenchmarkManifest` rejects
  `provenance: "synthetic"` at validation; report banners print `[REAL]` /
  `[SYNTHETIC]` so results are never conflatable.

## 5b. Paddle perception (v1 — real, benchmarked small)

Status: **PARTIAL REAL-VIDEO BASELINE** (working on real footage, benchmarked
on a small labeled set; not paddle-trained).

Pipeline (all pixels, no wrist proxies):

```
tools/paddle-lab/detect_paddle.py      D-FINE medium COCO (Apache-2.0 code+weights)
  proxy classes: tennis racket, baseball bat   ← COCO has no paddle class;
  score floor 0.12–0.15, ~67–91 ms/frame MPS      provenance records the proxy
        ↓ paddle-dets.json (pixels)
packages/swing-lab/src/paddleTracker.ts
  two-stage association (ByteTrack-style): ≥0.35 starts tracks, ≥0.15 extends
  constant-velocity prediction, ≤250ms gap, no interpolation of misses
  plausible-size gate (rejects buildings/people)
  pose-GATED selection: best (coverage × score × wrist-proximity) track;
  wrist coordinates never become paddle observations
        ↓ canonical PaddleTrack (paddle.dfine-coco-proxy, normalized coords)
analyzeCapture: modalities.paddle = true (measured) | unavailable(reason)
estimateContact: + paddle_speed_peak signal; ballConfirmed flag says whether
  any BALL evidence corroborates (motion-only estimates say so)
overlay.mp4: magenta box + center + confidence + track id + trail,
  "paddle lost" marker on in-window misses, coverage strip on the timeline
```

Per-observation confidence is **heuristic-v1 (uncalibrated)** — detector
score × local continuity × wrist proximity — and is labeled as such in every
artifact.

Real-video results (2026-08-28, Apple M-series, MPS):

| clip (real, CC BY) | quality gate | paddle track | contact |
|---|---|---|---|
| wm-dink-01 (rear dink) | REJECTED body_not_fully_visible | TRACKED 50% window coverage, wrist dist 0.064 | paddle+wrist fused, motion-only |
| wm-volley-02 (rear-side volley) | ANALYZABLE | TRACKED 73%, paddle=true reached fusion | paddle@6700 + wrist@6680 → conf 0.64 |
| wm-far-03 (far court, walk-in) | REJECTED player_too_small | excluded from benchmark: primary subject ill-defined (failure exhibit) | — |

REAL PADDLE BENCHMARK (`pnpm lab:paddle-bench`, point labels, hit radius
0.08 norm): **videos 2 · annotated frames 28 · annotators 1** —
precision 0.53, recall 0.53, median center error 0.010–0.073 when hit.
Sample size is tiny and printed first; occluded-frame "false positives" may
partly reflect conservative labels (single annotator). Grow via
`pnpm lab:annotate datasets/paddle-bench/bundles` (click-to-label paddle
points, visible/occluded/absent).

Known failure modes measured so far: paddle hidden in front of body between
strokes (rear view), multi-person primary-subject ambiguity (pose anchor
stickiness added in `ApplePoseProvider.primaryPerson`; walk-ins can still
steal focus), COCO-proxy misses on edge-on paddles at distance. Missing
coverage (not yet in corpus): left-handed near player confirmed, bright/white
paddle close-up, indoor lighting, deliberate motion blur, true side view.

On-device outlook (not done): D-FINE exports to ONNX; Core ML conversion is
plausible but unverified. The domain contracts are runtime-neutral, so a
Core ML or server deployment slot into the same `PaddleTrack` provenance.

## 5c. Ball perception (v1 — real, benchmarked small) + contact v3

Status: **PARTIAL REAL-VIDEO BASELINE** (`ball.motion-diff-tracker.v1`,
frozen in `datasets/ball-bench/baselines.json`).

Ball perception is TEMPORAL by construction — never per-frame classification:

```
tools/paddle-lab/ball_candidates.py     3-frame differencing + connected
  numpy/scipy (BSD), deterministic        components; ~3-6 ms/frame; emits a
  candidates only, ball decided later     chronic-background-motion grid
        ↓ ball-candidates.json (~40 candidates/frame incl. reserved small-blob slots)
packages/swing-lab/src/ballTracker.ts
  global lowest-cost association (constant-velocity prediction, ≤130ms gaps,
    NO interpolation — every observation is a measured candidate)
  physics gates: speed ceiling/floor, turn-smoothness, blob size
  context gates: chronic-motion cells, pose-derived play band, body-dwell
    (shirt/limb blobs live on the body; balls only graze it)
  primary selection: window overlap × length × speed × straightness ×
    paddle affinity; with a paddle track present, a primary ball MUST have
    approached it (learned from failure BALL_FALSE_POSITIVE_BACKGROUND)
        ↓ canonical BallTrack (ball.motion-diff-tracker, deterministic runtime)
estimateContact v3 (contact-evidence-3):
  independent signals: paddle_speed_peak, wrist_speed_peak,
    ball_direction_change, ball_paddle_proximity (wrist fallback only when
    no paddle track)
  ballConfirmed / paddleConfirmed require evidence AND presence within
    ±100ms of the fused moment; being lost at contact revokes confirmation
    (limitingFactors: ball_lost_at_contact / paddle_lost_at_contact)
```

REAL BALL BENCHMARK (`pnpm lab:ball-bench`): **videos 2 · ball-labeled
frames 10 · annotators 1** — wm-volley-02: precision 1.00, recall 0.67,
median center error 0.011 normalized (11px @1000px); wm-dink-01: honestly
UNTRACKED (its earlier background-drift false positive is preserved under
`datasets/ball-bench/failures/` as a regression exhibit). Misses are the
outgoing ball after contact (<5 observations before leaving frame).

Temporal ablation, measured on real footage (the point of the design):
raw ~1010 motion candidates/s → association ~260–290 tracks (~900 obs/s) →
physics+context ~49–70 tracks (~145–200 obs/s) → exactly one primary claim
or an honest reason.

Contact timing vs human labels (n=2, fps 25): volley 40ms = 1.0 frame error
with **ball-confirmed + paddle-confirmed** (4 independent signals fused);
dink 131ms = 3.3 frames, paddle-only (contact label uncertainty unspecified).

Annotation bench now labels paddle AND ball (visible / occluded /
not_visible / uncertain) plus a contact frame with uncertainty
(exact / ±1 / ±2 / uncertain), with ±1/±5/±10-frame navigation and keyboard
stepping. Failure artifacts (clip + overlay + debug + classification) live in
`datasets/ball-bench/failures/` and become regression tests.

## 5d. Stroke recognition + phase reality check (2026-08-28)

**Corpus**: now 2 independent source recordings (Wikimedia CC BY outdoor
tournament + US Navy/AFN public-domain indoor Sasebo event; 2 more AFN
sources registered unlabeled). Benches print per-source rows and coverage
gaps; `pnpm lab:dataset-report` prints the full dataset state.

**Stroke recognition** (`stroke-heuristic-1`, hierarchical, uncalibrated):
L1 category → L2 forehand/backhand (camera-facing-corrected midline test) →
L3 withheld (`bounce_not_observed_level3_uncommitted`) — the classifier
never claims DRIVE/VOLLEY/DINK separation it cannot defend. REAL benchmark
(n=3 labeled strokes, 3 classes): **L1 3/3 · L2 2/3 · L3 0/3 all abstained
(by design)**. The single L2 miss is a cascade from the wrong-paddle
selection failure on `afn-sasebo-rally1`. declared / annotated / predicted
stay separate fields everywhere.

**Phase segmentation — measured on real labels for the first time** (12
boundaries, ±2-frame label precision): the wrist-geometry segmenter
(baseline A, synthetic-tuned) has median boundary errors of **870–1280ms**
on real footage; a paddle-speed-only baseline (B) achieves **160ms (accel) /
20ms (contact boundary) / 162ms (follow-end)**. Evidence-backed conclusion:
real phase segmentation should be rebuilt around the measured paddle track;
the geometric segmenter does not transfer from synthetic to real video.

**Kinetic sequence (EXPERIMENTAL)**: per-run `sequence.json` carries masked
per-timestep pose/paddle/ball + contact-relative time; hip/shoulder-line
angular-speed peaks and wrist/paddle speed peaks are ordered relative to
contact in every clip report — labeled experimental, not coaching metrics.

**Known failure chain to fix next** (all preserved under
`datasets/*/failure-review.json` + `failures/`): paddle wrong-object
selection in doubles (partner's paddle) → wrong contact point → wrong stroke
side; ball body-overlap fragmentation (white shirt) → recall 0 on Source B's
contact window; no ball reacquisition after contact (designed, not
implemented — outgoing volley labels are the waiting test case).

## 5e. StrokeEvent isolation + per-event contact + phases v2 (2026-08-28)

The unit of analysis is now ONE isolated stroke event (`stroke-event-1`):
kinematic peak proposals → valley merging → MULTI_STROKE_AMBIGUOUS when
leaders are comparable → **per-event contact scan** (a ball/paddle-confirmed
contact inside exactly one event selects that event). Downstream contact,
phases, stroke classification and sequences are event-local; the window
midpoint fallback was removed everywhere (event PEAK is the only permitted
reference, explicitly flagged, never called contact).

Measured effects (no detector/phase threshold changes):
- rally1: 4 proposals → honest ambiguity → resolved to E3 by a
  ball+paddle-confirmed contact 2973ms (label 2900±1 frame)
- held-out dink: contact un-abstained → 1407ms ball+paddle-confirmed
  (label 1260±2) — the earlier regression was window contamination
- contact: n=3, 0 abstentions, median 73ms, all ball-confirmed
- phases 4-way on identical labels: geometry.v1 880–2366ms · paddle-speed
  765–1065ms · v1(+event contact) 73–197ms · **v2 event-local best
  (accel 160 / contact 73 / follow 130 / recovery 400ms), anchor-or-abstain**
- event bench (n=5 labels): target recall 2/3, start/end median 150/210ms,
  contact-inside-event 3/3, false proposals 4/7
- WRONG-PLAYER PADDLE now directly measured: 1/1 dual-labeled frame still
  selects the partner's paddle (frozen detector) — the top open failure.

## 6. Model roadmap (licensing-vetted, 2026-08)

From the commercial licensing survey (key risks: Ultralytics YOLO is
AGPL/paid-enterprise; VideoMAE/TimeSformer/V-JEPA-1 weights are
non-commercial; many "MIT code" repos ship unlicensed weights):

| Task | Safe path (code + weights) | Notes |
|---|---|---|
| Pose | Apple Vision / MediaPipe (shipping) | already the phone baseline |
| Paddle detection | RF-DETR Nano–Large or D-FINE (Apache-2.0), custom-trained | needs our labeled data; no pretrained paddle model exists |
| Ball tracking | WASB / TrackNetV3-style multi-frame heatmap architecture (MIT code), trained on our data | pretrained weights are license-unclear ⇒ treat as architecture only |
| Track association | ByteTrack / BoT-SORT / Norfair (MIT/BSD) | detector-independent |
| Ball-flight cue (on device) | `VNDetectTrajectoriesRequest` (shipping in swing-lab) | stationary camera only, gated as in §4 |
| Video embeddings (server, offline) | DINOv2 / InternVideo2 / X-CLIP (Apache/MIT) | never on the 60fps path |
| Avoid | Ultralytics YOLOv8/11 & YOLO-World (AGPL/GPL), FastSAM (license conflict), VideoMAE v1/v2 weights, TimeSformer, V-JEPA-1 (all NC) | unless paid/relicensed |

Every candidate model still enters through the registry with its own
benchmark report before it can produce a user-visible number.

## 7. What this loop still cannot do (honest limits)

- No paddle model and no trained ball model exist; the modalities stay
  `unavailable` with reasons until first-party data + training produce one
  that passes benchmarks.
- Contact from pose alone is an estimate (±1 frame at best) — treated as
  such everywhere.
- Trajectory ball candidates require a stationary camera; handheld footage
  correctly fails the noise gate.
- The animated demo clip abstains by design (analysisConfidence 0.62); the
  loop needs real tripod footage of real strokes, which is exactly what the
  dataset pipeline collects.
