import { CHECKPOINTS, FAULT_DIRECTIONS } from "@pickle/shared-types";
import type { CheckpointKey, FaultDirection } from "@pickle/shared-types";
import {
  DEFAULT_CUE_RULES,
  DEFAULT_LIVE_CUE_RULES,
  type CueRules,
  type LiveCheckpointObservation,
  type LiveCueRules,
  type LiveRepObservation,
  type RepObservation,
} from "../../src/index.js";
import { SeededRng } from "./seededRng.js";

/**
 * Seeded generators of legal / near-legal / hostile rep streams for both cue
 * engines. "Legal" mirrors what the mobile consumers actually feed the engines
 * (apps/mobile/src/flow/liveCourt.ts, liveSessionCoach.ts): monotonic 1-based
 * repIndex, one-decimal 0–10 overall scores, 0–100 checkpoint scores with
 * severity derived like packages/scoring (clamped (100 - score) / 100),
 * unique checkpoint keys, inapplicable checkpoints carry null score and
 * severity 0. "Near-legal" relaxes each of those one at a time (gaps or
 * duplicate repIndex, extra decimals, slightly out-of-range numbers, a scored
 * rep with a null overall, a moving focus checkpoint, duplicate checkpoint
 * keys, inapplicable checkpoints with numbers). "Hostile" injects NaN and
 * ±Infinity — inputs no upstream should ever produce, kept in a separate
 * campaign so they never dilute the legal counts.
 */
export type InputMode = "legal" | "near-legal" | "hostile";

export interface SequenceSpec {
  seed: number;
  mode: InputMode;
  length: number;
}

const HOSTILE_NUMBERS = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

function hostileOr(rng: SeededRng, value: number, p = 0.08): number {
  return rng.chance(p) ? rng.pick(HOSTILE_NUMBERS) : value;
}

function severityFor(score: number | null, rng: SeededRng, mode: InputMode): number {
  if (score === null) return 0;
  const derived = Math.min(Math.max((100 - score) / 100, 0), 1);
  if (mode === "legal") {
    // Mostly derived like the scoring engine, sometimes an independent legal value.
    return rng.chance(0.7) ? derived : rng.fixed(0, 1, 3);
  }
  if (mode === "near-legal" && rng.chance(0.15)) return rng.pick([-0.1, 1.2, 1.0000001, -0]);
  return rng.chance(0.7) ? derived : rng.fixed(0, 1, 3);
}

function directionFor(severity: number, rng: SeededRng): FaultDirection {
  if (severity === 0 && rng.chance(0.8)) return "none";
  return rng.pick(FAULT_DIRECTIONS);
}

export function nextRepIndex(previous: number, rng: SeededRng, mode: InputMode): number {
  if (mode === "legal") return previous + 1;
  const roll = rng.next();
  if (roll < 0.06) return previous; // duplicate
  if (roll < 0.12) return previous + rng.int(2, 5); // gap
  if (roll < 0.15) return Math.max(0, previous - rng.int(1, 3)); // regression
  return previous + 1;
}

// ---------------------------------------------------------------- cueEngine

export function generateCueRules(rng: SeededRng): CueRules {
  if (rng.chance(0.5)) return DEFAULT_CUE_RULES;
  const correctionSeverity = rng.fixed(0.2, 0.6, 2);
  return {
    correctionSeverity,
    stableSeverity: rng.fixed(0, correctionSeverity - 0.05, 2),
    improvementDelta: rng.int(1, 30),
    maxConsecutiveCorrections: rng.int(1, 4),
    stableCooldownReps: rng.int(1, 8),
    lowConfidenceGuidanceAfter: rng.int(1, 6),
    personalBestMinRep: rng.int(1, 6),
  };
}

export function generateCueSequence(spec: SequenceSpec): {
  rules: CueRules;
  reps: RepObservation[];
} {
  const rng = new SeededRng(spec.seed);
  const rules = generateCueRules(rng);
  const fixedFocus: CheckpointKey = rng.pick(CHECKPOINTS);
  const movingFocus = spec.mode !== "legal" && rng.chance(0.4);
  const reps: RepObservation[] = [];
  let repIndex = 0;
  for (let i = 0; i < spec.length; i += 1) {
    repIndex = nextRepIndex(repIndex, rng, spec.mode);
    const focusCheckpoint = movingFocus && rng.chance(0.3) ? rng.pick(CHECKPOINTS) : fixedFocus;
    const lowConfidence = rng.chance(0.2);
    if (lowConfidence) {
      reps.push({
        repIndex,
        resultKind: "low_confidence",
        overallScore: null,
        focusCheckpoint,
        focusScore: null,
        focusDirection: "none",
        focusSeverity: 0,
      });
      continue;
    }
    let overallScore: number | null = rng.fixed(0, 10, 1);
    let focusScore: number | null = rng.chance(0.1) ? null : rng.fixed(0, 100, 1);
    if (spec.mode === "near-legal") {
      if (rng.chance(0.05)) overallScore = null;
      else if (rng.chance(0.1)) overallScore = rng.pick([-0.1, 10.1, 6.85, 7.123456]);
      if (rng.chance(0.08)) focusScore = rng.pick([-3, 105, 63.4567]);
    }
    let focusSeverity = severityFor(focusScore, rng, spec.mode);
    if (spec.mode === "hostile") {
      overallScore = overallScore === null ? null : hostileOr(rng, overallScore);
      focusScore = focusScore === null ? null : hostileOr(rng, focusScore);
      focusSeverity = hostileOr(rng, focusSeverity);
    }
    reps.push({
      repIndex,
      resultKind: "scored",
      overallScore,
      focusCheckpoint,
      focusScore,
      focusDirection: directionFor(focusSeverity, rng),
      focusSeverity,
    });
  }
  return { rules, reps };
}

