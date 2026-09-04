import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeRng, type Rng } from './prng';

/**
 * Generic seeded-sequence campaign runner used by both `mod-app-root` stress
 * suites. A suite supplies:
 *
 * - an action vocabulary (`Action` is any JSON-serialisable value the suite
 *   can execute), a `draw(rng, model)` that proposes the next LEGAL or
 *   NEAR-LEGAL action given the model's current state, and
 * - a `Session` that executes one action against the real unit and returns a
 *   step observation, checking every invariant after every step (throwing an
 *   `InvariantViolation` when one fails).
 *
 * The runner owns: seed → sequence generation, per-step tracing, failure
 * capture, determinism replay (same seed twice → identical trace), and
 * delta-debugging minimisation of any failing sequence (the recorded minimal
 * sequence replays the SAME invariant id). Results are written as a JSON
 * table (seed → outcome) under `artifacts/stress/mod-app-root/`.
 */

export class InvariantViolation extends Error {
  constructor(
    readonly invariant: string,
    detail: string,
  ) {
    super(`${invariant}: ${detail}`);
    this.name = 'InvariantViolation';
  }
}

export interface Session<Action, Observation> {
  /** Execute one action. Return the observation; throw InvariantViolation. */
  step(action: Action): Observation;
  /** Tear down (unmount, restore globals). Must not throw. */
  close(): void;
}

export interface SuiteSpec<Action, Observation, Model> {
  name: string;
  /** Fresh model for a new sequence (pure, seed-independent). */
  initialModel(): Model;
  /** Propose the next action given rng + model; must be deterministic. */
  draw(rng: Rng, model: Model, stepIndex: number): Action;
  /** Open a fresh session sharing `model` (the session mutates the model). */
  open(model: Model, seed: number): Session<Action, Observation>;
  /** Coverage bucket of one observation (e.g. the rendered branch). */
  observationKey(observation: Observation): string;
}

export interface StepTrace<Action, Observation> {
  i: number;
  action: Action;
  observed: Observation | null;
  error?: string;
}

export type Outcome = 'HELD' | 'BROKEN' | 'CRASHED';

export interface SequenceRow<Action, Observation> {
  seed: number;
  length: number;
  outcome: Outcome;
  /** Executed steps (equals length when HELD). */
  steps: number;
  invariant: string | null;
  error: string | null;
  deterministic: boolean | null;
  traceHash: string;
  actions: Action[];
  /** Observation buckets hit by this sequence (spec.observationKey). */
  coverage: Record<string, number>;
  /** Full trace kept for failures and single-seed replays only. */
  trace?: StepTrace<Action, Observation>[];
  minimized?: {
    steps: number;
    actions: Action[];
    invariant: string | null;
    error: string | null;
    trace: StepTrace<Action, Observation>[];
  };
  durationMs: number;
}

