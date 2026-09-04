import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

/**
 * Seeded randomized stress harness (lens: randomized-seeded long-run).
 *
 * A campaign is a model-checked action-sequence generator over one unit's
 * public API: every sequence is derived from a single integer seed, every
 * step re-checks the unit's documented invariants against an independent
 * model, and every failure is minimized and re-run so the report carries a
 * replayable seed, the minimized action list and a flakiness rate.
 *
 * Scale is controlled by STRESS_ITER (sequences per campaign; small default
 * so the suite stays fast). STRESS_SEED changes the base seed. STRESS_OUT_DIR
 * writes one JSON table (seed → outcome) per campaign for evidence.
 */

export const DEFAULT_STRESS_ITER = 100;
export const DEFAULT_STRESS_SEED = 20260904;
export const MIN_SEQUENCE_LENGTH = 5;
export const MAX_SEQUENCE_LENGTH = 60;

export class InvariantViolation extends Error {
  constructor(
    readonly invariant: string,
    readonly detail: string,
  ) {
    super(`${invariant}: ${detail}`);
    this.name = "InvariantViolation";
  }
}

export function check(condition: boolean, invariant: string, detail: () => string): void {
  if (!condition) throw new InvariantViolation(invariant, detail());
}

export function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === "number" && !Number.isFinite(v)) return `__nonfinite:${String(v)}`;
    if (typeof v === "bigint") return `__bigint:${v.toString()}`;
    if (v === undefined) return "__undefined";
    return v;
  });
}

export function checkEqual(actual: unknown, expected: unknown, invariant: string): void {
  const a = stable(actual);
  const e = stable(expected);
  check(a === e, invariant, () => `expected ${e} got ${a}`);
}

/** Like `stable` but with object keys sorted — structural equality that ignores insertion order. */
export function canonical(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (typeof v === "object" && v !== null) {
      const record = v as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, sortKeys(record[key])]),
      );
    }
    return v;
  };
  return stable(sortKeys(value));
}

export function checkCanonicalEqual(actual: unknown, expected: unknown, invariant: string): void {
  const a = canonical(actual);
  const e = canonical(expected);
  check(a === e, invariant, () => `expected ${e} got ${a}`);
}

export interface Rng {
  readonly seed: number;
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
  /** Fisher–Yates permutation of 0..n-1. */
  permutation(n: number): number[];
  fork(): Rng;
}

/** mulberry32 — small, fast, fully reproducible from a 32-bit seed. */
export function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    seed,
    next,
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    pick(items) {
      if (items.length === 0) throw new Error("pick from empty list");
      return items[Math.floor(next() * items.length)]!;
    },
    chance(probability) {
      return next() < probability;
    },
    permutation(n) {
      const order = Array.from({ length: n }, (_, i) => i);
      for (let i = n - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [order[i], order[j]] = [order[j]!, order[i]!];
      }
      return order;
    },
    fork() {
      return makeRng(Math.floor(next() * 4294967296));
    },
  };
  return rng;
}

