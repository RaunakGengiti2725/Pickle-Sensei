/**
 * Seeded RNG for the StreakCalendarScreen stress campaign. mulberry32: tiny,
 * deterministic, replayable from a 32-bit seed. Every variant the campaign
 * renders is a pure function of its seed, so a failing row is replayed with
 * `STRESS_SEED=<seed>`.
 */
export class SeededRng {
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

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Integer in [lo, hi] inclusive. */
  range(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty list');
    return items[this.int(items.length)] as T;
  }

  /** k distinct picks (k clamped to items.length), order seeded. */
  sample<T>(items: readonly T[], k: number): T[] {
    const pool = [...items];
    const out: T[] = [];
    while (out.length < k && pool.length > 0) {
      out.push(pool.splice(this.int(pool.length), 1)[0] as T);
    }
    return out;
  }
}

/** Seeds for iteration i of a campaign rooted at `base` (stable, replayable). */
export function campaignSeed(base: number, iteration: number): number {
  return Math.imul(base ^ (iteration * 0x9e3779b1), 0x85ebca6b) >>> 0 || 1;
}
