import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Seeded randomized long-run harness shared by the model-registry stress
 * suites (test/stress/*.stress.test.ts).
 *
 * Every sequence is fully determined by (baseSeed, index): the generator
 * derives a per-sequence seed, builds an action list from it, and the
 * executor replays that list against the real API while model-checking the
 * documented invariants after every step. Failing sequences are shrunk by
 * greedy step removal so the recorded repro is the smallest action list that
 * still violates the invariant.
 *
 * Campaign scale is controlled by the environment (small defaults so the
 * suite stays fast in CI):
 *   STRESS_ITER  sequences per suite            (default 150)
 *   STRESS_SEED  base seed                      (default 20260904)
 *   STRESS_MIN   minimum sequence length         (default 5)
 *   STRESS_MAX   maximum sequence length         (default 60)
 *   STRESS_OUT   directory for the JSON seed→outcome tables (unset = no file)
 *   STRESS_REPLAY  a per-sequence seed from a table row; runs ONLY that
 *                  sequence (iterations forced to 1) so any row is replayable
 */

export interface StressConfig {
  iterations: number;
  baseSeed: number;
  minLength: number;
  maxLength: number;
  outDir: string | null;
  /** When set, the single per-sequence seed to replay instead of deriving seeds from baseSeed. */
  replaySeed: number | null;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return parsed;
}

export function stressConfig(): StressConfig {
  const outDir = process.env["STRESS_OUT"];
  const replay = process.env["STRESS_REPLAY"];
  const replaySeed = replay === undefined || replay === "" ? null : envInt("STRESS_REPLAY", 0);
  const config: StressConfig = {
    iterations: replaySeed === null ? envInt("STRESS_ITER", 150) : 1,
    baseSeed: envInt("STRESS_SEED", 20260904),
    minLength: envInt("STRESS_MIN", 5),
    maxLength: envInt("STRESS_MAX", 60),
    outDir: outDir === undefined || outDir === "" ? null : outDir,
    replaySeed,
  };
  if (config.minLength < 1 || config.maxLength < config.minLength) {
    throw new Error(`invalid STRESS_MIN/STRESS_MAX: ${config.minLength}/${config.maxLength}`);
  }
  return config;
}

/** mulberry32 — small, fast, well-distributed 32-bit PRNG; identical output per seed on every engine. */
export class Rng {
  private state: number;

  public constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  public next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  public int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  public chance(p: number): boolean {
    return this.next() < p;
  }

  public pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick from empty list");
    return items[this.int(0, items.length - 1)] as T;
  }

  /** Random subset (possibly empty) preserving source order. */
  public subset<T>(items: readonly T[], keepProbability = 0.5): T[] {
    return items.filter(() => this.chance(keepProbability));
  }

  /** Non-empty random subset preserving source order. */
  public nonEmptySubset<T>(items: readonly T[], keepProbability = 0.5): T[] {
    const picked = this.subset(items, keepProbability);
    return picked.length === 0 ? [this.pick(items)] : picked;
  }
}

