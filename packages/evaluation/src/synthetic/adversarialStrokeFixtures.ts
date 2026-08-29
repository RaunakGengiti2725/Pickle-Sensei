import type { PoseFrame, PoseLandmark, PoseLandmarkName } from "@pickle/shared-types";
import type { PoseSequence } from "@pickle/swing-domain";
import { generateSwing, generateSwingSequence } from "./swingGenerator.js";

/**
 * SYNTHETIC ADVERSARIAL stroke fixtures — red-team inputs for the
 * hierarchical stroke heuristic (vision-geometry strokeHeuristicLite and
 * swing-lab strokeHeuristic). Each fixture realizes a NON-STROKE or
 * ambiguous-motion shape that the AUTO DETECT path could plausibly receive
 * from a mis-fired trigger: a fake/aborted swing, walking arm motion, a
 * static reach, degenerate seated-pose geometry.
 *
 * Provenance is always "synthetic" and stamped as such: these skeletons
 * exercise the classifier's abstention hierarchy against known-adversarial
 * geometry. They are not human data and never substitute for consented
 * first-party benchmarks.
 */

export const ADVERSARIAL_PRODUCER = {
  providerId: "synthetic.adversarial-stroke-redteam",
  modelVersion: "adversarial-stroke-1",
  runtime: "deterministic",
  executionTarget: "on_device",
  artifactHash: null,
} as const;

export interface AdversarialStrokeFixture {
  id: string;
  description: string;
  sequence: PoseSequence;
  window: { startMs: number; endMs: number; peakMs: number };
  /** Measured wrist-speed series for the fixture, or null when unmeasured. */
  wristSpeeds: Array<{ timestampMs: number; value: number }> | null;
}

const FRAME_INTERVAL_MS = 30;
const FRAME_COUNT = 21;

interface BodyGeometry {
  shoulderY: number;
  hipY: number;
  leftShoulderX: number;
  rightShoulderX: number;
  leftHipX: number;
  rightHipX: number;
}

const STANDING: BodyGeometry = {
  shoulderY: 0.4,
  hipY: 0.64,
  leftShoulderX: 0.6,
  rightShoulderX: 0.8,
  leftHipX: 0.62,
  rightHipX: 0.78,
};

function mark(name: PoseLandmarkName, x: number, y: number, visibility = 0.9): PoseLandmark {
  return { name, x, y, visibility };
}

