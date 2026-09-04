/**
 * Deterministic PRNG for the stress harness (mulberry32). Every variant is a
 * pure function of its seed, so any row of the results table can be replayed
 * with `STRESS_SEED=<seed>`.
 */
export class SeededRng {
  private state: number;

  constructor(public readonly seed: number) {
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

  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error('SeededRng.pick: empty list');
    }
    return items[this.int(0, items.length - 1)] as T;
  }
}

/** Splits one campaign seed into per-iteration seeds (stable across runs). */
export function iterationSeed(campaignSeed: number, iteration: number): number {
  const rng = new SeededRng(
    (campaignSeed ^ Math.imul(iteration + 1, 0x9e3779b1)) >>> 0,
  );
  return Math.floor(rng.next() * 0x7fffffff);
}
