# P — Latency Map & Attack Plan (Wave A)

**Target:** one guided stroke → feedback: ideal ≤2s, strong ≤3s, max ≤5s.
**Scope of numbers:** everything below is measured on the development **Mac**. **PHYSICAL IPHONE NUMBERS DO NOT EXIST.** Every on-device projection is BLOCKED_EXTERNAL until hardware runs happen (see §6).

All measurements are file-backed: `datasets/experiments/wave-a/P-runs/P-measurements.json` (fresh runs, this workstream), `datasets/paddle-bench/runs/*/report.json` (bench timings), `datasets/experiments/EXP-2026-08-28-roi-keyframe-grid.json` (stride/ROI grid).

---

## 1. Measured baseline (Mac)

### 1.1 What the bench reports do and don't record

Six run dirs exist under `datasets/paddle-bench/runs/` (task brief said 5). The five current-schema reports record **only the cheap TS stages** — the heavy stages are absent because bench runs use `--reuse-extract`, which skips extraction (`analyzeVideo.ts:208-216`), paddle detection (`:831-853`), and ball candidates (`:1043-1064`), so those timers never fire. `wm-far-03/report.json` is an older-schema run that did record heavy stages.

| case (report.json .timings) | player | prePass | paddleTrack | ballTrack | eventIso | fusion |
|---|---|---|---|---|---|---|
| afn-sasebo-rally1 | 10ms | 1ms | 12ms | 94ms | 1ms | 28ms |
| afn-sasebo-rally2 | 9ms | 2ms | 20ms | 99ms | 2ms | — |
| afn-vic-rally1 | 6ms | 1ms | 12ms | 68ms | 1ms | — |
| wm-dink-01 | 13ms | 3ms | 42ms | 111ms | 1ms | — |
| wm-volley-02 | 16ms | 1ms | 25ms | 80ms | 1ms | 34ms |
| wm-far-03 (old schema) | — | — | 9ms | — | — | — (poseExtract **5598ms**, paddleDetect **19757ms**, overlay 671ms) |

`fusionAnalysisMs` is absent whenever the quality gate aborts before stage 6 (`analyzeVideo.ts:723-730`). **Missing everywhere in current-schema reports:** poseExtractMs, paddleDetectMs, ballCandidatesMs, total wall-clock.

### 1.2 Fresh sandbox measurement (permitted single dev case: afn-sasebo-rally2)

Sandbox copy at `datasets/experiments/wave-a/P-runs/afn-sasebo-rally2`; two runs from `packages/swing-lab` (full transcription: `P-runs/P-measurements.json`).

**Run A — cold, no `--reuse-extract`: total 55.07s wall**

| stage | measured | notes |
|---|---|---|
| pose+trajectory+scene extraction | **6,012ms** (`poseExtractMs`) | swing-lab `extract` (main.swift:108-194) |
| paddle detector subprocess | **43,675ms** (`paddleDetectMs`) | event-gated span 1,967ms, 74 frames, stride 1, MPS |
| — of which model load | 2,075ms | paddle-dets.json `.timing.modelLoadSec` |
| — of which pure inference | 9,203ms (124.4ms/frame) | `.timing.inferenceSecTotal` |
| — of which decode+postproc residual | ~17.1s | `.timing.wallSecTotal` 26.34s − inference (ffmpeg rawvideo full-res pipe, detect_paddle.py:59-80) |
| — of which process fixed overhead | ~15.3s | 43.68 − 26.34 − 2.08: python + torch/transformers import + HF Hub check (unauthenticated-hub warning printed) |
| ball candidates subprocess | **2,803ms** (`ballCandidatesMs`) | self-timed 1,803ms ⇒ ~1.0s python/numpy startup |
| all TS stages (player/prePass/track/eventIso) | ~126ms combined | see table above |
| node/tsx startup + orchestration | ~1.2s | from Run B |

**Run B — with `--reuse-extract`: total 1.25s wall** (everything downstream of the three heavy artifacts, including node/tsx startup).

