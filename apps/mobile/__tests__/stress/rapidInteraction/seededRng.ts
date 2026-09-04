/**
 * Deterministic PRNG for the stress campaigns: every iteration is a pure
 * function of its seed, so a failing seed replays byte-for-byte with
 * `STRESS_SEED=<n>`. mulberry32 — small, well distributed, dependency-free.
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

  /** Uniform integer in [min, max] (both inclusive). */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  bool(probabilityTrue = 0.5): boolean {
    return this.next() < probabilityTrue;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick() from an empty list');
    return items[this.int(0, items.length - 1)] as T;
  }

  /** Weighted choice: `[value, weight]` pairs, weights need not sum to 1. */
  weighted<T>(entries: ReadonlyArray<readonly [T, number]>): T {
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = this.next() * total;
    for (const [value, weight] of entries) {
      roll -= weight;
      if (roll < 0) return value;
    }
    return entries[entries.length - 1]![0];
  }

  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
    }
    return copy;
  }
}

/**
 * Campaign controls. Defaults are sized for the regular suite; the campaign
 * run overrides them (`STRESS_ITER=300 STRESS_OUT=artifacts/stress/x.json`).
 */
export function campaignSeeds(): number[] {
  const repeat = Math.max(
    1,
    Number.parseInt(process.env.STRESS_REPEAT ?? '1', 10) || 1,
  );
  const single = process.env.STRESS_SEED;
  let base: number[];
  if (single !== undefined && single !== '') {
    base = single
      .split(',')
      .map(part => Number.parseInt(part.trim(), 10))
      .filter(seed => Number.isFinite(seed));
  } else {
    const iterations = Number.parseInt(process.env.STRESS_ITER ?? '12', 10);
    const start = Number.parseInt(process.env.STRESS_SEED_BASE ?? '1', 10);
    base = Array.from({ length: iterations }, (_, i) => start + i);
  }
  const seeds: number[] = [];
  for (let r = 0; r < repeat; r += 1) seeds.push(...base);
  return seeds;
}
