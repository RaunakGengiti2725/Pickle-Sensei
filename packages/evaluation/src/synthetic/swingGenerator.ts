import type { PoseFrame, PoseLandmark, PoseLandmarkName } from "@pickle/shared-types";
import type { PoseSequence } from "@pickle/swing-domain";

/**
 * SYNTHETIC swing generator — the canonical source of labeled-synthetic
 * benchmark cases. It constructs skeleton frames whose geometry realizes
 * REQUESTED ground-truth values exactly (stance ratio, knee flexion, contact
 * point, path lengths, timing), so provider output can be asserted against
 * known truth with tight tolerances.
 *
 * Provenance is always "synthetic": these skeletons validate measurement and
 * segmentation MATH. They are not human data and never substitute for
 * consented first-party benchmarks (directive §21).
 */

/** ModelRef stamped on synthetic sequences so provenance is unmistakable. */
export const SYNTHETIC_PRODUCER = {
  providerId: "synthetic.swing-generator",
  modelVersion: "synthetic-swing-1",
  runtime: "deterministic",
  executionTarget: "on_device",
  artifactHash: null,
} as const;

export interface SwingTruth {
  /** Body scale: torso length in image units (square video). */
  torsoLength: number;
  stanceWidthRatio: number;
  kneeFlexionDeg: number;
  /** Contact point, in torso lengths forward of the hip center. */
  contactForwardNorm: number;
  /** Contact height as a fraction of shoulder height above ground. */
  contactHeightRatio: number;
  /** Wrist path length through backswing, in torso lengths. */
  backswingLengthNorm: number;
  /** How far below contact the swing dips before rising into contact. */
  swingDipNorm: number;
  /** Peak image-plane separation between shoulder line and hip line. */
  shoulderTurnDeg: number;
  handed: "right" | "left";
  fps: number;
  /** Phase durations in ms. */
  readyMs: number;
  backswingMs: number;
  accelerateMs: number;
  followMs: number;
  recoverMs: number;
}

export const DEFAULT_TRUTH: SwingTruth = {
  torsoLength: 0.2,
  stanceWidthRatio: 1.35,
  kneeFlexionDeg: 30,
  contactForwardNorm: 0.42,
  contactHeightRatio: 0.4,
  backswingLengthNorm: 0.8,
  swingDipNorm: 0.12,
  shoulderTurnDeg: 50,
  handed: "right",
  fps: 60,
  readyMs: 400,
  backswingMs: 450,
  // Exactly 15 frames at 60fps so the contact instant lands on a frame.
  accelerateMs: 250,
  followMs: 320,
  recoverMs: 550,
};

interface Skeleton {
  frames: PoseFrame[];
  clip: { width: number; height: number; fps: number; durationMs: number; uri: string };
  window: { startMs: number; endMs: number; peakMs: number };
}