**Detector fixed-cost micro-bench** (600ms span, 18 frames, three fresh processes — `P-runs/P-detector-fresh*.json`):

| variant | real | modelLoad | inference | derived fixed overhead |
|---|---|---|---|---|
| fresh (weights on disk) | 33.7s | 3.3s | 13.8s (768.9ms/f — first-inference MPS compile) | ~10.3s |
| warm repeat | 20.2s | 2.0s | 3.6s (200ms/f) | ~10.0s + 2.0s load ≈ **12s/invocation** |
| warm + `HF_HUB_OFFLINE=1` | 16.3s | 0.7s | 4.2s | ~5.6s (hub check ≈ −3.9s) |

**Reconciliation with the "~23s research path (pose ~6.9s, detector ~14.6s)" prior:** that prior is consistent with detector *inference+load* on a full window (ROI-grid artifact recorded 12.2s inference stride-1 on rally1, "fixed model-load overhead per run (~2-4s)" — EXP-2026-08-28-roi-keyframe-grid.json:7,27; wm-far-03 recorded paddleDetectMs 19,757ms). The fresh cold run shows the *true end-to-end* cost is dominated by per-invocation process overhead (~12-15s) + decode residual (~17s at this span) that the earlier numbers did not include. Both are real; they measure different things.

### 1.3 Stride/ROI lever (measured elsewhere, artifact-cited)

`EXP-2026-08-28-roi-keyframe-grid.json`: rally1 stride1-full 12.2s inference → stride3+targetROI 4.0s at equal S0 recall (0.846); volley 6.1s → 2.2s with recall 0.25→0.5. Shortlisted operating point: **stride 3 + target ROI ≈ −65% detector compute** (findings[2]). Caveats: S0-only, n=21 labels, full-cascade validation required before promotion (caveats[0-1]). Note: ROI is a *quality* lever, not per-frame-latency (ms/frame ~constant, findings[2]); stride does not reduce ffmpeg decode (detect_paddle.py:121 skips inference only).

---

## 2. Critical path — stage DAG (from `packages/swing-lab/src/analyzeVideo.ts`, read fully)

```
extract (L208-216: pose.json, people.json, ball.json, scenes.json, extract-meta.json)   [6.0s]
  └─ parse (L241-246)
      └─ player identity ← people.json (L261-350)                                        [~10-20ms]
          └─ scene validity ← scenes.json (L353-379)
              └─ quality gate (L385) → stroke window (L389-410)                          [~ms]
                  ├─ ball-modality resolve ← ball.json (L426-441)
                  ├─ event PRE-PASS — POSE ONLY (L444-452; paddleSpeeds:null L447)       [1-3ms]
                  │    └─ detectSpan (L456-477)
                  ├─ PADDLE stage (L480-487; runPaddleStage L803-919)
                  │    ├─ python detect_paddle.py (L841-852) ← video + detectSpan ONLY   [43.7s cold]
                  │    └─ track build/select (L855-878)                                  [12-42ms]
                  ├─ BALL stage (L493-499; runBallStage L1020-1120)
                  │    ├─ python ball_candidates.py (L1052-1063) ← video + window±1.2s   [2.8s]
                  │    │      (L1040-1041) — does NOT read paddle output
                  │    └─ buildBallTracks/select ← NEEDS paddle observations             [68-134ms]
                  │           (L1067-1076; paddle param wired at L497)
                  └─ event isolation ← wrist + paddle speeds (L508-517)                  [1-2ms]
                      └─ contact ← ball track + paddle speeds/centers (L556-573)
                          └─ contact-aware ball relink (L580-617)
                              └─ final target event ← contact (L629-667)
                                  ├─ classifyStroke ← targetEvent+contact (L676-687)
                                  ├─ buildStrokeSequence ← targetEvent+contact (L689-698)
                                  └─ phases v1/v2 ← contact (L702-721)
                                      └─ fusion analyzeCapture (L734-777)                [28-34ms]
                                          └─ (optional) overlay (L1253-1272)             [671ms, wm-far-03]
```

