/**
 * Seeded PRNG for the randomized stress lens. mulberry32: 32-bit state, fast,
 * and fully reproducible from an integer seed — every generated sequence is
 * replayable from `(seed)` alone.
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

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick from empty list");
    const item = items[Math.floor(this.next() * items.length)];
    if (item === undefined) throw new Error("pick produced undefined");
    return item;
  }

  weighted<T>(entries: ReadonlyArray<readonly [T, number]>): T {
    let total = 0;
    for (const [, w] of entries) total += w;
    let x = this.next() * total;
    for (const [value, w] of entries) {
      x -= w;
      if (x < 0) return value;
    }
    const last = entries[entries.length - 1];
    if (!last) throw new Error("weighted from empty list");
    return last[0];
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const a = out[i];
      const b = out[j];
      if (a === undefined || b === undefined) continue;
      out[i] = b;
      out[j] = a;
    }
    return out;
  }

  /** Lowercase [a-z0-9_] identifier fragment. */
  slug(minLen: number, maxLen: number): string {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789_";
    const len = this.int(minLen, maxLen);
    let s = "";
    for (let i = 0; i < len; i++) s += alphabet[Math.floor(this.next() * alphabet.length)];
    return s;
  }
}

/** Derive a child seed so sub-generators do not share a stream. */
export function deriveSeed(seed: number, salt: number): number {
  let h = (seed ^ Math.imul(salt + 1, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
