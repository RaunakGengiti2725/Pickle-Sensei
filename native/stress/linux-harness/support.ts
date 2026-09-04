import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Linux-plane stress support for the native swing-lab / camera-engine unit.
 *
 * Same SplitMix64 stream as native/stress/vision-stress-xctest StressSupport
 * (same base seed → same per-iteration seeds), so a seed reported here can be
 * replayed here or on the Apple plane with `STRESS_SEED=<seed>` (exactly that
 * one iteration). `STRESS_BASE_SEED` re-bases the derived sequence instead.
 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const MASK64 = (1n << 64n) - 1n;

export class SeededRng {
  private state: bigint;

  constructor(seed: bigint) {
    this.state = BigInt.asUintN(64, seed);
  }

  next(): bigint {
    this.state = (this.state + 0x9e3779b97f4a7c15n) & MASK64;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    return z ^ (z >> 31n);
  }

  /** Uniform in [0, 1). */
  double(): number {
    return Number(this.next() >> 11n) / 2 ** 53;
  }

  doubleIn(lo: number, hi: number): number {
    return lo + (hi - lo) * this.double();
  }

  int(lo: number, hi: number): number {
    return lo + Math.floor(this.double() * (hi - lo + 1));
  }

  bool(probability = 0.5): boolean {
    return this.double() < probability;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error("pick from empty list");
    return item;
  }
}

const DEFAULT_ITERATIONS = 3;
const DEFAULT_BASE_SEED = 0x5eed_0000_0001n;

function iterations(): number {
  const raw = process.env.STRESS_ITER;
  const value = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_ITERATIONS;
}

function baseSeed(): bigint {
  const raw = process.env.STRESS_BASE_SEED;
  if (!raw) return DEFAULT_BASE_SEED;
  try {
    return BigInt(raw);
  } catch {
    return DEFAULT_BASE_SEED;
  }
}

function replaySeed(): bigint | null {
  const raw = process.env.STRESS_SEED;
  if (!raw) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

export const campaign = {
  defaultIterations: DEFAULT_ITERATIONS,
  defaultBaseSeed: DEFAULT_BASE_SEED,
  get iterations(): number {
    return iterations();
  },
  get baseSeed(): bigint {
    return baseSeed();
  },
  /** Deterministic per-iteration seeds (odd, so a seed is never 0). */
  seeds(count: number = iterations()): bigint[] {
    const replay = replaySeed();
    if (replay !== null) return [replay];
    const rng = new SeededRng(baseSeed());
    return Array.from({ length: count }, () => rng.next() | 1n);
  },
};

export type Outcome = "HELD" | "BROKEN" | "SKIPPED";

export interface ResultRow {
  suite: string;
  test: string;
  seed: string;
  outcome: Outcome;
  detail: string;
}

/** Seed → outcome table, flushed to JSON so every row is replayable. */
export class ResultTable {
  private readonly rows: ResultRow[] = [];

  constructor(private readonly suite: string) {}

  record(test: string, seed: bigint | string, outcome: Outcome, detail = ""): void {
    this.rows.push({ suite: this.suite, test, seed: seed.toString(), outcome, detail });
  }

  get brokenCount(): number {
    return this.rows.filter((row) => row.outcome === "BROKEN").length;
  }

  get executedCount(): number {
    return this.rows.filter((row) => row.outcome !== "SKIPPED").length;
  }

  flush(): string {
    const dir =
      process.env.STRESS_RESULTS_DIR ?? join(REPO_ROOT, "artifacts", "stress", "linux-harness");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${this.suite}.json`);
    const summary = {
      suite: this.suite,
      plane: "linux",
      baseSeed: campaign.baseSeed.toString(),
      iterations: campaign.iterations,
      executed: this.executedCount,
      held: this.rows.filter((row) => row.outcome === "HELD").length,
      broken: this.brokenCount,
      skipped: this.rows.filter((row) => row.outcome === "SKIPPED").length,
      rows: this.rows,
    };
    writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`);
    return path;
  }
}
