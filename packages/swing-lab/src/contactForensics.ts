import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parsePoseSequence, toLegacyPoseFrames, type PoseSequence } from "@pickle/swing-domain";
import { detectOfflineStrokeWindow, estimateContact } from "@pickle/vision-geometry";
import { REPO_ROOT } from "./engine/corpus.js";
import {
  buildPlayerTracks,
  initializeTargetFromSeed,
  targetPoseSequence,
  type PeopleFile,
  type TargetSeed,
} from "./playerTracker.js";
import { clampToScene, decideScene, type ScenesFile } from "./sceneValidity.js";
import {
  proposeStrokeEventsV2,
  selectTargetEventV2,
  type StrokeEventProposalV2,
} from "./strokeEvents.js";

/**
 * CONTACT FORENSICS — replay harness for the contact estimator on the DEV
 * gold cases, over SANDBOX run artifacts (never the frozen canonical dirs).
 *
 *   npx tsx src/contactForensics.ts [--runs <dir>] [--dump-series] [--case <id>]
 *
 * For each case it reconstructs the exact estimator inputs the pipeline
 * builds (canonical target sequence, contact scan scope, paddle centers /
 * speeds from the persisted debug.json paddle track, ball observations from
 * the persisted temporal ball track), prints every raw signal timestamp and
 * its offset vs the gold contact, and prints what the frozen v3 flat fusion
 * would decide next to what the CURRENT estimator decides. This is a
 * diagnosis tool: it fabricates nothing, and when a modality is absent it
 * says so.
 *
 * Gold contacts come from the human annotation bundles
 * (bundles/<case>/annotation/devin-visual-v1.json, owner=target), never from
 * pipeline output.
 */

interface ForensicsCase {
  caseId: string;
  tap: { x: number; y: number };
  stroke: string;
}

const DEV_CASES: ForensicsCase[] = [
  { caseId: "wm-volley-02", tap: { x: 0.5271, y: 0.4552 }, stroke: "volley" },
  { caseId: "afn-sasebo-rally1", tap: { x: 0.5644, y: 0.4665 }, stroke: "volley" },
  { caseId: "afn-sasebo-rally2", tap: { x: 0.7923, y: 0.702 }, stroke: "volley" },
];

const PB = join(REPO_ROOT, "datasets/paddle-bench");
const DEFAULT_RUNS = join(REPO_ROOT, "datasets/experiments/wave-a/A-runs");

interface DebugPaddleObservation {
  t: number;
  x: number;
  y: number;
  w: number;
  h: number;
  conf: number;
}

interface DebugFile {
  paddle: { observations: DebugPaddleObservation[] } | null;
  ballTrack: { observations: Array<{ t: number; x: number; y: number; conf: number }> } | null;
  ballPoints: Array<{ t: number; x: number; y: number }>;
  ballTimeline: {
    states: Array<{ state: string; fromMs: number; toMs: number }>;
  } | null;
  events: { target: string | null; list: Array<{ id: string; startMs: number; endMs: number; peakMs: number }> } | null;
}

function loadGoldContact(caseId: string): number {
  const annotationPath = join(PB, "bundles", caseId, "annotation", "devin-visual-v1.json");
  const annotation = JSON.parse(readFileSync(annotationPath, "utf8")) as {
    eventLabels?: Array<{ owner: string; contactMs: number | null }>;
  };
  const target = (annotation.eventLabels ?? []).find((entry) => entry.owner === "target");
  if (!target || target.contactMs === null) {
    throw new Error(`no gold target contact in ${annotationPath}`);
  }
  return target.contactMs;
}

