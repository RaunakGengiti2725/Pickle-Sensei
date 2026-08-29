import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SHOT_TYPES, type ShotTypeSlug } from "@pickle/shared-types";
import { analyzeCapture, type FusionProviders } from "@pickle/analysis-pipeline";
import {
  CheckpointThresholdFaultDetector,
  EngineUncertaintyEstimator,
  PriorityCoachingRanker,
  Sm1TechniqueScorer,
} from "@pickle/scoring";
import {
  measured,
  parsePoseSequence,
  sha256Hex,
  toLegacyPoseFrames,
  unavailable,
  type AnalysisRecord,
  type BallObservation,
  type PoseSequence,
} from "@pickle/swing-domain";
import {
  detectOfflineStrokeWindow,
  estimateContact,
  evaluateCaptureQuality,
  GeometricPhaseSegmenter,
  GeometryBiomechanicsExtractor,
  OFFLINE_TRIGGER_VERSION,
  type StrokeFamily,
} from "@pickle/vision-geometry";
import {
  BALL_GATES,
  resolveBallModality,
  windowBallObservations,
  type TrajectoryFile,
} from "./ballCandidates.js";
import {
  BALL_CONFIDENCE_MODEL,
  buildBallTracks,
  linkBallTimeline,
  selectPrimaryBallTrack,
  type BallCandidateFile,
  type BallTimeline,
  type BallTrackCandidate,
  type BallTrackingOutcome,
  type BallTrackObservation,
} from "./ballTracker.js";
import {
  buildPlayerTracks,
  initializeTargetFromSeed,
  otherPlayersWrists,
  selectTargetPlayer,
  targetPoseSequence,
  type PeopleFile,
  type TargetSeed,
} from "./playerTracker.js";
import { segmentPhasesTemporal, segmentPhasesTemporalV2 } from "./phaseTemporal.js";
import {
  clampToScene,
  crossesCut,
  decideScene,
  type SceneDecision,
  type ScenesFile,
} from "./sceneValidity.js";
import {
  proposeStrokeEventsV2,
  selectTargetEventV2,
  STROKE_EVENT_VERSION_2,
  type StrokeEventProposal,
} from "./strokeEvents.js";
import { classifyStroke } from "./strokeHeuristic.js";
import { buildStrokeSequence } from "./strokeSequence.js";
import {
  buildPaddleTracks,
  PADDLE_CONFIDENCE_MODEL,
  mergePaddleTracklets,
  paddleSpeedSeries,
  selectPrimaryPaddleTrack,
  wristSeriesFromFrames,
  type wristSeries,
  type PaddleAssociationDecision,
  type PaddleTrackingOutcome,
  type RawPaddleDetectionFile,
  type TrackedPaddleObservation,
} from "./paddleTracker.js";
import {
  admitCropDetections,
  bridgeTrackedEstimates,
  mergeCropDetectionsIntoFile,
  PADDLE_CROP_RECOVERY_VERSION,
  paddleLostFrameTimes,
  planWristCropRects,
  type CropDetectionFrame,
} from "./paddleCropRecovery.js";
import {
  mergePaddleDetectionFiles,
  planTwoPassSchedule,
  type TwoPassSchedule,
} from "./paddleSchedule.js";
import { planPass1Roi, type Pass1RoiPlan } from "./paddleRoi.js";
import { renderReport, type LabRunReport, type PlayerStageReport } from "./report.js";
import {
  detectPaddleWindow,
  startPaddleWorker,
  type PaddleWorkerSupervisor,
} from "./paddleWorker.js";

/**
 * swing-lab analyze-video — the offline research pipeline, end to end:
 *
 *   video file
 *     → native extract (SAME ApplePoseProvider as the phone) → pose.json + ball.json
 *     → canonical parse (same parser as the phone)
 *     → capture-quality gate → offline stroke window → contact evidence
 *     → analyzeCapture fusion (same engine, scorer, and abstention rules)
 *     → analysis.json + debug.json + printed report [+ overlay.mp4]
 *
 * Nothing here is mobile-app plumbing: no permits, no DB — this is the tool
 * for studying real footage and building datasets. Every abstention is a
 * first-class outcome with its reason printed, not an error.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const SWIFT_LAB_DIR = join(REPO_ROOT, "native/swing-lab");
const SWIFT_BIN = join(SWIFT_LAB_DIR, ".build/release/swing-lab");

interface CliArgs {
  video: string;
  stroke: ShotTypeSlug;
  handedness: "right" | "left" | "ambidextrous";
  cameraView: "side" | "rear_oblique";
  outDir: string;
  overlay: boolean;
  reuseExtract: boolean;
  /** "auto" or an explicit player track id. */
  player: "auto" | number;
  /** Run the expensive detector over the whole stroke window (baseline
   * comparison path) instead of the event-gated fast path. */
  fullScan: boolean;
  /** Enable CANDIDATE tracklet reconciliation (see runPaddleStage). */
  mergeTracklets: boolean;
  /** Enable wrist-conditioned crop re-detection in the paddle-lost
   * neighborhood (crop-recovery-v1, W12 winner). OFF by default. */
  cropRecovery: boolean;
  /** Warm paddle-detector worker (detect_paddle.py --serve): model loads once
   * per run instead of once per detect invocation. Default ON — worker
   * requests write bit-equal detection payloads (verified rally2 + volley on
   * Mac in W2, re-verified on Linux CPU in C07) and every worker failure
   * falls back to the one-shot path. --no-paddle-worker restores the
   * one-shot-only behavior. */
  paddleWorker: boolean;
  /** OFF-by-default adaptive two-pass detector schedule: sparse scan +
   * stride-1 densification (see paddleSchedule.ts). */
  twoPass: boolean;
  /** Pass-1 stride when --two-pass is on. */
  sparseStride: number;
  /** OFF-by-default dynamic target-ROI for the two-pass PASS 1 ONLY: crop
   * sparse-scan inference to the target's expected paddle zone (built from
   * BOTH target wrists over the detect span — W12: never trust handedness).
   * Pass 2 (dense, near contact) always stays full-frame, and any plan
   * abstention falls back to the untouched full-frame pass 1
   * (see paddleRoi.ts). No effect without --two-pass. */
  pass1Roi: boolean;
  /** Product-assisted target selection: one tap during setup. */
  targetSeed: TargetSeed | null;
}

function parseArgs(argv: string[]): CliArgs {
  const positional = argv.filter((argument) => !argument.startsWith("--"));
  const video = positional[0];
  if (!video) {
    console.error(
      "usage: pnpm analyze:video <video> [--stroke forehand_drive] [--handedness right]\n" +
        "         [--camera side] [--out <dir>] [--overlay] [--reuse-extract]",
    );
    process.exit(2);
  }
  const flag = (name: string): string | null => {
    const index = argv.indexOf(name);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1]! : null;
  };
  const stroke = (flag("--stroke") ?? "forehand_drive") as ShotTypeSlug;
  if (!SHOT_TYPES.includes(stroke)) {
    console.error(`unknown stroke '${stroke}'. valid: ${SHOT_TYPES.join(", ")}`);
    process.exit(2);
  }
  const videoPath = resolve(video);
  const playerFlag = flag("--player");
  return {
    video: videoPath,
    stroke,
    handedness: (flag("--handedness") ?? "right") as CliArgs["handedness"],
    cameraView: (flag("--camera") ?? "side") as CliArgs["cameraView"],
    outDir: resolve(flag("--out") ?? join(dirname(videoPath), `${basename(videoPath)}.swing-lab`)),
    overlay: argv.includes("--overlay"),
    reuseExtract: argv.includes("--reuse-extract"),
    player: playerFlag && playerFlag !== "auto" ? Number(playerFlag) : "auto",
    fullScan: argv.includes("--full-scan"),
    mergeTracklets: argv.includes("--merge-tracklets"),
    cropRecovery: argv.includes("--crop-recovery"),
    paddleWorker: !argv.includes("--no-paddle-worker"),
    twoPass: argv.includes("--two-pass"),
    sparseStride: Number(flag("--sparse-stride") ?? 3),
    pass1Roi: argv.includes("--pass1-roi"),
    targetSeed: (() => {
      const tap = flag("--target-tap");
      if (tap) {
        const [x, y] = tap.split(",").map(Number);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          return { mode: "user_tapped_person", point: { x: x!, y: y! } } as TargetSeed;
        }
      }
      const side = flag("--target-side");
      if (side === "left" || side === "right") {
        return { mode: "user_selected_court_half", half: side, nearSide: true } as TargetSeed;
      }
      return null;
    })(),
  };
}

