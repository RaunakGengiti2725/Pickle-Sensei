/**
 * Stress units for the swing-lab long-run-leak campaign.
 *
 * Every unit turns a 32-bit seed into a SYNTHETIC input stream (seeded LCG
 * over the committed generators — `generateSwingSequence`, the adversarial
 * fixture corpus, the frozen coach-gates spec) and invokes the production
 * function under test. No labels are fabricated: the properties checked are
 * label-free (finite outputs, ordering, abstention carries a reason,
 * determinism, lifecycle cleanup). Classification quality is owned by the
 * benchmark, not by this harness.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preAnalysisGate } from "@pickle/analysis-pipeline";
import { generateSwingSequence } from "@pickle/evaluation";
import type { PoseSequence } from "@pickle/swing-domain";
import { evaluateFrameAnalyzability, type FrameStats } from "@pickle/vision-geometry";
import {
  ballSpeedSeries,
  buildBallTracks,
  buildPaddleTracks,
  buildPlayerTracks,
  checkArtifactInvariants,
  classifyStroke,
  mergePaddleTracklets,
  otherPlayersWrists,
  paddleSpeedSeries,
  proposeStrokeEvents,
  segmentPhasesTemporalV2,
  selectPrimaryBallTrack,
  selectPrimaryPaddleTrack,
  selectTargetPlayer,
  targetPoseSequence,
  wristSeries,
  type BallCandidateFile,
  type PeopleFile,
  type RawPaddleDetectionFile,
  type TrackedPaddleObservation,
} from "../../src/index.js";
import { runCoachGates } from "../../src/coachGates.js";
import { PaddleServeWorker, PaddleWorkerSupervisor } from "../../src/paddleWorker.js";
import { proposeStrokeEventsV2 } from "../../src/strokeEvents.js";
import {
  buildSyntheticInputs,
  defaultShadowPair,
  evaluateShadowRow,
} from "../../src/shadowEval.js";
import { findNonFinite, lcg, type IterationResult, type StressUnit } from "./leakHarness.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const jsonRoundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const between = (rand: () => number, lo: number, hi: number) => lo + rand() * (hi - lo);
const pick = <T>(rand: () => number, items: readonly T[]): T =>
  items[Math.floor(rand() * items.length)]!;

function result(
  output: unknown,
  abstained: boolean,
  violations: string[] = [],
  allowNonFinite: (path: string) => boolean = () => false,
): IterationResult {
  return {
    output,
    abstained,
    nonFinite: findNonFinite(output).filter((path) => !allowNonFinite(path)),
    violations,
  };
}

// ── seeded synthetic streams ───────────────────────────────────────────────

/** A perturbed synthetic swing: body scale, contact geometry, handedness,
 *  frame rate and phase durations drawn from plausible ranges, plus optional
 *  visibility degradation so the abstention paths are exercised too. */
function seededSwing(rand: () => number) {
  const handed: "right" | "left" = rand() < 0.5 ? "right" : "left";
  const { sequence, window } = generateSwingSequence({
    torsoLength: between(rand, 0.14, 0.28),
    stanceWidthRatio: between(rand, 1.0, 1.8),
    kneeFlexionDeg: between(rand, 10, 60),
    contactForwardNorm: between(rand, 0.1, 0.8),
    contactHeightRatio: between(rand, 0.15, 1.3),
    backswingLengthNorm: between(rand, 0.3, 1.3),
    swingDipNorm: between(rand, 0.0, 0.3),
    shoulderTurnDeg: between(rand, 10, 90),
    handed,
    fps: pick(rand, [30, 60]),
    readyMs: Math.round(between(rand, 200, 600)),
    backswingMs: Math.round(between(rand, 250, 700)),
    accelerateMs: Math.round(between(rand, 150, 400)),
    followMs: Math.round(between(rand, 200, 500)),
    recoverMs: Math.round(between(rand, 300, 700)),
  });
  const degrade = rand();
  const degraded: PoseSequence =
    degrade < 0.25
      ? {
          ...sequence,
          frames: sequence.frames.map((frame) => ({
            ...frame,
            landmarks: frame.landmarks.map((mark) => {
              const hit = rand() < 0.3;
              return hit
                ? {
                    ...mark,
                    visibility: rand() * 0.4,
                    x: mark.x + (rand() - 0.5) * 0.02,
                    y: mark.y + (rand() - 0.5) * 0.02,
                  }
                : mark;
            }),
          })),
        }
      : sequence;
  return { sequence: degraded, window, handed, degraded: degrade < 0.25 };
}

