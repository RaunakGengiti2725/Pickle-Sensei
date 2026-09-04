import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Seeded randomized long-run stress kit (lens `randomized-seeded`).
 *
 * Every sequence is replayable from its seed: actions are generated up front
 * from a deterministic PRNG, then executed against a fresh system-under-test
 * with invariants model-checked after every step. The same seed is executed
 * twice and the two traces must be byte-identical. Failing sequences are
 * minimized with ddmin over the action list and re-run to measure flakiness.
 *
 * Environment:
 *   STRESS_ITER  sequences per campaign (default per test file, small)
 *   STRESS_SEED  base seed (default 20260904)
 *   STRESS_OUT   directory receiving `<campaign>.json` seed→outcome tables
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, n). */
  int(n: number): number;
  /** Uniform integer in [lo, hi]. */
  range(lo: number, hi: number): number;
  bool(probability?: number): boolean;
  pick<T>(items: readonly T[]): T;
  float(lo: number, hi: number): number;
}

/** mulberry32 — small, fast, deterministic; state is a single uint32. */
export function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number): number => {
    if (!Number.isInteger(n) || n <= 0) throw new Error(`rng.int: n must be a positive integer`);
    return Math.floor(next() * n);
  };
  return {
    next,
    int,
    range: (lo, hi) => lo + int(hi - lo + 1),
    bool: (probability = 0.5) => next() < probability,
    pick: (items) => {
      if (items.length === 0) throw new Error("rng.pick: empty list");
      return items[int(items.length)] as (typeof items)[number];
    },
    float: (lo, hi) => lo + next() * (hi - lo),
  };
}

/** Derive the per-sequence seed from a base seed and index (splitmix-style hash). */
export function seedFor(baseSeed: number, index: number): number {
  let z = (baseSeed + Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}

export interface StressEnv {
  iterations: number;
  baseSeed: number;
  outDir: string | null;
}

export function readStressEnv(defaultIterations: number): StressEnv {
  const iterRaw = process.env.STRESS_ITER;
  const seedRaw = process.env.STRESS_SEED;
  const iterations = iterRaw === undefined ? defaultIterations : Number(iterRaw);
  const baseSeed = seedRaw === undefined ? 20260904 : Number(seedRaw);
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error(`STRESS_ITER must be a positive integer, got ${String(iterRaw)}`);
  }
  if (!Number.isInteger(baseSeed) || baseSeed < 0) {
    throw new Error(`STRESS_SEED must be a non-negative integer, got ${String(seedRaw)}`);
  }
  return { iterations, baseSeed, outDir: process.env.STRESS_OUT ?? null };
}

/** Thrown by executors when a model-checked invariant does not hold. */
export class InvariantViolation extends Error {
  constructor(
    readonly invariant: string,
    detail: string,
  ) {
    super(`${invariant}: ${detail}`);
    this.name = "InvariantViolation";
  }
}

export function check(condition: boolean, invariant: string, detail: () => string): void {
  if (!condition) throw new InvariantViolation(invariant, detail());
}

/** Depth-first scan for non-finite numbers anywhere inside a JSON-like value. */
export function findNonFinite(value: unknown, path = "$"): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? null : `${path}=${String(value)}`;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findNonFinite(value[i], `${path}[${i}]`);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      const hit = findNonFinite(child, `${path}.${key}`);
      if (hit !== null) return hit;
    }
  }
  return null;
}

export interface ExecutionOutcome {
  /** One JSON-serializable summary per executed step (used for determinism). */
  trace: unknown[];
  /** First invariant failure, if any; steps after it are not executed. */
  failure: { stepIndex: number; message: string } | null;
}

/**
 * Executor contract: run `actions` against a FRESH system-under-test,
 * checking invariants after every step. Must catch InvariantViolation (and
 * unexpected throws) into `failure`; expected throws from near-legal actions
 * are part of the trace, not failures.
 */
export type Executor<A> = (actions: readonly A[]) => ExecutionOutcome;

export interface SequenceRow {
  index: number;
  seed: number;
  length: number;
  stepsExecuted: number;
  outcome: "HELD" | "BROKEN" | "NONDETERMINISTIC";
  failure: { stepIndex: number; message: string } | null;
  traceSha: string;
  replayTraceSha: string;
  minimized: { actions: unknown[]; length: number; message: string } | null;
  /** Re-run count/failures when the first two executions disagreed. */
  flake: { runs: number; failures: number } | null;
}