export function stressIterations(): number {
  const raw = process.env["STRESS_ITER"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_STRESS_ITER;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`STRESS_ITER must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

/** Per-test vitest timeout scaled with STRESS_ITER so long campaigns are not cut off by the 5s default. */
export function stressTestTimeoutMs(): number {
  return Math.max(60_000, stressIterations() * 2_000);
}

export function stressBaseSeed(): number {
  const raw = process.env["STRESS_SEED"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_STRESS_SEED;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`STRESS_SEED must be a non-negative integer, got "${raw}"`);
  }
  return parsed;
}

/** Sequence i of a campaign gets a seed that is a pure function of (base, i). */
export function sequenceSeed(baseSeed: number, index: number): number {
  return makeRng((baseSeed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0).int(0, 0xffffffff);
}

export interface StressCampaign<Action, Model> {
  name: string;
  /** Fresh model for one sequence; may draw sequence-wide parameters. */
  init(rng: Rng): Model;
  /** Next legal/near-legal action. Must depend only on rng + history. */
  genAction(rng: Rng, index: number, history: readonly Action[]): Action;
  /** Apply the action to the unit AND the model, check every invariant,
   * return a compact trace token (compared across replays). */
  step(model: Model, action: Action, index: number): string;
  /** Aggregate counters for the report (mutated by step). */
  stats?: Record<string, number>;
}

export interface FailureRecord {
  invariant: string;
  detail: string;
  stepIndex: number;
}

export type SequenceOutcome = "held" | "broken" | "nondeterministic" | "generator_nondeterministic";

export interface SequenceRow {
  seed: number;
  length: number;
  outcome: SequenceOutcome;
  failure?: FailureRecord;
  minimized?: { length: number; actions: unknown[]; failure: FailureRecord };
  /** Failures out of 10 replays of the minimized sequence (1 = deterministic). */
  flakyRate?: number;
  traceDivergence?: { stepIndex: number; first: string; second: string };
}

export interface CampaignReport {
  campaign: string;
  baseSeed: number;
  iterations: number;
  sequenceLength: { min: number; max: number };
  stepsExecuted: number;
  held: number;
  broken: number[];
  nondeterministic: number[];
  durationMs: number;
  stats: Record<string, number>;
  rows: SequenceRow[];
}

interface Execution {
  trace: string[];
  failure: FailureRecord | null;
}

function execute<A, M>(campaign: StressCampaign<A, M>, actions: readonly A[], rng: Rng): Execution {
  const model = campaign.init(rng);
  const trace: string[] = [];
  for (let index = 0; index < actions.length; index += 1) {
    try {
      trace.push(campaign.step(model, actions[index]!, index));
    } catch (error) {
      if (error instanceof InvariantViolation) {
        return {
          trace,
          failure: { invariant: error.invariant, detail: error.detail, stepIndex: index },
        };
      }
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return { trace, failure: { invariant: "no-throw", detail: message, stepIndex: index } };
    }
  }
  return { trace, failure: null };
}

function generate<A, M>(campaign: StressCampaign<A, M>, seed: number): { rng: Rng; actions: A[] } {
  const rng = makeRng(seed);
  const initRng = rng.fork();
  const length = rng.int(MIN_SEQUENCE_LENGTH, MAX_SEQUENCE_LENGTH);
  const actions: A[] = [];
  for (let index = 0; index < length; index += 1) {
    actions.push(campaign.genAction(rng, index, actions));
  }
  return { rng: initRng, actions };
}

/** Greedy one-at-a-time removal (ddmin-lite): keeps any failing subsequence. */
function minimize<A, M>(
  campaign: StressCampaign<A, M>,
  actions: readonly A[],
  initSeed: number,
): { actions: A[]; failure: FailureRecord } {
  let current = [...actions];
  let failure = execute(campaign, current, makeRng(initSeed)).failure!;
  let progress = true;
  while (progress && current.length > 1) {
    progress = false;
    for (let index = current.length - 1; index >= 0; index -= 1) {
      const candidate = current.filter((_, i) => i !== index);
      const result = execute(campaign, candidate, makeRng(initSeed));
      if (result.failure !== null) {
        current = candidate;
        failure = result.failure;
        progress = true;
      }
    }
  }
  return { actions: current, failure };
}

/** Long campaigns yield to the event loop so the vitest worker keeps answering RPCs. */
const YIELD_EVERY_MS = 250;

export async function runStressCampaign<A, M>(
  campaign: StressCampaign<A, M>,
  options: { iterations?: number; baseSeed?: number } = {},
): Promise<CampaignReport> {
  const iterations = options.iterations ?? stressIterations();
  const baseSeed = options.baseSeed ?? stressBaseSeed();
  const started = Date.now();
  const rows: SequenceRow[] = [];
  let stepsExecuted = 0;
  let minLength = Number.POSITIVE_INFINITY;
  let maxLength = 0;
  let lastYield = started;

  for (let index = 0; index < iterations; index += 1) {
    if (Date.now() - lastYield > YIELD_EVERY_MS) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      lastYield = Date.now();
    }
    const seed = sequenceSeed(baseSeed, index);
    const first = generate(campaign, seed);
    const second = generate(campaign, seed);
    const row: SequenceRow = { seed, length: first.actions.length, outcome: "held" };
    minLength = Math.min(minLength, first.actions.length);
    maxLength = Math.max(maxLength, first.actions.length);

    if (stable(first.actions) !== stable(second.actions)) {
      row.outcome = "generator_nondeterministic";
      rows.push(row);
      continue;
    }

    const initSeed = first.rng.seed;
    const run1 = execute(campaign, first.actions, makeRng(initSeed));
    const run2 = execute(campaign, first.actions, makeRng(initSeed));
    stepsExecuted += run1.trace.length + (run1.failure ? 1 : 0);

    const divergence = run1.trace.findIndex((token, i) => token !== run2.trace[i]);
    if (
      divergence !== -1 ||
      run1.trace.length !== run2.trace.length ||
      stable(run1.failure) !== stable(run2.failure)
    ) {
      row.outcome = "nondeterministic";
      const at = divergence === -1 ? Math.min(run1.trace.length, run2.trace.length) : divergence;
      row.traceDivergence = {
        stepIndex: at,
        first: run1.trace[at] ?? stable(run1.failure),
        second: run2.trace[at] ?? stable(run2.failure),
      };
    }

    if (run1.failure !== null) {
      if (row.outcome === "held") row.outcome = "broken";
      row.failure = run1.failure;
      const minimized = minimize(campaign, first.actions, initSeed);
      let failures = 0;
      for (let replay = 0; replay < 10; replay += 1) {
        if (execute(campaign, minimized.actions, makeRng(initSeed)).failure !== null) failures += 1;
      }
      row.minimized = {
        length: minimized.actions.length,
        actions: minimized.actions as unknown[],
        failure: minimized.failure,
      };
      row.flakyRate = failures / 10;
    }
    rows.push(row);
  }

  const report: CampaignReport = {
    campaign: campaign.name,
    baseSeed,
    iterations,
    sequenceLength: {
      min: Number.isFinite(minLength) ? minLength : 0,
      max: maxLength,
    },
    stepsExecuted,
    held: rows.filter((row) => row.outcome === "held").length,
    broken: rows.filter((row) => row.outcome === "broken").map((row) => row.seed),
    nondeterministic: rows
      .filter(
        (row) => row.outcome === "nondeterministic" || row.outcome === "generator_nondeterministic",
      )
      .map((row) => row.seed),
    durationMs: Date.now() - started,
    stats: { ...(campaign.stats ?? {}) },
    rows,
  };
  writeReport(report);
  return report;
}

function writeReport(report: CampaignReport): void {
  const dir = process.env["STRESS_OUT_DIR"];
  if (dir === undefined || dir.trim() === "") return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${report.campaign}.json`), JSON.stringify(report, null, 2));
}