// -------------------------------------------------------------- liveSession

export function generateLiveRules(rng: SeededRng): LiveCueRules {
  if (rng.chance(0.5)) return DEFAULT_LIVE_CUE_RULES;
  return {
    correctionSeverity: rng.fixed(0.2, 0.6, 2),
    improvementDelta: rng.int(1, 30),
    personalBestMinRep: rng.int(1, 6),
    setupGuidanceAfter: rng.int(1, 6),
    announceScores: rng.chance(0.7),
  };
}

function generateCheckpoint(
  key: CheckpointKey,
  rng: SeededRng,
  mode: InputMode,
): LiveCheckpointObservation {
  const applicable = !rng.chance(0.1);
  if (!applicable && (mode === "legal" || rng.chance(0.6))) {
    return { key, score: null, direction: "none", severity: 0, applicable: false };
  }
  let score: number | null = rng.chance(0.1) ? null : rng.fixed(0, 100, 1);
  if (mode === "near-legal" && rng.chance(0.08)) score = rng.pick([-3, 105, 63.4567]);
  let severity = severityFor(score, rng, mode);
  if (mode === "hostile") {
    score = score === null ? null : hostileOr(rng, score);
    severity = hostileOr(rng, severity);
  }
  return { key, score, direction: directionFor(severity, rng), severity, applicable };
}

export function generateLiveSequence(spec: SequenceSpec): {
  rules: LiveCueRules;
  reps: LiveRepObservation[];
} {
  const rng = new SeededRng(spec.seed);
  const rules = generateLiveRules(rng);
  const reps: LiveRepObservation[] = [];
  let repIndex = 0;
  for (let i = 0; i < spec.length; i += 1) {
    repIndex = nextRepIndex(repIndex, rng, spec.mode);
    const roll = rng.next();
    if (roll < 0.25) {
      reps.push({
        repIndex,
        kind: roll < 0.15 ? "low_confidence" : "abstained",
        overallScore: null,
        checkpoints: [],
      });
      continue;
    }
    let overallScore: number | null = rng.fixed(0, 10, 1);
    if (spec.mode === "near-legal") {
      if (rng.chance(0.05)) overallScore = null;
      else if (rng.chance(0.1)) overallScore = rng.pick([-0.1, 10.1, 6.85, 7.123456]);
    }
    if (spec.mode === "hostile" && overallScore !== null) {
      overallScore = hostileOr(rng, overallScore);
    }
    let keys: CheckpointKey[] = rng.subset(CHECKPOINTS, rng.chance(0.3) ? 1 : 0.6);
    if (rng.chance(0.3)) keys = rng.shuffle(keys);
    if (spec.mode !== "legal" && rng.chance(0.1) && keys.length > 0) {
      keys = [...keys, rng.pick(keys)]; // duplicate key
    }
    reps.push({
      repIndex,
      kind: "scored",
      overallScore,
      checkpoints: keys.map((key) => generateCheckpoint(key, rng, spec.mode)),
    });
  }
  return { rules, reps };
}

// ------------------------------------------------------------- sessionEnd

export interface SessionEndInput {
  scoredCount: number;
  startAverage: number | null;
  endAverage: number | null;
  best: number | null;
}

export function generateSessionEndInput(seed: number, mode: InputMode): SessionEndInput {
  const rng = new SeededRng(seed);
  const scoredCount = rng.chance(0.1) ? 0 : rng.chance(0.15) ? 1 : rng.int(2, 60);
  const average = (): number | null => {
    if (rng.chance(0.1)) return null;
    // The consumer (apps/mobile/src/flow/sessionProgress.ts) rounds both
    // averages to one decimal before calling; near-legal feeds raw means.
    const value = mode === "legal" ? rng.fixed(0, 10, 1) : rng.fixed(-1, 11, rng.int(0, 6));
    return mode === "hostile" ? hostileOr(rng, value, 0.2) : value;
  };
  const best = rng.chance(0.1) ? null : rng.fixed(0, 10, 1);
  return {
    scoredCount,
    startAverage: scoredCount === 0 ? null : average(),
    endAverage: scoredCount === 0 ? null : average(),
    best: scoredCount === 0 ? null : best,
  };
}
