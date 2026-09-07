import { DEFAULT_TRUTH, generateSwingSequence, type SwingTruth } from "@pickle/evaluation";
import type { PoseSequence } from "@pickle/swing-domain";
import { hashSeed, SeededRng } from "./rng.js";
import {
  ARM_LANDMARKS,
  ALL_LANDMARKS,
  bodyCenter,
  bystanderFrom,
  cropBelow,
  dropoutJoints,
  emptyLandmarks,
  floorVisibility,
  identityFlicker,
  identitySwitch,
  jitter,
  LEG_LANDMARKS,
  LOWER_BODY_LANDMARKS,
  nearestTimestamp,
  occlude,
  removeFrames,
  removeJoints,
  scaleAbout,
  spectator,
  translate,
  type DropoutMode,
} from "./synth.js";

/**
 * PLAYER VISIBILITY scenario matrix.
 *
 * Each scenario maps (seed) → a synthesized keypoint stream plus the
 * expectation the honest pipeline must satisfy for that visibility
 * condition. Expectations are deliberately conservative:
 *
 *   must_score            — clean control; the pipeline must still score.
 *   must_abstain          — there is no analyzable player stroke in the
 *                           tracked keypoints (no player, spectator, tracked
 *                           identity is not the hitter, swinging arm never
 *                           measured, player absent through contact). ANY
 *                           scored result is a wrong score.
 *   must_not_be_confident — a stroke exists but the body is degraded in a way
 *                           the committed capture-quality gate itself refuses
 *                           (too small / cropped / not fully visible). A score
 *                           may be shown only with reduced confidence — a
 *                           "normal" presentation is a confident wrong score.
 *   measure_only          — mild degradation; recorded for the deviation
 *                           table, no hard verdict.
 */
export type Expectation = "must_score" | "must_abstain" | "must_not_be_confident" | "measure_only";

export type ScenarioParams = Record<string, number | string | boolean | null>;

export interface ScenarioCase {
  scenarioId: string;
  seed: number;
  expectation: Expectation;
  truth: SwingTruth;
  handedness: "right" | "left";
  /** Trigger peak hint handed to the pipeline (null = imported clip / no measured peak). */
  peakHintMs: number | null;
  params: ScenarioParams;
  sequence: PoseSequence;
  /** The untouched reference stream for the same seed (score deviation baseline). */
  reference: PoseSequence;
  window: { startMs: number; endMs: number; peakMs: number };
}

export interface ScenarioDefinition {
  id: string;
  description: string;
  expectation: Expectation;
  build: (rng: SeededRng, base: BaseSwing) => { sequence: PoseSequence; params: ScenarioParams };
}

export interface BaseSwing {
  truth: SwingTruth;
  sequence: PoseSequence;
  window: { startMs: number; endMs: number; peakMs: number };
  contactMs: number;
  durationMs: number;
}

/** Realistic per-seed variation of the committed swing fixture. */
export function baseSwing(rng: SeededRng): BaseSwing {
  const truth: Partial<SwingTruth> = {
    torsoLength: rng.uniform(0.16, 0.24),
    handed: rng.pick(["right", "left"] as const),
    fps: rng.pick([30, 60]),
    contactForwardNorm: rng.uniform(0.3, 0.5),
    contactHeightRatio: rng.uniform(0.3, 0.5),
    kneeFlexionDeg: rng.uniform(20, 40),
    shoulderTurnDeg: rng.uniform(35, 60),
    backswingLengthNorm: rng.uniform(0.6, 1.0),
    stanceWidthRatio: rng.uniform(1.1, 1.6),
  };
  const generated = generateSwingSequence(truth);
  return {
    truth: { ...DEFAULT_TRUTH, ...truth },
    sequence: generated.sequence,
    window: generated.window,
    contactMs: generated.window.peakMs,
    durationMs: generated.window.endMs,
  };
}

const pickMode = (rng: SeededRng): DropoutMode => rng.pick(["omit", "low_visibility"] as const);

/** Light realistic sensor noise applied to every non-control case. */
const SENSOR_JITTER_SIGMA = 0.002;