function ensureSwiftBinary(): string {
  if (!existsSync(SWIFT_BIN)) {
    console.log("building native extractor (first run)…");
    execFileSync("swift", ["build", "-c", "release"], { cwd: SWIFT_LAB_DIR, stdio: "inherit" });
  }
  return SWIFT_BIN;
}

function labProviders(): FusionProviders {
  return {
    phase: new GeometricPhaseSegmenter({ aspectRatio: 1 }),
    biomechanics: new GeometryBiomechanicsExtractor(),
    scorer: new Sm1TechniqueScorer(),
    faultDetector: new CheckpointThresholdFaultDetector(),
    uncertainty: new EngineUncertaintyEstimator(),
    coach: new PriorityCoachingRanker(),
    classifier: null,
    shadowScorers: [],
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.video)) {
    console.error(`video not found: ${args.video}`);
    process.exit(2);
  }
  mkdirSync(args.outDir, { recursive: true });

  // Spawn the warm detector worker immediately so its startup (python import
  // + model load + warmup) overlaps pose extraction; runPaddleStage awaits
  // ready only when it actually sends a request.
  const paddleWorker = args.paddleWorker
    ? startPaddleWorker(
        join(REPO_ROOT, "tools/paddle-lab/.venv/bin/python"),
        join(REPO_ROOT, "tools/paddle-lab/detect_paddle.py"),
      )
    : null;
  try {
    await run(args, paddleWorker);
  } finally {
    paddleWorker?.dispose();
  }
}

