/**
 * Deterministic PRNG for the tts stress harness. Every campaign iteration
 * derives its own seed from (campaignSeed, index) so any single row of the
 * results table can be replayed in isolation with `runIteration(seed)`.
 */

export interface Rng {
  readonly seed: number;
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  bool(probabilityTrue?: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** Weighted pick; weights need not sum to 1. */
  weighted<T>(items: readonly (readonly [T, number])[]): T;
}

/** mulberry32 — small, fast, well-distributed for test generation. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    seed: seed >>> 0,
    next,
    int(min, max) {
      if (max < min) throw new Error(`rng.int: max ${max} < min ${min}`);
      return min + Math.floor(next() * (max - min + 1));
    },
    bool(probabilityTrue = 0.5) {
      return next() < probabilityTrue;
    },
    pick(items) {
      if (items.length === 0) throw new Error('rng.pick: empty list');
      const item = items[Math.floor(next() * items.length)];
      return item as (typeof items)[number];
    },
    weighted(items) {
      let total = 0;
      for (const [, w] of items) total += w;
      let roll = next() * total;
      for (const [item, w] of items) {
        roll -= w;
        if (roll < 0) return item;
      }
      const last = items[items.length - 1];
      if (!last) throw new Error('rng.weighted: empty list');
      return last[0];
    },
  };
  return rng;
}

/**
 * Derive a per-iteration seed from a campaign seed and an index. Uses a
 * 32-bit mixing step so consecutive indices produce unrelated streams.
 */
export function deriveSeed(campaignSeed: number, index: number): number {
  let h = (campaignSeed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (index + 0x7f4a7c15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
}
