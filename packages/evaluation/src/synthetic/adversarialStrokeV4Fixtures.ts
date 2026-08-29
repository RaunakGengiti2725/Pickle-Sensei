import type { PoseFrame, PoseLandmark, PoseLandmarkName } from "@pickle/shared-types";
import type { PoseSequence } from "@pickle/swing-domain";
import type { AdversarialStrokeFixture } from "./adversarialStrokeFixtures.js";

/**
 * SYNTHETIC ADVERSARIAL fixtures targeting the stroke-heuristic-4
 * ABSENCE-OF-MEASUREMENT gates (wave-f f20-rt-stroke-hardened).
 *
 * Every v4 gate draws a binary line between "measured" and "absent"; these
 * skeletons live on and beyond those lines: a rival wrist measured 1-2
 * frames (enough to disarm the attribution gate, not enough to verify the
 * comparison), clustered mid-swing measurement dropouts that make a real
 * swing read as stillness, a one-sided speed-sample slice that reads as "no
 * energy", torso extents parked just above the 0.6x-median collapse floor,
 * and genuine strokes (crouch dink, occluded-rival forehand) that the new
 * gates falsely abstain.
 *
 * Provenance is always "synthetic" and stamped as such. Ground truth for
 * each fixture is stated in its description; the red-team suite pins the
 * measured outputs (confidently-wrong commits and false abstentions alike).
 */

export const ADVERSARIAL_V4_PRODUCER = {
  providerId: "synthetic.adversarial-stroke-v4-redteam",
  modelVersion: "adversarial-stroke-v4-1",
  runtime: "deterministic",
  executionTarget: "on_device",
  artifactHash: null,
} as const;

const FRAME_INTERVAL_MS = 30;

function mark(name: PoseLandmarkName, x: number, y: number, visibility = 0.9): PoseLandmark {
  return { name, x, y, visibility };
}

function toSequence(frames: PoseFrame[]): PoseSequence {
  return {
    schemaVersion: 1,
    format: "pickle.pose-sequence.v1",
    coordinateSystem: "normalized_image_top_left",
    producedBy: { ...ADVERSARIAL_V4_PRODUCER },
    video: { width: 1080, height: 1080, fps: 33 },
    frames: frames.map((frame, index) => ({
      frameIndex: index,
      timestampMs: frame.timestampMs,
      confidence: frame.confidence,
      landmarks: frame.landmarks.map((landmark) => ({
        name: landmark.name,
        x: landmark.x,
        y: landmark.y,
        visibility: landmark.visibility,
      })),
    })),
  } as PoseSequence;
}

/** Frames across ±halfSpanMs of peakMs at 30ms spacing. */
function buildFrames(
  peakMs: number,
  halfSpanMs: number,
  frameAt: (tMs: number, index: number) => PoseLandmark[],
): PoseFrame[] {
  const frames: PoseFrame[] = [];
  const count = Math.floor((2 * halfSpanMs) / FRAME_INTERVAL_MS) + 1;
  const startMs = peakMs - halfSpanMs;
  for (let index = 0; index < count; index += 1) {
    const tMs = startMs + index * FRAME_INTERVAL_MS;
    frames.push({
      timestampMs: tMs,
      space: "normalized-image",
      confidence: 0.9,
      landmarks: frameAt(tMs, index),
    });
  }
  return frames;
}

function fastSpeedSeries(peakMs: number): Array<{ timestampMs: number; value: number }> {
  return Array.from({ length: 20 }, (_, index) => ({
    timestampMs: peakMs - 300 + index * 30,
    value: 1.2,
  }));
}

const SHOULDER_Y = 0.4;
const HIP_Y = 0.6;

function torso(hipY = HIP_Y): PoseLandmark[] {
  return [
    mark("left_shoulder", 0.62, SHOULDER_Y),
    mark("right_shoulder", 0.78, SHOULDER_Y),
    mark("left_hip", 0.63, hipY),
    mark("right_hip", 0.77, hipY),
  ];
}

/**
 * F20-F1 target: the actual striking (right) arm is occluded for all but
 * TWO adjacent frames near the reference (measured travel 0.02u), while the
 * visible non-striking (left) counterbalance arm is measured in every frame
 * and travels ~0.14u. The rival-wrist attribution gate is disarmed by the
 * 2 measured rival frames, so the left wrist wins dominant-wrist attribution
 * and the stroke is committed off the wrong arm. Ground truth: a genuine
 * RIGHT-arm forehand — any committed side derived from the left wrist is
 * unattributable and wrong.
 */
