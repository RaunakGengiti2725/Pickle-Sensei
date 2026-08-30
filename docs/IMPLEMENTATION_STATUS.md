# IMPLEMENTATION STATUS

Statuses: NOT_STARTED | IN_PROGRESS | BLOCKED | IMPLEMENTED | TESTED. `IMPLEMENTED` means code exists; it does not mean a model or metric has passed product release validation.

Last reviewed: 2026-08-28

## Intelligence platform status (do not blur these categories)

**WORKING NOW** (running on a phone/simulator today):

- Native capture with live pose, automatic trigger, private clip, durable evidence (iOS + Android)
- iOS pose-sequence sidecar retention (`pickle.pose-sequence.v1`, hashed, hash ENFORCED before analysis) + capture-artifact reader bridge
- Stroke declaration UI (declared vs predicted stored separately)
- Canonical swing domain model + serialization (`@pickle/swing-domain`)
- Multimodal fusion engine `analyzeCapture` with abstention, provenance, evidence, shadow support
- Deterministic providers: phase.geometry, biomech.geometry, scorer.sm-v1, faults, uncertainty, coaching
- Model registry resolution (`@pickle/model-registry`), permit-gated on-device analysis runner, immutable multi-analysis storage (`local_analysis_record`)
- Evaluation harness + synthetic-provenance benchmarks (`pnpm eval:*`)
- **swing-lab research loop** (`docs/PERCEPTION.md`): desktop extract (same ApplePoseProvider as the phone) → canonical parse → capture-quality gate → offline stroke window → evidence-fused contact estimate → same fusion engine → printed verdict + overlay video; verified end-to-end on real footage
- **Paddle perception v1** (`docs/PERCEPTION.md` §5b, frozen as `paddle.dfine-coco-proxy.v1`): D-FINE COCO-proxy detector (Apache-2.0) + two-stage pose-gated tracker → canonical `PaddleTrack` reaching the fusion engine (`modalities.paddle=true` on real footage); paddle overlay (box/conf/track id/trail/lost-marker/coverage strip); REAL benchmark (2 videos / 28 labeled frames / 1 annotator: P 0.53, R 0.53) — PARTIAL REAL-VIDEO BASELINE, uncalibrated heuristic confidence, no paddle-trained model yet
- **Ball perception v1** (`docs/PERCEPTION.md` §5c, frozen as `ball.motion-diff-tracker.v1`): temporal motion-candidate pipeline (3-frame differencing → global association → physics/context/body-dwell gates) → canonical `BallTrack` (`modalities.ball=true` on real footage); REAL benchmark (10 ball-labeled frames: volley P 1.00 / R 0.67, median error 11px) with measured temporal ablation and preserved failure exhibits — PARTIAL REAL-VIDEO BASELINE
- Contact estimation v3: independent paddle/wrist/ball evidence signals; `ballConfirmed`/`paddleConfirmed` require presence at the fused moment (lost-at-contact revokes confirmation); real-footage volley contact within 1 frame of the human label with ball+paddle confirmation
- **Two-source corpus + per-source benchmarking** (`docs/PERCEPTION.md` §5d): Wikimedia CC BY outdoor + US Navy/AFN public-domain indoor; benches print per-source rows, coverage gaps, and confidence-class breakdowns; `pnpm lab:dataset-report` prints dataset state; failure reviews + regression exhibits under `datasets/*/failure-review.json` and `failures/`
- **Stroke recognition heuristic** (`stroke-heuristic-1`, hierarchical, uncalibrated): REAL benchmark n=3 — L1 3/3, L2 2/3, L3 honestly abstained (bounce unobserved); declared/annotated/predicted kept separate — PARTIAL REAL-VIDEO BASELINE
- **Phase segmentation reality check**: first real boundary labels (12) show the synthetic-tuned wrist-geometry segmenter erring 870–1280ms median on real video while a paddle-speed baseline hits 20–162ms — real phase segmentation must be rebuilt on the paddle track (measured, evidence-backed)
- **Dataset engine (pickle-real-v0.1)**: immutable hash-sealed release (5 sources / 10 files / 5 annotated cases / 5 training-ready target events), session-split with leakage audit (1 documented wm limitation), integrity checks (provenance, duplicates, label sanity, contact-inside-event, phase ordering), training-justification verdicts (`training-justification.json`: every learned task honestly BLOCKED_ON_DATA with floors); `pnpm lab:dataset-release`, `pnpm lab:data-gaps`
- **Held-out tier real result** (afn-vic-2025, single run): target locked (conf 0.87), BLUE ball tracked (35 obs), contact 714ms vs label 680±1 = 1.0 frame, stroke L1/L2 correct; paddle proxy missed the bright paddle (R 0.00) — plus preserved SCENE_CUT_UNDETECTED exhibit from the first cut
- Kinetic-sequence research artifacts: per-run `sequence.json` (masked pose/paddle/ball timesteps, contact-relative time) + experimental hip/shoulder/wrist/paddle peak ordering in clip reports
- Multi-person pose robustness: largest-torso primary-person selection with temporal stickiness (`ApplePoseProvider`)
- Capture-quality gate, offline trigger, contact-evidence estimator, trajectory ball-candidate gating (`@pickle/vision-geometry`, `@pickle/swing-lab`)
- Consent-gated dataset exporter (not_asked ≡ denied, no override), local annotation bench (structured multi-annotator labels), real-benchmark manifests with player-grouped deterministic splits and [REAL]/[SYNTHETIC] report banners

