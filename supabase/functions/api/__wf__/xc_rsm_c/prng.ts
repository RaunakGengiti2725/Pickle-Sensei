// Deterministic PRNG for the randomized state-machine campaign. sfc32 seeded
// through splitmix32 so neighbouring seeds (3000, 3001, …) produce unrelated
// streams. Every random decision in a run goes through ONE instance so a seed
// replays the exact same request sequence.

export class Prng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  /** Number of draws so far — recorded with failures for replay diagnostics. */
  draws = 0;

  constructor(readonly seed: number) {
    let s = seed >>> 0;
    const mix = (): number => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.a = mix();
    this.b = mix();
    this.c = mix();
    this.d = mix();
    for (let i = 0; i < 12; i += 1) this.nextUint32();
  }

  nextUint32(): number {
    this.draws += 1;
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    if (n <= 0) throw new Error(`Prng.int(${n})`);
    return Math.floor(this.next() * n);
  }

  /** Uniform integer in [lo, hi] inclusive. */
  range(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("Prng.pick([])");
    return items[this.int(items.length)];
  }

  /** Pick a key by relative weight (weights need not sum to 1). */
  weighted<T extends string>(weights: Partial<Record<T, number>>): T {
    const entries = Object.entries(weights) as Array<[T, number]>;
    let total = 0;
    for (const [, w] of entries) total += Math.max(0, w);
    if (total <= 0) throw new Error("Prng.weighted: no positive weight");
    let roll = this.next() * total;
    for (const [key, w] of entries) {
      roll -= Math.max(0, w);
      if (roll < 0) return key;
    }
    return entries[entries.length - 1][0];
  }

  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = this.int(i + 1);
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }
}
