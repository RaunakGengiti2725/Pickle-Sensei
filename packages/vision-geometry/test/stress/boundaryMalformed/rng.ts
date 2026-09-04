/**
 * Seeded PRNG for the boundary/malformed-input stress campaign. mulberry32:
 * tiny, deterministic, and good enough to replay any iteration from its
 * (scenario, seed) pair byte for byte.
 */
export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [lo, hi] (inclusive). */
  int(lo: number, hi: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
  /** Fisher–Yates shuffle of a copy. */
  shuffle<T>(items: readonly T[]): T[];
}

export function rng(seed: number): Rng {
  let state = seed >>> 0 || 0x9e3779b9;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number): number => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) throw new Error("rng.pick on empty list");
    return items[int(0, items.length - 1)] as T;
  };
  return {
    next,
    int,
    pick,
    chance: (probability) => next() < probability,
    shuffle: (items) => {
      const copy = [...items];
      for (let index = copy.length - 1; index > 0; index -= 1) {
        const swap = int(0, index);
        const held = copy[index] as (typeof copy)[number];
        copy[index] = copy[swap] as (typeof copy)[number];
        copy[swap] = held;
      }
      return copy;
    },
  };
}

/** Independent sub-stream so scenario and seed never alias each other. */
export function scenarioSeed(scenarioId: string, seed: number): number {
  let hash = 0x811c9dc5;
  for (const char of scenarioId) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash ^ Math.imul(seed + 1, 0x9e3779b1)) >>> 0;
}