async function run(args: CliArgs, paddleWorker: PaddleWorkerSupervisor | null): Promise<void> {
  // ── 1. Native extraction (measured pose + ball candidates) ─────────────
  const timings: Record<string, number> = {};
  const posePath = join(args.outDir, "pose.json");
  const ballPath = join(args.outDir, "ball.json");
  if (
    !args.reuseExtract ||
    !existsSync(posePath) ||
    !existsSync(join(args.outDir, "people.json"))
  ) {
    const bin = ensureSwiftBinary();
    console.log("extracting pose + trajectories (Apple Vision, upright frames)…");
    const started = Date.now();
    execFileSync(bin, ["extract", args.video, "--out", args.outDir], { stdio: "inherit" });
    timings["poseExtractMs"] = Date.now() - started;
  } else {
    console.log("reusing existing extraction artifacts");
  }
  const poseJson = readFileSync(posePath, "utf8");
  const meta = JSON.parse(readFileSync(join(args.outDir, "extract-meta.json"), "utf8")) as {
    video: { durationMs: number };
  };

  const report: LabRunReport = {
    video: args.video,
    outDir: args.outDir,
    stroke: args.stroke,
    poseSequenceSha256: sha256Hex(poseJson),
    quality: null,
    window: null,
    contact: null,
    ballDiagnostics: null,
    ballModality: "unavailable",
    ballStage: null,
    paddle: null,
    strokePrediction: null,
    kineticEvents: null,
    timings,
    outcome: { kind: "not_run", detail: "pipeline did not reach analysis" },
  };

  // ── 2. Canonical parse — the phone's own parser, same strictness ───────
  const parsed = parsePoseSequence(poseJson, {
    providerId: "pose.apple-vision",
    runtime: "vision_framework",
    executionTarget: "on_device",
    artifactHash: null,
  });
  if (!parsed.ok) {
    report.outcome = {
      kind: "rejected",
      detail: `pose sequence invalid: ${parsed.failure.code} — ${parsed.failure.message}`,
    };
    finish(report, args, null);
    return;
  }
  let sequence = parsed.value;

  // ── 2b. PLAYER IDENTITY: temporal tracks + explicit target ─────────────
  // Multi-person frames → persistent player tracks → ONE target whose pose
  // becomes the canonical sequence. Wrong-player association poisons
  // everything downstream, so identity comes before all other perception.
  const peoplePath = join(args.outDir, "people.json");
  let playerStage: PlayerStageReport | null = null;
  let otherWrists: ReturnType<typeof otherPlayersWrists> = [];
  let targetLossPeriods: Array<{ fromMs: number; toMs: number }> = [];
  let playersDebug: PlayersDebug | null = null;
  if (existsSync(peoplePath)) {
    const playerStarted = Date.now();
    const peopleFile = JSON.parse(readFileSync(peoplePath, "utf8")) as PeopleFile;
    const tracks = buildPlayerTracks(peopleFile);
    // PRODUCT-ASSISTED: an explicit user seed resolves identity; otherwise the
    // auto policy guesses. Either way ONE physical person is locked and then
    // followed — the seed never re-decides identity later.
    let target: (typeof tracks)[number];
    let allTracks = tracks;
    let aliasIds: number[] = [];
    let identityRisks: string[] = [];
    let identityConfidence: number;
    let identityMode: string;
    if (args.targetSeed) {
      const seeded = initializeTargetFromSeed(tracks, args.targetSeed);
      if (!seeded.ok) {
        report.outcome = {
          kind: "rejected",
          detail: `target seed failed: ${seeded.failure.code} — ${seeded.failure.message}`,
        };
        finish(report, args, null);
        return;
      }
      target = seeded.value.target;
      aliasIds = seeded.value.identity.aliasTrackIds;
      identityRisks = seeded.value.identity.risks;
      identityConfidence = seeded.value.identity.confidence;
      identityMode = seeded.value.identity.seedMode;
    } else {
      const selection = selectTargetPlayer(
        tracks,
        args.player === "auto"
          ? { policy: "auto" }
          : { policy: "explicit", explicitTrackId: args.player },
        null,
      );
      if (!selection.ok) {
        report.outcome = {
          kind: "rejected",
          detail: `player selection failed: ${selection.failure.code} — ${selection.failure.message}`,
        };
        finish(report, args, null);
        return;
      }
      target = selection.value.target;
      allTracks = selection.value.allTracks;
      identityRisks = selection.value.risks;
      identityConfidence = selection.value.confidence;
      identityMode = `auto_${selection.value.policy}`;
    }
    timings["playerTrackMs"] = Date.now() - playerStarted;
    sequence = targetPoseSequence(peopleFile, target);
    otherWrists = otherPlayersWrists(allTracks, target.trackId, aliasIds);
    targetLossPeriods = target.lossPeriods;
    playersDebug = {
      targetId: target.trackId,
      tracks: allTracks.map((track) => ({
        id: track.trackId,
        points: track.frames
          .filter((_, index) => index % 4 === 0)
          .map((frame) => ({
            t: frame.timestampMs,
            x: Number(frame.torsoMid.x.toFixed(3)),
            y: Number(frame.torsoMid.y.toFixed(3)),
          })),
      })),
    };
    playerStage = {
      targetTrackId: target.trackId,
      policy: identityMode as PlayerStageReport["policy"],
      selectionConfidence: identityConfidence,
      targetCoverage: target.coverage,
      lossPeriods: target.lossPeriods.length,
      aliasTrackIds: aliasIds,
      candidateTracks: allTracks.map((track) => ({
        trackId: track.trackId,
        coverage: Number(track.coverage.toFixed(2)),
        meanTorsoSpan: Number(track.meanTorsoSpan.toFixed(3)),
      })),
      risks: identityRisks,
    };
  } else {
    console.log("people.json missing (older extraction): single-person pose fallback");
  }
  report.player = playerStage;

  // ── 2c. SCENE VALIDITY — never analyze across a shot boundary ──────────
  const scenesPath = join(args.outDir, "scenes.json");
  let scene: SceneDecision | null = null;
  if (existsSync(scenesPath)) {
    const scenes = JSON.parse(readFileSync(scenesPath, "utf8")) as ScenesFile;
    scene = decideScene(
      scenes,
      sequence.frames.map((frame) => frame.timestampMs),
    );
    report.scene = {
      detector: scenes.detector,
      cutCount: scene.cutCount,
      cuts: scene.cuts,
      analysisSegment: scene.analysisSegment,
      risks: scene.risks,
    };
    // Restrict the canonical sequence to the analysis shot.
    if (scene.multiShot) {
      sequence = {
        ...sequence,
        frames: sequence.frames.filter(
          (frame) =>
            frame.timestampMs >= scene!.analysisSegment.startMs &&
            frame.timestampMs < scene!.analysisSegment.endMs,
        ),
      };
    }
  }

  // ── 3. Capture-quality gate ────────────────────────────────────────────
  // The gate decides whether a SCORE may be produced. Perception stages
  // (window, paddle, ball, contact, overlay) still run on rejected footage —
  // the lab exists to study exactly those hard cases.
  const quality = evaluateCaptureQuality(sequence);
  report.quality = quality;

  // ── 4. Offline stroke window ───────────────────────────────────────────
  const window = detectOfflineStrokeWindow(sequence);
  if (!window.ok) {
    report.outcome = {
      kind: "abstained",
      detail: `${window.failure.code}: ${window.failure.message}`,
    };
    finish(report, args, buildDebug(report, null, []));
    return;
  }
  let strokeWindow = window.value;
  if (scene) {
    const clamped = clampToScene(strokeWindow, scene.analysisSegment);
    if (!clamped) {
      report.outcome = {
        kind: "abstained",
        detail: "SCENE_INVALID: the detected stroke window lies outside the analysis shot",
      };
      finish(report, args, buildDebug(report, null, []));
      return;
    }
    strokeWindow = { ...strokeWindow, startMs: clamped.startMs, endMs: clamped.endMs };
  }
  report.window = strokeWindow;
  // Window-aware identity risks (Part 22): a lost target near the stroke is
  // a first-class analysis-quality problem.
  if (playerStage) {
    const inWindowLoss = targetLossPeriods.filter(
      (loss) => loss.toMs >= strokeWindow.startMs && loss.fromMs <= strokeWindow.endMs,
    );
    if (inWindowLoss.length > 0) {
      playerStage.risks.push(
        `TARGET_PLAYER_LOST: ${inWindowLoss.length} loss period(s) inside the stroke window`,
      );
    }
  }

  // ── 5. Ball candidates + contact evidence ──────────────────────────────
  const trajectoryFile = JSON.parse(readFileSync(ballPath, "utf8")) as TrajectoryFile;
  const ball = resolveBallModality({
    file: trajectoryFile,
    window: strokeWindow,
    videoDurationMs: meta.video.durationMs,
  });
  report.ballDiagnostics = ball.diagnostics;
  report.ballModality = ball.modality.status;
  // Trajectory points are only contact evidence when the scene passed the
  // noise gate; a moving camera/scene produces parabolic junk that must not
  // influence the contact estimate.
  const sceneTrustworthy =
    ball.diagnostics.trajectoriesPerSecond <= BALL_GATES.maxTrajectoriesPerSecond;
  const ballObservations = sceneTrustworthy
    ? windowBallObservations(trajectoryFile, strokeWindow)
    : [];
  // ── 5a¹. POSE-DERIVATIVE CACHE — computed ONCE from the canonical
  // sequence + final stroke window, then threaded through every stage that
  // previously re-derived it (pre-pass, paddle association, contact wrists,
  // event isolation, stroke recognition, research sequence, ball gating).
  // The sequence is frozen at this point (target selected, scene-clamped),
  // so each entry is byte-identical to the per-stage recomputation it
  // replaces. Smoothing inside the stroke-event proposer is intentionally
  // NOT cached: strokeEvents.ts is verbatim-mirrored into analysis-pipeline
  // (drift-guard byte-compare), so its internals stay self-contained.
  const poseDerivativesStarted = Date.now();
  const pose = buildPoseDerivatives(sequence, strokeWindow);
  timings["poseDerivativesMs"] = Date.now() - poseDerivativesStarted;

  // ── 5a². PRE-PASS event proposals from POSE ONLY (cheap) — these gate the
  // expensive paddle detector to the frames that can matter (fast path).
  const prePassStarted = Date.now();
  const prePass = proposeStrokeEventsV2({
    paddleSpeeds: null,
    wristSpeeds: pose.dominantWristSpeeds,
    clipStartMs: strokeWindow.startMs,
    clipEndMs: strokeWindow.endMs,
  });
  timings["eventPrePassMs"] = Date.now() - prePassStarted;
  // A stroke needs preparation + follow-through context around its kinematic
  // peak; a bare peak span starves the tracker (measured: 240ms span → paddle
  // coverage 17% → UNTRACKED). Pad, union, clamp, and enforce a floor.
  const EVENT_CONTEXT_PAD_MS = 600;
  const MIN_DETECT_SPAN_MS = 1500;
  let prePassSpan: { startMs: number; endMs: number } = strokeWindow;
  if (prePass.events.length > 0) {
    const startMs =
      Math.min(...prePass.events.map((event) => event.startMs)) - EVENT_CONTEXT_PAD_MS;
    const endMs = Math.max(...prePass.events.map((event) => event.endMs)) + EVENT_CONTEXT_PAD_MS;
    const deficit = MIN_DETECT_SPAN_MS - (endMs - startMs);
    const grow = deficit > 0 ? deficit / 2 : 0;
    prePassSpan = {
      startMs: Math.max(strokeWindow.startMs, startMs - grow),
      endMs: Math.min(strokeWindow.endMs, endMs + grow),
    };
  }
  const detectSpan = args.fullScan ? strokeWindow : prePassSpan;
  report.detectSpan = {
    mode: args.fullScan ? "full-window" : "event-gated",
    startMs: Math.round(detectSpan.startMs),
    endMs: Math.round(detectSpan.endMs),
    windowMs: Math.round(strokeWindow.endMs - strokeWindow.startMs),
    spanMs: Math.round(detectSpan.endMs - detectSpan.startMs),
    prePassEvents: prePass.events.length,
  };

  // ── 5b/5c prep. Paddle detection ∥ ball candidate generation ───────────
  // The two python extraction subprocesses are independent (video → files);
  // only the TRACKING stages couple (ball gating consumes the paddle track).
  // Run the subprocesses concurrently, then track in the sequential order —
  // artifacts are byte-identical to the fully sequential pipeline. Each prep
  // catches its own failures so one detector cannot poison the other.
  const ballPrepPromise = prepareBallCandidates({ args, window: strokeWindow, timings });
  const paddlePrep = await preparePaddleDetections({
    args,
    window: strokeWindow,
    detectSpan,
    eventPeaksMs: prePass.events.map((event) => event.peakMs),
    targetWrists: args.twoPass && args.pass1Roi ? wristSeries(sequence) : null,
    timings,
    worker: paddleWorker,
  });
  const ballPrep = await ballPrepPromise;

  // ── 5b. Paddle perception: pixel detector → tracker → gated modality ───
  const paddleOutcome = await runPaddleStage({
    args,
    targetWrists: pose.wristSeries,
    otherWrists,
    window: strokeWindow,
    detectSpan,
    timings,
    prep: paddlePrep,
  });
  report.paddle = paddleOutcome.reportEntry;
  report.paddleSchedule = paddlePrep.status === "ready" ? paddlePrep.schedule : null;
  const paddleObservations =
    paddleOutcome.tracking?.status === "tracked" ? paddleOutcome.tracking.lab.observations : null;
  // Paddle derivatives, also computed once (three stages consumed their own
  // paddleSpeedSeries/centers projections of the SAME track before).
  const paddleSpeeds = paddleObservations ? paddleSpeedSeries(paddleObservations) : null;
  const paddleCenters =
    paddleObservations?.map((observation) => ({
      timestampMs: observation.timestampMs,
      x: observation.center.x,
      y: observation.center.y,
    })) ?? null;

  // ── 5c. Ball perception: motion candidates → temporal track → gates ────
  const ballOutcome = runBallStage({
    args,
    sequence,
    legacyFrames: pose.legacyFrames,
    window: strokeWindow,
    paddle: paddleObservations,
    timings,
    prep: ballPrep,
  });
  report.ballStage = ballOutcome.reportEntry;

  // ── 5c¹. STROKE EVENT ISOLATION (first-class unit of analysis) ─────────
  // v2 DECOUPLING: the target's BODY motion proposes events; paddle evidence
  // only confirms/ranks/refines. A different paddle representation (merge,
  // ROI, keyframes) can no longer redefine which movement happened — the
  // measured v1 failures were rally1 contact 73→2411ms under merge and a
  // cascade-selected event with 0% gold overlap.
  const eventStarted = Date.now();
  const proposals = proposeStrokeEventsV2({
    paddleSpeeds,
    wristSpeeds: pose.dominantWristSpeeds,
    clipStartMs: 0,
    clipEndMs: meta.video.durationMs,
  });
  timings["eventIsolationMs"] = Date.now() - eventStarted;
  if (scene && scene.multiShot) {
    const before = proposals.events.length;
    proposals.events = proposals.events.filter(
      (event) =>
        !crossesCut(scene!.cuts, event) &&
        event.startMs >= scene!.analysisSegment.startMs - 200 &&
        event.endMs <= scene!.analysisSegment.endMs + 200,
    );
    if (proposals.events.length < before) {
      report.scene?.risks.push(
        `SCENE_EVENTS_DROPPED: ${before - proposals.events.length} event proposal(s) crossed or sat outside the analysis shot`,
      );
    }
  }
  report.events = {
    version: STROKE_EVENT_VERSION_2,
    source: proposals.source,
    proposals: proposals.events,
  };

  // Contact evidence priority: the measured temporal ball track; otherwise
  // the (already noise-gated) Apple trajectory points.
  const contactBallObservations =
    ballOutcome.tracking?.status === "tracked"
      ? ballOutcome.tracking.track.observations
      : ballObservations.length > 0
        ? ballObservations
        : null;
  // Provisional target event (prominence + paddle confirmation) bounds the
  // contact search; final selection re-checks with the contact anchor.
  // CONTACT SCOPE ≠ EVENT BOUNDS: v2 events carry preparation/follow-through
  // (wide, for phases/replay); contact evidence lives near the (paddle-
  // refined) peak. Searching the whole widened event dragged unrelated
  // peaks into scope and tripped the disagreement gate (measured on the
  // held-out regen: contact 34ms → abstained). The scan window is therefore
  // the peak neighborhood clamped to the event.
  const CONTACT_SCOPE_MS = 450;
  const contactScope = (event: { startMs: number; endMs: number; peakMs: number }) => ({
    startMs: Math.max(event.startMs, event.peakMs - CONTACT_SCOPE_MS),
    endMs: Math.min(event.endMs, event.peakMs + CONTACT_SCOPE_MS),
    peakMotionMs: event.peakMs,
  });
  const provisional = selectTargetEventV2(proposals.events, null);
  const contactSearchWindow =
    provisional.status === "selected"
      ? contactScope(provisional.event)
      : { ...strokeWindow, peakMotionMs: strokeWindow.peakMotionMs };
  // v4 estimator inputs: the TARGET's wrist positions over time (gates ball
  // evidence to the target) and the declared stroke's coarse family (picks
  // temporal priors). The declared stroke is context, never ground truth —
  // the family only widens/narrows kernel widths.
  const targetWristsForContact = pose.targetWrists;
  const contactStrokeFamily = ((): StrokeFamily => {
    switch (args.stroke) {
      case "volley":
        return "volley";
      case "dink":
      case "third_shot_drop":
        return "dink";
      case "serve":
        return "serve";
      case "overhead":
        return "overhead";
      case "forehand_drive":
      case "backhand_drive":
      case "return":
        return "drive";
      default:
        return "unknown";
    }
  })();
  const contact = estimateContact({
    sequence,
    window: contactSearchWindow,
    ballObservations: contactBallObservations,
    paddleSpeeds,
    paddleCenters,
    targetWrists: targetWristsForContact,
    strokeFamily: contactStrokeFamily,
  });
  report.contact = contact;

  // ── 5c². Contact-aware ball reacquisition (second linking pass) ────────
  // The first linking pass ran without a contact anchor. With a contact
  // estimate available, retry the occlusion bridge: at contact the velocity
  // discontinuity is legitimate, so the outgoing search uses the contact
  // region instead of the incoming corridor.
  if (
    ballOutcome.tracking?.status === "tracked" &&
    ballOutcome.tracking.timeline.reacquisition.attempted &&
    ballOutcome.tracking.timeline.reacquisition.result !== "SUCCESS" &&
    contact.status === "estimated"
  ) {
    const contactPoint = contactLocation(
      contact.estimatedContactMs,
      paddleObservations,
      ballOutcome.tracking.lab.observations,
    );
    if (contactPoint) {
      const relinked = linkBallTimeline({
        primary: ballOutcome.tracking.lab,
        candidates: [...ballOutcome.gated, ...ballOutcome.fragments],
        contact: { tMs: contact.estimatedContactMs, ...contactPoint },
        windowEndMs: strokeWindow.endMs,
      });
      ballOutcome.tracking.timeline = relinked.timeline;
      if (relinked.outgoing) {
        const combined = [
          ...ballOutcome.tracking.lab.observations,
          ...relinked.outgoing.observations,
        ];
        ballOutcome.tracking.lab = { ...ballOutcome.tracking.lab, observations: combined };
        ballOutcome.tracking.track = {
          ...ballOutcome.tracking.track,
          observations: combined.map((observation, index) => ({
            frameIndex: index,
            timestampMs: Math.round(observation.timestampMs),
            x: observation.x,
            y: observation.y,
            confidence: observation.confidence,
          })),
        };
      }
    }
  }
  if (ballOutcome.tracking?.status === "tracked" && report.ballStage?.status === "tracked") {
    report.ballStage.timeline = summarizeTimeline(ballOutcome.tracking.timeline);
  }
  const contactMs =
    contact.status === "estimated" ? contact.estimatedContactMs : strokeWindow.peakMotionMs;

  // ── 5c². Final target-event selection (contact-anchored when possible) ─
  // If the provisional event yielded no contact, scan EACH proposed event:
  // a contact confirmed by independent ball/paddle evidence inside exactly
  // one event selects that event (contact belongs to one event — and picks
  // it). Multiple confirmed contacts = ambiguity, honestly reported.
  let contactFinal: ReturnType<typeof estimateContact> = contact;
  if (contact.status !== "estimated" && proposals.events.length > 1) {
    const confirmed: Array<{
      event: StrokeEventProposal;
      contact: Extract<ReturnType<typeof estimateContact>, { status: "estimated" }>;
    }> = [];
    for (const event of proposals.events) {
      const candidate = estimateContact({
        sequence,
        window: contactScope(event),
        ballObservations: contactBallObservations,
        paddleSpeeds,
        paddleCenters,
        targetWrists: targetWristsForContact,
        strokeFamily: contactStrokeFamily,
      });
      // When a measured ball track exists, paddle-only confirmation is not
      // enough to anchor event selection: the ball was OBSERVED and did not
      // corroborate the moment (measured failure: rally1's paddle-lift near
      // a drifting dead ball would have selected the wrong event).
      const confirmedEnough =
        candidate.status === "estimated" &&
        (candidate.ballConfirmed ||
          (candidate.paddleConfirmed && contactBallObservations === null));
      if (candidate.status === "estimated" && confirmedEnough) {
        confirmed.push({ event, contact: candidate });
      }
    }
    if (confirmed.length === 1) {
      contactFinal = confirmed[0]!.contact;
      report.contact = contactFinal;
    } else if (confirmed.length > 1) {
      report.contactScanNote = `EVENT_CONTACT_AMBIGUOUS: ${confirmed.length} events carry confirmed contacts (${confirmed
        .map((entry) => entry.event.eventId)
        .join(", ")})`;
    }
  }
  const estimatedContactMs =
    contactFinal.status === "estimated" ? contactFinal.estimatedContactMs : null;
  const targetEvent = selectTargetEventV2(proposals.events, estimatedContactMs);
  report.targetEvent = targetEvent;

  // ── 5d. Stroke recognition + research sequence — EVENT-LOCAL ───────────
  const wristSpeedSeries = pose.dominantWristSpeeds;
  const paddleSpeedsForStroke = paddleSpeeds;
  const analysisScope =
    targetEvent.status === "selected"
      ? { startMs: targetEvent.event.startMs, endMs: targetEvent.event.endMs }
      : null;
  const strokePrediction = analysisScope
    ? classifyStroke({
        sequence,
        window: analysisScope,
        contactMs: estimatedContactMs,
        eventPeakMs: targetEvent.status === "selected" ? targetEvent.event.peakMs : null,
        handedness: args.handedness,
        paddle: paddleObservations,
        paddleSpeeds: paddleSpeedsForStroke,
        wristSpeeds: wristSpeedSeries,
        legacyFrames: pose.legacyFrames,
      })
    : null;
  report.strokePrediction = strokePrediction;
  const strokeSequence = buildStrokeSequence({
    sequence,
    window: analysisScope ?? strokeWindow,
    contactMs: estimatedContactMs,
    paddle: paddleObservations,
    ball: ballOutcome.tracking?.status === "tracked" ? ballOutcome.tracking.lab.observations : null,
    wristSpeeds: wristSpeedSeries,
    paddleSpeeds: paddleSpeedsForStroke,
    legacyFrames: pose.legacyFrames,
  });
  writeFileSync(join(args.outDir, "sequence.json"), JSON.stringify(strokeSequence));
  report.kineticEvents = strokeSequence.kinetics.events;

  // ── 5e. phase segmentation: frozen v1 (bench continuity) + v2 ──────────
  report.temporalPhases = segmentPhasesTemporal({
    window: strokeWindow,
    contactMs: estimatedContactMs,
    paddleSpeeds: paddleSpeedsForStroke,
    wristSpeeds: wristSpeedSeries,
  });
  report.temporalPhasesV2 = analysisScope
    ? segmentPhasesTemporalV2({
        event:
          targetEvent.status === "selected"
            ? { ...analysisScope, peakMs: targetEvent.event.peakMs }
            : analysisScope,
        contactMs: estimatedContactMs,
        paddleSpeeds: paddleSpeedsForStroke,
        wristSpeeds: wristSpeedSeries,
      })
    : {
        status: "abstained",
        reason:
          targetEvent.status === "ambiguous" ? targetEvent.reason : "no stroke event isolated",
      };

  if (!quality.analyzable) {
    report.outcome = {
      kind: "not_analyzable",
      detail: `capture quality gate failed: ${quality.reasons.join(", ")} — perception artifacts written; no score permitted`,
    };
    finish(
      report,
      args,
      buildDebug(
        report,
        null,
        ballObservations,
        paddleOutcome.tracking,
        ballOutcome.tracking,
        playersDebug,
      ),
    );
    return;
  }

  // ── 6. Fusion analysis — the same engine the app runs ──────────────────
  const analysisStarted = Date.now();
  const analysis = await analyzeCapture(
    labProviders(),
    {
      captureId: `lab-${sha256Hex(poseJson).slice(0, 12)}`,
      pose: sequence,
      paddle:
        paddleOutcome.tracking?.status === "tracked"
          ? measured(paddleOutcome.tracking.track)
          : unavailable(paddleOutcome.unavailableReason),
      ball:
        ballOutcome.tracking?.status === "tracked"
          ? measured(ballOutcome.tracking.track)
          : ball.modality.status === "measured"
            ? ball.modality
            : unavailable(ballOutcome.unavailableReason),
      trigger: {
        startMs: strokeWindow.startMs,
        endMs: strokeWindow.endMs,
        peakMotionMs: contactMs,
        confidence: strokeWindow.confidence,
        producedBy: {
          providerId: "trigger.offline-wrist-speed",
          modelVersion: OFFLINE_TRIGGER_VERSION,
          runtime: "deterministic",
          executionTarget: "on_device",
          artifactHash: null,
        },
      },
      stroke: { declared: args.stroke, predicted: null },
      handedness: args.handedness,
      cameraView: args.cameraView,
      capturedAtIso: new Date().toISOString(),
    },
    {
      analysisId: `lab-analysis-${Date.now()}`,
      sessionId: null,
      appVersion: "swing-lab",
      modelBundleVersion: "swing-lab-desktop",
      nowIso: () => new Date().toISOString(),
      makeId: () => `run-${Math.random().toString(36).slice(2, 10)}`,
    },
  );

  timings["fusionAnalysisMs"] = Date.now() - analysisStarted;

  if (!analysis.ok) {
    report.outcome = {
      kind: "abstained",
      detail: `${analysis.failure.code}: ${analysis.failure.message}`,
    };
    finish(
      report,
      args,
      buildDebug(
        report,
        null,
        ballObservations,
        paddleOutcome.tracking,
        ballOutcome.tracking,
        playersDebug,
      ),
    );
    return;
  }
  writeFileSync(join(args.outDir, "analysis.json"), JSON.stringify(analysis.value, null, 2));
  report.outcome = { kind: "analyzed", record: analysis.value };
  finish(
    report,
    args,
    buildDebug(
      report,
      analysis.value,
      ballObservations,
      paddleOutcome.tracking,
      ballOutcome.tracking,
      playersDebug,
    ),
  );
}