function wristSpeedSeries(sequence: PoseSequence, handed: "right" | "left") {
  const name = `${handed}_wrist`;
  const series: Array<{ timestampMs: number; value: number }> = [];
  let previous: { t: number; x: number; y: number } | null = null;
  for (const frame of sequence.frames) {
    const wrist = frame.landmarks.find((mark) => mark.name === name);
    if (!wrist) continue;
    if (previous) {
      const dt = (frame.timestampMs - previous.t) / 1000;
      if (dt > 0) {
        series.push({
          timestampMs: frame.timestampMs,
          value: Math.hypot(wrist.x - previous.x, wrist.y - previous.y) / dt,
        });
      }
    }
    previous = { t: frame.timestampMs, x: wrist.x, y: wrist.y };
  }
  return series;
}

/** Paddle observations riding the dominant wrist with seeded jitter/dropout. */
function seededPaddleObservations(
  rand: () => number,
  sequence: PoseSequence,
  handed: "right" | "left",
): TrackedPaddleObservation[] {
  const name = `${handed}_wrist`;
  const dropRate = rand() * 0.3;
  const jitter = rand() * 0.02;
  const observations: TrackedPaddleObservation[] = [];
  for (const frame of sequence.frames) {
    if (rand() < dropRate) continue;
    const wrist = frame.landmarks.find((mark) => mark.name === name);
    if (!wrist) continue;
    const cx = wrist.x + (rand() - 0.5) * jitter;
    const cy = wrist.y - 0.04 + (rand() - 0.5) * jitter;
    const confidence = between(rand, 0.3, 0.95);
    observations.push({
      timestampMs: frame.timestampMs,
      box: { x: cx - 0.03, y: cy - 0.04, width: 0.06, height: 0.08 },
      center: { x: cx, y: cy },
      detectorScore: confidence,
      trackId: 1,
      confidence,
      nearWrist: true,
    });
  }
  return observations;
}

function seededSpeedSeries(rand: () => number, clipEndMs: number) {
  const stepMs = 20 + Math.floor(rand() * 30);
  const series: Array<{ timestampMs: number; value: number }> = [];
  let value = rand() * 0.4;
  for (let t = 0; t <= clipEndMs; t += stepMs) {
    value = Math.max(0, value + (rand() - 0.5) * 0.4);
    if (rand() < 0.05) value += rand() * 4;
    series.push({ timestampMs: t, value });
  }
  return series;
}

// ── control: does nothing but return a seed-derived value ──────────────────
// Its heap slope is the harness's own floor (the per-iteration results row);
// a production unit's slope should be read net of this one.

export const controlNoopUnit: StressUnit = {
  id: "control-noop",
  iterate(seed) {
    const rand = lcg(seed);
    return result({ seed, value: rand() }, false, []);
  },
};

// ── unit: stroke classifier (the mobile AUTO DETECT path) ──────────────────

export const strokeClassifierUnit: StressUnit = {
  id: "stroke-classifier",
  iterate(seed) {
    const rand = lcg(seed);
    const { sequence, window, handed } = seededSwing(rand);
    const paddle = rand() < 0.75 ? seededPaddleObservations(rand, sequence, handed) : null;
    const useContact = rand() < 0.7;
    const prediction = classifyStroke({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs },
      contactMs: useContact ? window.peakMs + Math.round((rand() - 0.5) * 60) : null,
      eventPeakMs: window.peakMs,
      handedness: handed,
      paddle,
      paddleSpeeds: paddle ? paddleSpeedSeries(paddle) : null,
      wristSpeeds: wristSpeedSeries(sequence, handed),
    });
    const violations: string[] = [];
    if (!(prediction.confidence >= 0 && prediction.confidence <= 1)) {
      violations.push(`confidence_out_of_unit_range:${prediction.confidence}`);
    }
    if (prediction.label.length === 0) violations.push("empty_label");
    const abstained = prediction.label === "UNKNOWN";
    if (abstained && prediction.limitingFactors.length === 0) {
      violations.push("abstention_without_limiting_factor");
    }
    return result(prediction, abstained, violations);
  },
};

