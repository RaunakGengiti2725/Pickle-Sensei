/**
 * Seeded PRNG for the boundary/malformed stress campaigns.
 *
 * Every campaign iteration derives its own 32-bit seed from the campaign
 * seed + iteration index (`iterationSeed`), so any single failing input can
 * be regenerated with `STRESS_SEED=<campaign> STRESS_ONLY=<iteration seed>`
 * without replaying the whole run. SplitMix32-style mixing; no Math.random.
 */

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform 32-bit unsigned integer. */
  next(): number {
    // mulberry32
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Uniform float in [0, 1). */
  float(): number {
    return this.next() / 4294967296;
  }

  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number {
    if (max < min) throw new Error(`Rng.int: max < min (${min}, ${max})`);
    const span = max - min + 1;
    return min + Math.floor(this.float() * span);
  }

  bool(probabilityTrue = 0.5): boolean {
    return this.float() < probabilityTrue;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("Rng.pick: empty list");
    return items[this.int(0, items.length - 1)] as T;
  }

  /** Fisher-Yates shuffle into a NEW array. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      const tmp = out[i] as T;
      out[i] = out[j] as T;
      out[j] = tmp;
    }
    return out;
  }
}

/** Deterministic per-iteration seed derived from the campaign seed. */
export function iterationSeed(campaignSeed: number, iteration: number): number {
  let h = (campaignSeed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (iteration + 0x7f4a7c15), 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

export interface CampaignConfig {
  /** Campaign seed (STRESS_SEED, default 20260904). */
  seed: number;
  /** Iterations per campaign (STRESS_ITER, default small so the suite stays fast). */
  iterations: number;
  /** When set (STRESS_ONLY), run only the iteration whose derived seed matches. */
  only: number | null;
  /** Directory for the seed → outcome JSON tables (STRESS_OUT); null = do not write. */
  outDir: string | null;
}

function envInt(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export function campaignConfig(defaultIterations = 40): CampaignConfig {
  const outDir = process.env["STRESS_OUT"];
  return {
    seed: envInt("STRESS_SEED") ?? 20260904,
    iterations: envInt("STRESS_ITER") ?? defaultIterations,
    only: envInt("STRESS_ONLY"),
    outDir: outDir === undefined || outDir.trim() === "" ? null : outDir,
  };
}
