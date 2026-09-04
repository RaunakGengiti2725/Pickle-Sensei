import { CHECKPOINTS, FAULT_DIRECTIONS } from "@pickle/shared-types";
import type {
  LiveCheckpointObservation,
  LiveRepObservation,
  RepObservation,
} from "../../src/index.js";

/**
 * Seeded synthetic rep streams for the stress harness. Every stream is a pure
 * function of its seed (mulberry32), so any failing iteration is replayable
 * from `{ seed, reps }` alone. Values stay inside the documented input domain
 * of the cue engines (0–10 overall, 0–100 checkpoint score, 0–1 severity,
 * canonical checkpoint keys and fault directions) — these are synthetic
 * inputs, never labels.
 */

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error("pick from empty list");
  return item;
}

function intInclusive(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** 0–10 with one decimal, like the scoring engine emits. */
function overallScore(rng: Rng): number {
  return Math.round(rng() * 100) / 10;
}

function liveCheckpoints(rng: Rng): LiveCheckpointObservation[] {
  const count = intInclusive(rng, 0, CHECKPOINTS.length);
  // Canonical order, no duplicate keys — mirrors CheckpointScore[] from scoring.
  const keys = [...CHECKPOINTS].filter(() => rng() < count / CHECKPOINTS.length);
  return keys.map((key) => {
    const severity = rng() < 0.2 ? 0 : Math.round(rng() * 1000) / 1000;
    return {
      key,
      score: rng() < 0.1 ? null : intInclusive(rng, 0, 100),
      direction: pick(rng, FAULT_DIRECTIONS),
      severity,
      applicable: rng() < 0.85,
    };
  });
}

export function liveRepStream(seed: number, reps: number): LiveRepObservation[] {
  const rng = mulberry32(seed);
  const out: LiveRepObservation[] = [];
  for (let repIndex = 1; repIndex <= reps; repIndex += 1) {
    const roll = rng();
    const kind: LiveRepObservation["kind"] =
      roll < 0.7 ? "scored" : roll < 0.85 ? "low_confidence" : "abstained";
    if (kind === "scored") {
      out.push({
        repIndex,
        kind,
        overallScore: overallScore(rng),
        checkpoints: liveCheckpoints(rng),
      });
    } else {
      out.push({ repIndex, kind, overallScore: null, checkpoints: [] });
    }
  }
  return out;
}

export function sparseRepStream(seed: number, reps: number): RepObservation[] {
  const rng = mulberry32(seed ^ 0x5bd1e995);
  const out: RepObservation[] = [];
  for (let repIndex = 1; repIndex <= reps; repIndex += 1) {
    const lowConfidence = rng() < 0.2;
    out.push({
      repIndex,
      resultKind: lowConfidence ? "low_confidence" : "scored",
      overallScore: lowConfidence ? null : overallScore(rng),
      focusCheckpoint: pick(rng, CHECKPOINTS),
      focusScore: lowConfidence || rng() < 0.1 ? null : intInclusive(rng, 0, 100),
      focusDirection: pick(rng, FAULT_DIRECTIONS),
      focusSeverity: rng() < 0.2 ? 0 : Math.round(rng() * 1000) / 1000,
    });
  }
  return out;
}

export interface SessionEndInput {
  scoredCount: number;
  startAverage: number | null;
  endAverage: number | null;
  best: number | null;
}

export function sessionEndInput(seed: number, reps: number): SessionEndInput {
  const rng = mulberry32(seed ^ 0x27d4eb2f);
  const scoredCount = intInclusive(rng, 0, reps);
  const maybe = (): number | null => (rng() < 0.2 ? null : overallScore(rng));
  return { scoredCount, startAverage: maybe(), endAverage: maybe(), best: maybe() };
}
