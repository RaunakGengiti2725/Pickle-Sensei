/**
 * Deterministic 32-bit PRNG (mulberry32) for replayable stress campaigns.
 * Every iteration derives its own generator from `(campaignSeed, index)` so a
 * single failing iteration can be replayed from its seed alone.
 */
export class Prng {
  private state: number;

  public constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  public next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [0, n). */
  public int(n: number): number {
    return Math.floor(this.next() * n);
  }

  public bool(p = 0.5): boolean {
    return this.next() < p;
  }

  public pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick from empty list");
    return items[this.int(items.length)] as T;
  }

  /** Random subset (possibly empty) preserving order. */
  public subset<T>(items: readonly T[], p = 0.5): T[] {
    return items.filter(() => this.bool(p));
  }
}

/** Stable per-iteration seed: campaign seed mixed with the iteration index. */
export function iterationSeed(campaignSeed: number, index: number): number {
  let h = (campaignSeed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ index, 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