// ── unit: ball tracker ─────────────────────────────────────────────────────

const BALL_WINDOW = { startMs: 300, endMs: 1400 };
const ballCandidate = (x: number, y: number, rand: () => number) => ({
  x,
  y,
  areaPx: 20 + Math.floor(rand() * 60),
  wNorm: 0.008 + rand() * 0.006,
  hNorm: 0.008 + rand() * 0.006,
  elong: 1 + rand() * 0.6,
  score: 200 + Math.floor(rand() * 600),
});

function seededBallFile(rand: () => number): BallCandidateFile {
  const frameCount = 50;
  const stepMs = 40;
  const flights: Array<{
    startMs: number;
    count: number;
    x0: number;
    y0: number;
    dx: number;
    dy: number;
  }> = [];
  const flightCount = 1 + Math.floor(rand() * 3);
  for (let index = 0; index < flightCount; index += 1) {
    flights.push({
      startMs: Math.floor(rand() * 20) * stepMs,
      count: 8 + Math.floor(rand() * 25),
      x0: rand(),
      y0: between(rand, 0.1, 0.9),
      dx: (rand() - 0.5) * 0.08,
      dy: (rand() - 0.5) * 0.04,
    });
  }
  const jitter = rand() * 0.006;
  const noiseRate = rand() * 3;
  const frames: BallCandidateFile["frames"] = [];
  for (let index = 0; index < frameCount; index += 1) {
    const tMs = index * stepMs;
    const candidates: BallCandidateFile["frames"][number]["candidates"] = [];
    for (const flight of flights) {
      const k = (tMs - flight.startMs) / stepMs;
      if (k < 0 || k >= flight.count) continue;
      candidates.push(
        ballCandidate(
          flight.x0 + k * flight.dx + (rand() - 0.5) * jitter,
          flight.y0 + k * flight.dy + (rand() - 0.5) * jitter,
          rand,
        ),
      );
    }
    const noise = Math.floor(rand() * noiseRate);
    for (let n = 0; n < noise; n += 1) candidates.push(ballCandidate(rand(), rand(), rand));
    frames.push({ tMs, candidates, rawComponentCount: candidates.length });
  }
  return {
    schemaVersion: 1,
    generator: { version: "stress", method: "synthetic", scale: 0.5, note: "" },
    video: { path: "stress.mp4", width: 1000, height: 1000, fps: 25, durationMs: 4000 },
    window: { startMs: 0, endMs: 4000 },
    backgroundActivity: { grid: 24, cells: new Array(24 * 24).fill(0) },
    timing: { framesProcessed: frames.length, wallSecTotal: 0, msPerFrame: 0 },
    frames,
  };
}

const BALL_POSE = generateSwingSequence().sequence;

export const ballTrackerUnit: StressUnit = {
  id: "ball-tracker",
  iterate(seed) {
    const rand = lcg(seed);
    const file = seededBallFile(rand);
    const paddle = rand() < 0.5 ? seededPaddleObservations(rand, BALL_POSE, "right") : null;
    const { gated, all, fragments, ablation } = buildBallTracks(
      file,
      BALL_POSE,
      BALL_WINDOW,
      paddle,
    );
    const outcome = selectPrimaryBallTrack(gated, ablation, BALL_WINDOW, {
      paddleTrackExists: paddle !== null,
      fragments,
    });
    const violations: string[] = [];
    let speeds: Array<{ timestampMs: number; value: number }> = [];
    if (outcome.status === "tracked") {
      speeds = ballSpeedSeries(outcome.lab.observations);
      let last = -Infinity;
      for (const observation of outcome.track.observations) {
        if (observation.timestampMs < last) violations.push("observations_not_time_ordered");
        last = observation.timestampMs;
      }
    }
    return result(
      { outcome, allCount: all.length, gatedCount: gated.length, speeds },
      outcome.status !== "tracked",
      violations,
    );
  },
};

// ── unit: player tracker ───────────────────────────────────────────────────

function person(x: number, y: number, span: number, v: number) {
  return {
    c: v,
    l: [
      { n: "left_shoulder", x: x - 0.02, y, v },
      { n: "right_shoulder", x: x + 0.02, y, v },
      { n: "left_hip", x: x - 0.02, y: y + span, v },
      { n: "right_hip", x: x + 0.02, y: y + span, v },
      { n: "left_wrist", x, y: y + span + 0.05, v },
      { n: "right_wrist", x: x + 0.03, y: y + span + 0.05, v },
    ],
  };
}