function fnv1a(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export interface Execution<Action, Observation> {
  actions: Action[];
  plannedLength: number;
  trace: StepTrace<Action, Observation>[];
  outcome: Outcome;
  invariant: string | null;
  error: string | null;
}

function runSteps<Action, Observation, Model>(
  spec: SuiteSpec<Action, Observation, Model>,
  seed: number,
  plannedLength: number,
  nextAction: (model: Model, i: number) => Action,
): Execution<Action, Observation> {
  const model = spec.initialModel();
  const session = spec.open(model, seed);
  const actions: Action[] = [];
  const trace: StepTrace<Action, Observation>[] = [];
  const done = (
    outcome: Outcome,
    invariant: string | null,
    error: string | null,
  ): Execution<Action, Observation> => ({
    actions,
    plannedLength,
    trace,
    outcome,
    invariant,
    error,
  });
  try {
    for (let i = 0; i < plannedLength; i += 1) {
      // Legality depends on the evolving model, so the draw sees the SAME
      // model the executor mutates (generation and execution are one pass;
      // replay from the seed regenerates the identical list).
      const action = nextAction(model, i);
      actions.push(action);
      try {
        const observed = session.step(action);
        trace.push({ i, action, observed });
      } catch (error) {
        trace.push({
          i,
          action,
          observed: null,
          error: describeError(error),
        });
        if (error instanceof InvariantViolation) {
          return done('BROKEN', error.invariant, error.message);
        }
        return done('CRASHED', 'noThrow', describeError(error));
      }
    }
  } finally {
    session.close();
  }
  return done('HELD', null, null);
}

/** Draw + execute one seeded sequence, checking invariants after every step. */
export function runSequence<Action, Observation, Model>(
  spec: SuiteSpec<Action, Observation, Model>,
  seed: number,
  minLen: number,
  maxLen: number,
): Execution<Action, Observation> {
  const rng = makeRng(seed);
  const length = rng.int(minLen, maxLen);
  return runSteps(spec, seed, length, (model, i) => spec.draw(rng, model, i));
}

/** Execute a concrete action list (used by minimisation and replays). */
export function executeSequence<Action, Observation, Model>(
  spec: SuiteSpec<Action, Observation, Model>,
  seed: number,
  actions: readonly Action[],
): Execution<Action, Observation> {
  return runSteps(spec, seed, actions.length, (_model, i) => actions[i]!);
}

export function traceHash<Action, Observation>(
  trace: readonly StepTrace<Action, Observation>[],
): string {
  return fnv1a(JSON.stringify(trace));
}

/**
 * ddmin-style minimisation: drop chunks of the action list while the SAME
 * invariant still fails; then drop single actions. Bounded by `budget`
 * executions so a pathological case cannot stall the suite.
 */
export function minimizeFailure<Action, Observation, Model>(
  spec: SuiteSpec<Action, Observation, Model>,
  seed: number,
  actions: readonly Action[],
  invariant: string,
  budget = 400,
): SequenceRow<Action, Observation>['minimized'] {
  let current = actions.slice();
  let executions = 0;
  const stillFails = (candidate: readonly Action[]): boolean => {
    if (executions >= budget) return false;
    executions += 1;
    const result = executeSequence(spec, seed, candidate);
    return result.outcome !== 'HELD' && result.invariant === invariant;
  };
  let granularity = 2;
  while (current.length >= 2 && executions < budget) {
    const size = Math.ceil(current.length / granularity);
    let reduced = false;
    for (let start = 0; start < current.length; start += size) {
      const candidate = current
        .slice(0, start)
        .concat(current.slice(start + size));
      if (candidate.length > 0 && stillFails(candidate)) {
        current = candidate;
        granularity = Math.max(granularity - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (granularity >= current.length) break;
      granularity = Math.min(current.length, granularity * 2);
    }
  }
  const final = executeSequence(spec, seed, current);
  return {
    steps: current.length,
    actions: current,
    invariant: final.invariant,
    error: final.error,
    trace: final.trace,
  };
}

export interface RunSeedOptions {
  minLen: number;
  maxLen: number;
  /** Replay a second time and compare traces (determinism check). */
  determinism: boolean;
  /** Keep the full per-step trace on the row even when HELD. */
  keepTrace: boolean;
}

export function runSeed<Action, Observation, Model>(
  spec: SuiteSpec<Action, Observation, Model>,
  seed: number,
  options: RunSeedOptions,
): SequenceRow<Action, Observation> {
  const started = Date.now();
  const first = runSequence(spec, seed, options.minLen, options.maxLen);
  const actions = first.actions;
  const hash = traceHash(first.trace);
  let deterministic: boolean | null = null;
  if (options.determinism) {
    const second = runSequence(spec, seed, options.minLen, options.maxLen);
    deterministic =
      JSON.stringify(second.actions) === JSON.stringify(actions) &&
      traceHash(second.trace) === hash;
  }
  const coverage: Record<string, number> = {};
  for (const step of first.trace) {
    if (step.observed === null) continue;
    const key = spec.observationKey(step.observed);
    coverage[key] = (coverage[key] ?? 0) + 1;
  }
  const row: SequenceRow<Action, Observation> = {
    seed,
    length: first.plannedLength,
    outcome: first.outcome,
    steps: first.trace.length,
    invariant: first.invariant,
    error: first.error,
    deterministic,
    traceHash: hash,
    actions,
    coverage,
    durationMs: 0,
  };
  if (first.outcome !== 'HELD' || options.keepTrace) row.trace = first.trace;
  if (first.outcome !== 'HELD' && first.invariant) {
    row.minimized = minimizeFailure(spec, seed, actions, first.invariant);
  }
  if (deterministic === false) {
    row.outcome = 'BROKEN';
    row.invariant = row.invariant ?? 'determinism';
    row.error =
      row.error ??
      'same seed produced a different action list or trace on replay';
  }
  row.durationMs = Date.now() - started;
  return row;
}

// ─── Artifacts ──────────────────────────────────────────────────────────────

export interface CampaignSummary<Action, Observation> {
  suite: string;
  unit: 'mod-app-root';
  lens: 'randomized-seeded';
  generatedAt: string;
  node: string;
  env: {
    STRESS_ITER: string | null;
    STRESS_SEED: string | null;
    STRESS_SEED_BASE: string | null;
    STRESS_MIN_LEN: string | null;
    STRESS_MAX_LEN: string | null;
  };
  sequences: number;
  stepsExecuted: number;
  held: number;
  broken: number;
  crashed: number;
  nondeterministic: number;
  lengthRange: [number, number] | null;
  invariantsChecked: readonly string[];
  actionHistogram: Record<string, number>;
  observationHistogram: Record<string, number>;
  failingSeeds: {
    seed: number;
    invariant: string | null;
    error: string | null;
    minimizedSteps: number | null;
  }[];
  rows: SequenceRow<Action, Observation>[];
}

export function artifactDir(): string {
  const override = process.env.STRESS_ARTIFACT_DIR;
  return override && override !== ''
    ? resolve(override)
    : resolve(__dirname, '../../../../artifacts/stress/mod-app-root');
}

export function summarize<Action, Observation>(
  suite: string,
  rows: readonly SequenceRow<Action, Observation>[],
  invariantsChecked: readonly string[],
  actionKind: (action: Action) => string,
): CampaignSummary<Action, Observation> {
  const histogram: Record<string, number> = {};
  const observations: Record<string, number> = {};
  let steps = 0;
  let minLen = Number.POSITIVE_INFINITY;
  let maxLen = 0;
  for (const row of rows) {
    steps += row.steps;
    minLen = Math.min(minLen, row.length);
    maxLen = Math.max(maxLen, row.length);
    for (const action of row.actions) {
      const kind = actionKind(action);
      histogram[kind] = (histogram[kind] ?? 0) + 1;
    }
    for (const [key, count] of Object.entries(row.coverage)) {
      observations[key] = (observations[key] ?? 0) + count;
    }
  }
  const env = (name: string) => process.env[name] ?? null;
  return {
    suite,
    unit: 'mod-app-root',
    lens: 'randomized-seeded',
    generatedAt: new Date().toISOString(),
    node: process.version,
    env: {
      STRESS_ITER: env('STRESS_ITER'),
      STRESS_SEED: env('STRESS_SEED'),
      STRESS_SEED_BASE: env('STRESS_SEED_BASE'),
      STRESS_MIN_LEN: env('STRESS_MIN_LEN'),
      STRESS_MAX_LEN: env('STRESS_MAX_LEN'),
    },
    sequences: rows.length,
    stepsExecuted: steps,
    held: rows.filter(r => r.outcome === 'HELD').length,
    broken: rows.filter(r => r.outcome === 'BROKEN').length,
    crashed: rows.filter(r => r.outcome === 'CRASHED').length,
    nondeterministic: rows.filter(r => r.deterministic === false).length,
    lengthRange: rows.length ? [minLen, maxLen] : null,
    invariantsChecked,
    actionHistogram: histogram,
    observationHistogram: observations,
    failingSeeds: rows
      .filter(r => r.outcome !== 'HELD')
      .map(r => ({
        seed: r.seed,
        invariant: r.invariant,
        error: r.error,
        minimizedSteps: r.minimized?.steps ?? null,
      })),
    rows: rows.slice(),
  };
}

export function writeCampaignArtifact<Action, Observation>(
  summary: CampaignSummary<Action, Observation>,
): string {
  const dir = artifactDir();
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${summary.suite}.json`);
  writeFileSync(file, JSON.stringify(summary, null, 2));
  return file;
}
