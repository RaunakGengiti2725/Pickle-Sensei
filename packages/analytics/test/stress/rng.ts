/**
 * Seeded PRNG for the randomized stress campaigns (mulberry32). Every
 * sequence is derived from one 32-bit seed so any failure replays exactly.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
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
    if (items.length === 0) throw new Error("rng.pick: empty list");
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error("rng.pick: hole");
    return item;
  }

  /** Weighted pick; weights need not sum to 1. */
  weighted<T>(entries: readonly (readonly [weight: number, value: T])[]): T {
    const total = entries.reduce((sum, [w]) => sum + w, 0);
    let roll = this.next() * total;
    for (const [w, value] of entries) {
      roll -= w;
      if (roll < 0) return value;
    }
    const last = entries[entries.length - 1];
    if (!last) throw new Error("rng.weighted: empty list");
    return last[1];
  }

  /** Lower-case alphanumeric token of the given length. */
  token(length: number): string {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    let out = "";
    for (let i = 0; i < length; i++) out += alphabet[this.int(0, alphabet.length - 1)];
    return out;
  }

  /** A random-looking base64 run (standard alphabet, no padding). */
  base64Run(length: number): string {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let out = "";
    for (let i = 0; i < length; i++) out += alphabet[this.int(0, alphabet.length - 1)];
    return out;
  }
}

/** Derive the per-sequence seed from the campaign base seed and the index. */
export function sequenceSeed(baseSeed: number, index: number): number {
  // Knuth multiplicative hash keeps neighbouring indices far apart.
  return (Math.imul(baseSeed ^ 0x9e3779b9, 0x85ebca6b) + Math.imul(index + 1, 0x27d4eb2f)) >>> 0;
}
