/**
 * Deterministic PRNG for the stress harnesses (mulberry32, 32-bit state).
 * Every draw is a pure function of the seed and the draw order, so a
 * sequence is replayable from its seed alone — never `Math.random`.
 */
export interface SeededRng {
  /** Uniform in [0, 1). */
  float(): number;
  /** Uniform integer in [lo, hi] (inclusive). */
  int(lo: number, hi: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Uniform element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** Lowercase hex string of `length` characters. */
  hex(length: number): string;
  /** Number of draws made so far (for trace bookkeeping). */
  readonly draws: number;
}

export function createSeededRng(seed: number): SeededRng {
  let state = seed >>> 0 || 0x9e3779b9;
  let draws = 0;
  const next = (): number => {
    draws += 1;
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: SeededRng = {
    float: next,
    int(lo, hi) {
      if (hi < lo) throw new Error(`int(${lo}, ${hi}): empty range`);
      return lo + Math.floor(next() * (hi - lo + 1));
    },
    chance(p) {
      return next() < p;
    },
    pick(items) {
      if (items.length === 0) throw new Error('pick: empty array');
      const item = items[Math.floor(next() * items.length)];
      return item as (typeof items)[number];
    },
    hex(length) {
      let out = '';
      while (out.length < length) {
        out += Math.floor(next() * 16).toString(16);
      }
      return out;
    },
    get draws() {
      return draws;
    },
  };
  return rng;
}

/** Derives a child seed from a parent seed and a lane index (splitmix-ish). */
export function deriveSeed(seed: number, lane: number): number {
  let x = (seed ^ Math.imul(lane + 1, 0x85ebca6b)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}