export function sparseRivalWrongArmFixture(peakMs = 2000): AdversarialStrokeFixture {
  const frames = buildFrames(peakMs, 300, (tMs) => {
    const phase = (tMs - peakMs) / 300; // -1 → 1
    // Non-striking left arm: smooth counterbalance sweep on the player's
    // left, measured everywhere.
    const leftWristX = 0.6 - 0.07 * phase;
    const landmarks = [
      ...torso(),
      mark("left_wrist", leftWristX, 0.56, 0.85),
      mark("left_elbow", (0.62 + leftWristX) / 2, 0.49, 0.85),
    ];
    // Striking right arm: occluded except two adjacent frames right at the
    // reference, where it is glimpsed mid-swing.
    if (tMs === peakMs || tMs === peakMs - FRAME_INTERVAL_MS) {
      const glimpseX = tMs === peakMs ? 0.88 : 0.86;
      landmarks.push(mark("right_wrist", glimpseX, 0.5, 0.6));
      landmarks.push(mark("right_elbow", (0.78 + glimpseX) / 2, 0.46, 0.6));
    }
    return landmarks;
  });
  return {
    id: "sparse-rival-wrong-arm",
    description:
      "Genuine right-arm forehand with the striking wrist measured in only 2 adjacent frames (travel 0.02u); the visible left counterbalance arm (travel ~0.14u) wins attribution. Ground truth: right-arm FOREHAND.",
    sequence: toSequence(frames),
    window: { startMs: peakMs - 300, endMs: peakMs + 300, peakMs },
    wristSpeeds: fastSpeedSeries(peakMs),
  };
}

/**
 * F20-F2 target: torso extent parked just ABOVE the 0.6x-median collapse
 * floor. The sequence's standing median torso extent is 0.20u; across the
 * overhead corroboration window (±150ms) a partial hip occlusion compresses
 * the measured extent to 0.125u (62.5% of median — the gate passes). A
 * shoulder-high volley contact (wrist 0.045u above the shoulder line, a
 * genuine 0.22 torso-units on the player's REAL torso) then normalizes to
 * 0.36 "torso-units above the shoulders" and the raise window sees the same
 * inflation in every frame, so point and skeleton agree on a false OVERHEAD.
 * Ground truth: shoulder-high FOREHAND volley, not an overhead.
 */
export function torsoCollapseBoundaryOverheadFixture(peakMs = 2000): AdversarialStrokeFixture {
  const frames = buildFrames(peakMs, 600, (tMs) => {
    const collapsed = Math.abs(tMs - peakMs) <= 150;
    const hipY = collapsed ? SHOULDER_Y + 0.125 : SHOULDER_Y + 0.2;
    const phase = Math.min(1, Math.max(-1, (tMs - peakMs) / 250));
    // Genuine punch-volley: wrist sweeps forward-right at shoulder height.
    const wristX = 0.82 + 0.05 * phase;
    const wristY = SHOULDER_Y - 0.045;
    return [
      ...torso(hipY),
      mark("right_wrist", wristX, wristY, 0.9),
      mark("right_elbow", (0.78 + wristX) / 2, SHOULDER_Y + 0.03, 0.9),
      mark("left_wrist", 0.6, 0.55, 0.7),
      mark("left_elbow", 0.61, 0.48, 0.7),
    ];
  });
  return {
    id: "torso-collapse-boundary-overhead",
    description:
      "Shoulder-high volley (contact 0.22 real torso-units above shoulders) with hip occlusion compressing the window's torso extent to 62.5% of the sequence median — just above the 0.6 collapse floor. Ground truth: FOREHAND volley, not OVERHEAD.",
    sequence: toSequence(frames),
    window: { startMs: peakMs - 300, endMs: peakMs + 300, peakMs },
    wristSpeeds: fastSpeedSeries(peakMs),
  };
}

/**
 * Honest-torso control for F20-F2: byte-identical motion with the hips
 * measured correctly (extent 0.20u everywhere). The same contact reads
 * 0.22 torso-units above the shoulders — below the 0.25 overhead line —
 * and the classifier correctly commits a side instead of OVERHEAD.
 */