function seededPeopleFile(rand: () => number): PeopleFile {
  const people = 1 + Math.floor(rand() * 3);
  const frameCount = 40 + Math.floor(rand() * 60);
  const walkers = Array.from({ length: people }, () => ({
    x: between(rand, 0.1, 0.9),
    y: between(rand, 0.3, 0.6),
    vx: (rand() - 0.5) * 0.02,
    span: between(rand, 0.08, 0.16),
    dropFrom: rand() < 0.4 ? Math.floor(rand() * frameCount) : -1,
    dropLen: 2 + Math.floor(rand() * 10),
  }));
  const frames: PeopleFile["frames"] = [];
  for (let i = 0; i < frameCount; i += 1) {
    const p: PeopleFile["frames"][number]["p"] = [];
    for (const walker of walkers) {
      if (walker.dropFrom >= 0 && i >= walker.dropFrom && i < walker.dropFrom + walker.dropLen)
        continue;
      p.push(
        person(
          Math.min(0.95, Math.max(0.05, walker.x + i * walker.vx)),
          walker.y,
          walker.span,
          between(rand, 0.5, 1),
        ),
      );
    }
    frames.push({ t: i * 33, p });
  }
  return {
    schemaVersion: 1,
    poseModelVersion: "synthetic",
    video: { w: 1920, h: 1080, fps: 30 },
    frames,
  };
}

export const playerTrackerUnit: StressUnit = {
  id: "player-tracker",
  iterate(seed) {
    const rand = lcg(seed);
    const file = seededPeopleFile(rand);
    const tracks = buildPlayerTracks(file);
    const selection = selectTargetPlayer(tracks, { policy: "auto" }, null);
    const violations: string[] = [];
    for (const track of tracks) {
      if (!(track.coverage >= 0 && track.coverage <= 1)) violations.push("coverage_out_of_range");
    }
    let derived: unknown = null;
    if (selection.ok) {
      const target = selection.value.target;
      const pose = targetPoseSequence(file, target);
      const others = otherPlayersWrists(tracks, target.trackId);
      derived = { frames: pose.frames.length, otherFrames: others.length };
      if (!(selection.value.confidence >= 0 && selection.value.confidence <= 1)) {
        violations.push("selection_confidence_out_of_range");
      }
    } else if (selection.failure.code.length === 0) {
      violations.push("failure_without_code");
    }
    return result({ tracks, selection, derived }, !selection.ok, violations);
  },
};

// ── unit: paddle tracker (build → merge → select → speeds) ─────────────────

const PADDLE_VIDEO = { path: "stress.mp4", width: 1000, height: 1000, fps: 60, durationMs: 4000 };

function seededPaddleFile(
  rand: () => number,
  sequence: PoseSequence,
  handed: "right" | "left",
): RawPaddleDetectionFile {
  const name = `${handed}_wrist`;
  const dropEvery = rand() < 0.5 ? 0 : 2 + Math.floor(rand() * 6);
  const falsePositives = Math.floor(rand() * 3);
  const statics = Array.from({ length: falsePositives }, () => ({
    x: rand() * 1000,
    y: rand() * 1000,
    score: between(rand, 0.3, 0.95),
  }));
  const frames: RawPaddleDetectionFile["frames"] = [];
  let index = 0;
  for (const frame of sequence.frames) {
    index += 1;
    const detections: RawPaddleDetectionFile["frames"][number]["detections"] = [];
    const wrist = frame.landmarks.find((mark) => mark.name === name);
    if (wrist && !(dropEvery && index % dropEvery === 0)) {
      const cx = wrist.x * 1000 + (rand() - 0.5) * 10;
      const cy = wrist.y * 1000 - 40 + (rand() - 0.5) * 10;
      detections.push({
        box: [cx - 35, cy - 45, cx + 35, cy + 45],
        score: between(rand, 0.2, 0.95),
        label: "tennis racket",
      });
    }
    for (const fp of statics) {
      detections.push({
        box: [fp.x - 30, fp.y - 40, fp.x + 30, fp.y + 40],
        score: fp.score,
        label: "tennis racket",
      });
    }
    frames.push({ tMs: frame.timestampMs, detections, extras: [] });
  }
  return {
    schemaVersion: 1,
    detector: {
      modelId: "stress",
      version: "stress",
      license: "Apache-2.0",
      device: "cpu",
      proxyLabels: ["tennis racket"],
      proxyNote: "",
      scoreFloor: 0.08,
    },
    video: PADDLE_VIDEO,
    window: { startMs: 0, endMs: PADDLE_VIDEO.durationMs },
    timing: {
      modelLoadSec: 0,
      framesProcessed: frames.length,
      inferenceSecTotal: 0,
      inferenceMsPerFrame: 0,
      wallSecTotal: 0,
    },
    frames,
  };
}

