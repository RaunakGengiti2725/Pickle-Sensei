/**
 * Deterministic PRNG for the visibility matrix (mulberry32). Every scenario
 * case is fully replayable from (scenarioId, seed): the same seed always
 * produces the same synthesized keypoint stream.
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

  /** Uniform in [lower, upper). */
  public uniform(lower: number, upper: number): number {
    return lower + (upper - lower) * this.next();
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

  /** Standard normal via Box–Muller. */
  public gaussian(): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

/** Stable 32-bit hash so scenario ids and seeds combine into one stream. */
export function hashSeed(scenarioId: string, seed: number): number {
  let h = 2166136261 ^ seed;
  for (let index = 0; index < scenarioId.length; index += 1) {
    h ^= scenarioId.charCodeAt(index);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