/** Smoothstep easing keeps velocity continuous, with its peak mid-segment. */
function ease(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Accelerating easing: velocity grows through the segment, peaking at its end. */
function easeIn(t: number): number {
  return t * t;
}

/** Decelerating easing: velocity is highest at the segment start. */
function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Knee position realizing an exact flexion angle: on the perpendicular of the
 * hip→ankle segment at its midpoint, offset d = (|HA|/2)·tan(flexion/2) —
 * closed-form from cos θ = (d²−h²)/(d²+h²) with θ = 180° − flexion.
 */
function kneeFor(
  hip: { x: number; y: number },
  ankle: { x: number; y: number },
  flexionDeg: number,
  outwardSign: 1 | -1,
): { x: number; y: number } {
  const dx = ankle.x - hip.x;
  const dy = ankle.y - hip.y;
  const length = Math.hypot(dx, dy);
  const d = (length / 2) * Math.tan((flexionDeg * Math.PI) / 360);
  const nx = (-dy / length) * outwardSign;
  const ny = (dx / length) * outwardSign;
  return { x: (hip.x + ankle.x) / 2 + nx * d, y: (hip.y + ankle.y) / 2 + ny * d };
}

export function generateSwing(overrides: Partial<SwingTruth> = {}): Skeleton {
  const truth: SwingTruth = { ...DEFAULT_TRUTH, ...overrides };
  const T = truth.torsoLength;
  const sign = truth.handed === "right" ? 1 : -1; // forward direction (+x for righty)

  // Static body frame (square video → aspect 1, so x distances = y distances).
  const groundY = 0.92;
  const hipY = groundY - 1.55 * T; // hip height 1.55 torsos above ground
  const shoulderY = hipY - T; // torso vertical: shoulder-center to hip-center = T
  const headY = shoulderY - 0.35 * T;
  const centerX = 0.5;
  const shoulderHalf = 0.35 * T;
  const hipHalf = 0.28 * T;
  const stanceHalf = (truth.stanceWidthRatio * (2 * shoulderHalf)) / 2;

  const shoulderCenter = { x: centerX, y: shoulderY };

  // Exact-flexion knees on the perpendicular of each hip→ankle segment.
  const leftKnee = kneeFor(
    { x: centerX - hipHalf, y: hipY },
    { x: centerX - stanceHalf, y: groundY },
    truth.kneeFlexionDeg,
    -1,
  );
  const rightKnee = kneeFor(
    { x: centerX + hipHalf, y: hipY },
    { x: centerX + stanceHalf, y: groundY },
    truth.kneeFlexionDeg,
    1,
  );

  // Wrist waypoints (dominant hand). Ready near hip-front; the backswing is a
  // straight pull-back whose path length equals the requested truth.
  const readyWrist = { x: centerX + sign * 0.15 * T, y: hipY - 0.4 * T };
  const backswingReach = truth.backswingLengthNorm * T;
  const backWrist = { x: readyWrist.x - sign * backswingReach, y: readyWrist.y };
  const contactWrist = {
    x: centerX + sign * truth.contactForwardNorm * T,
    y: groundY - truth.contactHeightRatio * (groundY - shoulderY),
  };
  // The forward swing dips below both endpoints then rises into contact.
  const dipY = Math.max(backWrist.y, contactWrist.y) + truth.swingDipNorm * T;
  const followWrist = {
    x: contactWrist.x + sign * 0.45 * T,
    y: contactWrist.y - 0.55 * T,
  };

  // Arc-length table for the accelerate Bezier, so an easing on arc fraction
  // maps to true spatial speed — the constructed swing genuinely peaks at
  // contact for every body geometry.
  const bezier = (t: number): { x: number; y: number } => {
    // Control point chosen so the curve PASSES THROUGH the dip at t = 0.5
    // (a quadratic never reaches its control point, so the dip must be
    // solved for: P1 = 2·D − (P0+P2)/2).
    const p1 = {
      x: (backWrist.x + contactWrist.x) / 2,
      y: 2 * dipY - (backWrist.y + contactWrist.y) / 2,
    };
    const u = 1 - t;
    return {
      x: u * u * backWrist.x + 2 * u * t * p1.x + t * t * contactWrist.x,
      y: u * u * backWrist.y + 2 * u * t * p1.y + t * t * contactWrist.y,
    };
  };
  const ARC_SAMPLES = 240;
  const arcTable: number[] = [0];
  {
    let length = 0;
    let previous = bezier(0);
    for (let index = 1; index <= ARC_SAMPLES; index += 1) {
      const point = bezier(index / ARC_SAMPLES);
      length += Math.hypot(point.x - previous.x, point.y - previous.y);
      arcTable.push(length);
      previous = point;
    }
  }
  const bezierAtArcFraction = (fraction: number): { x: number; y: number } => {
    const target = fraction * (arcTable[ARC_SAMPLES] ?? 0);
    let low = 0;
    let high = ARC_SAMPLES;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((arcTable[mid] ?? 0) < target) low = mid + 1;
      else high = mid;
    }
    const upper = Math.max(1, low);
    const before = arcTable[upper - 1] ?? 0;
    const after = arcTable[upper] ?? before;
    const segment = after - before;
    const within = segment > 0 ? (target - before) / segment : 0;
    return bezier((upper - 1 + within) / ARC_SAMPLES);
  };

  const phases = [
    { name: "ready", duration: truth.readyMs },
    { name: "backswing", duration: truth.backswingMs },
    { name: "accelerate", duration: truth.accelerateMs },
    { name: "follow", duration: truth.followMs },
    { name: "recover", duration: truth.recoverMs },
  ] as const;
  const durationMs = phases.reduce((sum, phase) => sum + phase.duration, 0);
  const frameInterval = 1000 / truth.fps;

  const wristAt = (tMs: number): { x: number; y: number } => {
    let start = 0;
    for (const phase of phases) {
      const local = tMs - start;
      if (local <= phase.duration || phase === phases[phases.length - 1]) {
        const raw = Math.min(1, Math.max(0, local / phase.duration));
        switch (phase.name) {
          case "ready":
            return readyWrist;
          case "backswing": {
            const t = ease(raw);
            return { x: lerp(readyWrist.x, backWrist.x, t), y: lerp(readyWrist.y, backWrist.y, t) };
          }
          case "accelerate":
            // Arc-fraction easing: spatial speed grows monotonically and
            // peaks exactly at contact — like a real forward swing.
            return bezierAtArcFraction(easeIn(raw));
          case "follow": {
            const t = easeOut(raw);
            return {
              x: lerp(contactWrist.x, followWrist.x, t),
              y: lerp(contactWrist.y, followWrist.y, t),
            };
          }
          case "recover": {
            const t = ease(raw);
            return {
              x: lerp(followWrist.x, readyWrist.x, t),
              y: lerp(followWrist.y, readyWrist.y, t),
            };
          }
        }
      }
      start += phase.duration;
    }
    return readyWrist;
  };

  // Image-plane shoulder-line tilt: ramps up through the backswing, holds
  // through contact, and settles back during recovery.
  const tiltAt = (tMs: number): number => {
    const backswingEnd = truth.readyMs + truth.backswingMs;
    const followEnd = backswingEnd + truth.accelerateMs + truth.followMs;
    const total = followEnd + truth.recoverMs;
    if (tMs <= truth.readyMs) return 0;
    if (tMs <= backswingEnd)
      return truth.shoulderTurnDeg * ease((tMs - truth.readyMs) / truth.backswingMs);
    if (tMs <= followEnd) return truth.shoulderTurnDeg;
    return truth.shoulderTurnDeg * (1 - ease(Math.min(1, (tMs - followEnd) / (total - followEnd))));
  };

  const frames: PoseFrame[] = [];
  for (let tMs = 0; tMs <= durationMs; tMs += frameInterval) {
    const wrist = wristAt(tMs);
    const tiltRad = (tiltAt(tMs) * Math.PI) / 180;
    const shoulderVec = {
      x: Math.cos(tiltRad) * shoulderHalf,
      y: Math.sin(tiltRad) * shoulderHalf,
    };
    const leftShoulder = { x: shoulderCenter.x - shoulderVec.x, y: shoulderY - shoulderVec.y };
    const rightShoulder = { x: shoulderCenter.x + shoulderVec.x, y: shoulderY + shoulderVec.y };
    const dominantIsRight = truth.handed === "right";
    const dominantShoulder = dominantIsRight ? rightShoulder : leftShoulder;
    const offWrist = { x: centerX - sign * 0.35 * T, y: hipY - 0.45 * T };
    const elbowTowardWrist = {
      x: dominantShoulder.x + (wrist.x - dominantShoulder.x) * 0.5,
      y: dominantShoulder.y + (wrist.y - dominantShoulder.y) * 0.5,
    };
    const mark = (name: PoseLandmarkName, x: number, y: number): PoseLandmark => ({
      name,
      x,
      y,
      visibility: 0.95,
    });
    frames.push({
      timestampMs: Math.round(tMs),
      space: "normalized-image",
      confidence: 0.95,
      landmarks: [
        mark("head", centerX, headY),
        mark("left_shoulder", leftShoulder.x, leftShoulder.y),
        mark("right_shoulder", rightShoulder.x, rightShoulder.y),
        mark("left_hip", centerX - hipHalf, hipY),
        mark("right_hip", centerX + hipHalf, hipY),
        mark("left_knee", leftKnee.x, leftKnee.y),
        mark("right_knee", rightKnee.x, rightKnee.y),
        mark("left_ankle", centerX - stanceHalf, groundY),
        mark("right_ankle", centerX + stanceHalf, groundY),
        mark(
          dominantIsRight ? "right_elbow" : "left_elbow",
          elbowTowardWrist.x,
          elbowTowardWrist.y,
        ),
        mark(dominantIsRight ? "right_wrist" : "left_wrist", wrist.x, wrist.y),
        mark(dominantIsRight ? "left_elbow" : "right_elbow", offWrist.x, offWrist.y - 0.25 * T),
        mark(dominantIsRight ? "left_wrist" : "right_wrist", offWrist.x, offWrist.y),
      ],
    });
  }

  const contactAtMs = truth.readyMs + truth.backswingMs + truth.accelerateMs;
  return {
    frames,
    clip: {
      width: 1080,
      height: 1080,
      fps: truth.fps,
      durationMs,
      uri: "synthetic://swing",
    },
    window: { startMs: 0, endMs: durationMs, peakMs: contactAtMs },
  };
}