interface PaddleStage {
  tracking: PaddleTrackingOutcome | null;
  reportEntry: LabRunReport["paddle"];
  unavailableReason: string;
}

/** Run a paddle-lab python tool as a child process (async, logs inherited). */
function runPythonTool(python: string, argv: string[]): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(python, argv, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${basename(argv[0] ?? python)} exited with code ${code}`));
    });
  });
}

type PaddleDetectionPrep =
  | { status: "ready"; schedule: TwoPassSchedule | null }
  | { status: "env_missing" }
  | { status: "failed"; message: string };

type BallCandidatePrep =
  { status: "ready" } | { status: "env_missing" } | { status: "failed"; message: string };

/**
 * Detector subprocess phase of the paddle stage — file-producing only, no
 * tracking. Kept separate from runPaddleStage so it can run CONCURRENTLY
 * with ball candidate generation (the tracking phases stay sequential —
 * ball gating consumes the paddle track). Never throws: every failure is
 * carried in the prep result so one stage cannot poison the other.
 */
async function preparePaddleDetections(input: {
  args: CliArgs;
  window: { startMs: number; endMs: number };
  detectSpan: { startMs: number; endMs: number };
  /** Kinematic peaks from the pose-only pre-pass (two-pass densification). */
  eventPeaksMs: readonly number[];
  /** Target wrist series for --pass1-roi planning; null when the flag is
   * off (the plan is never computed, pass 1 stays full-frame). */
  targetWrists: ReturnType<typeof wristSeries> | null;
  timings: Record<string, number>;
  /** Warm detector worker; null → one-shot path. Worker failures fall back. */
  worker: PaddleWorkerSupervisor | null;
}): Promise<PaddleDetectionPrep> {
  const python = join(REPO_ROOT, "tools/paddle-lab/.venv/bin/python");
  const script = join(REPO_ROOT, "tools/paddle-lab/detect_paddle.py");
  if (!existsSync(python) || !existsSync(script)) {
    return { status: "env_missing" };
  }
  const detsPath = join(input.args.outDir, "paddle-dets.json");
  try {
    const wantedStart = Math.max(0, input.detectSpan.startMs - 250);
    const wantedEnd = input.detectSpan.endMs + 250;
    // Reuse only when the existing detections actually cover the current
    // stroke window — pose/window changes must invalidate stale detections.
    // Two-pass mode never reuses: a stride-1 file must not stand in for a
    // scheduled artifact (H found the reuse gate ignores stride — footgun).
    let reusable = false;
    if (input.args.reuseExtract && existsSync(detsPath) && !input.args.twoPass) {
      const existing = JSON.parse(readFileSync(detsPath, "utf8")) as RawPaddleDetectionFile;
      reusable =
        existing.window.startMs <= wantedStart + 100 && existing.window.endMs >= wantedEnd - 100;
      if (!reusable)
        console.log("existing paddle detections do not cover this window; re-detecting");
    }
    if (reusable) return { status: "ready", schedule: null };
    const detect = async (
      out: string,
      startMs: number,
      endMs: number,
      stride: number,
      roi: [number, number, number, number] | null = null,
    ): Promise<void> => {
      const path = await detectPaddleWindow({
        worker: input.worker,
        request: { video: input.args.video, out, startMs, endMs, stride, roi },
        oneShot: () =>
          execFileSync(
            python,
            [
              script,
              "--video",
              input.args.video,
              "--out",
              out,
              "--start-ms",
              String(startMs),
              "--end-ms",
              String(endMs),
              "--stride",
              String(stride),
              ...(roi ? ["--roi", roi.join(",")] : []),
            ],
            { stdio: "inherit" },
          ),
      });
      input.timings["paddleDetectViaWorker"] = path === "worker" ? 1 : 0;
    };
    const started = Date.now();
    if (!input.args.twoPass) {
      console.log("detecting paddle candidates (D-FINE COCO proxy, python)…");
      await detect(detsPath, wantedStart, wantedEnd, 1);
      input.timings["paddleDetectMs"] = Date.now() - started;
      return { status: "ready", schedule: null };
    }
    // ── Adaptive two-pass schedule (OFF by default; paddleSchedule.ts) ────
    console.log(
      `two-pass paddle detection: sparse scan (stride ${input.args.sparseStride}) + adaptive densification…`,
    );
    // ── Dynamic target-ROI for pass 1 only (OFF by default; paddleRoi.ts).
    // Pass 2 below always runs full-frame — dense regions carry the contact
    // evidence and must never be cropped.
    let pass1RoiPlan: Pass1RoiPlan | null = null;
    if (input.targetWrists) {
      pass1RoiPlan = planPass1Roi({
        wrists: input.targetWrists,
        detectSpan: { startMs: wantedStart, endMs: wantedEnd },
      });
      console.log(
        pass1RoiPlan.status === "roi"
          ? `pass-1 target ROI [${pass1RoiPlan.roiNorm.join(", ")}] (${Math.round(pass1RoiPlan.areaFraction * 100)}% of frame)`
          : `pass-1 target ROI unavailable (${pass1RoiPlan.reason}); full-frame pass 1`,
      );
    }
    const sparsePath = join(input.args.outDir, "paddle-dets.pass1.json");
    await detect(
      sparsePath,
      wantedStart,
      wantedEnd,
      input.args.sparseStride,
      pass1RoiPlan?.status === "roi" ? pass1RoiPlan.roiNorm : null,
    );
    input.timings["paddleDetectSparseMs"] = Date.now() - started;
    const sparseFile = JSON.parse(readFileSync(sparsePath, "utf8")) as RawPaddleDetectionFile;
    const sparseTracks = buildPaddleTracks(sparseFile, input.window);
    const densest = [...sparseTracks].sort(
      (a, b) => b.observations.length - a.observations.length,
    )[0];
    const schedule = planTwoPassSchedule({
      detectSpan: { startMs: wantedStart, endMs: wantedEnd },
      frameIntervalMs: 1000 / sparseFile.video.fps,
      primaryTrack: densest ?? null,
      paddleSpeeds: densest ? paddleSpeedSeries(densest.observations) : null,
      eventPeaksMs: input.eventPeaksMs,
      config: { sparseStride: input.args.sparseStride },
    });
    const denseStarted = Date.now();
    const denseFiles: RawPaddleDetectionFile[] = [];
    for (const [index, region] of schedule.denseRegions.entries()) {
      const densePath = join(input.args.outDir, `paddle-dets.pass2-${index}.json`);
      await detect(densePath, region.startMs, region.endMs, 1);
      denseFiles.push(JSON.parse(readFileSync(densePath, "utf8")) as RawPaddleDetectionFile);
    }
    input.timings["paddleDetectDenseMs"] = Date.now() - denseStarted;
    const merged = mergePaddleDetectionFiles(sparseFile, denseFiles, schedule);
    writeFileSync(detsPath, JSON.stringify(merged.file));
    writeFileSync(
      join(input.args.outDir, "paddle-schedule.json"),
      JSON.stringify(
        {
          schedule,
          pass1Roi: pass1RoiPlan,
          realized: {
            sparseFrames: sparseFile.timing.framesProcessed,
            denseFrames: denseFiles.reduce((total, file) => total + file.timing.framesProcessed, 0),
            mergedFrames: merged.file.frames.length,
            framesByPass: merged.passes,
          },
        },
        null,
        2,
      ),
    );
    input.timings["paddleDetectMs"] = Date.now() - started;
    return { status: "ready", schedule };
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Pixel-based paddle perception: D-FINE proxy detector (python) → two-stage
 * tracker → pose-gated selection. Every failure mode is an honest
 * `unavailable` reason; the wrist is never converted into a paddle.
 */
async function runPaddleStage(input: {
  args: CliArgs;
  /** Target wrist positions from the pose-derivative cache. */
  targetWrists: ReturnType<typeof wristSeries>;
  otherWrists: ReturnType<typeof otherPlayersWrists>;
  window: { startMs: number; endMs: number };
  /** Detection span — the union of candidate stroke events when available,
   * which is what makes the fast path fast (Mission 37/38: expensive models
   * run on relevant frames only). Falls back to the stroke window. */
  detectSpan: { startMs: number; endMs: number };
  timings: Record<string, number>;
  prep: PaddleDetectionPrep;
}): Promise<PaddleStage> {
  const python = join(REPO_ROOT, "tools/paddle-lab/.venv/bin/python");
  const script = join(REPO_ROOT, "tools/paddle-lab/detect_paddle.py");
  if (input.prep.status === "env_missing") {
    return {
      tracking: null,
      reportEntry: { status: "unavailable", reason: "paddle_detector_env_not_installed" },
      unavailableReason:
        "paddle_detector_env_not_installed (tools/paddle-lab: python3.12 venv + torch)",
    };
  }
  if (input.prep.status === "failed") {
    return {
      tracking: null,
      reportEntry: { status: "unavailable", reason: `detector_failed: ${input.prep.message}` },
      unavailableReason: `paddle_detector_failed: ${input.prep.message}`,
    };
  }
  const detsPath = join(input.args.outDir, "paddle-dets.json");
  try {
    const file = JSON.parse(readFileSync(detsPath, "utf8")) as RawPaddleDetectionFile;
    const trackStarted = Date.now();
    const rawCandidates = buildPaddleTracks(file, input.window);
    // Tracklet reconciliation is a measured CANDIDATE, not production:
    //   paddle stage  : S3 recall 0.22 → 0.48, S4/S5 precision 0.27 → 0.67,
    //                   wrong-player 1/2 → 0/2   (better)
    //   downstream    : contact median 73ms → 151ms with one catastrophic
    //                   case (rally1 73ms → 2411ms), event recall 4/5 → 3/5,
    //                   stroke L2 3/4 → 2/4       (worse)
    // Net product effect is negative today, so it stays behind --merge-tracklets
    // until the cascade is understood. See
    // datasets/experiments/EXP-2026-08-28-tracklet-merge.json.
    let candidates = rawCandidates;
    if (input.args.mergeTracklets) {
      const { merged, links } = mergePaddleTracklets(rawCandidates, input.window);
      candidates = merged;
      input.timings["paddleMergeLinks"] = links;
    }
    const targetWrists = input.targetWrists;
    let tracking = selectPrimaryPaddleTrack(
      candidates,
      targetWrists,
      input.window,
      input.otherWrists,
    );
    let detectorLabel = file.detector.version;

    // crop-recovery-v1 (W12 winner, HANDOFF_V3 §6 item 3): wrist-conditioned
    // {256,704}px crop re-detection bounded to the paddle-lost neighborhood.
    // Crop detections are provenance-tagged and only ever EXTEND tracks; the
    // admission gate (wrist proximity + FP-family suppression) carries
    // precision, not the score floor. OFF unless --crop-recovery.
    if (input.args.cropRecovery) {
      const frameIntervalMs = 1000 / file.video.fps;
      const lost = paddleLostFrameTimes(
        file.frames.map((frame) => frame.tMs),
        tracking.status === "tracked" ? [tracking.lab] : [],
        input.window,
        frameIntervalMs,
      );
      const plan = planWristCropRects(lost, targetWrists, file.video);
      if (plan.length > 0) {
        console.log(
          `${PADDLE_CROP_RECOVERY_VERSION}: re-detecting ${plan.length} paddle-lost frames on wrist crops…`,
        );
        const planPath = join(input.args.outDir, "paddle-crop-plan.json");
        writeFileSync(planPath, JSON.stringify({ video: input.args.video, crops: plan }));
        const cropDetsPath = join(input.args.outDir, "paddle-crop-dets.json");
        execFileSync(
          python,
          [script, "--video", input.args.video, "--crops", planPath, "--out", cropDetsPath],
          { stdio: "inherit" },
        );
        const cropFile = JSON.parse(readFileSync(cropDetsPath, "utf8")) as {
          frames: CropDetectionFrame[];
        };
        const admission = admitCropDetections(cropFile.frames, targetWrists, file.video);
        input.timings["cropRecoveryAdmitted"] = admission.admitted.reduce(
          (total, frame) => total + frame.detections.length,
          0,
        );
        input.timings["cropRecoveryRejectedFpFamily"] = admission.rejectedFpFamily;
        if (admission.admitted.length > 0) {
          const augmented = mergeCropDetectionsIntoFile(file, admission.admitted);
          let recovered = buildPaddleTracks(augmented, input.window);
          if (input.args.mergeTracklets) {
            recovered = mergePaddleTracklets(recovered, input.window).merged;
          }
          tracking = selectPrimaryPaddleTrack(
            recovered,
            targetWrists,
            input.window,
            input.otherWrists,
          );
          if (tracking.status === "tracked") {
            // Lab-side bridge only: TRACKED_ESTIMATE observations stay out of
            // the domain PaddleTrack — estimates are never detections.
            tracking = {
              ...tracking,
              lab: {
                ...tracking.lab,
                observations: bridgeTrackedEstimates(tracking.lab.observations, frameIntervalMs),
              },
            };
          }
          detectorLabel = `${file.detector.version}+${PADDLE_CROP_RECOVERY_VERSION}`;
        }
      }
    }
    input.timings["paddleTrackMs"] = Date.now() - trackStarted;

    if (tracking.status === "tracked") {
      return {
        tracking,
        reportEntry: {
          status: "tracked",
          trackId: tracking.lab.trackId,
          observationCount: tracking.lab.observations.length,
          windowCoverage: tracking.lab.windowCoverage,
          meanDetectorScore: tracking.lab.meanScore,
          meanWristDistance: tracking.lab.meanWristDistance,
          candidateTracks: tracking.allTracks.length,
          detector: detectorLabel,
          inferenceMsPerFrame: file.timing.inferenceMsPerFrame,
          confidenceModel: PADDLE_CONFIDENCE_MODEL,
          association: summarizeAssociation(tracking.association),
        },
        unavailableReason: "",
      };
    }
    return {
      tracking,
      reportEntry: {
        status: "untracked",
        reason: tracking.reason,
        candidateTracks: tracking.allTracks.length,
        detector: detectorLabel,
        inferenceMsPerFrame: file.timing.inferenceMsPerFrame,
        association: tracking.association ? summarizeAssociation(tracking.association) : null,
      },
      unavailableReason: `paddle_untracked: ${tracking.reason}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      tracking: null,
      reportEntry: { status: "unavailable", reason: `detector_failed: ${message}` },
      unavailableReason: `paddle_detector_failed: ${message}`,
    };
  }
}

