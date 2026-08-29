import type { BallObservation, PoseSequence } from "@pickle/swing-domain";
import { generateSwingSequence, type SwingTruth } from "./swingGenerator.js";

/**
 * SYNTHETIC ADVERSARIAL contact fixtures — red-team inputs for the contact
 * estimator (vision-geometry estimateContact, contact-evidence-4.x). Every
 * fixture carries its constructed ground-truth contact instant, so a probe
 * can measure not just abstention behavior (the D3-04 fabricated-marker
 * family) but LOCALIZATION error: a confident estimate far from the
 * constructed truth is a confident-but-wrong contact.
 *
 * Families (e09): fast swings at low capture fps, ball occlusion around the
 * hit (including post-occlusion bounce decoys), edge-on paddle tracks with
 * re-acquisition jumps, missing modalities, and degenerate pose (identity
 * swaps, low-visibility torso, tiny players).
 *
 * Provenance is always "synthetic": these inputs exercise estimator MATH
 * against known-adversarial geometry. They are not human data and never
 * substitute for consented first-party benchmarks.
 */

export const ADVERSARIAL_CONTACT_PRODUCER = {
  providerId: "synthetic.adversarial-contact-redteam",
  modelVersion: "adversarial-contact-1",
  runtime: "deterministic",
  executionTarget: "on_device",
} as const;

export interface AdversarialContactFixture {
  id: string;
  family:
    "fast_swing" | "occluded_ball" | "edge_on_paddle" | "missing_modality" | "degenerate_pose";
  description: string;
  sequence: PoseSequence;
  window: { startMs: number; endMs: number; peakMotionMs: number | null };
  /** Constructed ground-truth contact instant (ms). */
  trueContactMs: number;
  ballObservations: BallObservation[] | null;
  paddleSpeeds: Array<{ timestampMs: number; value: number }> | null;
  paddleCenters: Array<{ timestampMs: number; x: number; y: number }> | null;
  targetWrists: Array<{ timestampMs: number; x: number; y: number }> | null;
  strokeFamily: "volley" | "dink" | "drive" | "serve" | "overhead" | "unknown" | null;
  /** What a correct estimator does here: localize truth, or abstain. */
  expectation: "estimate_near_truth" | "abstain_or_near_truth" | "must_not_confirm_wrong";
}

/** Incoming→outgoing ball with its direction change exactly at `contact`
 * (position `at`), sampled every `stepMs`, optionally masked by an
 * occlusion interval [hideFromMs, hideToMs). */
function ballThrough(options: {
  contactMs: number;
  at: { x: number; y: number };
  fromMs: number;
  toMs: number;
  stepMs: number;
  inFrom: { x: number; y: number };
  outTo: { x: number; y: number };
  confidence?: number;
  hideFromMs?: number;
  hideToMs?: number;
}): BallObservation[] {
  const observations: BallObservation[] = [];
  let frameIndex = 0;
  for (let t = options.fromMs; t <= options.toMs; t += options.stepMs) {
    if (
      options.hideFromMs !== undefined &&
      options.hideToMs !== undefined &&
      t >= options.hideFromMs &&
      t < options.hideToMs
    ) {
      frameIndex += 1;
      continue;
    }
    const before = t <= options.contactMs;
    const span = before ? options.contactMs - options.fromMs : options.toMs - options.contactMs;
    const raw =
      span > 0 ? (before ? (t - options.fromMs) / span : (t - options.contactMs) / span) : 0;
    const x = before
      ? options.inFrom.x + (options.at.x - options.inFrom.x) * raw
      : options.at.x + (options.outTo.x - options.at.x) * raw;
    const y = before
      ? options.inFrom.y + (options.at.y - options.inFrom.y) * raw
      : options.at.y + (options.outTo.y - options.at.y) * raw;
    observations.push({
      frameIndex: frameIndex++,
      timestampMs: t,
      x,
      y,
      confidence: options.confidence ?? 0.8,
    });
  }
  return observations;
}

/** Paddle center track tracking the dominant wrist with a small offset. */
function paddleFromWrist(
  sequence: PoseSequence,
  offset: { x: number; y: number },
  keep: (tMs: number) => boolean = () => true,
): Array<{ timestampMs: number; x: number; y: number }> {
  const centers: Array<{ timestampMs: number; x: number; y: number }> = [];
  for (const frame of sequence.frames) {
    if (!keep(frame.timestampMs)) continue;
    const wrist = frame.landmarks.find((mark) => mark.name === "right_wrist");
    if (!wrist) continue;
    centers.push({ timestampMs: frame.timestampMs, x: wrist.x + offset.x, y: wrist.y + offset.y });
  }
  return centers;
}