/** The same synthetic swing as a canonical, provenance-stamped PoseSequence. */
export function generateSwingSequence(overrides: Partial<SwingTruth> = {}): {
  sequence: PoseSequence;
  window: { startMs: number; endMs: number; peakMs: number };
} {
  const swing = generateSwing(overrides);
  return {
    sequence: {
      schemaVersion: 1,
      format: "pickle.pose-sequence.v1",
      coordinateSystem: "normalized_image_top_left",
      producedBy: { ...SYNTHETIC_PRODUCER },
      video: { width: swing.clip.width, height: swing.clip.height, fps: swing.clip.fps },
      frames: swing.frames.map((frame, index) => ({
        frameIndex: index,
        timestampMs: frame.timestampMs,
        confidence: frame.confidence,
        landmarks: frame.landmarks.map((mark) => ({
          name: mark.name,
          x: mark.x,
          y: mark.y,
          visibility: mark.visibility,
        })),
      })),
    },
    window: swing.window,
  };
}

/** Mirrors a generated skeleton left↔right (x → 1−x, landmark names swapped). */
export function mirrorFrames(frames: readonly PoseFrame[]): PoseFrame[] {
  const swap = (name: PoseLandmarkName): PoseLandmarkName =>
    name.startsWith("left_")
      ? (name.replace("left_", "right_") as PoseLandmarkName)
      : name.startsWith("right_")
        ? (name.replace("right_", "left_") as PoseLandmarkName)
        : name;
  return frames.map((frame) => ({
    ...frame,
    landmarks: frame.landmarks.map((entry) => ({
      ...entry,
      name: swap(entry.name),
      x: 1 - entry.x,
    })),
  }));
}
