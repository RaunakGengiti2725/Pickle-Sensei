/**
 * Deterministic PRNG for the stress harness. Every iteration of every
 * scenario derives its own 32-bit seed from (campaign seed, iteration) so a
 * single failing row of the results table can be replayed in isolation.
 *
 * mulberry32 core + a splitmix-style mixer for seed derivation. Not
 * cryptographic; only reproducibility matters here.
 */

export class SeededRng {
  private state: number;

  constructor(readonly seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [lo, hi] (inclusive). */
  int(lo: number, hi: number): number {
    if (hi < lo) throw new Error(`SeededRng.int: hi < lo (${lo}, ${hi})`);
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  /** Uniform float in [lo, hi). */
  float(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("SeededRng.pick: empty list");
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error("SeededRng.pick: undefined item");
    return item;
  }

  /** Fresh 32-bit seed derived from this stream (for sub-generators). */
  fork(): number {
    return Math.floor(this.next() * 4294967296) >>> 0;
  }
}

/** Stable per-iteration seed: mixes campaign seed and iteration index. */
export function iterationSeed(campaignSeed: number, iteration: number): number {
  let h = (campaignSeed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (iteration + 0x7f4a7c15), 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}