/** Consecutive-step speeds (u/s) of a center track. */
function speedsOf(
  centers: ReadonlyArray<{ timestampMs: number; x: number; y: number }>,
): Array<{ timestampMs: number; value: number }> {
  const speeds: Array<{ timestampMs: number; value: number }> = [];
  for (let index = 1; index < centers.length; index += 1) {
    const previous = centers[index - 1]!;
    const current = centers[index]!;
    const dtMs = current.timestampMs - previous.timestampMs;
    if (dtMs <= 0) continue;
    speeds.push({
      timestampMs: (current.timestampMs + previous.timestampMs) / 2,
      value: (Math.hypot(current.x - previous.x, current.y - previous.y) / dtMs) * 1000,
    });
  }
  return speeds;
}

/** Wrist position of the synthetic swing at the constructed contact. */
function wristAtContact(sequence: PoseSequence, contactMs: number): { x: number; y: number } {
  let best: { x: number; y: number } | null = null;
  let bestDelta = Infinity;
  for (const frame of sequence.frames) {
    const delta = Math.abs(frame.timestampMs - contactMs);
    if (delta >= bestDelta) continue;
    const wrist = frame.landmarks.find((mark) => mark.name === "right_wrist");
    if (!wrist) continue;
    best = { x: wrist.x, y: wrist.y };
    bestDelta = delta;
  }
  return best ?? { x: 0.58, y: 0.6 };
}

function swing(overrides: Partial<SwingTruth> = {}) {
  return generateSwingSequence(overrides);
}