/** Derives the per-sequence seed from the campaign base seed and the sequence index. */
export function sequenceSeed(baseSeed: number, index: number): number {
  // splitmix-style hash so neighbouring indices do not produce correlated streams.
  let h = (baseSeed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export interface StepFailure {
  step: number;
  invariant: string;
  detail: string;
}

export interface SequenceRun<A> {
  seed: number;
  actions: A[];
  /** One canonical line per executed step; identical across replays of the same seed. */
  trace: string[];
  failure: StepFailure | null;
}

export interface SequenceRow {
  index: number;
  seed: number;
  length: number;
  outcome: "held" | "broken";
  deterministic: boolean;
  failure: StepFailure | null;
  /** Present only for broken sequences: the shrunk action list that still fails. */
  minimized: { length: number; actions: unknown[]; failure: StepFailure } | null;
}

export interface SuiteTable {
  suite: string;
  commit: string | null;
  config: StressConfig;
  sequences: number;
  stepsExecuted: number;
  held: number;
  broken: number;
  nondeterministic: number;
  /** Count of executed steps by canonical outcome (first two trace tokens) — shows which legal/near-legal paths ran. */
  outcomeHistogram: Record<string, number>;
  /** Broken sequences grouped by violated invariant. */
  failuresByInvariant: Record<string, number>;
  rows: SequenceRow[];
}

export interface SuiteDefinition<A> {
  suite: string;
  generate: (rng: Rng, length: number) => A[];
  /** Replays an action list from a clean state; must be pure given the actions. */
  execute: (actions: A[], seed: number) => SequenceRun<A>;
}

function traceKey<A>(run: SequenceRun<A>): string {
  return JSON.stringify({ trace: run.trace, failure: run.failure });
}

/**
 * Greedy step-removal shrinker: repeatedly drops single actions while the
 * run still fails on the SAME invariant. Bounded by O(n²) executions, which
 * is cheap for these in-memory APIs.
 */
export function shrink<A>(
  definition: SuiteDefinition<A>,
  seed: number,
  actions: A[],
  invariant: string,
): SequenceRun<A> {
  let current = actions;
  let currentRun = definition.execute(current, seed);
  let progressed = true;
  while (progressed && current.length > 1) {
    progressed = false;
    for (let i = 0; i < current.length; i += 1) {
      const candidate = [...current.slice(0, i), ...current.slice(i + 1)];
      const run = definition.execute(candidate, seed);
      if (run.failure !== null && run.failure.invariant === invariant) {
        current = candidate;
        currentRun = run;
        progressed = true;
        break;
      }
    }
  }
  return currentRun;
}

/** Runs the whole campaign for one suite: generate → execute twice (determinism) → shrink failures. */
export function runCampaign<A>(definition: SuiteDefinition<A>, config: StressConfig): SuiteTable {
  const rows: SequenceRow[] = [];
  const outcomeHistogram: Record<string, number> = {};
  let stepsExecuted = 0;
  for (let index = 0; index < config.iterations; index += 1) {
    const seed = config.replaySeed ?? sequenceSeed(config.baseSeed, index);
    const rng = new Rng(seed);
    const length = rng.int(config.minLength, config.maxLength);
    const actions = definition.generate(rng, length);
    const first = definition.execute(actions, seed);
    const second = definition.execute(actions, seed);
    const deterministic = traceKey(first) === traceKey(second);
    stepsExecuted += first.trace.length;
    for (const line of first.trace) {
      const tokens = line.split(" ");
      const key = tokens.slice(0, tokens[1] === "rejected" ? 3 : 2).join(" ");
      outcomeHistogram[key] = (outcomeHistogram[key] ?? 0) + 1;
    }
    let minimized: SequenceRow["minimized"] = null;
    if (first.failure !== null) {
      const shrunk = shrink(definition, seed, actions, first.failure.invariant);
      minimized = {
        length: shrunk.actions.length,
        actions: shrunk.actions,
        failure: shrunk.failure ?? first.failure,
      };
    }
    rows.push({
      index,
      seed,
      length: actions.length,
      outcome: first.failure === null && deterministic ? "held" : "broken",
      deterministic,
      failure: first.failure,
      minimized,
    });
  }
  return {
    suite: definition.suite,
    commit: process.env["STRESS_COMMIT"] ?? null,
    config,
    sequences: rows.length,
    stepsExecuted,
    held: rows.filter((row) => row.outcome === "held").length,
    broken: rows.filter((row) => row.outcome === "broken").length,
    nondeterministic: rows.filter((row) => !row.deterministic).length,
    outcomeHistogram: sortedRecord(outcomeHistogram),
    failuresByInvariant: sortedRecord(
      rows.reduce<Record<string, number>>((acc, row) => {
        if (row.outcome !== "broken") return acc;
        const name = row.deterministic ? (row.failure?.invariant ?? "?") : "NONDETERMINISTIC";
        acc[name] = (acc[name] ?? 0) + 1;
        return acc;
      }, {}),
    ),
    rows,
  };
}

function sortedRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** Writes the seed→outcome table when STRESS_OUT is set; returns the path or null. */
export function writeTable(table: SuiteTable): string | null {
  if (table.config.outDir === null) return null;
  mkdirSync(table.config.outDir, { recursive: true });
  const path = join(table.config.outDir, `${table.suite}.json`);
  writeFileSync(path, `${JSON.stringify(table, null, 2)}\n`);
  return path;
}

/** Human-readable list of broken seeds for assertion messages. */
export function describeBroken(table: SuiteTable): string {
  return table.rows
    .filter((row) => row.outcome === "broken")
    .map(
      (row) =>
        `seed=${row.seed} idx=${row.index}${row.deterministic ? "" : " NONDETERMINISTIC"} ` +
        `${row.failure?.invariant ?? "?"} @step${row.failure?.step ?? "?"}: ${row.failure?.detail ?? ""}`,
    )
    .join("\n");
}

/** True when any number reachable from `value` is NaN or ±Infinity. */
export function containsNonFinite(value: unknown): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(containsNonFinite);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(containsNonFinite);
  }
  return false;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error);
}