**PARTIALLY IMPLEMENTED**:

- Android pose-sequence sidecar (code written symmetric to iOS; NOT compiled/verified — no Java runtime on the dev machine)
- Shot sync of on-device scores (client complete; server rejects until an audited sm-v1 release record exists — by design)
- Consent plumbing (`training_consent` column + domain types + consent-gated exporter exist; no in-app consent UI yet)

**ARCHITECTURE READY** (contracts, registry, storage, and fusion slots exist; drop-in when a real model lands):

- Stroke classifier (`IStrokeClassifier`), paddle detector/tracker, ball detector/tracker, court detector, camera calibrator, temporal feature encoder (`ITemporalFeatureEncoder`), learned technique scorer, shadow deployment, server/hybrid execution targets, downloadable model manifests, 3D landmarks (optional `z` + explicit coordinate systems), reprocessing of historical captures, player-profile personalization

**REQUIRES DATA** (consent-first first-party collection; zero cleared public datasets — see `datasets/pickleball/registry.json`; the collection/annotation/export pipeline itself now exists — `docs/PERCEPTION.md` §5):

- Any learned model above; expert-rated scoring benchmarks; coach-agreement evaluation

**REQUIRES TRAINING** (after data exists): stroke classifier, phase model, paddle/ball trackers, temporal representation, learned scoring/fault models

**REQUIRES VALIDATION** (before any user-facing claim): sm-v1 targets against a coach panel; pose accuracy per coaching metric; every learned model against frozen holdouts + release gates

## Product truth at a glance

- The native camera is wired on iOS and Android. It automatically watches for player motion; there is no manual stroke picker.
- Live pose is real: Apple Vision on iOS and bundled MediaPipe BlazePose on Android drive the body heat map. The colored glow is calculated from successive observed joint positions. The detected interval now persists a cross-platform v1 summary of real pose attempts, visibility, coverage, and sparse per-joint movement. It is a motion visualization, not a muscle map, injury assessment, or coaching diagnosis.
- A short private clip is retained around the motion trigger. Without a validated pickleball classifier and scoring bundle, the capture remains `unknown`/`awaiting_model`; no stroke label, score, drill, or improvement claim is invented.
- Calibrated ball tracking is not implemented, so the app does not display MPH.
- Live Court scoring is unavailable. Cue/session logic and native TTS exist, but they are not exposed as a working coaching loop without validated repetitions and scores.
- The production training catalog contains no seeded placeholder drills or media. It remains empty until reviewed, rights-cleared content is published.
- The account service enforces two lifetime free successful ratings followed by a hard entitlement gate. Only a successful server-accepted rating consumes one; current `awaiting_model` captures consume none.
- Seeded scoring configurations are validating hypotheses, not active releases. Migration `0013` leaves a fresh database with zero active scoring models and makes canonical score sync require an audited, evidence-backed release record.
- Deterministic data may be used by tests of pure math and orchestration. It is isolated to test code and is not a production/demo inference path.

## Foundation and backend