export const SCENARIOS: readonly ScenarioDefinition[] = [
  {
    id: "full_body_clean",
    description: "Full body visible for the whole clip; realistic sensor jitter and ≤3% dropout.",
    expectation: "must_score",
    build: (rng, base) => {
      const rate = rng.uniform(0, 0.03);
      const mode = pickMode(rng);
      let sequence = jitter(base.sequence, rng, SENSOR_JITTER_SIGMA);
      sequence = dropoutJoints(sequence, rng, ALL_LANDMARKS, rate, mode);
      return { sequence, params: { dropoutRate: rate, mode, jitterSigma: SENSOR_JITTER_SIGMA } };
    },
  },
  {
    id: "partial_body_upper_only",
    description:
      "Framing cuts the body at the hips: hips, knees and ankles never measured (torso half only).",
    expectation: "must_not_be_confident",
    build: (rng, base) => {
      const mode = pickMode(rng);
      const sequence = removeJoints(
        jitter(base.sequence, rng, SENSOR_JITTER_SIGMA),
        LOWER_BODY_LANDMARKS,
        mode,
      );
      return { sequence, params: { mode, removed: LOWER_BODY_LANDMARKS.join(",") } };
    },
  },
  {
    id: "legs_missing",
    description:
      "Knees and ankles never measured (occluded by net/bag or below frame); torso and arms intact. Body placed at a seeded height so the true ground line is NOT the image bottom.",
    expectation: "must_not_be_confident",
    build: (rng, base) => {
      const mode = pickMode(rng);
      const dy = -rng.uniform(0, 0.3);
      const sequence = removeJoints(
        translate(jitter(base.sequence, rng, SENSOR_JITTER_SIGMA), 0, dy),
        LEG_LANDMARKS,
        mode,
      );
      return { sequence, params: { mode, translateY: dy, trueGroundY: 0.92 + dy } };
    },
  },
  {
    id: "legs_cropped_by_frame",
    description:
      "Legs cut by the bottom frame edge: every landmark below the cut is out of view for the whole clip.",
    expectation: "must_not_be_confident",
    build: (rng, base) => {
      const mode = pickMode(rng);
      const yCut = rng.uniform(0.72, 0.88);
      const sequence = cropBelow(jitter(base.sequence, rng, SENSOR_JITTER_SIGMA), yCut, mode);
      return { sequence, params: { mode, yCut } };
    },
  },
  {
    id: "arms_missing_dominant",
    description:
      "The swinging (dominant) arm is never measured — wrist and elbow absent for the whole clip.",
    expectation: "must_abstain",
    build: (rng, base) => {
      const mode = pickMode(rng);
      const sequence = removeJoints(
        jitter(base.sequence, rng, SENSOR_JITTER_SIGMA),
        ARM_LANDMARKS[base.truth.handed],
        mode,
      );
      return { sequence, params: { mode, removed: ARM_LANDMARKS[base.truth.handed].join(",") } };
    },
  },
  {
    id: "arms_missing_both",
    description: "Neither arm is measured for the whole clip (both wrists/elbows absent).",
    expectation: "must_abstain",
    build: (rng, base) => {
      const mode = pickMode(rng);
      const sequence = removeJoints(
        jitter(base.sequence, rng, SENSOR_JITTER_SIGMA),
        [...ARM_LANDMARKS.left, ...ARM_LANDMARKS.right],
        mode,
      );
      return { sequence, params: { mode } };
    },
  },
  {
    id: "arm_dropout_intermittent",
    description:
      "Swinging wrist and elbow drop out independently per frame at a seeded 30–70% rate.",
    expectation: "measure_only",
    build: (rng, base) => {
      const mode = pickMode(rng);
      const rate = rng.uniform(0.3, 0.7);
      const sequence = dropoutJoints(
        jitter(base.sequence, rng, SENSOR_JITTER_SIGMA),
        rng,
        ARM_LANDMARKS[base.truth.handed],
        rate,
        mode,
      );
      return { sequence, params: { mode, dropoutRate: rate } };
    },
  },
  {
    id: "occlusion_through_contact",
    description:
      "Another body passes in front of the player: swinging arm + torso hidden for 150–400 ms spanning contact.",
    expectation: "must_not_be_confident",
    build: (rng, base) => {
      const mode = pickMode(rng);
      const span = rng.uniform(150, 400);
      const startMs = base.contactMs - span * rng.uniform(0.3, 0.7);
      const endMs = startMs + span;
      const joints = [
        ...ARM_LANDMARKS[base.truth.handed],
        "left_shoulder",
        "right_shoulder",
        "left_hip",
        "right_hip",
      ];
      const sequence = occlude(
        jitter(base.sequence, rng, SENSOR_JITTER_SIGMA),
        joints,
        startMs,
        endMs,
        mode,
      );
      return { sequence, params: { mode, occlusionStartMs: startMs, occlusionEndMs: endMs } };
    },
  },
  {
    id: "occlusion_partial_side",
    description:
      "Net post / partner hides one side of the body (non-dominant arm + same-side leg) for a 300–800 ms window anywhere in the clip.",
    expectation: "measure_only",
    build: (rng, base) => {
      const mode = pickMode(rng);
      const side = base.truth.handed === "right" ? "left" : "right";
      const span = rng.uniform(300, 800);
      const startMs = rng.uniform(0, base.durationMs - span);
      const joints = [...ARM_LANDMARKS[side], `${side}_knee`, `${side}_ankle`, `${side}_hip`];
      const sequence = occlude(
        jitter(base.sequence, rng, SENSOR_JITTER_SIGMA),
        joints,
        startMs,
        startMs + span,
        mode,
      );
      return { sequence, params: { mode, side, occlusionStartMs: startMs, spanMs: span } };
    },
  },
  {
    id: "exit_reenter_through_contact",
    description:
      "Player leaves the frame and comes back: no frames measured for a 500–1500 ms gap that contains contact.",
    expectation: "must_abstain",
    build: (rng, base) => {
      const gap = rng.uniform(500, 1500);
      const startMs = base.contactMs - gap * rng.uniform(0.2, 0.8);
      const sequence = removeFrames(
        jitter(base.sequence, rng, SENSOR_JITTER_SIGMA),
        startMs,
        startMs + gap,
      );
      return { sequence, params: { gapStartMs: startMs, gapMs: gap } };
    },
  },
  {
    id: "exit_reenter_before_swing",
    description:
      "Player steps out and back during the ready stance: a 400–900 ms gap that ends before the backswing starts.",
    expectation: "measure_only",
    build: (rng, base) => {
      const readyEnd = base.truth.readyMs;
      const gap = rng.uniform(400, 900);
      const startMs = Math.max(0, readyEnd - gap - rng.uniform(0, 100));
      const sequence = removeFrames(
        jitter(base.sequence, rng, SENSOR_JITTER_SIGMA),
        startMs,
        startMs + gap,
      );
      return { sequence, params: { gapStartMs: startMs, gapMs: gap } };
    },
  },
  {
    id: "multi_person_identity_switch",
    description:
      "Two people on court: the tracked identity jumps from the player to a standing bystander 0–300 ms before contact and stays there.",
    expectation: "must_abstain",
    build: (rng, base) => {
      const offset = { x: rng.pick([-1, 1]) * rng.uniform(0.18, 0.3), y: rng.uniform(-0.05, 0.05) };
      const scale = rng.uniform(0.8, 1.2);
      const bystander = bystanderFrom(base.sequence, offset, scale);
      const switchMs = nearestTimestamp(base.sequence, base.contactMs - rng.uniform(0, 300));
      const sequence = identitySwitch(
        jitter(base.sequence, rng, SENSOR_JITTER_SIGMA),
        bystander,
        switchMs,
      );
      return {
        sequence,
        params: { switchMs, bystanderDx: offset.x, bystanderDy: offset.y, bystanderScale: scale },
      };
    },
  },
  {
    id: "multi_person_flicker",
    description:
      "Two people on court: each frame independently reports the bystander instead of the player at a seeded 30–60% rate.",
    expectation: "must_abstain",
    build: (rng, base) => {
      const offset = { x: rng.pick([-1, 1]) * rng.uniform(0.18, 0.3), y: rng.uniform(-0.05, 0.05) };
      const scale = rng.uniform(0.8, 1.2);
      const rate = rng.uniform(0.3, 0.6);
      const bystander = bystanderFrom(base.sequence, offset, scale);
      const sequence = identityFlicker(
        jitter(base.sequence, rng, SENSOR_JITTER_SIGMA),
        rng,
        bystander,
        rate,
      );
      return {
        sequence,
        params: { flickerRate: rate, bystanderDx: offset.x, bystanderScale: scale },
      };
    },
  },
  {
    id: "spectator_static",
    description:
      "The tracked person is a spectator standing still for the whole clip (only sensor jitter moves the joints).",
    expectation: "must_abstain",
    build: (rng, base) => {
      const sigma = rng.uniform(0.001, 0.004);
      const sequence = jitter(spectator(base.sequence, null), rng, sigma);
      return { sequence, params: { jitterSigma: sigma } };
    },
  },
  {
    id: "spectator_gesture",
    description:
      "The tracked person is a spectator making a slow arm gesture (wave / point) — motion, but no stroke.",
    expectation: "must_abstain",
    build: (rng, base) => {
      const amplitude = rng.uniform(0.02, 0.08);
      const periodMs = rng.uniform(900, 1800);
      const sequence = jitter(
        spectator(base.sequence, { amplitude, periodMs }),
        rng,
        SENSOR_JITTER_SIGMA,
      );
      return { sequence, params: { gestureAmplitude: amplitude, gesturePeriodMs: periodMs } };
    },
  },
  {
    id: "no_player_empty_frames",
    description:
      "Frames were recorded but no person was measured in any of them (empty landmarks).",
    expectation: "must_abstain",
    build: (_rng, base) => ({ sequence: emptyLandmarks(base.sequence), params: {} }),
  },
  {
    id: "no_player_no_frames",
    description: "The recorded pose sequence has zero frames.",
    expectation: "must_abstain",
    build: (_rng, base) => ({ sequence: { ...base.sequence, frames: [] }, params: {} }),
  },
  {
    id: "no_player_subthreshold_visibility",
    description:
      "Every landmark is emitted, but at visibility 0.05–0.28 (below the 0.3 measured threshold): noise, not a person.",
    expectation: "must_abstain",
    build: (rng, base) => {
      const upper = rng.uniform(0.15, 0.28);
      const sequence = floorVisibility(
        jitter(base.sequence, rng, rng.uniform(0.005, 0.03)),
        rng,
        0.05,
        upper,
      );
      return { sequence, params: { visibilityUpper: upper } };
    },
  },
  {
    id: "far_camera",
    description:
      "Player far from the phone: skeleton scaled to a torso of 0.04–0.076 image heights (below the 0.08 gate) with absolute pixel-level jitter.",
    expectation: "must_not_be_confident",
    build: (rng, base) => {
      const targetTorso = rng.uniform(0.04, 0.076);
      const factor = targetTorso / base.truth.torsoLength;
      const mode = pickMode(rng);
      const sigma = rng.uniform(0.002, 0.005);
      const sequence = jitter(
        scaleAbout(base.sequence, bodyCenter(base.sequence), factor, mode),
        rng,
        sigma,
      );
      return { sequence, params: { mode, scaleFactor: factor, targetTorso, jitterSigma: sigma } };
    },
  },
  {
    id: "far_camera_noiseless",
    description:
      "Same far-camera scale (torso 0.04–0.076) with NO positional noise: isolates the gate/scale-invariance question from noise amplification.",
    expectation: "must_not_be_confident",
    build: (rng, base) => {
      const targetTorso = rng.uniform(0.04, 0.076);
      const factor = targetTorso / base.truth.torsoLength;
      const mode = pickMode(rng);
      const sequence = scaleAbout(base.sequence, bodyCenter(base.sequence), factor, mode);
      return { sequence, params: { mode, scaleFactor: factor, targetTorso } };
    },
  },
  {
    id: "close_camera",
    description:
      "Player too close: skeleton scaled to a torso of 0.62–0.9 image heights (above the 0.6 gate); joints leaving the image are not measured.",
    expectation: "must_not_be_confident",
    build: (rng, base) => {
      const targetTorso = rng.uniform(0.62, 0.9);
      const factor = targetTorso / base.truth.torsoLength;
      const mode = pickMode(rng);
      const sequence = jitter(
        scaleAbout(base.sequence, bodyCenter(base.sequence), factor, mode),
        rng,
        SENSOR_JITTER_SIGMA,
      );
      return { sequence, params: { mode, scaleFactor: factor, targetTorso } };
    },
  },
  {
    id: "heavy_jitter",
    description:
      "Full body visible but every landmark carries heavy positional noise (σ = 10–25% of torso length).",
    expectation: "measure_only",
    build: (rng, base) => {
      const sigma = base.truth.torsoLength * rng.uniform(0.1, 0.25);
      return {
        sequence: jitter(base.sequence, rng, sigma),
        params: { jitterSigma: sigma, sigmaOverTorso: sigma / base.truth.torsoLength },
      };
    },
  },
];

export function buildCase(definition: ScenarioDefinition, seed: number): ScenarioCase {
  const rng = new SeededRng(hashSeed(definition.id, seed));
  const base = baseSwing(rng);
  const peakHintMs = rng.chance(0.5) ? base.contactMs : null;
  const built = definition.build(rng, base);
  return {
    scenarioId: definition.id,
    seed,
    expectation: definition.expectation,
    truth: base.truth,
    handedness: base.truth.handed,
    peakHintMs,
    params: { ...built.params, peakHintMs },
    sequence: built.sequence,
    reference: base.sequence,
    window: base.window,
  };
}