export const paddleTrackerUnit: StressUnit = {
  id: "paddle-tracker",
  iterate(seed) {
    const rand = lcg(seed);
    const { sequence, window, handed } = seededSwing(rand);
    const file = seededPaddleFile(rand, sequence, handed);
    const win = { startMs: window.startMs, endMs: window.endMs };
    const candidates = buildPaddleTracks(file, win);
    const { merged, links } = mergePaddleTracklets(candidates, win);
    const wrists = wristSeries(sequence);
    const otherWrists =
      rand() < 0.4
        ? wrists.map((entry) => ({
            timestampMs: entry.timestampMs,
            wrists: entry.wrists.map((w) => ({ x: 1 - w.x, y: w.y })),
          }))
        : [];
    const outcome = selectPrimaryPaddleTrack(merged, wrists, win, otherWrists, {
      ownershipGuard: rand() < 0.5,
    });
    const violations: string[] = [];
    let speeds: Array<{ timestampMs: number; value: number }> = [];
    if (outcome.status === "tracked") {
      speeds = paddleSpeedSeries(outcome.lab.observations);
      for (const observation of outcome.lab.observations) {
        if (!(observation.confidence >= 0 && observation.confidence <= 1)) {
          violations.push("observation_confidence_out_of_range");
          break;
        }
      }
    } else if (outcome.reason.length === 0) {
      violations.push("untracked_without_reason");
    }
    return result(
      { outcome, candidates: candidates.length, merged: merged.length, links, speeds },
      outcome.status !== "tracked",
      violations,
    );
  },
};

// ── unit: stroke event proposals + temporal phase segmentation ─────────────

export const strokeEventsPhasesUnit: StressUnit = {
  id: "stroke-events-phases",
  iterate(seed) {
    const rand = lcg(seed);
    const clipEndMs = 800 + Math.floor(rand() * 8000);
    const paddle = rand() < 0.3 ? null : seededSpeedSeries(rand, clipEndMs);
    const wrist = rand() < 0.2 ? null : seededSpeedSeries(rand, clipEndMs);
    const violations: string[] = [];
    const proposals = [
      proposeStrokeEvents({ paddleSpeeds: paddle, wristSpeeds: wrist, clipStartMs: 0, clipEndMs }),
      proposeStrokeEventsV2({
        paddleSpeeds: paddle,
        wristSpeeds: wrist,
        clipStartMs: 0,
        clipEndMs,
      }),
    ];
    for (const proposal of proposals) {
      let lastStart = -Infinity;
      for (const event of proposal.events) {
        if (event.endMs < event.startMs) violations.push("negative_event_duration");
        if (event.peakMs < event.startMs || event.peakMs > event.endMs)
          violations.push("peak_outside_event");
        if (!(event.confidence >= 0 && event.confidence <= 1))
          violations.push("event_confidence_out_of_range");
        if (event.startMs < lastStart) violations.push("events_not_time_ordered");
        lastStart = event.startMs;
      }
      for (const v of checkArtifactInvariants(jsonRoundTrip(proposal))) {
        violations.push(`invariant:${v.rule}`);
      }
    }
    const startMs = Math.floor(rand() * 1000);
    const endMs = startMs + 300 + Math.floor(rand() * 2000);
    const contactMs =
      rand() < 0.4
        ? null
        : startMs + Math.floor(rand() * (endMs - startMs) * 1.4 - (endMs - startMs) * 0.2);
    const peakMs = rand() < 0.5 ? undefined : startMs + Math.floor(rand() * (endMs - startMs));
    const segmentation = segmentPhasesTemporalV2({
      event: peakMs === undefined ? { startMs, endMs } : { startMs, endMs, peakMs },
      contactMs,
      paddleSpeeds: paddle,
      wristSpeeds: wrist,
    });
    let abstained = true;
    let anchorFree = false;
    if (segmentation.status === "segmented") {
      abstained = false;
      anchorFree = segmentation.boundaries.anchorBasis === "event_peak";
      if (anchorFree && !Number.isNaN(segmentation.boundaries.contactMs))
        violations.push("anchor_free_carries_contact");
      for (const v of checkArtifactInvariants(jsonRoundTrip(segmentation.boundaries))) {
        violations.push(`invariant:${v.rule}`);
      }
    } else if (segmentation.reason.length === 0) {
      violations.push("segmentation_abstention_without_reason");
    }
    return result(
      { proposals, segmentation },
      abstained,
      violations,
      // Anchor-free segmentation carries contactMs = NaN BY CONTRACT.
      (path) => anchorFree && path === "$.segmentation.boundaries.contactMs",
    );
  },
};