| Item                                                                                                                                                   | Status                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Monorepo, strict TypeScript, lint/format, Vitest, CI                                                                                                   | TESTED                                                                    |
| PostgreSQL migrations, account/profile/onboarding, owner-scoped shot/session data, permit-bound sync, progress, catalog, privacy, and entitlement APIs | TESTED                                                                    |
| Analysis-permit accounting: two successful ratings, atomic consume/release, replay and cross-user protection                                           | TESTED                                                                    |
| Scoring release integrity: 100%-active SHA-256 bundle, dataset/evaluation/coach evidence, releasing admin, exact shot-config binding                   | TESTED                                                                    |
| Cloud deep analysis worker                                                                                                                             | NOT_STARTED; endpoint returns typed 501 and releases the permit           |
| Apple/Google store receipt validation                                                                                                                  | BLOCKED on production credentials; never substituted with a local success |
| Reviewed drill and instructional-media catalog                                                                                                         | BLOCKED on content review/licensing; zero placeholder entries published   |
| Learned stroke, paddle, phase, and scoring models                                                                                                      | BLOCKED on consented data, expert labels, validation, and release gates   |
| Calibrated ball tracker / true speed measurement                                                                                                       | NOT_STARTED                                                               |

## Mobile

| Item                                                                                                                                       | Status                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Premium design system, onboarding, home, library, progress ranges, settings/privacy, fixed bottom navigation, animated Coach action        | IMPLEMENTED and simulator-reviewed                                                                                                                                                                                                               |
| Evidence-driven guided-camera state story and direct Auto Analyze launch                                                                   | IMPLEMENTED; physical-device visual and accessibility validation pending                                                                                                                                                                         |
| Account-first hydration and account-scoped SQLite/outbox/profile state                                                                     | TESTED                                                                                                                                                                                                                                           |
| Canonical onboarding sync and canonical progress hydration                                                                                 | TESTED                                                                                                                                                                                                                                           |
| Hard navigation gate for analysis/Live Court and canonical subscription access                                                             | IMPLEMENTED                                                                                                                                                                                                                                      |
| iOS native camera: AVFoundation, Apple Vision live pose, measured motion glow, automatic trigger, private pre/post clip + durable evidence | TESTED by 10 Swift tests and simulator build; physical-device validation pending                                                                                                                                                                 |
| Android native camera: CameraX, MediaPipe live pose, measured motion glow, automatic trigger, private pre/post clip + durable evidence     | TESTED by 12 focused JVM tests/debug APK; physical-device validation pending                                                                                                                                                                     |
| Automatic pickleball stroke recognition                                                                                                    | BLOCKED on validated classifier; returns `unknown`. Declared stroke (user input) is captured separately and drives scoring config selection until then                                                                                           |
| Numeric form score/checkpoints/personalized correction                                                                                     | IMPLEMENTED end to end on-device: pose-sequence sidecar → `analyzeCapture` fusion → sm-v1 → immutable `AnalysisRecord` + permit-gated rating; targets remain hypotheses pending coach validation; server sync requires an audited release record |
| True ball speed                                                                                                                            | BLOCKED on calibrated ball tracking; no MPH shown                                                                                                                                                                                                |
| Saved drills/training-plan persistence                                                                                                     | IMPLEMENTED against real catalog records; catalog is empty until reviewed content is published                                                                                                                                                   |
| Live Court                                                                                                                                 | UNAVAILABLE until automatic repetitions and scoring pass release gates                                                                                                                                                                           |

## ML and content

| Item                                                                                          | Status                                                |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Exact 61-technique taxonomy plus `unknown_technique`/`no_stroke`/`partial`/`aborted` outcomes | IMPLEMENTED                                           |
| v2 annotation/manifest schemas and consent/rights/two-annotator/coach release gates           | TESTED — 17 validator unit tests passing              |
| Commercially cleared temporal pickleball training dataset                                     | NOT_AVAILABLE; registry records zero cleared datasets |
| Coach-adjudicated holdout and production model bundle                                         | NOT_STARTED                                           |
| Rights-cleared human instruction videos                                                       | NOT_PUBLISHED                                         |

## Release blockers

1. Acquire consented, rights-cleared, representative pickleball video and expert labels.
2. Train and validate stroke, paddle, phase, feature, and scoring models against frozen quality/fairness gates.
3. Validate native capture and thermal behavior on representative physical iOS and Android devices.
4. Publish reviewed drills and licensed/owned human instruction media.
5. Configure and verify App Store / Play purchase credentials and server notifications.
6. Release Live Court only after the complete repetition-to-score-to-cue loop passes its measured gates.
