/**
 * Deterministic PRNG for the stress harness. Every scenario is fully
 * replayable from its 32-bit seed: `seededRng(seed)` yields the same
 * sequence on every platform (mulberry32 — integer arithmetic only, no
 * Math.random, no Date).
 */
export interface SeededRng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  /** Uniform float in [min, max). */
  float(min: number, max: number): number;
  /** One element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** Bernoulli trial. */
  chance(probability: number): boolean;
}

export function seededRng(seed: number): SeededRng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    float(min, max) {
      return min + next() * (max - min);
    },
    pick(items) {
      const index = Math.floor(next() * items.length);
      const item = items[index];
      if (item === undefined) throw new Error("pick() on empty array");
      return item;
    },
    chance(probability) {
      return next() < probability;
    },
  };
}

/** Per-iteration seed derived from a campaign seed (splitmix-style hash). */
export function iterationSeed(campaignSeed: number, iteration: number): number {
  let z = (campaignSeed + Math.imul(iteration + 1, 0x9e3779b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}