**Paddle ∥ ball concurrency — verified YES for the expensive parts.** The two python subprocesses share only the video path and time spans as inputs and write disjoint outputs (`paddle-dets.json` L824, `ball-candidates.json` L1038). `ball_candidates.py` is invoked with video+window only (L1052-1063) — the paddle result is consumed **only** by the cheap TS association step (`buildBallTracks`, L1067-1072; `selectPrimaryBallTrack` context L1073-1076; 68-134ms measured). Today both run via blocking `execFileSync` (L841, L1052) — strictly sequential. Ball candidates need only the stroke window (known at L398), i.e. it can launch even *before* the pre-pass; the detector needs the pre-pass detectSpan (L469). Bonus complementarity: ball is CPU (numpy/scipy), detector is MPS GPU.

**Contact vs stroke-sequence — verified NO (strictly sequential).** `buildStrokeSequence` consumes `analysisScope` (L691) derived from `targetEvent` (L672-675), which is selected with `estimatedContactMs` (L664-666), which comes from contact estimation (L561-573, refined L629-663); it also consumes `contactMs` directly (L692). Same for `classifyStroke` (L680). Parallelizing would change semantics — and is pointless: everything from event isolation to fusion measures <200ms combined. `classifyStroke` and `buildStrokeSequence` are mutually independent (L676-698) but both ms-scale.

---

## 3. Mobile path — what is recomputed that capture already computed

**Live capture (iOS, per frame):** `apps/mobile/ios/LocalPods/PickleNative/Sources/GuidedCaptureViewController.swift` — `poseProvider.extractPose(pixelBuffer:timestampMs:)` on the vision queue (**L352**; provider instantiated L37) using `ApplePoseProvider` (`native/vision-core/Sources/ApplePoseProvider.swift:35-72`; the pod copy `apps/mobile/ios/LocalPods/PickleNative/Sources/Core/ApplePoseProvider.swift` is byte-identical — verified by diff). Frames are retained in a 15s ring buffer (`poseHistory`, L92-93, L373-383).

**At stroke detection:** the retained history is exported beside the clip — `GuidedCaptureViewController.swift:546-557` → `ClipMediaStore.exportStrokeWindow` → `writePoseSequenceSidecar` (`ClipMediaStore.swift:135-142`, writer at L222-280), format **`pickle.pose-sequence.v1`** — the *same wire format* the desktop extractor writes (`native/swing-lab/Sources/main.swift:206-213`).

**Post-capture on the phone today:** `apps/mobile/src/screens/AnalyzeScreen.tsx` — technique declared (L274-275), camera launched (L361), zero-touch score kick-off (L388) → `apps/mobile/src/analysis/runCaptureAnalysis.ts`: reads the sidecar (L89), hash-verifies (L97), parses (L104-110), and runs `analyzeCapture` with **paddle and ball `unavailable`** (L143-144). **Pose is NOT recomputed on the phone today** — the phone path already reuses capture-time pose.

**Where the recomputation lives:** the research pipeline — the thing Wave B ports on-device — re-runs the *same* `ApplePoseProvider` over every frame of the already-recorded video: `analyzeVideo.ts:208-216` → `swing-lab extract` (`main.swift:108-194`), which recomputes per frame: multi-person poses (`extractAllPoses`, L169), primary pose (`extractPose`, L182), Vision ball trajectories (L119-129, 163-164), and scene histogram (L146-162). Measured cost: **6,012ms** fresh run / 5,598ms wm-far-03.

**Wave B pose-reuse integration (the ~6s candidate):** feed the ported paddle/ball/event stages from the capture sidecar instead of re-extracting. Parity gaps to resolve, with receipts:
- The sidecar holds only the **primary person** (live path uses `extractPose`, GuidedCapture L352); offline identity needs `people.json` (`analyzeVideo.ts:261-350`). But on-device the identity problem is *already solved live*: start-region tap → walk-out → occupancy/gesture lock (`GuidedCaptureViewController.swift:630-656, 695-756`), which seeds the provider anchor (`lockTarget` L758-768 → `setPrimaryPersonSeed`, ApplePoseProvider.swift:116-118). The offline player-track+seed machinery replicates on the Mac what the phone did live — so on-device it can be skipped, not ported.
- Ball trajectories (`ball.json`) and `scenes.json` are extract byproducts (main.swift L119-129, L146-162). Wave B must either accumulate them live at capture (the trajectory request is already stateful/streaming-fed, main.swift:120-127) or accept a slim post-pass; guided capture's single-shot recording makes scene cuts a non-issue on-device.

