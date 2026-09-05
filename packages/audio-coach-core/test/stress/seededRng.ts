/**
 * Tiny seeded PRNG (mulberry32) so every stress sequence is replayable from
 * its 32-bit seed. No dependency on fast-check — the workspace does not ship it.
 */
export class SeededRng {
  private a: number;

  constructor(public readonly seed: number) {
    this.a = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.a = (this.a + 0x6d2b79f5) >>> 0;
    let t = this.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Float in [min, max). */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Float rounded to `decimals` places. */
  fixed(min: number, max: number, decimals: number): number {
    const factor = 10 ** decimals;
    return Math.round(this.float(min, max) * factor) / factor;
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error("pick() on empty array");
    return item;
  }

  /** Random subset (order preserved), each element kept with probability p. */
  subset<T>(items: readonly T[], p: number): T[] {
    return items.filter(() => this.chance(p));
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      const a = out[i];
      const b = out[j];
      if (a !== undefined && b !== undefined) {
        out[i] = b;
        out[j] = a;
      }
    }
    return out;
  }
}

/** Derive the per-sequence seed from a campaign base seed and an index. */
export function sequenceSeed(baseSeed: number, index: number): number {
  // splitmix-style scramble so neighbouring indices are uncorrelated.
  let z = (baseSeed + index * 0x9e3779b9) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}