/** Rebuild the canonical target sequence exactly as analyzeVideo.ts does. */
function buildSequence(
  runDir: string,
  tap: { x: number; y: number },
): { sequence: PoseSequence; sceneSegment: { startMs: number; endMs: number } | null } {
  const poseJson = readFileSync(join(runDir, "pose.json"), "utf8");
  const parsed = parsePoseSequence(poseJson, {
    providerId: "pose.apple-vision",
    runtime: "vision_framework",
    executionTarget: "on_device",
    artifactHash: null,
  });
  if (!parsed.ok) throw new Error(`pose parse failed: ${parsed.failure.code}`);
  let sequence = parsed.value;

  const peoplePath = join(runDir, "people.json");
  if (existsSync(peoplePath)) {
    const people = JSON.parse(readFileSync(peoplePath, "utf8")) as PeopleFile;
    const tracks = buildPlayerTracks(people);
    const seed: TargetSeed = { mode: "user_tapped_person", point: tap };
    const seeded = initializeTargetFromSeed(tracks, seed);
    if (!seeded.ok) throw new Error(`target seed failed: ${seeded.failure.code}`);
    sequence = targetPoseSequence(people, seeded.value.target);
  }

  let sceneSegment: { startMs: number; endMs: number } | null = null;
  const scenesPath = join(runDir, "scenes.json");
  if (existsSync(scenesPath)) {
    const scenes = JSON.parse(readFileSync(scenesPath, "utf8")) as ScenesFile;
    const scene = decideScene(
      scenes,
      sequence.frames.map((frame) => frame.timestampMs),
    );
    sceneSegment = scene.analysisSegment;
    if (scene.multiShot) {
      sequence = {
        ...sequence,
        frames: sequence.frames.filter(
          (frame) =>
            frame.timestampMs >= scene.analysisSegment.startMs &&
            frame.timestampMs < scene.analysisSegment.endMs,
        ),
      };
    }
  }
  return { sequence, sceneSegment };
}