---

## 4. Prewarm plan

**Inventory of initializations (all measured on Mac unless noted):**

| resource | where it initializes | measured cost | prewarmable? |
|---|---|---|---|
| D-FINE python process: interpreter + torch/transformers imports + HF Hub check | every `runPaddleStage` spawn (`analyzeVideo.ts:841-851`); imports at `detect_paddle.py:29-31,105` | ~10.0s/invocation warm; hub check ≈ 3.9s of it (micro-bench, §1.2) | YES — persistent worker, or `HF_HUB_OFFLINE`/local snapshot |
| D-FINE weight load (`from_pretrained` → MPS) | `detect_paddle.py:107-110` | 2.0-3.3s (0.7s with hub offline) | YES — keep model resident |
| first-inference MPS graph compile | first frame of each fresh process | 768.9 vs 200-235 ms/frame steady ⇒ ~0.5-0.6s | YES — one dummy inference at warmup |
| ball_candidates python startup | `analyzeVideo.ts:1052-1062`; imports `ball_candidates.py:27-28` | ~1.0s (2,803 TS-measured − 1,803 self-timed) | YES — same worker treatment |
| Swift extractor binary build | first run only (`ensureSwiftBinary`, `analyzeVideo.ts:175-181`) | one-time `swift build` | lab-only concern |
| Apple Vision body-pose model | lazily at first `perform` (`ApplePoseProvider.swift:36-38`) | not separately measured | ALREADY WARM on-device — live pose runs from camera start (GuidedCapture L352), so the product flow itself is the warmup |
| node/tsx | lab CLI only | ~1.1s | lab-only |

**The user's free setup time** (files: `AnalyzeScreen.tsx`, `GuidedCaptureViewController.swift`):
T0 technique select (AnalyzeScreen L274-275, picker L634) → T1 "Opening camera…" (L352-356 → native VC) → T2 tap start region ("Tap where you'll be standing", GuidedCapture L300, tap L630-656) → T3 **walk-out** (`waitingForOccupant` L46; the user physically walks onto the court — L645 comment: "the user is walking away") → T4 lock (L758-768) → armed (L404-415) → swing.

**What to prewarm when:**
1. **At T1 (camera open):** start the detector worker (spawn python, import torch, load D-FINE, run one dummy inference). Measured bound: this removes **~12-13s + ~0.6s first-inference compile** from the analysis critical path on Mac. The walk-out phase alone is comfortably longer than the ~15s cold warmup measured in fresh1 (§1.2), so by swing time the worker is resident.
2. **At T1:** start the ball-candidates worker (removes ~1.0s).
3. **Immediately (config, not timing):** point the detector at a local snapshot / set hub-offline for invocations — measured −3.9s/invocation even without a worker.
4. **On-device pose (Wave B):** nothing to do — capture flow already warms Vision; keep it warm by not tearing the session down between lock and stroke.
Savings NOT bounded by measurement: none claimed — every number above traces to §1.2.

---

## 5. Budget table & top-5 actions

End-to-end, Mac, afn-sasebo-rally2 event-gated span (1,967ms detect span; 74 frames stride-1). M = measured, P = projected arithmetic on measured components.