function toSequence(frames: PoseFrame[]): PoseSequence {
  return {
    schemaVersion: 1,
    format: "pickle.pose-sequence.v1",
    coordinateSystem: "normalized_image_top_left",
    producedBy: { ...ADVERSARIAL_PRODUCER },
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

function buildFrames(
  peakMs: number,
  frameAt: (tMs: number, index: number) => PoseLandmark[],
): PoseFrame[] {
  const frames: PoseFrame[] = [];
  const startMs = peakMs - ((FRAME_COUNT - 1) / 2) * FRAME_INTERVAL_MS;
  for (let index = 0; index < FRAME_COUNT; index += 1) {
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

function speedSeries(peakMs: number, value: number): Array<{ timestampMs: number; value: number }> {
  return Array.from({ length: 20 }, (_, index) => ({
    timestampMs: peakMs - 300 + index * 30,
    value,
  }));
}

function torsoMarks(body: BodyGeometry): PoseLandmark[] {
  return [
    mark("left_shoulder", body.leftShoulderX, body.shoulderY),
    mark("right_shoulder", body.rightShoulderX, body.shoulderY),
    mark("left_hip", body.leftHipX, body.hipY),
    mark("right_hip", body.rightHipX, body.hipY),
  ];
}

/**
 * Aborted swing: the wrist pulls back and returns to ready without ever
 * accelerating into a contact. Measured wrist speed stays at checked-swing
 * levels (~0.2 u/s) through the whole window.
 */
export function abortedSwingFixture(peakMs = 2000): AdversarialStrokeFixture {
  const frames = buildFrames(peakMs, (tMs) => {
    const phase = (tMs - peakMs) / 300; // -1 → 1 across the window
    const pullback = Math.max(0, 1 - Math.abs(phase)); // peaks at reference
    const wristX = 0.72 - 0.06 * pullback;
    const wristY = 0.56 + 0.01 * pullback;
    return [
      ...torsoMarks(STANDING),
      mark("right_wrist", wristX, wristY),
      mark("right_elbow", (0.8 + wristX) / 2, (0.4 + wristY) / 2),
      mark("left_wrist", 0.62, 0.58, 0.6),
      mark("left_elbow", 0.61, 0.5, 0.6),
    ];
  });
  return {
    id: "aborted-swing",
    description:
      "Backswing pulled back and checked — no forward acceleration, no contact; wrist speed ~0.2 u/s.",
    sequence: toSequence(frames),
    window: { startMs: peakMs - 300, endMs: peakMs + 300, peakMs },
    wristSpeeds: speedSeries(peakMs, 0.2),
  };
}

/**
 * Walk-through: the whole body translates across frame while the arms dangle
 * and swing gently at hip level — ordinary walking, not a stroke.
 */
export function walkThroughFixture(peakMs = 2000): AdversarialStrokeFixture {
  const frames = buildFrames(peakMs, (tMs, index) => {
    const drift = (index - (FRAME_COUNT - 1) / 2) * 0.004; // ~0.13 u/s walk
    const armSwing = 0.02 * Math.sin((index / FRAME_COUNT) * Math.PI * 2);
    const body: BodyGeometry = {
      ...STANDING,
      leftShoulderX: STANDING.leftShoulderX + drift,
      rightShoulderX: STANDING.rightShoulderX + drift,
      leftHipX: STANDING.leftHipX + drift,
      rightHipX: STANDING.rightHipX + drift,
    };
    return [
      ...torsoMarks(body),
      mark("right_wrist", 0.79 + drift + armSwing, 0.66),
      mark("right_elbow", 0.795 + drift + armSwing / 2, 0.53),
      mark("left_wrist", 0.61 + drift - armSwing, 0.66),
      mark("left_elbow", 0.605 + drift - armSwing / 2, 0.53),
    ];
  });
  return {
    id: "walk-through",
    description:
      "Player walks through frame with arms dangling at the sides; wrist speed ~0.15 u/s.",
    sequence: toSequence(frames),
    window: { startMs: peakMs - 300, endMs: peakMs + 300, peakMs },
    wristSpeeds: speedSeries(peakMs, 0.15),
  };
}

/**
 * Degenerate seated geometry: the pose estimator collapsed the hips onto the
 * shoulder line (chair-back occlusion), so torso-normalized ratios explode —
 * a chest-height hand sits "1.5 torso-units above the shoulders".
 */
export function wheelchairDegenerateTorsoFixture(peakMs = 2000): AdversarialStrokeFixture {
  const shoulderY = 0.5;
  const hipY = shoulderY + 0.02; // collapsed: real extent lost to occlusion
  const frames = buildFrames(peakMs, (tMs, index) => {
    const sway = 0.015 * Math.sin((index / FRAME_COUNT) * Math.PI * 2);
    const wristY = shoulderY - 0.03; // chest-height in image terms
    return [
      mark("left_shoulder", 0.6, shoulderY),
      mark("right_shoulder", 0.8, shoulderY),
      mark("left_hip", 0.62, hipY, 0.35),
      mark("right_hip", 0.78, hipY, 0.35),
      mark("right_wrist", 0.76 + sway, wristY),
      mark("right_elbow", 0.79 + sway / 2, shoulderY + 0.02),
      mark("left_wrist", 0.62, shoulderY + 0.06, 0.6),
      mark("left_elbow", 0.61, shoulderY + 0.03, 0.6),
    ];
  });
  return {
    id: "wheelchair-degenerate-torso",
    description:
      "Seated player with chair-occluded hips collapsed onto the shoulder line (torso extent 0.02); hand at chest height.",
    sequence: toSequence(frames),
    window: { startMs: peakMs - 300, endMs: peakMs + 300, peakMs },
    wristSpeeds: null,
  };
}

/**
 * Legitimate seated stroke: compressed but REAL torso extent (0.12) and a
 * genuine forehand swing on the player's right. The abstention gates must
 * not fire here — wheelchair kinematics are in-distribution strokes.
 */
export function wheelchairSeatedStrokeFixture(peakMs = 2000): AdversarialStrokeFixture {
  const shoulderY = 0.46;
  const hipY = shoulderY + 0.12;
  const frames = buildFrames(peakMs, (tMs) => {
    const phase = Math.min(1, Math.max(-1, (tMs - peakMs) / 250));
    // Forward swing: back-left before the reference, out-right after.
    const wristX = 0.82 + 0.1 * phase;
    const wristY = 0.6 - 0.04 * Math.max(0, phase);
    return [
      mark("left_shoulder", 0.6, shoulderY),
      mark("right_shoulder", 0.8, shoulderY),
      mark("left_hip", 0.62, hipY),
      mark("right_hip", 0.78, hipY),
      mark("right_wrist", wristX, wristY),
      mark("right_elbow", (0.8 + wristX) / 2, (shoulderY + wristY) / 2),
      mark("left_wrist", 0.6, 0.6, 0.6),
      mark("left_elbow", 0.6, 0.53, 0.6),
    ];
  });
  return {
    id: "wheelchair-seated-stroke",
    description:
      "Seated player with real (compressed) torso extent 0.12 hitting a genuine forehand — must still classify.",
    sequence: toSequence(frames),
    window: { startMs: peakMs - 300, endMs: peakMs + 300, peakMs },
    wristSpeeds: null,
  };
}

/**
 * Static reach/stretch: the arm is held high above the shoulder line for the
 * whole window with essentially no motion — reaching for a ball call, a
 * stretch, a wave. Not a stroke; especially not an OVERHEAD.
 */
export function staticReachFixture(peakMs = 2000): AdversarialStrokeFixture {
  const frames = buildFrames(peakMs, () => [
    ...torsoMarks(STANDING),
    mark("right_wrist", 0.76, STANDING.shoulderY - 0.2),
    mark("right_elbow", 0.79, STANDING.shoulderY - 0.08),
    mark("left_wrist", 0.62, 0.58, 0.6),
    mark("left_elbow", 0.61, 0.5, 0.6),
  ]);
  return {
    id: "static-reach",
    description:
      "Arm held motionless ~0.83 torso-units above the shoulder line for the whole window; wrist speed ~0.05 u/s.",
    sequence: toSequence(frames),
    window: { startMs: peakMs - 300, endMs: peakMs + 300, peakMs },
    wristSpeeds: speedSeries(peakMs, 0.05),
  };
}

/* ── wave-e e10: ambiguous-motion fixtures ─────────────────────────────────
 * Each fixture below realizes an ambiguous or out-of-declaration motion the
 * AUTO DETECT trigger can hand the stroke hierarchy: a ball-less practice
 * swing, a non-dominant-hand swing, degenerate camera-facing geometry
 * (profile view, mid-rotation shoulder crossing), wheelchair rim propulsion,
 * and an energetic-but-checked swing. Ground truth for each is recorded in
 * the fixture description; the red-team suites assert either abstention or
 * (for pinned open findings) the current measured wrong output.
 */

/**
 * Practice/shadow swing: kinematically a full genuine forehand swing — but
 * there is no ball and no contact anywhere; the only reference available is
 * the motion peak. Ground truth: NOT a stroke (no ball was struck).
 */
export function practiceShadowSwingFixture(): AdversarialStrokeFixture {
  const { sequence, window } = generateSwingSequence();
  return {
    id: "practice-shadow-swing",
    description:
      "Full-energy shadow swing with no ball and no contact; reference is the motion peak. Not a stroke.",
    sequence,
    window,
    wristSpeeds: speedSeries(window.peakMs, 1.8),
  };
}

/**
 * Non-dominant-hand swing: the player is DECLARED right-handed but swings a
 * genuine forehand with the LEFT hand (off-hand reach/rally clowning/injury
 * adaptation). Ground truth: a left-hand forehand — under a right-handed
 * declaration the side is not decidable from midline geometry alone.
 */
export function nonDominantHandSwingFixture(): AdversarialStrokeFixture {
  const { sequence, window } = generateSwingSequence({ handed: "left" });
  return {
    id: "non-dominant-hand-swing",
    description:
      "Left-hand forehand by a declared right-handed player; the moving wrist contradicts the declaration.",
    sequence,
    window,
    wristSpeeds: speedSeries(window.peakMs, 1.8),
  };
}

/**
 * Near-profile view: the shoulder line is nearly parallel to the camera
 * axis, so the image-plane shoulder width collapses to ~0.005u — far below
 * any usable normalization base. Ground truth: side is NOT measurable; the
 * wrist's 0.0075u offset from the midline is estimator-noise scale.
 */
export function profileViewCollapsedShouldersFixture(peakMs = 2000): AdversarialStrokeFixture {
  const frames = buildFrames(peakMs, (tMs) => {
    const phase = Math.min(1, Math.max(-1, (tMs - peakMs) / 250));
    const wristX = 0.71 + 0.08 * phase;
    const wristY = 0.6 - 0.03 * Math.max(0, phase);
    return [
      mark("left_shoulder", 0.7, 0.4),
      mark("right_shoulder", 0.705, 0.4),
      mark("left_hip", 0.7, 0.62),
      mark("right_hip", 0.704, 0.62),
      mark("right_wrist", wristX, wristY),
      mark("right_elbow", (0.705 + wristX) / 2, (0.4 + wristY) / 2),
    ];
  });
  return {
    id: "profile-view-collapsed-shoulders",
    description:
      "Genuine swing seen in near-profile: image-plane shoulder width 0.005u; midline offset at contact 0.0075u (noise scale).",
    sequence: toSequence(frames),
    window: { startMs: peakMs - 300, endMs: peakMs + 300, peakMs },
    wristSpeeds: speedSeries(peakMs, 1.2),
  };
}

/**
 * Facing flip at contact: a genuine rear-view right-handed forehand whose
 * torso rotation carries the shoulders past profile exactly at the contact
 * frame (right shoulder momentarily at image-left of the left shoulder).
 * Every other frame shows the rear view. Ground truth: FOREHAND.
 */
export function facingFlipAtContactFixture(): AdversarialStrokeFixture {
  const swing = generateSwing();
  const frames = swing.frames.map((frame) => {
    if (Math.abs(frame.timestampMs - swing.window.peakMs) > 15) return frame;
    return {
      ...frame,
      landmarks: frame.landmarks.map((landmark) => {
        if (landmark.name === "left_shoulder") return { ...landmark, x: 0.52 };
        if (landmark.name === "right_shoulder") return { ...landmark, x: 0.48 };
        return landmark;
      }),
    };
  });
  return {
    id: "facing-flip-at-contact",
    description:
      "Rear-view forehand with shoulders crossed past profile at the contact frame only. Ground truth: FOREHAND.",
    sequence: toSequence(frames),
    window: swing.window,
    wristSpeeds: speedSeries(swing.window.peakMs, 1.8),
  };
}

/**
 * Wheelchair rim propulsion: both hands sweep down-and-back along the wheel
 * rims beside the hips — an energetic, symmetric, bimanual push. Ground
 * truth: NOT a stroke (chair propulsion between shots).
 */
export function wheelchairRimPushFixture(peakMs = 2000): AdversarialStrokeFixture {
  const shoulderY = 0.46;
  const hipY = 0.58; // compressed-but-real seated torso extent 0.12
  const frames = buildFrames(peakMs, (tMs) => {
    const phase = (tMs - peakMs) / 300;
    const push = Math.sin(phase * Math.PI);
    const rightWristX = 0.84 + 0.05 * push;
    const rightWristY = 0.62 + 0.06 * push;
    const leftWristX = 0.56 - 0.05 * push;
    const leftWristY = 0.62 + 0.06 * push;
    return [
      mark("left_shoulder", 0.6, shoulderY),
      mark("right_shoulder", 0.8, shoulderY),
      mark("left_hip", 0.62, hipY),
      mark("right_hip", 0.78, hipY),
      mark("right_wrist", rightWristX, rightWristY),
      mark("right_elbow", (0.8 + rightWristX) / 2, (shoulderY + rightWristY) / 2),
      mark("left_wrist", leftWristX, leftWristY),
      mark("left_elbow", (0.6 + leftWristX) / 2, (shoulderY + leftWristY) / 2),
    ];
  });
  return {
    id: "wheelchair-rim-push",
    description:
      "Seated player pushing both wheel rims (symmetric bimanual arc at hip height, ~0.9 u/s). Not a stroke.",
    sequence: toSequence(frames),
    window: { startMs: peakMs - 300, endMs: peakMs + 300, peakMs },
    wristSpeeds: speedSeries(peakMs, 0.9),
  };
}

/**
 * Genuine two-handed backhand by a right-handed player: BOTH hands on ONE
 * grip, wrists ~0.05u apart, sweeping together across the body to a contact
 * left of the midline. Symmetric-bimanual-gate control: both wrists move
 * with full synchrony and identical magnitude — exactly like a rim push —
 * but the SEPARATION stays small (hands share the grip), so the classifier
 * must still commit BACKHAND, not abstain. Ground truth: a stroke.
 */
export function twoHandedBackhandFixture(peakMs = 2000): AdversarialStrokeFixture {
  const frames = buildFrames(peakMs, (tMs) => {
    const s = Math.max(0, Math.min(1, (tMs - (peakMs - 300)) / 300));
    const wristX = 0.7 - 0.25 * s;
    const wristY = 0.6 - 0.08 * s;
    return [
      ...torsoMarks(STANDING),
      mark("right_wrist", wristX, wristY),
      mark("right_elbow", (0.8 + wristX) / 2, (0.4 + wristY) / 2),
      mark("left_wrist", wristX + 0.05, wristY + 0.02),
      mark("left_elbow", (0.6 + wristX + 0.05) / 2, (0.4 + wristY) / 2),
    ];
  });
  return {
    id: "two-handed-backhand",
    description:
      "Two-handed backhand (right-handed): both wrists on one grip, ~0.05u apart, sweeping to a contact 1.25 shoulder-widths left of the midline. A genuine stroke.",
    sequence: toSequence(frames),
    window: { startMs: peakMs - 300, endMs: peakMs + 300, peakMs },
    wristSpeeds: speedSeries(peakMs, 0.9),
  };
}

/**
 * Energetic aborted swing: a FAST backswing pull (1.0 u/s) inside the event
 * window, then the swing is checked — the wrist freezes well before the
 * reference instant. Ground truth: NOT a stroke (checked swing, no contact).
 */
export function energeticAbortedSwingFixture(peakMs = 2000): AdversarialStrokeFixture {
  const frames = buildFrames(peakMs, (tMs) => {
    const early = Math.max(0, Math.min(1, (tMs - (peakMs - 300)) / 150));
    const wristX = 0.72 - 0.15 * early;
    return [
      ...torsoMarks(STANDING),
      mark("right_wrist", wristX, 0.56),
      mark("right_elbow", (0.8 + wristX) / 2, 0.48),
    ];
  });
  return {
    id: "energetic-aborted-swing",
    description:
      "Fast backswing pull (1.0 u/s) checked 150ms into the window; wrist frozen at the reference. Not a stroke.",
    sequence: toSequence(frames),
    window: { startMs: peakMs - 300, endMs: peakMs + 300, peakMs },
    wristSpeeds: Array.from({ length: 20 }, (_, index) => ({
      timestampMs: peakMs - 300 + index * 30,
      value: index < 5 ? 1.0 : 0.02,
    })),
  };
}