/**
 * POSE-DERIVATIVE CACHE — every pose-adjacent projection analyzeVideo's
 * stages consume, computed exactly once from the frozen canonical sequence.
 * Entries are the SAME pure projections the stages used to re-derive
 * per-call; sharing the arrays is safe because every consumer treats its
 * series inputs as read-only (proposer/contact/stroke stages copy before
 * sorting and never mutate samples).
 */
interface PoseDerivatives {
  /** toLegacyPoseFrames(sequence) — the shared legacy projection. */
  legacyFrames: ReturnType<typeof toLegacyPoseFrames>;
  /** Both-wrist positions per timestamp (paddle association gate). */
  wristSeries: ReturnType<typeof wristSeries>;
  /** Dominant-wrist speed series (event pre-pass + isolation + stroke). */
  dominantWristSpeeds: Array<{ timestampMs: number; value: number }>;
  /** Flat wrist positions, visibility ≥ 0.25 (contact-evidence gating). */
  targetWrists: Array<{ timestampMs: number; x: number; y: number }>;
}

function buildPoseDerivatives(
  sequence: PoseSequence,
  window: { startMs: number; endMs: number },
): PoseDerivatives {
  const legacyFrames = toLegacyPoseFrames(sequence);
  return {
    legacyFrames,
    wristSeries: wristSeriesFromFrames(legacyFrames),
    dominantWristSpeeds: dominantWristSpeeds(legacyFrames, window),
    targetWrists: legacyFrames.flatMap((frame) =>
      frame.landmarks
        .filter((mark) => mark.name.endsWith("wrist") && mark.visibility >= 0.25)
        .map((mark) => ({ timestampMs: frame.timestampMs, x: mark.x, y: mark.y })),
    ),
  };
}