export interface CampaignReport {
  campaign: string;
  baseSeed: number;
  iterations: number;
  minLength: number;
  maxLength: number;
  sequencesExecuted: number;
  stepsExecuted: number;
  held: number;
  broken: number;
  nondeterministic: number;
  failingSeeds: number[];
  rows: SequenceRow[];
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function traceSha(outcome: ExecutionOutcome): string {
  return fnv1a(JSON.stringify(outcome));
}

/** ddmin over the action list: smallest sub-list that still fails. */
export function minimizeActions<A>(
  actions: readonly A[],
  run: Executor<A>,
  fails: (o: ExecutionOutcome) => boolean = (o) => o.failure !== null,
): A[] {
  let current = [...actions];
  let granularity = 2;
  while (current.length >= 2) {
    const chunk = Math.ceil(current.length / granularity);
    let reduced = false;
    for (let start = 0; start < current.length; start += chunk) {
      const candidate = [...current.slice(0, start), ...current.slice(start + chunk)];
      if (candidate.length === 0) continue;
      if (fails(run(candidate))) {
        current = candidate;
        granularity = Math.max(granularity - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (granularity >= current.length) break;
      granularity = Math.min(granularity * 2, current.length);
    }
  }
  return current;
}

export interface CampaignSpec<A> {
  campaign: string;
  env: StressEnv;
  minLength: number;
  maxLength: number;
  generate: (rng: Rng, length: number) => A[];
  execute: Executor<A>;
}

export function runCampaign<A>(spec: CampaignSpec<A>): CampaignReport {
  const rows: SequenceRow[] = [];
  let stepsExecuted = 0;
  for (let index = 0; index < spec.env.iterations; index += 1) {
    const seed = seedFor(spec.env.baseSeed, index);
    const rng = makeRng(seed);
    const length = rng.range(spec.minLength, spec.maxLength);
    const actions = spec.generate(rng, length);
    const first = spec.execute(actions);
    const second = spec.execute(actions);
    const firstSha = traceSha(first);
    const secondSha = traceSha(second);
    const executed = first.failure === null ? first.trace.length : first.failure.stepIndex + 1;
    stepsExecuted += executed;
    let outcome: SequenceRow["outcome"] = "HELD";
    let minimized: SequenceRow["minimized"] = null;
    let flake: SequenceRow["flake"] = null;
    if (firstSha !== secondSha) {
      outcome = "NONDETERMINISTIC";
      let failures = 0;
      for (let run = 0; run < 10; run += 1) {
        if (spec.execute(actions).failure !== null) failures += 1;
      }
      flake = { runs: 10, failures };
    } else if (first.failure !== null) {
      outcome = "BROKEN";
      const minimal = minimizeActions(actions, spec.execute);
      const minimalOutcome = spec.execute(minimal);
      minimized = {
        actions: minimal,
        length: minimal.length,
        message: minimalOutcome.failure?.message ?? first.failure.message,
      };
    }
    rows.push({
      index,
      seed,
      length: actions.length,
      stepsExecuted: executed,
      outcome,
      failure: first.failure,
      traceSha: firstSha,
      replayTraceSha: secondSha,
      minimized,
      flake,
    });
  }
  const report: CampaignReport = {
    campaign: spec.campaign,
    baseSeed: spec.env.baseSeed,
    iterations: spec.env.iterations,
    minLength: spec.minLength,
    maxLength: spec.maxLength,
    sequencesExecuted: rows.length,
    stepsExecuted,
    held: rows.filter((r) => r.outcome === "HELD").length,
    broken: rows.filter((r) => r.outcome === "BROKEN").length,
    nondeterministic: rows.filter((r) => r.outcome === "NONDETERMINISTIC").length,
    failingSeeds: rows.filter((r) => r.outcome !== "HELD").map((r) => r.seed),
    rows,
  };
  if (spec.env.outDir !== null) {
    mkdirSync(spec.env.outDir, { recursive: true });
    writeFileSync(
      join(spec.env.outDir, `${spec.campaign}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  return report;
}

/** Human-readable failure digest for assertion messages. */
export function describeFailures(report: CampaignReport): string {
  return report.rows
    .filter((r) => r.outcome !== "HELD")
    .slice(0, 10)
    .map(
      (r) =>
        `seed=${r.seed} index=${r.index} outcome=${r.outcome} step=${r.failure?.stepIndex ?? "?"} ` +
        `msg=${r.failure?.message ?? r.minimized?.message ?? "(trace mismatch)"} ` +
        `minimized=${r.minimized === null ? "n/a" : JSON.stringify(r.minimized.actions)}`,
    )
    .join("\n");
}

/** Wrap an executor body so invariant violations and unexpected throws become `failure`. */
export function executeSteps<A>(
  actions: readonly A[],
  step: (action: A, index: number) => unknown,
): ExecutionOutcome {
  const trace: unknown[] = [];
  for (let index = 0; index < actions.length; index += 1) {
    try {
      trace.push(step(actions[index] as A, index));
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return { trace, failure: { stepIndex: index, message } };
    }
  }
  return { trace, failure: null };
}
