/**
 * Deterministic PRNG for the outbox stress campaigns.
 *
 * Every iteration is a pure function of its 32-bit seed, so any row of the
 * emitted JSON table replays with `STRESS_REPLAY=<family>:<seed>`.
 */
export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
}

/** mulberry32 — same generator the lifecycle matrix uses. */
export function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) =>
    min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) throw new Error('pick() on an empty list');
    const item = items[Math.min(int(0, items.length - 1), items.length - 1)];
    return item as T;
  };
  return {
    next,
    int,
    pick,
    chance: p => next() < p,
  };
}

/** Derive the per-iteration seed from (campaign seed, family index, i). */
export function iterationSeed(
  baseSeed: number,
  familyIndex: number,
  iteration: number,
): number {
  let h = (baseSeed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (familyIndex + 0x7f4a7c15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13) ^ iteration, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Deterministic RFC-4122-shaped id (version nibble 4, variant 10xx). */
export function seededUuid(rng: Rng): string {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 32; i += 1) {
    if (i === 12) out += '4';
    else if (i === 16) out += hex[8 + rng.int(0, 3)];
    else out += hex[rng.int(0, 15)];
    if (i === 7 || i === 11 || i === 15 || i === 19) out += '-';
  }
  return out;
}