/** Dominant-wrist speed series (normalized u/s) from the legacy frames. */
function dominantWristSpeeds(
  legacy: ReturnType<typeof toLegacyPoseFrames>,
  window: { startMs: number; endMs: number },
): Array<{ timestampMs: number; value: number }> {
  // Choose the wrist with more total travel inside the window.
  const travel = { left: 0, right: 0 };
  const last: Record<string, { x: number; y: number } | undefined> = {};
  const perWrist: Record<"left" | "right", Array<{ timestampMs: number; value: number }>> = {
    left: [],
    right: [],
  };
  for (const frame of legacy) {
    for (const sideName of ["left", "right"] as const) {
      const mark = frame.landmarks.find(
        (landmark) => landmark.name === `${sideName}_wrist` && landmark.visibility >= 0.25,
      );
      if (!mark) continue;
      const prior = last[sideName];
      if (prior) {
        const dtSec =
          perWrist[sideName].length > 0
            ? (frame.timestampMs - perWrist[sideName][perWrist[sideName].length - 1]!.timestampMs) /
              1000
            : 0.04;
        const step = Math.hypot(mark.x - prior.x, mark.y - prior.y);
        if (dtSec > 0 && dtSec <= 0.15) {
          perWrist[sideName].push({ timestampMs: frame.timestampMs, value: step / dtSec });
          if (frame.timestampMs >= window.startMs && frame.timestampMs <= window.endMs) {
            travel[sideName] += step;
          }
        }
      }
      last[sideName] = { x: mark.x, y: mark.y };
    }
  }
  return travel.right >= travel.left ? perWrist.right : perWrist.left;
}

