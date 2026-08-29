// F20 — parametric boundary sweep of the stroke-heuristic-4
// absence-of-measurement gates (wave-f f20-rt-stroke-hardened).
//
// Deterministic SYNTHETIC sweeps that locate each gate's decision boundary
// and measure what sits on either side of it:
//   1. rival-wrist measured-frame count (0..6): where does the attribution
//      gate stop abstaining, and is the committed output attributable?
//   2. window torso-extent ratio vs the sequence median (0.50..1.00): the
//      abstain band, the confidently-wrong OVERHEAD band, and the correct
//      band for a shoulder-high volley under partial hip occlusion.
//   3. genuine-crouch torso ratio (0.50..0.75): the coverage floor for real
//      postural compression at the reference.
//   4. in-window sub-floor speed-sample count (0..5) under mid-swing
//      estimator dropout: where the "no swing energy" gate starts firing on
//      a genuine fast swing.
//
// Run from packages/swing-lab (its tsx + deps):
//   cd packages/swing-lab && npx tsx ../../datasets/experiments/wave-f/f20-coverage-sweep.ts
//
// LINUX-CPU synthetic-geometry only: no run dir touched, no committed label
// read or written, held-out cases and fresh candidates never involved.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PoseSequence } from "@pickle/swing-domain";
import { classifyStroke } from "../../../packages/swing-lab/src/index.js";

const OUT_DIR = dirname(fileURLToPath(import.meta.url));

const SHOULDER_Y = 0.4;
const HIP_Y = 0.6;
const PEAK_MS = 2000;

interface Mark {
  name: string;
  x: number;
  y: number;
  visibility: number;
}

function mark(name: string, x: number, y: number, visibility = 0.9): Mark {
  return { name, x, y, visibility };
}

function torso(hipY = HIP_Y, shoulderY = SHOULDER_Y): Mark[] {
  return [
    mark("left_shoulder", 0.62, shoulderY),
    mark("right_shoulder", 0.78, shoulderY),
    mark("left_hip", 0.63, hipY),
    mark("right_hip", 0.77, hipY),
  ];
}

function toSequence(frames: Array<{ timestampMs: number; landmarks: Mark[] }>): PoseSequence {
  return {
    schemaVersion: 1,
    format: "pickle.pose-sequence.v1",
    coordinateSystem: "normalized_image_top_left",
    producedBy: {
      providerId: "synthetic.f20-coverage-sweep",
      modelVersion: "f20-sweep-1",
      runtime: "deterministic",
      executionTarget: "on_device",
      artifactHash: null,
    },
    video: { width: 1080, height: 1080, fps: 33 },
    frames: frames.map((frame, index) => ({
      frameIndex: index,
      timestampMs: frame.timestampMs,
      confidence: 0.9,
      landmarks: frame.landmarks,
    })),
  } as PoseSequence;
}

function buildFrames(
  halfSpanMs: number,
  frameAt: (tMs: number) => Mark[],
): Array<{ timestampMs: number; landmarks: Mark[] }> {
  const frames: Array<{ timestampMs: number; landmarks: Mark[] }> = [];
  for (let tMs = PEAK_MS - halfSpanMs; tMs <= PEAK_MS + halfSpanMs; tMs += 30) {
    frames.push({ timestampMs: tMs, landmarks: frameAt(tMs) });
  }
  return frames;
}

const fastSpeeds = Array.from({ length: 20 }, (_, index) => ({
  timestampMs: PEAK_MS - 300 + index * 30,
  value: 1.2,
}));

function classify(
  frames: Array<{ timestampMs: number; landmarks: Mark[] }>,
  wristSpeeds: Array<{ timestampMs: number; value: number }> | null = fastSpeeds,
) {
  return classifyStroke({
    sequence: toSequence(frames),
    window: { startMs: PEAK_MS - 300, endMs: PEAK_MS + 300 },
    contactMs: PEAK_MS,
    handedness: "right",
    paddle: null,
    paddleSpeeds: null,
    wristSpeeds,
  });
}

// ── Sweep 1: rival-wrist measured-frame count ─────────────────────────────
// Genuine RIGHT-arm forehand; the striking right wrist is glimpsed in only
// 2 adjacent frames while the left counterbalance arm is measured in a
// varying number of frames near the reference. Attributable ground truth:
// FOREHAND (right arm). Committed output derived from the left wrist is
// wrong by attribution.
function rivalSweepCase(rivalFrames: number) {
  let granted = 0;
  const frames = buildFrames(300, (tMs) => {
    const phase = (tMs - PEAK_MS) / 300;
    const landmarks = [...torso()];
    const leftWristX = 0.6 - 0.07 * phase;
    // The rival (left) wrist is measured only in the first `rivalFrames`
    // frames within ±200ms of the reference.
    if (Math.abs(tMs - PEAK_MS) <= 200 && granted < rivalFrames) {
      granted += 1;
      landmarks.push(mark("left_wrist", leftWristX, 0.56, 0.85));
      landmarks.push(mark("left_elbow", (0.62 + leftWristX) / 2, 0.49, 0.85));
    }
    if (tMs === PEAK_MS || tMs === PEAK_MS - 30) {
      const glimpseX = tMs === PEAK_MS ? 0.88 : 0.86;
      landmarks.push(mark("right_wrist", glimpseX, 0.5, 0.6));
      landmarks.push(mark("right_elbow", (0.78 + glimpseX) / 2, 0.46, 0.6));
    }
    return landmarks;
  });
  return classify(frames);
}