/** Same dominant-wrist speed series analyzeVideo.ts feeds event isolation. */
function dominantWristSpeeds(
  sequence: PoseSequence,
  window: { startMs: number; endMs: number },
): Array<{ timestampMs: number; value: number }> {
  const travel = { left: 0, right: 0 };
  const last: Record<string, { x: number; y: number } | undefined> = {};
  const perWrist: Record<"left" | "right", Array<{ timestampMs: number; value: number }>> = {
    left: [],
    right: [],
  };
  for (const frame of toLegacyPoseFrames(sequence)) {
    for (const sideName of ["left", "right"] as const) {
      const mark = frame.landmarks.find(
        (landmark) => landmark.name === `${sideName}_wrist` && landmark.visibility >= 0.25,
      );
      if (!mark) continue;
      const prior = last[sideName];
      if (prior) {
        const series = perWrist[sideName];
        const dtSec =
          series.length > 0
            ? (frame.timestampMs - series[series.length - 1]!.timestampMs) / 1000
            : 0.04;
        const step = Math.hypot(mark.x - prior.x, mark.y - prior.y);
        if (dtSec > 0 && dtSec <= 0.15) {
          series.push({ timestampMs: frame.timestampMs, value: step / dtSec });
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

/** Wrist positions of the target (normalized image coords, both wrists). */
function targetWristPositions(
  sequence: PoseSequence,
): Array<{ timestampMs: number; x: number; y: number }> {
  const positions: Array<{ timestampMs: number; x: number; y: number }> = [];
  for (const frame of toLegacyPoseFrames(sequence)) {
    for (const mark of frame.landmarks) {
      if (!mark.name.endsWith("wrist") || mark.visibility < 0.25) continue;
      positions.push({ timestampMs: frame.timestampMs, x: mark.x, y: mark.y });
    }
  }
  return positions;
}

function paddleCentersFromDebug(
  debug: DebugFile,
): Array<{ timestampMs: number; x: number; y: number }> | null {
  const observations = debug.paddle?.observations;
  if (!observations || observations.length === 0) return null;
  return observations.map((observation) => ({
    timestampMs: observation.t,
    x: observation.x + observation.w / 2,
    y: observation.y + observation.h / 2,
  }));
}

function speedSeriesFromCenters(
  centers: ReadonlyArray<{ timestampMs: number; x: number; y: number }>,
): Array<{ timestampMs: number; value: number }> {
  const series: Array<{ timestampMs: number; value: number }> = [];
  for (let index = 1; index < centers.length; index += 1) {
    const previous = centers[index - 1]!;
    const current = centers[index]!;
    const dtSec = (current.timestampMs - previous.timestampMs) / 1000;
    if (dtSec <= 0 || dtSec > 0.15) continue;
    series.push({
      timestampMs: current.timestampMs,
      value: Math.hypot(current.x - previous.x, current.y - previous.y) / dtSec,
    });
  }
  return series;
}

/**
 * Ball observations the FIRST estimateContact call saw: the persisted track
 * minus any contact-aware REACQUIRED tail (that relink runs only after the
 * first contact estimate exists, so its points were not inputs to it).
 */
function firstPassBallObservations(
  debug: DebugFile,
): Array<{ frameIndex: number; timestampMs: number; x: number; y: number; confidence: number }> | null {
  const track = debug.ballTrack?.observations;
  if (track && track.length > 0) {
    const reacquired = (debug.ballTimeline?.states ?? []).find(
      (span) => span.state === "REACQUIRED",
    );
    const cutoff = reacquired ? reacquired.fromMs : Infinity;
    const kept = track.filter((observation) => observation.t < cutoff);
    return kept.map((observation, index) => ({
      frameIndex: index,
      timestampMs: observation.t,
      x: observation.x,
      y: observation.y,
      confidence: observation.conf,
    }));
  }
  if (debug.ballPoints.length > 0) {
    return debug.ballPoints.map((point, index) => ({
      frameIndex: index,
      timestampMs: point.t,
      x: point.x,
      y: point.y,
      confidence: 0.5,
    }));
  }
  return null;
}

/** The frozen v3 fusion (flat weighted mean + 250ms disagreement veto),
 * re-implemented here as the reference the candidate is compared against. */
function v3ReferenceFusion(
  signals: Array<{ signal: string; timestampMs: number; weight: number }>,
): { status: "estimated"; estimatedContactMs: number; spreadMs: number } | { status: "abstained"; spreadMs: number } {
  const total = signals.reduce((sum, signal) => sum + signal.weight, 0);
  const fused = signals.reduce((sum, signal) => sum + signal.timestampMs * signal.weight, 0) / total;
  const spread =
    signals.length > 1
      ? Math.max(...signals.map((signal) => Math.abs(signal.timestampMs - fused)))
      : 0;
  if (spread > 250) return { status: "abstained", spreadMs: Math.round(spread) };
  return { status: "estimated", estimatedContactMs: Math.round(fused), spreadMs: Math.round(spread) };
}

/** v3's signal extraction (global peaks / sharpest turn / closest approach),
 * reproduced for the side-by-side print. */
function v3Signals(input: {
  sequence: PoseSequence;
  window: { startMs: number; endMs: number };
  ball: ReadonlyArray<{ timestampMs: number; x: number; y: number }> | null;
  paddleSpeeds: ReadonlyArray<{ timestampMs: number; value: number }> | null;
  paddleCenters: ReadonlyArray<{ timestampMs: number; x: number; y: number }> | null;
}): Array<{ signal: string; timestampMs: number; weight: number; detail: string }> {
  const signals: Array<{ signal: string; timestampMs: number; weight: number; detail: string }> = [];
  const paddle = input.paddleSpeeds
    ?.filter((sample) => sample.timestampMs >= input.window.startMs && sample.timestampMs <= input.window.endMs)
    .sort((a, b) => a.timestampMs - b.timestampMs);
  if (paddle && paddle.length >= 5) {
    let peak = 0;
    for (let index = 1; index < paddle.length; index += 1) {
      if (paddle[index]!.value > paddle[peak]!.value) peak = index;
    }
    if (paddle[peak]!.value >= 0.5) {
      signals.push({
        signal: "paddle_speed_peak",
        timestampMs: paddle[peak]!.timestampMs,
        weight: 0.45,
        detail: `peak ${paddle[peak]!.value.toFixed(2)} u/s`,
      });
    }
  }
  const frames = toLegacyPoseFrames(input.sequence).filter(
    (frame) => frame.timestampMs >= input.window.startMs && frame.timestampMs <= input.window.endMs,
  );
  const aspect =
    input.sequence.video.height > 0 ? input.sequence.video.width / input.sequence.video.height : 1;
  const wristSpeed = (name: "left_wrist" | "right_wrist") => {
    const tracked: Array<{ timestampMs: number; x: number; y: number }> = [];
    for (const frame of frames) {
      const mark = frame.landmarks.find((entry) => entry.name === name && entry.visibility >= 0.3);
      if (mark) tracked.push({ timestampMs: frame.timestampMs, x: mark.x * aspect, y: mark.y });
    }
    const series: Array<{ timestampMs: number; value: number }> = [];
    for (let index = 1; index < tracked.length; index += 1) {
      const dtMs = tracked[index]!.timestampMs - tracked[index - 1]!.timestampMs;
      if (dtMs <= 0 || dtMs > 150) continue;
      series.push({
        timestampMs: tracked[index]!.timestampMs,
        value:
          (Math.hypot(
            tracked[index]!.x - tracked[index - 1]!.x,
            tracked[index]!.y - tracked[index - 1]!.y,
          ) /
            dtMs) *
          1000,
      });
    }
    return series;
  };
  const right = wristSpeed("right_wrist");
  const left = wristSpeed("left_wrist");
  const sumOf = (series: Array<{ value: number }>) =>
    series.reduce((total, sample) => total + sample.value, 0);
  const wrist = sumOf(right) >= sumOf(left) ? right : left;
  if (wrist.length >= 5) {
    let peak = 0;
    for (let index = 1; index < wrist.length; index += 1) {
      if (wrist[index]!.value > wrist[peak]!.value) peak = index;
    }
    signals.push({
      signal: "wrist_speed_peak",
      timestampMs: wrist[peak]!.timestampMs,
      weight: 0.4,
      detail: `peak ${wrist[peak]!.value.toFixed(2)} u/s`,
    });
  }
  const ball = input.ball
    ?.filter(
      (observation) =>
        observation.timestampMs >= input.window.startMs - 250 &&
        observation.timestampMs <= input.window.endMs + 250,
    )
    .sort((a, b) => a.timestampMs - b.timestampMs);
  if (ball && ball.length >= 4) {
    let bestTurn: { timestampMs: number; angleDeg: number } | null = null;
    for (let index = 1; index < ball.length - 1; index += 1) {
      const previous = ball[index - 1]!;
      const current = ball[index]!;
      const next = ball[index + 1]!;
      const inVec = { x: current.x - previous.x, y: current.y - previous.y };
      const outVec = { x: next.x - current.x, y: next.y - current.y };
      const inMag = Math.hypot(inVec.x, inVec.y);
      const outMag = Math.hypot(outVec.x, outVec.y);
      if (inMag < 1e-6 || outMag < 1e-6) continue;
      const cos = Math.min(1, Math.max(-1, (inVec.x * outVec.x + inVec.y * outVec.y) / (inMag * outMag)));
      const angleDeg = (Math.acos(cos) * 180) / Math.PI;
      if (angleDeg < 35) continue;
      if (!bestTurn || angleDeg > bestTurn.angleDeg) {
        bestTurn = { timestampMs: current.timestampMs, angleDeg };
      }
    }
    if (bestTurn) {
      signals.push({
        signal: "ball_direction_change",
        timestampMs: bestTurn.timestampMs,
        weight: 0.35,
        detail: `${bestTurn.angleDeg.toFixed(0)}°`,
      });
    }
    if (input.paddleCenters && input.paddleCenters.length > 0) {
      let best: { timestampMs: number; distance: number } | null = null;
      for (const observation of ball) {
        let nearest: { x: number; y: number } | null = null;
        let nearestDelta = Infinity;
        for (const center of input.paddleCenters) {
          const delta = Math.abs(center.timestampMs - observation.timestampMs);
          if (delta < nearestDelta) {
            nearestDelta = delta;
            nearest = center;
          }
        }
        if (!nearest || nearestDelta > 60) continue;
        const distance = Math.hypot(nearest.x - observation.x, nearest.y - observation.y);
        if (!best || distance < best.distance) best = { timestampMs: observation.timestampMs, distance };
      }
      if (best) {
        signals.push({
          signal: "ball_paddle_proximity",
          timestampMs: best.timestampMs,
          weight: 0.3,
          detail: `min dist ${best.distance.toFixed(3)}`,
        });
      }
    }
  }
  return signals;
}

function fmtOffset(timestampMs: number, gold: number): string {
  const delta = Math.round(timestampMs - gold);
  return `${delta >= 0 ? "+" : ""}${delta}ms vs gold`;
}

function main(): void {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | null => {
    const index = argv.indexOf(name);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1]! : null;
  };
  const runsDir = resolve(flag("--runs") ?? DEFAULT_RUNS);
  const only = flag("--case");
  const dumpSeries = argv.includes("--dump-series");

  for (const forensicsCase of DEV_CASES) {
    if (only && forensicsCase.caseId !== only) continue;
    const runDir = join(runsDir, forensicsCase.caseId);
    if (!existsSync(join(runDir, "debug.json"))) {
      console.log(`\n=== ${forensicsCase.caseId}: SKIPPED (no debug.json in ${runDir})`);
      continue;
    }
    const gold = loadGoldContact(forensicsCase.caseId);
    const debug = JSON.parse(readFileSync(join(runDir, "debug.json"), "utf8")) as DebugFile;
    const { sequence, sceneSegment } = buildSequence(runDir, forensicsCase.tap);

    const window = detectOfflineStrokeWindow(sequence);
    if (!window.ok) {
      console.log(`\n=== ${forensicsCase.caseId}: no stroke window (${window.failure.code})`);
      continue;
    }
    let strokeWindow = window.value;
    if (sceneSegment) {
      const clamped = clampToScene(strokeWindow, sceneSegment);
      if (clamped) strokeWindow = { ...strokeWindow, startMs: clamped.startMs, endMs: clamped.endMs };
    }

    const paddleCenters = paddleCentersFromDebug(debug);
    const paddleSpeeds = paddleCenters ? speedSeriesFromCenters(paddleCenters) : null;
    const ballObservations = firstPassBallObservations(debug);
    const wristSpeeds = dominantWristSpeeds(sequence, strokeWindow);
    const targetWrists = targetWristPositions(sequence);

    // Contact scan scope exactly as analyzeVideo.ts builds it.
    const proposals = proposeStrokeEventsV2({
      paddleSpeeds,
      wristSpeeds,
      clipStartMs: 0,
      clipEndMs: sequence.frames[sequence.frames.length - 1]?.timestampMs ?? strokeWindow.endMs,
    });
    const CONTACT_SCOPE_MS = 450;
    const contactScope = (event: { startMs: number; endMs: number; peakMs: number }) => ({
      startMs: Math.max(event.startMs, event.peakMs - CONTACT_SCOPE_MS),
      endMs: Math.min(event.endMs, event.peakMs + CONTACT_SCOPE_MS),
      peakMotionMs: event.peakMs,
    });
    const provisional = selectTargetEventV2(proposals.events, null);
    const scanWindow =
      provisional.status === "selected"
        ? contactScope(provisional.event)
        : { startMs: strokeWindow.startMs, endMs: strokeWindow.endMs, peakMotionMs: strokeWindow.peakMotionMs };

    console.log(`\n${"═".repeat(78)}`);
    console.log(
      `${forensicsCase.caseId} · gold contact ${gold}ms · stroke ${forensicsCase.stroke}`,
    );
    console.log(
      `window ${Math.round(strokeWindow.startMs)}–${Math.round(strokeWindow.endMs)} peak ${Math.round(strokeWindow.peakMotionMs)} · scan ${Math.round(scanWindow.startMs)}–${Math.round(scanWindow.endMs)} (provisional ${provisional.status === "selected" ? provisional.event.eventId : provisional.status})`,
    );
    console.log(
      `events: ${proposals.events.map((event: StrokeEventProposalV2) => `${event.eventId}[${Math.round(event.startMs)}–${Math.round(event.endMs)} peak ${Math.round(event.peakMs)}]`).join(" ")}`,
    );
    console.log(
      `modalities: paddle ${paddleCenters ? `${paddleCenters.length} centers` : "ABSENT"} · ball ${ballObservations ? `${ballObservations.length} obs ${Math.round(ballObservations[0]!.timestampMs)}–${Math.round(ballObservations[ballObservations.length - 1]!.timestampMs)}` : "ABSENT"}`,
    );

    // v3 side: reproduce signals + flat fusion.
    const signals = v3Signals({
      sequence,
      window: scanWindow,
      ball: ballObservations,
      paddleSpeeds,
      paddleCenters,
    });
    console.log("v3 signals (raw):");
    for (const signal of signals) {
      console.log(
        `  ${signal.signal.padEnd(24)} ${String(Math.round(signal.timestampMs)).padStart(6)}ms  ${fmtOffset(signal.timestampMs, gold).padEnd(16)} w${signal.weight}  ${signal.detail}`,
      );
    }
    const v3 = v3ReferenceFusion(signals);
    console.log(
      `v3 flat fusion: ${v3.status === "estimated" ? `${v3.estimatedContactMs}ms (${fmtOffset(v3.estimatedContactMs, gold)}), spread ${v3.spreadMs}ms` : `ABSTAINED (spread ${v3.spreadMs}ms > 250)`}`,
    );

    // Current estimator (v4 once landed) with the new optional inputs.
    const estimate = estimateContact({
      sequence,
      window: scanWindow,
      ballObservations,
      paddleSpeeds,
      paddleCenters,
      targetWrists,
      strokeFamily: "volley",
      includeFusionKernels: true,
    });
    if (estimate.status === "estimated") {
      console.log(
        `current estimator: ${estimate.estimatedContactMs}ms (${fmtOffset(estimate.estimatedContactMs, gold)}) conf ${estimate.confidence.toFixed(2)} ballConfirmed=${estimate.ballConfirmed} paddleConfirmed=${estimate.paddleConfirmed}`,
      );
      for (const signal of estimate.supportingEvidence) {
        console.log(
          `  ${signal.signal.padEnd(24)} ${String(Math.round(signal.timestampMs)).padStart(6)}ms  ${fmtOffset(signal.timestampMs, gold).padEnd(16)} w${signal.weight}  ${signal.detail}`,
        );
      }
      if (estimate.limitingFactors.length > 0) {
        console.log(`  limiting: ${estimate.limitingFactors.join(", ")}`);
      }
      if (estimate.modes && estimate.modes.length > 1) {
        console.log(
          `  modes: ${estimate.modes.map((mode) => `${mode.tMs}ms (${(mode.share * 100).toFixed(0)}%)`).join(" · ")}`,
        );
      }
      if (dumpSeries && estimate.fusionKernels) {
        console.log("  kernels:");
        for (const kernel of estimate.fusionKernels) {
          console.log(
            `    ${kernel.signal.padEnd(24)} ${String(kernel.tMs).padStart(6)}ms mass ${kernel.mass.toFixed(3)} σ${kernel.sigmaMs}  ${kernel.note}`,
          );
        }
      }
    } else {
      console.log(`current estimator: ABSTAINED — ${estimate.reason}`);
      if (estimate.modes) {
        console.log(
          `  modes: ${estimate.modes.map((mode) => `${mode.tMs}ms (${(mode.share * 100).toFixed(0)}%)`).join(" · ")}`,
        );
      }
    }
    const distribution =
      estimate.status === "estimated" || estimate.status === "abstained"
        ? (estimate as { contactDistribution?: Array<{ tMs: number; density: number }> })
            .contactDistribution
        : undefined;
    if (distribution && distribution.length > 2) {
      const maxima: Array<{ tMs: number; density: number }> = [];
      for (let index = 1; index < distribution.length - 1; index += 1) {
        if (
          distribution[index]!.density > distribution[index - 1]!.density &&
          distribution[index]!.density >= distribution[index + 1]!.density
        ) {
          maxima.push(distribution[index]!);
        }
      }
      console.log(
        `  density maxima: ${maxima
          .sort((a, b) => b.density - a.density)
          .slice(0, 5)
          .map((mode) => `${mode.tMs}ms(${mode.density.toFixed(2)})`)
          .join(" · ")}`,
      );
    }

    if (dumpSeries) {
      console.log("paddle speed series (scan window ±300ms):");
      for (const sample of paddleSpeeds ?? []) {
        if (sample.timestampMs < scanWindow.startMs - 300 || sample.timestampMs > scanWindow.endMs + 300) continue;
        const bar = "#".repeat(Math.min(60, Math.round(sample.value * 20)));
        const mark = Math.abs(sample.timestampMs - gold) <= 20 ? " <== GOLD" : "";
        console.log(`  ${String(Math.round(sample.timestampMs)).padStart(6)} ${sample.value.toFixed(2).padStart(6)} ${bar}${mark}`);
      }
      console.log("dominant wrist speed series (scan window ±300ms):");
      for (const sample of wristSpeeds) {
        if (sample.timestampMs < scanWindow.startMs - 300 || sample.timestampMs > scanWindow.endMs + 300) continue;
        const bar = "#".repeat(Math.min(60, Math.round(sample.value * 20)));
        const mark = Math.abs(sample.timestampMs - gold) <= 20 ? " <== GOLD" : "";
        console.log(`  ${String(Math.round(sample.timestampMs)).padStart(6)} ${sample.value.toFixed(2).padStart(6)} ${bar}${mark}`);
      }
      if (ballObservations) {
        console.log("ball observations (scan window ±300ms):");
        for (const observation of ballObservations) {
          if (observation.timestampMs < scanWindow.startMs - 300 || observation.timestampMs > scanWindow.endMs + 300) continue;
          const mark = Math.abs(observation.timestampMs - gold) <= 20 ? " <== GOLD" : "";
          console.log(
            `  ${String(Math.round(observation.timestampMs)).padStart(6)} (${observation.x.toFixed(3)}, ${observation.y.toFixed(3)}) conf ${observation.confidence.toFixed(2)}${mark}`,
          );
        }
      }
      const torso = medianTorsoSpan(sequence);
      console.log(`median torso span: ${torso === null ? "unmeasured" : torso.toFixed(3)} image units`);
      void targetWrists;
    }
  }
}

/** Median shoulder-mid→hip-mid distance (normalized image units). */
function medianTorsoSpan(sequence: PoseSequence): number | null {
  const spans: number[] = [];
  for (const frame of toLegacyPoseFrames(sequence)) {
    const get = (name: string) =>
      frame.landmarks.find((mark) => mark.name === name && mark.visibility >= 0.3) ?? null;
    const ls = get("left_shoulder");
    const rs = get("right_shoulder");
    const lh = get("left_hip");
    const rh = get("right_hip");
    if (!ls || !rs || !lh || !rh) continue;
    spans.push(
      Math.hypot(
        (ls.x + rs.x) / 2 - (lh.x + rh.x) / 2,
        (ls.y + rs.y) / 2 - (lh.y + rh.y) / 2,
      ),
    );
  }
  if (spans.length === 0) return null;
  const sorted = [...spans].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

main();