| stage | today (M) | + prewarm/worker (P) | + stride3+ROI (P) | + pose reuse (P) | + ball∥paddle (P) |
|---|---|---|---|---|---|
| pose/trajectory/scene extract | 6.01s | 6.01s | 6.01s | **0** (capture-time sidecar) | 0 |
| detector fixed overhead (proc+imports+hub+load) | ~15.3s | **~0** (resident worker) | ~0 | ~0 | ~0 |
| detector inference | 9.20s | 9.20s (+first-frame compile absorbed at warmup) | **~3.2s** (−65%, EXP grid) | ~3.2s | ~3.2s |
| detector decode+postproc residual | ~17.1s | ~17.1s | ~17.1s (stride skips inference only, detect_paddle.py:121) | ~17.1s | ~17.1s → **hidden/reduced only by action #5** |
| ball candidates | 2.80s | ~1.8s (worker) | ~1.8s | ~1.8s | **~0 visible** (runs under detector wall) |
| TS stages + fusion | ~0.2s | ~0.2s | ~0.2s | ~0.2s | ~0.2s |
| **total (Mac)** | **~55s (M: 55.07)** | **~34s** | **~28s** | **~22s** | **~21s; ~4-6s if action #5 lands** |

The last cell is the honest shape of the problem: after the four known levers, the Mac path is **decode-bound** — the detector's full-res ffmpeg rawvideo pipe (~230ms/frame measured residual) is the remaining monster, and it is a *lab-tool* artifact, not physics. On-device Wave B decodes natively and never pipes raw 1080p through a subprocess — but **no iPhone number exists for any row** (§6).

**Top-5 ranked actions:**
1. **Persistent prewarmed detector worker** (removes ~12-15s fixed, M §1.2). Targets: `tools/paddle-lab/detect_paddle.py` (worker/serve mode), `packages/swing-lab/src/analyzeVideo.ts:803-919` (`runPaddleStage` spawn→IPC). Interim zero-risk step: local model snapshot / hub-offline (−3.9s, M).
2. **Stride-3 + target-ROI operating point** (−65% detector inference, M in EXP-2026-08-28-roi-keyframe-grid). Targets: `detect_paddle.py` already accepts `--stride/--roi` (L89-103); `analyzeVideo.ts:841-851` doesn't pass them — add flags + ROI from target track. GATE: full cascade + paddle/ball/event benches before promotion (EXP caveats[0]).
3. **Detector decode-path fix** (~17.1s residual at this span, M §1.2). Targets: `detect_paddle.py:59-80` (`frame_iter`): decode at reduced resolution (D-FINE input is fixed-size anyway — EXP findings[2]) and/or decode only stride frames (`-vf select`), and/or one shared decode pass feeding both paddle and ball tools.
4. **Capture-time pose reuse (Wave B)** (−6.0s, M). Targets: consume sidecar (`ClipMediaStore.swift:222-280` writer; `runCaptureAnalysis.ts:89-110` reader) in the ported pipeline instead of re-running extract (`analyzeVideo.ts:208-216`, `main.swift:108-194`); skip offline identity on-device (live lock: `GuidedCaptureViewController.swift:630-656, 695-768`); decide live-vs-postpass for trajectories/scenes (main.swift:119-129, 146-162).
5. **Run ball_candidates concurrently with the detector** (−2.8s visible, M; ball needs only the stroke window, `analyzeVideo.ts:1040-1063`; only the 68-134ms association step needs the paddle track, L1067-1076). Targets: `analyzeVideo.ts:480-499` — replace the two `execFileSync` calls (L841, L1052) with concurrent spawns joined before L1067. Contact→stroke-sequence is NOT a parallelization candidate (strict data deps, L664-698; <200ms total).

---

## 6. BLOCKED_EXTERNAL — iPhone numbers require hardware

Every number in this document was measured on a Mac (MPS/AVFoundation/ffmpeg + python). The product target (≤2s/≤3s/≤5s) is defined **on iPhone**, where: pose runs live per-frame already (different cost), the D-FINE proxy detector does not exist as a CoreML artifact, decode is native, and thermal/ANE behavior is unknown. **No measurement in this repo speaks for iPhone latency. Obtaining device numbers (instrumented capture→feedback wall-clock on physical hardware) is a hard external dependency for Wave B and is explicitly not claimable from Mac data.**