export function torsoHonestShoulderVolleyFixture(peakMs = 2000): AdversarialStrokeFixture {
  const frames = buildFrames(peakMs, 600, (tMs) => {
    const phase = Math.min(1, Math.max(-1, (tMs - peakMs) / 250));
    const wristX = 0.82 + 0.05 * phase;
    const wristY = SHOULDER_Y - 0.045;
    return [
      ...torso(SHOULDER_Y + 0.2),
      mark("right_wrist", wristX, wristY, 0.9),
      mark("right_elbow", (0.78 + wristX) / 2, SHOULDER_Y + 0.03, 0.9),
      mark("left_wrist", 0.6, 0.55, 0.7),
      mark("left_elbow", 0.61, 0.48, 0.7),
    ];
  });
  return {
    id: "torso-honest-shoulder-volley",
    description:
      "Control: identical shoulder-high volley with honestly-measured torso extent 0.20u. Ground truth: FOREHAND volley.",
    sequence: toSequence(frames),
    window: { startMs: peakMs - 300, endMs: peakMs + 300, peakMs },
    wristSpeeds: fastSpeedSeries(peakMs),
  };
}

/**
 * F20-F3 target (coverage): a genuine deep-crouch dink. The player stands
 * (torso 0.20u) for most of the sequence and folds into a low crouch at
 * contact — the reference frame's REAL torso extent is 0.11u, 55% of the
 * sequence median, below the 0.6 collapse floor. The torso-collapse gate
 * cannot distinguish a real crouch from an occlusion collapse, so this
 * genuine stroke is falsely abstained. Ground truth: FOREHAND dink.
 */
export function crouchDinkFixture(peakMs = 2000): AdversarialStrokeFixture {
  const frames = buildFrames(peakMs, 600, (tMs) => {
    const nearContact = Math.abs(tMs - peakMs) <= 150;
    // A real crouch: shoulders drop toward the hips (hips stay put).
    const shoulderY = nearContact ? HIP_Y - 0.11 : SHOULDER_Y;
    const phase = Math.min(1, Math.max(-1, (tMs - peakMs) / 250));
    const wristX = 0.82 + 0.06 * phase;
    const wristY = HIP_Y + 0.05 - 0.02 * Math.max(0, phase);
    return [
      mark("left_shoulder", 0.62, shoulderY),
      mark("right_shoulder", 0.78, shoulderY),
      mark("left_hip", 0.63, HIP_Y),
      mark("right_hip", 0.77, HIP_Y),
      mark("right_wrist", wristX, wristY, 0.9),
      mark("right_elbow", (0.78 + wristX) / 2, (shoulderY + wristY) / 2, 0.9),
      mark("left_wrist", 0.6, HIP_Y, 0.7),
      mark("left_elbow", 0.61, HIP_Y - 0.06, 0.7),
    ];
  });
  return {
    id: "crouch-dink",
    description:
      "Genuine deep-crouch forehand dink: real reference-frame torso extent 0.11u vs standing sequence median 0.20u (55%). Ground truth: FOREHAND dink — abstention here is a coverage failure.",
    sequence: toSequence(frames),
    window: { startMs: peakMs - 300, endMs: peakMs + 300, peakMs },
    wristSpeeds: fastSpeedSeries(peakMs),
  };
}

/**
 * F20-F4 target (coverage regression vs stroke-heuristic-3): a genuine,
 * unambiguous right-arm forehand seen from an angle that keeps the left arm
 * fully occluded behind the torso for the whole clip. The rival wrist has
 * zero measured frames, so the v4 attribution gate abstains a stroke that
 * stroke-heuristic-3 committed correctly. Ground truth: FOREHAND.
 */
export function occludedRivalGenuineForehandFixture(peakMs = 2000): AdversarialStrokeFixture {
  const frames = buildFrames(peakMs, 300, (tMs) => {
    const phase = Math.min(1, Math.max(-1, (tMs - peakMs) / 250));
    const wristX = 0.82 + 0.08 * phase;
    const wristY = 0.55 - 0.03 * Math.max(0, phase);
    return [
      ...torso(),
      mark("right_wrist", wristX, wristY, 0.9),
      mark("right_elbow", (0.78 + wristX) / 2, (SHOULDER_Y + wristY) / 2, 0.9),
      // Left arm fully occluded behind the torso: never measured.
    ];
  });
  return {
    id: "occluded-rival-genuine-forehand",
    description:
      "Genuine right-arm forehand with the left arm occluded behind the torso for the whole clip (rival wrist 0 measured frames). Ground truth: FOREHAND — abstention is a v4 coverage regression.",
    sequence: toSequence(frames),
    window: { startMs: peakMs - 300, endMs: peakMs + 300, peakMs },
    wristSpeeds: fastSpeedSeries(peakMs),
  };
}