// ── unit: OOD pose-free frame gate (the wave-E gate math, no ffmpeg) ───────

export const oodFrameGateUnit: StressUnit = {
  id: "ood-frame-gate",
  iterate(seed) {
    const rand = lcg(seed);
    const frameCount = Math.floor(rand() * 400);
    const stats: FrameStats = {
      frameCount,
      durationMs: Math.floor(rand() * 20 * 60 * 1000),
      width: pick(rand, [64, 320, 1080, 1920]),
      height: pick(rand, [36, 180, 1920, 1080]),
      interFrameDiffs: Array.from({ length: Math.max(0, frameCount - 1) }, () => rand() * 30),
      spatialLumaStd: Array.from({ length: frameCount }, () => rand() * 80),
      letterboxRowFraction: rand(),
    };
    const frame = evaluateFrameAnalyzability(stats);
    const gate = preAnalysisGate({ frame, pose: null, poseQuality: null });
    const violations: string[] = [];
    if (frame.analyzable !== (frame.reasons.length === 0))
      violations.push("analyzable_reason_mismatch");
    if (!gate.ok && gate.failure.code.length === 0) violations.push("gate_failure_without_code");
    return result({ frame, gate }, !gate.ok, violations);
  },
};

// ── unit: coach gates (frozen spec SHA + file-backed evidence) ─────────────

export const coachGatesUnit: StressUnit = {
  id: "coach-gates",
  iterate() {
    const report = runCoachGates(REPO_ROOT);
    const violations: string[] = [];
    if (report.gates.length === 0) violations.push("no_gates_evaluated");
    for (const gate of report.gates) {
      if (gate.verdict === "PASS" && gate.detail.length === 0)
        violations.push(`pass_without_detail:${gate.id}`);
    }
    const { generatedAtIso: _generatedAtIso, ...stable } = report;
    // A gate report is a verdict, not an abstaining classifier: RELEASE_BLOCKED
    // (the expected state until real coach evidence exists) is recorded in the
    // output, not counted as abstention.
    return result(stable, false, violations);
  },
};

// ── unit: shadow eval over the committed synthetic adversarial corpus ──────

export const shadowEvalUnit: StressUnit = {
  id: "shadow-eval-synthetic",
  iterate(seed) {
    const rand = lcg(seed);
    const rows = buildSyntheticInputs();
    // Seeded evaluation order (the outputs must not depend on it).
    const order = rows
      .map((row, index) => ({ row, key: rand(), index }))
      .sort((a, b) => a.key - b.key);
    const pair = defaultShadowPair();
    const records = order.map(({ row }) => evaluateShadowRow(row, pair));
    const violations: string[] = [];
    for (const record of records) {
      if (
        !Number.isFinite(record.incumbentLatencyMs) ||
        !Number.isFinite(record.candidateLatencyMs)
      )
        violations.push(`non_finite_latency:${record.caseId}`);
      if (!record.incumbentCommitted && record.incumbentLimitingFactors.length === 0)
        violations.push(`incumbent_abstained_without_factor:${record.caseId}`);
    }
    const stable = records
      .map(({ incumbentLatencyMs: _a, candidateLatencyMs: _b, ...rest }) => rest)
      .sort((a, b) => a.caseId.localeCompare(b.caseId));
    const abstained = records.every((record) => !record.incumbentCommitted);
    return result(stable, abstained, violations);
  },
};

// ── unit: PaddleServeWorker lifecycle (spawn → detect → dispose) ───────────