// ── Sweep 2: window torso-extent ratio (occlusion) ────────────────────────
// Shoulder-high volley (wrist 0.045u above the shoulder line); hip occlusion
// compresses the ±150ms window's torso extent to ratio × the 0.20u median.
function torsoRatioCase(ratio: number) {
  const frames = buildFrames(600, (tMs) => {
    const collapsed = Math.abs(tMs - PEAK_MS) <= 150;
    const hipY = SHOULDER_Y + (collapsed ? 0.2 * ratio : 0.2);
    const phase = Math.min(1, Math.max(-1, (tMs - PEAK_MS) / 250));
    const wristX = 0.82 + 0.05 * phase;
    return [
      ...torso(hipY),
      mark("right_wrist", wristX, SHOULDER_Y - 0.045),
      mark("right_elbow", (0.78 + wristX) / 2, SHOULDER_Y + 0.03),
      mark("left_wrist", 0.6, 0.55, 0.7),
      mark("left_elbow", 0.61, 0.48, 0.7),
    ];
  });
  return classify(frames);
}

// ── Sweep 3: genuine crouch depth ─────────────────────────────────────────
// Real postural compression: shoulders drop toward static hips near the
// reference; the reference torso extent is ratio × the standing 0.20u.
function crouchRatioCase(ratio: number) {
  const frames = buildFrames(600, (tMs) => {
    const nearContact = Math.abs(tMs - PEAK_MS) <= 150;
    const shoulderY = nearContact ? HIP_Y - 0.2 * ratio : SHOULDER_Y;
    const phase = Math.min(1, Math.max(-1, (tMs - PEAK_MS) / 250));
    const wristX = 0.82 + 0.06 * phase;
    const wristY = HIP_Y + 0.05 - 0.02 * Math.max(0, phase);
    return [
      mark("left_shoulder", 0.62, shoulderY),
      mark("right_shoulder", 0.78, shoulderY),
      mark("left_hip", 0.63, HIP_Y),
      mark("right_hip", 0.77, HIP_Y),
      mark("right_wrist", wristX, wristY),
      mark("right_elbow", (0.78 + wristX) / 2, (shoulderY + wristY) / 2),
      mark("left_wrist", 0.6, HIP_Y, 0.7),
      mark("left_elbow", 0.61, HIP_Y - 0.06, 0.7),
    ];
  });
  return classify(frames);
}

// ── Sweep 4: in-window sub-floor speed samples under dropout ─────────────
// Genuine fast forehand; the speed series holds `count` pre-swing 0.1 u/s
// samples inside the window, then resumes only after it (series length
// stays ≥5 so the gate is armed).
function speedSampleCase(count: number) {
  const frames = buildFrames(300, (tMs) => {
    const phase = Math.min(1, Math.max(-1, (tMs - PEAK_MS) / 250));
    const wristX = 0.8 + 0.1 * phase;
    const wristY = 0.55 - 0.04 * Math.max(0, phase);
    return [
      ...torso(),
      mark("right_wrist", wristX, wristY),
      mark("right_elbow", (0.78 + wristX) / 2, (SHOULDER_Y + wristY) / 2),
      mark("left_wrist", 0.6, 0.56, 0.7),
      mark("left_elbow", 0.61, 0.49, 0.7),
    ];
  });
  const wristSpeeds = [
    ...Array.from({ length: count }, (_, index) => ({
      timestampMs: PEAK_MS - 290 + index * 30,
      value: 0.1,
    })),
    ...Array.from({ length: Math.max(5 - count, 3) }, (_, index) => ({
      timestampMs: PEAK_MS + 400 + index * 30,
      value: 0.1,
    })),
  ];
  return classify(frames, wristSpeeds);
}

function row(parameter: Record<string, number>, prediction: ReturnType<typeof classify>) {
  return {
    ...parameter,
    label: prediction.label,
    confidence: Number(prediction.confidence.toFixed(2)),
    limitingFactors: prediction.limitingFactors,
  };
}

const result = {
  sweep: "f20-coverage-sweep-v1",
  createdBy: "wave-f f20-rt-stroke-hardened",
  classifierVersion: "stroke-heuristic-4 (uncalibrated)",
  provenance:
    "deterministic synthetic geometry only; no committed labels, run dirs, held-out cases, or fresh candidates involved",
  sweeps: {
    rivalMeasuredFrames: {
      groundTruth: "genuine right-arm FOREHAND (striking wrist glimpsed 2 frames)",
      rows: [0, 1, 2, 3, 4, 5, 6].map((k) => row({ rivalMeasuredFrames: k }, rivalSweepCase(k))),
    },
    occlusionTorsoRatio: {
      groundTruth: "shoulder-high FOREHAND volley (contact 0.22 real torso-units above shoulders)",
      rows: [0.5, 0.55, 0.58, 0.6, 0.62, 0.7, 0.8, 0.85, 0.9, 0.95, 1.0].map((r) =>
        row({ torsoRatio: r }, torsoRatioCase(r)),
      ),
    },
    genuineCrouchTorsoRatio: {
      groundTruth: "genuine deep-crouch FOREHAND dink",
      rows: [0.5, 0.55, 0.58, 0.6, 0.62, 0.65, 0.7, 0.75].map((r) =>
        row({ torsoRatio: r }, crouchRatioCase(r)),
      ),
    },
    inWindowSubFloorSpeedSamples: {
      groundTruth: "genuine fast FOREHAND drive (mid-swing speed samples dropped)",
      rows: [0, 1, 2, 3, 4, 5].map((k) => row({ inWindowSamples: k }, speedSampleCase(k))),
    },
  },
};

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, "f20-coverage-sweep.json");
writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(`wrote ${outPath}`);