interface BallStage {
  tracking: BallTrackingOutcome | null;
  gated: BallTrackCandidate[];
  fragments: BallTrackCandidate[];
  reportEntry: LabRunReport["ballStage"];
  unavailableReason: string;
}

function summarizeAssociation(
  association: PaddleAssociationDecision,
): NonNullable<Extract<LabRunReport["paddle"], { status: "tracked" }>["association"]> {
  return {
    meanTargetWristDistance: association.meanTargetWristDistance,
    meanOtherWristDistance: association.meanOtherWristDistance,
    rejectedOtherPlayerTracks: association.rejectedOtherPlayerTracks,
    selectionMargin: association.selectionMargin,
    switchEvents: association.switchEvents.length,
    risks: association.risks,
  };
}

/** Best measured contact location: paddle center at the moment, else the
 * ball's own last pre-contact observation. */
function contactLocation(
  contactMs: number,
  paddle: readonly TrackedPaddleObservation[] | null,
  ball: readonly BallTrackObservation[],
): { x: number; y: number } | null {
  const paddleNear = paddle
    ?.filter((observation) => Math.abs(observation.timestampMs - contactMs) <= 80)
    .sort((a, b) => Math.abs(a.timestampMs - contactMs) - Math.abs(b.timestampMs - contactMs))[0];
  if (paddleNear) return { x: paddleNear.center.x, y: paddleNear.center.y };
  const ballNear = ball
    .filter((observation) => observation.timestampMs <= contactMs + 40)
    .sort((a, b) => b.timestampMs - a.timestampMs)[0];
  return ballNear ? { x: ballNear.x, y: ballNear.y } : null;
}

function summarizeTimeline(
  timeline: BallTimeline,
): NonNullable<Extract<LabRunReport["ballStage"], { status: "tracked" }>["timeline"]> {
  return {
    states: timeline.states.map(
      (span) => `${span.state} ${Math.round(span.fromMs)}-${Math.round(span.toMs)}ms`,
    ),
    reacquisition: timeline.reacquisition.attempted
      ? `${timeline.reacquisition.result}${timeline.reacquisition.contactAware ? " (contact-aware)" : ""}: ${timeline.reacquisition.detail}`
      : "not_attempted (track reaches window end)",
    bridgePointCount: timeline.bridge.length,
  };
}

/** Candidate-generation subprocess phase of the ball stage — see
 * preparePaddleDetections for the concurrency contract. Never throws. */
