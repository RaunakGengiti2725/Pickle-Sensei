/**
 * Seeded PRNG for the boundary/malformed-input stress campaign. Every
 * iteration derives its whole payload from one 32-bit seed, so any record in
 * the result table is replayable with `tsx test/stress/replay.ts <seed>`.
 *
 * sfc32 (Chris Doty-Humphrey's Small Fast Counter) seeded through splitmix32
 * so consecutive seeds do not produce correlated streams.
 */
export class Prng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    let s = seed >>> 0;
    const next = (): number => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = next();
    for (let i = 0; i < 12; i += 1) this.nextUint32();
  }

  nextUint32(): number {
    this.a >>>= 0;
    this.b >>>= 0;
    this.c >>>= 0;
    this.d >>>= 0;
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Uniform float in [0, 1). */
  float(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number {
    if (max < min) throw new Error(`int(): max ${max} < min ${min}`);
    return min + Math.floor(this.float() * (max - min + 1));
  }

  bool(probabilityTrue = 0.5): boolean {
    return this.float() < probabilityTrue;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick(): empty list");
    return items[this.int(0, items.length - 1)]!;
  }

  /** Pick by relative weight; `weights[i]` pairs with `items[i]`. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    if (items.length !== weights.length || items.length === 0) {
      throw new Error("weighted(): items/weights mismatch");
    }
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let roll = this.float() * total;
    for (let index = 0; index < items.length; index += 1) {
      roll -= weights[index]!;
      if (roll < 0) return items[index]!;
    }
    return items[items.length - 1]!;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let index = out.length - 1; index > 0; index -= 1) {
      const swap = this.int(0, index);
      const tmp = out[index]!;
      out[index] = out[swap]!;
      out[swap] = tmp;
    }
    return out;
  }
}
