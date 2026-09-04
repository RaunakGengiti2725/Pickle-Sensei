/**
 * Seeded, dependency-free PRNG for the xc-matrix-media-1 harness.
 *
 * SplitMix32-style mixing over a 32-bit state: every cell of the matrix
 * derives its own stream from (masterSeed, cellIndex) so any single cell can
 * be replayed in isolation without regenerating the cells before it.
 */
export class SeededRng {
  private state: number;

  public constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  public next(): number {
    this.state = (this.state + 0x9e3779b9) >>> 0;
    let z = this.state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    z = (z ^ (z >>> 16)) >>> 0;
    return z / 4294967296;
  }

  /** Uniform float in [min, max). */
  public uniform(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Integer in [min, max] inclusive. */
  public int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Standard normal via Box–Muller (two uniforms per draw; no caching). */
  public gaussian(): number {
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

/** Deterministic 32-bit hash of a string (FNV-1a) for deriving cell seeds. */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function deriveSeed(masterSeed: number, cellId: string): number {
  return (hash32(`${masterSeed}:${cellId}`) ^ (masterSeed >>> 0)) >>> 0;
}