/** Vitest glue: a campaign holds only when no sequence broke or diverged. */
export function expectCampaignHeld(report: CampaignReport): void {
  const problems = report.rows.filter((row) => row.outcome !== "held");
  const summary = problems.slice(0, 5).map((row) => ({
    seed: row.seed,
    outcome: row.outcome,
    failure: row.minimized?.failure ?? row.failure,
    minimizedLength: row.minimized?.length,
    minimizedActions: row.minimized?.actions,
    flakyRate: row.flakyRate,
    traceDivergence: row.traceDivergence,
  }));
  expect(
    problems.length,
    `${report.campaign}: ${problems.length}/${report.iterations} sequences failed; first: ${JSON.stringify(summary)}`,
  ).toBe(0);
  expect(report.stepsExecuted).toBeGreaterThanOrEqual(report.iterations * MIN_SEQUENCE_LENGTH);
}

/** Replay a single seed (debugging aid: STRESS_REPLAY_SEED=<seed>). */
export function replaySeed<A, M>(
  campaign: StressCampaign<A, M>,
  seed: number,
): Execution & { actions: A[] } {
  const generated = generate(campaign, seed);
  return {
    ...execute(campaign, generated.actions, makeRng(generated.rng.seed)),
    actions: generated.actions,
  };
}

export function bump(stats: Record<string, number>, key: string): void {
  stats[key] = (stats[key] ?? 0) + 1;
}