/**
 * F20-F5 target (coverage): one-sided speed-sample slice. A genuine fast
 * swing whose speed estimator dropped out exactly during the swing: the
 * event window contains only 3 measured PRE-swing samples (0.1 u/s, ready
 * stance), which satisfies MIN_WINDOW_SPEED_SAMPLES and reads as "no swing
 * energy" even though the pose frames show a full-speed stroke. Ground
 * truth: FOREHAND drive.
 */
export function speedDropoutDuringSwingFixture(peakMs = 2000): AdversarialStrokeFixture {
  const frames = buildFrames(peakMs, 300, (tMs) => {
    const phase = Math.min(1, Math.max(-1, (tMs - peakMs) / 250));
    const wristX = 0.8 + 0.1 * phase;
    const wristY = 0.55 - 0.04 * Math.max(0, phase);
    return [
      ...torso(),
      mark("right_wrist", wristX, wristY, 0.9),
      mark("right_elbow", (0.78 + wristX) / 2, (SHOULDER_Y + wristY) / 2, 0.9),
      mark("left_wrist", 0.6, 0.56, 0.7),
      mark("left_elbow", 0.61, 0.49, 0.7),
    ];
  });
  const wristSpeeds = [
    // 3 measured pre-swing samples at the very start of the event window…
    { timestampMs: peakMs - 290, value: 0.1 },
    { timestampMs: peakMs - 260, value: 0.1 },
    { timestampMs: peakMs - 230, value: 0.1 },
    // …then the estimator drops out for the swing itself; the series
    // resumes AFTER the window (length ≥5 keeps the gate armed).
    { timestampMs: peakMs + 400, value: 0.1 },
    { timestampMs: peakMs + 430, value: 0.1 },
    { timestampMs: peakMs + 460, value: 0.1 },
  ];
  return {
    id: "speed-dropout-during-swing",
    description:
      "Genuine fast forehand whose speed series lost every mid-swing sample; the window holds only 3 pre-swing 0.1 u/s samples. Ground truth: FOREHAND drive — 'no swing energy' here is a coverage failure.",
    sequence: toSequence(frames),
    window: { startMs: peakMs - 300, endMs: peakMs + 300, peakMs },
    wristSpeeds,
  };
}

/**
 * F20-F6 target (coverage): clustered mid-swing wrist dropout defeating the
 * MIN_TRAVEL_SAMPLE_FRAMES contract. The striking wrist is measured in 3
 * ready-stance frames before the swing and 3 follow-through frames after it
 * — 6 measured frames (≥5, the "sparse visibility must never masquerade as
 * stillness" floor) — but the loop swing returns the wrist near its start,
 * so the measured path length is ~0.01u and the travel gate reads a real
 * stroke as stillness. Ground truth: FOREHAND (loop swing, mid-swing frames
 * dropped).
 */
export function clusteredDropoutLoopSwingFixture(peakMs = 2000): AdversarialStrokeFixture {
  const frames = buildFrames(peakMs, 300, (tMs) => {
    const landmarks = [...torso(), mark("left_wrist", 0.6, 0.56, 0.7)];
    const delta = tMs - peakMs;
    // Measured only in the ready stance (-180..-120ms) and after the
    // follow-through returns near ready (+120..+180ms).
    if ((delta >= -180 && delta <= -120) || (delta >= 120 && delta <= 180)) {
      const wristX = delta < 0 ? 0.8 : 0.81;
      landmarks.push(mark("right_wrist", wristX, 0.56, 0.9));
      landmarks.push(mark("right_elbow", (0.78 + wristX) / 2, 0.48, 0.9));
    }
    return landmarks;
  });
  return {
    id: "clustered-dropout-loop-swing",
    description:
      "Genuine loop-swing forehand whose mid-swing wrist frames all dropped: 6 measured frames (3 ready + 3 returned follow-through) with path length ~0.01u. Ground truth: FOREHAND — 'no swing motion' here is a coverage failure.",
    sequence: toSequence(frames),
    window: { startMs: peakMs - 300, endMs: peakMs + 300, peakMs },
    wristSpeeds: fastSpeedSeries(peakMs),
  };
}