let workerDir: string | null = null;
let fakeWorkerPath: string | null = null;

const FAKE_WORKER_SOURCE = `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const say = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
say({ event: "ready", protocol: "paddle-serve-v1", modelLoadSec: 0, warmupSec: 0, device: "test" });
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.op === "shutdown") { say({ id: req.id, ok: true, event: "shutdown" }); process.exit(0); }
  if (req.hold) return; // never answered: the caller must cancel via dispose()
  writeFileSync(req.out, JSON.stringify({ frames: [], echo: req }));
  say({ id: req.id, ok: true, out: req.out, framesProcessed: 0, paddleDetections: 0, extras: 0, timing: {}, requestWallSec: 0 });
});
lines.on("close", () => process.exit(0));
`;

const waitForExit = (worker: PaddleServeWorker) =>
  new Promise<void>((resolveExit) => {
    const poll = setInterval(() => {
      if (!worker.alive) {
        clearInterval(poll);
        resolveExit();
      }
    }, 5);
  });

export const paddleWorkerUnit: StressUnit = {
  id: "paddle-worker-lifecycle",
  setup() {
    workerDir = mkdtempSync(join(tmpdir(), "swing-lab-stress-worker-"));
    fakeWorkerPath = join(workerDir, "fake-worker.mjs");
    writeFileSync(fakeWorkerPath, FAKE_WORKER_SOURCE);
  },
  teardown() {
    if (workerDir) rmSync(workerDir, { recursive: true, force: true });
    workerDir = null;
    fakeWorkerPath = null;
  },
  async iterate(seed) {
    const rand = lcg(seed);
    const out = join(workerDir!, `out-${seed}.json`);
    const spawnWorker = () =>
      new PaddleServeWorker(process.execPath, [fakeWorkerPath!], {
        log: () => {},
        readyTimeoutMs: 20_000,
        requestTimeoutMs: 20_000,
      });
    const mode = pick(rand, ["detect-dispose", "cancel-in-flight", "supervisor"] as const);
    const violations: string[] = [];
    const record: Record<string, unknown> = { mode };
    if (mode === "detect-dispose") {
      const worker = spawnWorker();
      const response = await worker.detect({ video: "clip.mp4", out, startMs: 100, endMs: 200 });
      record["ok"] = response.ok;
      worker.dispose();
      await waitForExit(worker);
      if (worker.alive) violations.push("worker_alive_after_dispose");
    } else if (mode === "cancel-in-flight") {
      const worker = spawnWorker();
      await worker.ready();
      const pending = worker.detect({
        video: "clip.mp4",
        out,
        startMs: 100,
        endMs: 200,
        ...({ hold: true } as object),
      });
      const settled = pending.then(
        () => "resolved" as const,
        () => "rejected" as const,
      );
      worker.dispose();
      await waitForExit(worker);
      let hungTimer: NodeJS.Timeout | null = null;
      const outcome = await Promise.race([
        settled,
        new Promise<"hung">((r) => {
          hungTimer = setTimeout(() => r("hung"), 5_000);
        }),
      ]);
      if (hungTimer) clearTimeout(hungTimer);
      record["pending"] = outcome;
      if (outcome !== "rejected") violations.push(`in_flight_request_not_cancelled:${outcome}`);
    } else {
      const supervisor = new PaddleWorkerSupervisor(spawnWorker, { maxRestarts: 1 });
      const response = await supervisor.detect({
        video: "clip.mp4",
        out,
        startMs: 100,
        endMs: 200,
      });
      record["ok"] = response.ok;
      record["restarts"] = supervisor.restarts;
      supervisor.dispose();
      const started = performance.now();
      while (supervisor.alive && performance.now() - started < 5_000) {
        await new Promise((r) => setTimeout(r, 5));
      }
      if (supervisor.alive) violations.push("supervisor_alive_after_dispose");
    }
    rmSync(out, { force: true });
    return result(record, false, violations);
  },
};

export const ALL_UNITS: readonly StressUnit[] = [
  controlNoopUnit,
  strokeClassifierUnit,
  ballTrackerUnit,
  playerTrackerUnit,
  paddleTrackerUnit,
  strokeEventsPhasesUnit,
  oodFrameGateUnit,
  coachGatesUnit,
  shadowEvalUnit,
  paddleWorkerUnit,
];