export function generateAdversarialContactFixtures(): AdversarialContactFixture[] {
  const fixtures: AdversarialContactFixture[] = [];

  // ── Family: fast swings ──────────────────────────────────────────────────
  {
    // Whip-fast drive captured at 30fps: the accelerate phase spans ~3 frames.
    const { sequence, window } = swing({ fps: 30, accelerateMs: 100, followMs: 200 });
    fixtures.push({
      id: "fast-30fps-pose-only",
      family: "fast_swing",
      description: "100ms accelerate phase at 30fps, pose only — 3 samples cover the strike",
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      trueContactMs: window.peakMs,
      ballObservations: null,
      paddleSpeeds: null,
      paddleCenters: null,
      targetWrists: null,
      strokeFamily: "drive",
      expectation: "estimate_near_truth",
    });
  }
  {
    // Same fast swing at 24fps with a ball through the true contact.
    const { sequence, window } = swing({ fps: 24, accelerateMs: 120, followMs: 240 });
    const at = wristAtContact(sequence, window.peakMs);
    fixtures.push({
      id: "fast-24fps-with-ball",
      family: "fast_swing",
      description: "120ms accelerate at 24fps; ball turn constructed at the true contact",
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      trueContactMs: window.peakMs,
      ballObservations: ballThrough({
        contactMs: window.peakMs,
        at,
        fromMs: window.peakMs - 300,
        toMs: window.peakMs + 300,
        stepMs: 42,
        inFrom: { x: 0.95, y: at.y - 0.05 },
        outTo: { x: at.x + 0.35, y: at.y - 0.2 },
      }),
      paddleSpeeds: null,
      paddleCenters: null,
      targetWrists: null,
      strokeFamily: "drive",
      expectation: "estimate_near_truth",
    });
  }

  // ── Family: occluded ball ────────────────────────────────────────────────
  {
    // Ball hidden ±150ms around contact (player body occludes the hit); the
    // turn itself is never observed. Motion evidence must carry the moment.
    const { sequence, window } = swing();
    const at = wristAtContact(sequence, window.peakMs);
    fixtures.push({
      id: "occluded-ball-at-contact",
      family: "occluded_ball",
      description: "ball track hidden 150ms either side of the hit; approach and departure visible",
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      trueContactMs: window.peakMs,
      ballObservations: ballThrough({
        contactMs: window.peakMs,
        at,
        fromMs: window.peakMs - 450,
        toMs: window.peakMs + 450,
        stepMs: 30,
        inFrom: { x: 0.95, y: at.y - 0.05 },
        outTo: { x: at.x + 0.4, y: at.y - 0.22 },
        hideFromMs: window.peakMs - 150,
        hideToMs: window.peakMs + 150,
      }),
      paddleSpeeds: null,
      paddleCenters: null,
      targetWrists: null,
      strokeFamily: "drive",
      expectation: "estimate_near_truth",
    });
  }
  {
    // Occluded hit + a DECOY: the outgoing ball bounces (sharp turn) 400ms
    // after the true contact, and the bounce happens to sit near the player's
    // relaxed wrist (recovery phase). The bounce is a gated, tethered turn —
    // the classic confident-but-wrong trap.
    const { sequence, window } = swing();
    const at = wristAtContact(sequence, window.peakMs);
    const bounceMs = window.peakMs + 400;
    const approach = ballThrough({
      contactMs: window.peakMs,
      at,
      fromMs: window.peakMs - 450,
      toMs: window.peakMs + 250,
      stepMs: 30,
      inFrom: { x: 0.95, y: at.y - 0.05 },
      outTo: { x: at.x + 0.1, y: at.y + 0.18 },
      hideFromMs: window.peakMs - 150,
      hideToMs: window.peakMs + 150,
    });
    // Bounce V: down then up, near the recovering wrist's neighborhood.
    const bounceAt = { x: at.x + 0.12, y: at.y + 0.22 };
    const bounce = ballThrough({
      contactMs: bounceMs,
      at: bounceAt,
      fromMs: bounceMs - 120,
      toMs: bounceMs + 150,
      stepMs: 30,
      inFrom: { x: bounceAt.x - 0.08, y: bounceAt.y - 0.15 },
      outTo: { x: bounceAt.x + 0.1, y: bounceAt.y - 0.16 },
    });
    fixtures.push({
      id: "occluded-ball-bounce-decoy",
      family: "occluded_ball",
      description:
        "hit occluded; sharp bounce turn 400ms later near the player — must not become the contact",
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      trueContactMs: window.peakMs,
      ballObservations: [...approach, ...bounce].map((observation, frameIndex) => ({
        ...observation,
        frameIndex,
      })),
      paddleSpeeds: null,
      paddleCenters: null,
      targetWrists: null,
      strokeFamily: "drive",
      expectation: "must_not_confirm_wrong",
    });
  }

  // ── Family: edge-on paddle ───────────────────────────────────────────────
  {
    // Edge-on paddle: the track exists on approach, dies ~180ms before the
    // hit (blade-on view), and re-acquires ~160ms after with a position jump.
    // The re-acquisition step reads as a large apparent speed — a fake peak
    // at the wrong moment.
    const { sequence, window } = swing();
    const gapStart = window.peakMs - 180;
    const gapEnd = window.peakMs + 160;
    const centers = paddleFromWrist(
      sequence,
      { x: 0.05, y: -0.03 },
      (tMs) => tMs < gapStart || tMs > gapEnd,
    );
    fixtures.push({
      id: "edge-on-paddle-reacquire-jump",
      family: "edge_on_paddle",
      description:
        "paddle track dies 180ms pre-hit, re-acquires 160ms post-hit with a step-speed spike",
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      trueContactMs: window.peakMs,
      ballObservations: null,
      paddleSpeeds: speedsOf(centers),
      paddleCenters: centers,
      targetWrists: null,
      strokeFamily: "drive",
      expectation: "estimate_near_truth",
    });
  }
  {
    // Edge-on the whole strike: paddle only measured in ready/backswing (its
    // last samples sit ~600ms before contact, a boundary-censored peak), and
    // the ball is only seen on approach.
    const { sequence, window } = swing();
    const cutoff = window.peakMs - 600;
    const centers = paddleFromWrist(sequence, { x: 0.05, y: -0.03 }, (tMs) => tMs <= cutoff);
    const at = wristAtContact(sequence, window.peakMs);
    fixtures.push({
      id: "edge-on-paddle-lost-early",
      family: "edge_on_paddle",
      description: "paddle lost 600ms before the hit; ball visible only on approach",
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      trueContactMs: window.peakMs,
      ballObservations: ballThrough({
        contactMs: window.peakMs,
        at,
        fromMs: window.peakMs - 500,
        toMs: window.peakMs,
        stepMs: 30,
        inFrom: { x: 0.95, y: at.y - 0.05 },
        outTo: at,
        hideFromMs: window.peakMs - 60,
        hideToMs: window.peakMs + 1,
      }),
      paddleSpeeds: speedsOf(centers),
      paddleCenters: centers,
      targetWrists: null,
      strokeFamily: "drive",
      expectation: "estimate_near_truth",
    });
  }

  // ── Family: missing modalities ───────────────────────────────────────────
  {
    // No pose at all inside the scan window (extraction failed there); only a
    // paddle track and a ball through the true contact survive.
    const { sequence, window } = swing();
    const at = wristAtContact(sequence, window.peakMs);
    const centers = paddleFromWrist(sequence, { x: 0.05, y: -0.03 });
    const shifted: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map((frame) => ({
        ...frame,
        timestampMs: frame.timestampMs + 10_000,
      })),
    };
    fixtures.push({
      id: "no-pose-in-window",
      family: "missing_modality",
      description: "pose absent in the scan window; paddle track + ball must carry (or abstain)",
      sequence: shifted,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      trueContactMs: window.peakMs,
      ballObservations: ballThrough({
        contactMs: window.peakMs,
        at,
        fromMs: window.peakMs - 300,
        toMs: window.peakMs + 300,
        stepMs: 30,
        inFrom: { x: 0.95, y: at.y - 0.05 },
        outTo: { x: at.x + 0.35, y: at.y - 0.2 },
      }),
      paddleSpeeds: speedsOf(centers),
      paddleCenters: centers,
      targetWrists: null,
      strokeFamily: "drive",
      expectation: "abstain_or_near_truth",
    });
  }
  {
    // Ball-only with explicit target wrists (no pose landmarks measurable,
    // no paddle): the wrists gate the turn but no motion evidence exists.
    const { sequence, window } = swing();
    const at = wristAtContact(sequence, window.peakMs);
    const shifted: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map((frame) => ({
        ...frame,
        timestampMs: frame.timestampMs + 10_000,
      })),
    };
    const targetWrists = sequence.frames
      .map((frame) => {
        const wrist = frame.landmarks.find((mark) => mark.name === "right_wrist");
        return wrist ? { timestampMs: frame.timestampMs, x: wrist.x, y: wrist.y } : null;
      })
      .filter((entry): entry is { timestampMs: number; x: number; y: number } => entry !== null);
    fixtures.push({
      id: "ball-plus-wrists-only",
      family: "missing_modality",
      description: "ball turn gated by provided target wrists; zero motion modalities",
      sequence: shifted,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      trueContactMs: window.peakMs,
      ballObservations: ballThrough({
        contactMs: window.peakMs,
        at,
        fromMs: window.peakMs - 300,
        toMs: window.peakMs + 300,
        stepMs: 30,
        inFrom: { x: 0.95, y: at.y - 0.05 },
        outTo: { x: at.x + 0.35, y: at.y - 0.2 },
      }),
      paddleSpeeds: null,
      paddleCenters: null,
      targetWrists,
      strokeFamily: "drive",
      expectation: "abstain_or_near_truth",
    });
  }

  // ── Family: degenerate pose ──────────────────────────────────────────────
  {
    // Identity swap: mid-recovery the wrist landmark jumps to a second player
    // half a frame away and swings THERE, producing a rival wrist peak ~700ms
    // after the true contact at plausible (sub-glitch-gate) speeds.
    const { sequence, window } = swing();
    const swapMs = window.peakMs + 500;
    const rivalPeakMs = window.peakMs + 700;
    const swapped: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map((frame) => {
        if (frame.timestampMs < swapMs) return frame;
        const local = frame.timestampMs - rivalPeakMs;
        // Rival swing: a smooth 0.25u-amplitude arc peaking at rivalPeakMs.
        const arc = Math.exp(-(local * local) / (2 * 120 * 120));
        return {
          ...frame,
          landmarks: frame.landmarks.map((mark) =>
            mark.name === "right_wrist"
              ? { ...mark, x: 0.25 + 0.22 * arc, y: 0.55 - 0.1 * arc }
              : mark,
          ),
        };
      }),
    };
    fixtures.push({
      id: "identity-swap-second-swing",
      family: "degenerate_pose",
      description:
        "wrist landmark jumps to another player mid-recovery and 'swings' 700ms after the hit",
      sequence: swapped,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      trueContactMs: window.peakMs,
      ballObservations: null,
      paddleSpeeds: null,
      paddleCenters: null,
      targetWrists: null,
      strokeFamily: "drive",
      expectation: "must_not_confirm_wrong",
    });
  }
  {
    // Torso unmeasurable: shoulders/hips below the visibility floor on every
    // frame, so all torso-normalized gates run on the default span, on a
    // TINY player (scale 0.5) — the gates are systematically misscaled.
    const { sequence, window } = swing({ torsoLength: 0.1 });
    const at = wristAtContact(sequence, window.peakMs);
    const blind: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map((frame) => ({
        ...frame,
        landmarks: frame.landmarks.map((mark) =>
          mark.name.includes("shoulder") || mark.name.includes("hip")
            ? { ...mark, visibility: 0.1 }
            : mark,
        ),
      })),
    };
    fixtures.push({
      id: "degenerate-torso-tiny-player",
      family: "degenerate_pose",
      description:
        "torso landmarks below visibility floor on a half-size player; default span used",
      sequence: blind,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      trueContactMs: window.peakMs,
      ballObservations: ballThrough({
        contactMs: window.peakMs,
        at,
        fromMs: window.peakMs - 300,
        toMs: window.peakMs + 300,
        stepMs: 30,
        inFrom: { x: 0.95, y: at.y - 0.03 },
        outTo: { x: at.x + 0.2, y: at.y - 0.12 },
      }),
      paddleSpeeds: null,
      paddleCenters: null,
      targetWrists: null,
      strokeFamily: "dink",
      expectation: "abstain_or_near_truth",
    });
  }

  return fixtures;
}