async function prepareBallCandidates(input: {
  args: CliArgs;
  window: { startMs: number; endMs: number };
  timings: Record<string, number>;
}): Promise<BallCandidatePrep> {
  const python = join(REPO_ROOT, "tools/paddle-lab/.venv/bin/python");
  const script = join(REPO_ROOT, "tools/paddle-lab/ball_candidates.py");
  if (!existsSync(python) || !existsSync(script)) {
    return { status: "env_missing" };
  }
  const candidatesPath = join(input.args.outDir, "ball-candidates.json");
  try {
    const wantedStart = Math.max(0, input.window.startMs - 1200);
    const wantedEnd = input.window.endMs + 1200;
    let reusable = false;
    if (input.args.reuseExtract && existsSync(candidatesPath)) {
      const existing = JSON.parse(readFileSync(candidatesPath, "utf8")) as BallCandidateFile;
      reusable =
        existing.window.startMs <= wantedStart + 100 && existing.window.endMs >= wantedEnd - 100;
      if (!reusable) console.log("existing ball candidates do not cover this window; regenerating");
    }
    if (!reusable) {
      console.log("generating ball candidates (3-frame differencing, python)…");
      const started = Date.now();
      await runPythonTool(python, [
        script,
        "--video",
        input.args.video,
        "--out",
        candidatesPath,
        "--start-ms",
        String(wantedStart),
        "--end-ms",
        String(wantedEnd),
      ]);
      input.timings["ballCandidatesMs"] = Date.now() - started;
    }
    return { status: "ready" };
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Temporal ball perception: motion candidates (python, deterministic) →
 * association → physics/context gates → pose/paddle-aware selection.
 * Apple-trajectory noise never reaches this path; failures are reasons.
 */
function runBallStage(input: {
  args: CliArgs;
  sequence: PoseSequence;
  /** Shared legacy projection from the pose-derivative cache. */
  legacyFrames: ReturnType<typeof toLegacyPoseFrames>;
  window: { startMs: number; endMs: number };
  paddle: readonly TrackedPaddleObservation[] | null;
  timings: Record<string, number>;
  prep: BallCandidatePrep;
}): BallStage {
  if (input.prep.status === "env_missing") {
    return {
      tracking: null,
      gated: [],
      fragments: [],
      reportEntry: { status: "unavailable", reason: "ball_candidate_env_not_installed" },
      unavailableReason: "ball_candidate_env_not_installed (tools/paddle-lab)",
    };
  }
  if (input.prep.status === "failed") {
    return {
      tracking: null,
      gated: [],
      fragments: [],
      reportEntry: {
        status: "unavailable",
        reason: `ball_candidates_failed: ${input.prep.message}`,
      },
      unavailableReason: `ball_candidates_failed: ${input.prep.message}`,
    };
  }
  const candidatesPath = join(input.args.outDir, "ball-candidates.json");
  try {
    const file = JSON.parse(readFileSync(candidatesPath, "utf8")) as BallCandidateFile;
    const trackStarted = Date.now();
    const { gated, fragments, ablation } = buildBallTracks(
      file,
      input.sequence,
      input.window,
      input.paddle,
      input.legacyFrames,
    );
    const tracking = selectPrimaryBallTrack(gated, ablation, input.window, {
      paddleTrackExists: (input.paddle?.length ?? 0) > 0,
      fragments,
    });
    input.timings["ballTrackMs"] = Date.now() - trackStarted;

    if (tracking.status === "tracked") {
      return {
        tracking,
        gated,
        fragments,
        reportEntry: {
          status: "tracked",
          trackId: tracking.lab.trackId,
          observationCount: tracking.lab.observations.length,
          windowOverlapMs: tracking.lab.windowOverlapMs,
          medianSpeed: tracking.lab.medianSpeed,
          minPaddleDistance: tracking.lab.minPaddleDistance,
          gatedTracks: tracking.gatedTracks.length,
          ablation: tracking.ablation,
          confidenceModel: BALL_CONFIDENCE_MODEL,
        },
        unavailableReason: "",
      };
    }
    return {
      tracking,
      gated,
      fragments,
      reportEntry: {
        status: "untracked",
        reason: tracking.reason,
        gatedTracks: tracking.gatedTracks.length,
        ablation: tracking.ablation,
      },
      unavailableReason: `ball_untracked: ${tracking.reason}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      tracking: null,
      gated: [],
      fragments: [],
      reportEntry: { status: "unavailable", reason: `ball_candidates_failed: ${message}` },
      unavailableReason: `ball_candidates_failed: ${message}`,
    };
  }
}

interface PlayersDebug {
  targetId: number;
  tracks: Array<{ id: number; points: Array<{ t: number; x: number; y: number }> }>;
}

function buildDebug(
  report: LabRunReport,
  record: AnalysisRecord | null,
  ballObservations: BallObservation[],
  paddle?: PaddleTrackingOutcome | null,
  ballTracking?: BallTrackingOutcome | null,
  players?: PlayersDebug | null,
): object {
  const phaseNames: Record<string, string> = {
    ready: "preparation",
    prepare: "backswing",
    accelerate: "acceleration",
    contact: "contact_zone",
    follow_through: "follow_through",
    recover: "recovery",
  };
  return {
    window: report.window
      ? {
          startMs: report.window.startMs,
          endMs: report.window.endMs,
          contactMs:
            report.contact?.status === "estimated"
              ? report.contact.estimatedContactMs
              : (report.window.peakMotionMs ?? null),
        }
      : null,
    quality: report.quality
      ? { analyzable: report.quality.analyzable, reasons: report.quality.reasons }
      : null,
    phases: (record?.result?.phases ?? []).map((span) => ({
      phase: phaseNames[span.key] ?? span.key,
      startMs: span.startMs,
      endMs: span.endMs,
    })),
    scoreLabel:
      record?.result && record.result.resultKind === "scored"
        ? `score ${record.result.overallScore}`
        : "no score",
    ballPoints: ballObservations.map((observation) => ({
      t: observation.timestampMs,
      x: observation.x,
      y: observation.y,
    })),
    paddle:
      paddle?.status === "tracked"
        ? {
            trackId: paddle.lab.trackId,
            confidenceModel: PADDLE_CONFIDENCE_MODEL,
            observations: paddle.lab.observations.map((observation) => ({
              t: Math.round(observation.timestampMs),
              x: observation.box.x,
              y: observation.box.y,
              w: observation.box.width,
              h: observation.box.height,
              conf: Number(observation.confidence.toFixed(3)),
            })),
          }
        : null,
    ballTrack:
      ballTracking?.status === "tracked"
        ? {
            trackId: ballTracking.lab.trackId,
            confidenceModel: BALL_CONFIDENCE_MODEL,
            observations: ballTracking.lab.observations.map((observation) => ({
              t: Math.round(observation.timestampMs),
              x: observation.x,
              y: observation.y,
              conf: Number(observation.confidence.toFixed(3)),
            })),
          }
        : null,
    contactInfo:
      report.contact?.status === "estimated"
        ? {
            tMs: report.contact.estimatedContactMs,
            confidence: Number(report.contact.confidence.toFixed(2)),
            ballConfirmed: report.contact.ballConfirmed,
            paddleConfirmed: report.contact.paddleConfirmed,
            evidence: report.contact.supportingEvidence.map((signal) => signal.signal),
          }
        : null,
    strokePrediction: report.strokePrediction
      ? {
          label: report.strokePrediction.label,
          confidence: Number(report.strokePrediction.confidence.toFixed(2)),
          depth: report.strokePrediction.taxonomyDepth,
        }
      : null,
    players: players ?? null,
    events: report.events
      ? {
          target:
            report.targetEvent?.status === "selected" ? report.targetEvent.event.eventId : null,
          list: report.events.proposals.map((event) => ({
            id: event.eventId,
            startMs: Math.round(event.startMs),
            endMs: Math.round(event.endMs),
            peakMs: Math.round(event.peakMs),
          })),
        }
      : null,
    ballTimeline:
      ballTracking?.status === "tracked"
        ? {
            states: ballTracking.timeline.states.map((span) => ({
              state: span.state,
              fromMs: Math.round(span.fromMs),
              toMs: Math.round(span.toMs),
            })),
            bridge: ballTracking.timeline.bridge.map((point) => ({
              t: Math.round(point.t),
              x: point.x,
              y: point.y,
            })),
          }
        : null,
  };
}

function finish(report: LabRunReport, args: CliArgs, debug: object | null): void {
  if (debug) {
    writeFileSync(join(args.outDir, "debug.json"), JSON.stringify(debug, null, 2));
  }
  if (args.overlay && debug) {
    const bin = ensureSwiftBinary();
    console.log("rendering overlay video…");
    const started = Date.now();
    execFileSync(
      bin,
      [
        "overlay",
        args.video,
        "--pose",
        join(args.outDir, "pose.json"),
        "--analysis",
        join(args.outDir, "debug.json"),
        "--out",
        join(args.outDir, "overlay.mp4"),
      ],
      { stdio: "inherit" },
    );
    report.timings["overlayRenderMs"] = Date.now() - started;
  }
  writeFileSync(join(args.outDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(renderReport(report));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
