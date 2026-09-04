/**
 * Deterministic PRNG (mulberry32) for the boundary/malformed stress campaign.
 * Every iteration is replayable from its 32-bit seed: the same seed always
 * produces the same generated input and therefore the same outcome.
 */
export class SeededRng {
  private state: number;

  public constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
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

  public chance(probability: number): boolean {
    return this.next() < probability;
  }

  public pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error("pick() on an empty list");
    return item;
  }
}

/** Stable 32-bit FNV-1a style hash so campaign ids and seeds combine into one stream. */
export function hashSeed(label: string, seed: number): number {
  let h = 2166136261 ^ seed;
  for (let index = 0; index < label.length; index += 1) {
    h ^= label.charCodeAt(index);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
