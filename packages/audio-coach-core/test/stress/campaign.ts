import {
  DEFAULT_CUE_RULES,
  DEFAULT_LIVE_CUE_RULES,
  INITIAL_COACH_STATE,
  INITIAL_LIVE_COACH_STATE,
  selectCue,
  selectLiveCue,
  sessionEndLine,
  type CoachState,
  type CueDecision,
  type CueRules,
  type LiveCoachSessionState,
  type LiveCueDecision,
  type LiveCueRules,
  type LiveRepObservation,
  type RepObservation,
} from "../../src/index.js";
import {
  generateCueSequence,
  generateLiveSequence,
  generateSessionEndInput,
  type InputMode,
  type SequenceSpec,
} from "./generators.js";
import {
  checkCueStep,
  checkLiveStep,
  checkSessionEndLine,
  INITIAL_CUE_MODEL,
  INITIAL_LIVE_MODEL,
  stepCueModel,
  stepLiveModel,
  type Violation,
} from "./invariants.js";
import { SeededRng, sequenceSeed } from "./seededRng.js";

/**
 * Seeded randomized long-run campaign over the audio-coach-core public API.
 * Every sequence is replayable from (engine, mode, seed): the seed fixes the
 * rules, the rep stream and its length (5–60). After every step the invariants
 * in invariants.ts are model-checked; each sequence is additionally run a
 * second time (same seed → identical trace), once with the state JSON
 * round-tripped between steps, and with deep-frozen inputs (any mutation of
 * state or rep throws in strict mode).
 */
export type Engine = "cue" | "live";

export interface StepViolation extends Violation {
  step: number;
}

export interface SequenceResult {
  engine: Engine;
  mode: InputMode;
  seed: number;
  length: number;
  defaultRules: boolean;
  outcome: "HELD" | "BROKEN" | "ADVISORY";
  hardViolations: StepViolation[];
  advisoryViolations: StepViolation[];
  deterministic: boolean;
  roundTripStable: boolean;
  threw: string | null;
  categories: Record<string, number>;
}

export const MIN_LENGTH = 5;
export const MAX_LENGTH = 60;

export function lengthForSeed(seed: number): number {
  return new SeededRng(seed ^ 0x5eed1e47).int(MIN_LENGTH, MAX_LENGTH);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** JSON text that keeps NaN/±Infinity distinguishable (JSON.stringify would null them). */
function canon(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === "number" && !Number.isFinite(v) ? `__${String(v)}__` : v,
  );
}

interface Trace<D> {
  decisions: D[];
  violations: StepViolation[];
  threw: string | null;
}

export function traceCue(
  rules: CueRules,
  reps: readonly RepObservation[],
  mode: InputMode,
  options: { roundTripState?: boolean; freeze?: boolean } = {},
): Trace<CueDecision> & { finalState: CoachState } {
  const decisions: CueDecision[] = [];
  const violations: StepViolation[] = [];
  let state: CoachState = INITIAL_COACH_STATE;
  let model = INITIAL_CUE_MODEL;
  let threw: string | null = null;
  const frozenRules = options.freeze ? deepFreeze(structuredClone(rules)) : rules;
  for (let i = 0; i < reps.length; i += 1) {
    const rep = reps[i];
    if (rep === undefined) break;
    const input = options.freeze ? deepFreeze(structuredClone(rep)) : rep;
    const before = options.roundTripState ? roundTrip(state) : state;
    if (options.freeze) deepFreeze(before);
    try {
      const { decision, nextState } = selectCue(before, input, frozenRules);
      decisions.push(decision);
      const modelAfter = stepCueModel(model, rep, decision);
      for (const v of checkCueStep({
        mode,
        rules,
        before,
        rep,
        decision,
        after: nextState,
        modelBefore: model,
        modelAfter,
      })) {
        violations.push({ ...v, step: i });
      }
      model = modelAfter;
      state = nextState;
    } catch (error) {
      threw = `step ${i}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
      break;
    }
  }
  return { decisions, violations, threw, finalState: state };
}

export function traceLive(
  rules: LiveCueRules,
  reps: readonly LiveRepObservation[],
  mode: InputMode,
  options: { roundTripState?: boolean; freeze?: boolean } = {},
): Trace<LiveCueDecision> & { finalState: LiveCoachSessionState } {
  const decisions: LiveCueDecision[] = [];
  const violations: StepViolation[] = [];
  let state: LiveCoachSessionState = INITIAL_LIVE_COACH_STATE;
  let model = INITIAL_LIVE_MODEL;
  let threw: string | null = null;
  const frozenRules = options.freeze ? deepFreeze(structuredClone(rules)) : rules;
  for (let i = 0; i < reps.length; i += 1) {
    const rep = reps[i];
    if (rep === undefined) break;
    const input = options.freeze ? deepFreeze(structuredClone(rep)) : rep;
    const before = options.roundTripState ? roundTrip(state) : state;
    if (options.freeze) deepFreeze(before);
    try {
      const { decision, nextState } = selectLiveCue(before, input, frozenRules);
      decisions.push(decision);
      const modelAfter = stepLiveModel(model, rep, decision);
      for (const v of checkLiveStep({
        mode,
        rules,
        before,
        rep,
        decision,
        after: nextState,
        modelBefore: model,
        modelAfter,
      })) {
        violations.push({ ...v, step: i });
      }
      model = modelAfter;
      state = nextState;
    } catch (error) {
      threw = `step ${i}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
      break;
    }
  }
  return { decisions, violations, threw, finalState: state };
}

function histogram(categories: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of categories) out[c] = (out[c] ?? 0) + 1;
  return out;
}

function sameJson(a: unknown, b: unknown): boolean {
  return canon(a) === canon(b);
}

/** Replay one sequence from its seed and evaluate every property. */
export function runSequence(engine: Engine, mode: InputMode, seed: number): SequenceResult {
  const spec: SequenceSpec = { seed, mode, length: lengthForSeed(seed) };
  const hostile = mode === "hostile";
  if (engine === "cue") {
    const { rules, reps } = generateCueSequence(spec);
    const a = traceCue(rules, reps, mode, { freeze: true });
    const b = traceCue(rules, reps, mode);
    const c = hostile ? a : traceCue(rules, reps, mode, { roundTripState: true });
    return finish(engine, mode, seed, reps.length, rules === DEFAULT_CUE_RULES, a, b, c, hostile);
  }
  const { rules, reps } = generateLiveSequence(spec);
  const a = traceLive(rules, reps, mode, { freeze: true });
  const b = traceLive(rules, reps, mode);
  const c = hostile ? a : traceLive(rules, reps, mode, { roundTripState: true });
  return finish(
    engine,
    mode,
    seed,
    reps.length,
    rules === DEFAULT_LIVE_CUE_RULES,
    a,
    b,
    c,
    hostile,
  );
}

function finish<D extends { category: string }>(
  engine: Engine,
  mode: InputMode,
  seed: number,
  length: number,
  defaultRules: boolean,
  a: Trace<D> & { finalState: unknown },
  b: Trace<D> & { finalState: unknown },
  c: Trace<D> & { finalState: unknown },
  hostile: boolean,
): SequenceResult {
  const deterministic = sameJson(a.decisions, b.decisions) && sameJson(a.finalState, b.finalState);
  // NaN never survives JSON, so the round-trip property is only meaningful for finite inputs.
  const roundTripStable =
    hostile || (sameJson(a.decisions, c.decisions) && sameJson(a.finalState, c.finalState));
  const hardViolations = a.violations.filter((v) => v.strength === "hard");
  const advisoryViolations = a.violations.filter((v) => v.strength === "advisory");
  if (!deterministic)
    hardViolations.push({ invariant: "D1.determinism", strength: "hard", detail: "", step: -1 });
  if (!roundTripStable)
    hardViolations.push({
      invariant: "D2.json-roundtrip-trace",
      strength: "hard",
      detail: "",
      step: -1,
    });
  if (a.threw !== null)
    hardViolations.push({ invariant: "X1.threw", strength: "hard", detail: a.threw, step: -1 });
  const outcome =
    hardViolations.length > 0 ? "BROKEN" : advisoryViolations.length > 0 ? "ADVISORY" : "HELD";
  return {
    engine,
    mode,
    seed,
    length,
    defaultRules,
    outcome,
    hardViolations,
    advisoryViolations,
    deterministic,
    roundTripStable,
    threw: a.threw,
    categories: histogram(a.decisions.map((d) => d.category)),
  };
}

export interface CampaignSummary {
  engine: Engine;
  mode: InputMode;
  baseSeed: number;
  sequences: number;
  steps: number;
  held: number;
  advisory: number;
  broken: number;
  byInvariant: Record<string, number>;
  categories: Record<string, number>;
  rows: SequenceResult[];
}

export function runCampaign(
  engine: Engine,
  mode: InputMode,
  count: number,
  baseSeed: number,
): CampaignSummary {
  const rows: SequenceResult[] = [];
  const byInvariant: Record<string, number> = {};
  const categories: Record<string, number> = {};
  let steps = 0;
  for (let i = 0; i < count; i += 1) {
    const row = runSequence(engine, mode, sequenceSeed(baseSeed, i));
    rows.push(row);
    steps += row.length;
    for (const v of [...row.hardViolations, ...row.advisoryViolations]) {
      byInvariant[v.invariant] = (byInvariant[v.invariant] ?? 0) + 1;
    }
    for (const [k, n] of Object.entries(row.categories)) categories[k] = (categories[k] ?? 0) + n;
  }
  return {
    engine,
    mode,
    baseSeed,
    sequences: rows.length,
    steps,
    held: rows.filter((r) => r.outcome === "HELD").length,
    advisory: rows.filter((r) => r.outcome === "ADVISORY").length,
    broken: rows.filter((r) => r.outcome === "BROKEN").length,
    byInvariant,
    categories,
    rows,
  };
}

// --------------------------------------------------------------- minimize

export interface Minimized<R> {
  invariant: string;
  originalLength: number;
  minimizedLength: number;
  rules: CueRules | LiveCueRules;
  reps: R[];
  detail: string;
}

function firstViolation<D>(trace: Trace<D>, invariant: string): StepViolation | null {
  return trace.violations.find((v) => v.invariant === invariant) ?? null;
}

/**
 * Greedy 1-minimal reduction: keep the failing step, drop any earlier rep
 * whose removal keeps the same invariant failing on the final rep.
 */
export function minimizeSequence(
  engine: Engine,
  mode: InputMode,
  seed: number,
  invariant: string,
): Minimized<RepObservation> | Minimized<LiveRepObservation> | null {
  const spec: SequenceSpec = { seed, mode, length: lengthForSeed(seed) };
  if (engine === "cue") {
    const { rules, reps } = generateCueSequence(spec);
    const run = (subset: RepObservation[]) =>
      firstViolation(traceCue(rules, subset, mode), invariant);
    const first = run(reps);
    if (first === null) return null;
    let current = reps.slice(0, first.step + 1);
    const stillFails = (subset: RepObservation[]) => run(subset)?.step === subset.length - 1;
    let progress = true;
    while (progress) {
      progress = false;
      for (let i = current.length - 2; i >= 0; i -= 1) {
        const candidate = [...current.slice(0, i), ...current.slice(i + 1)];
        if (stillFails(candidate)) {
          current = candidate;
          progress = true;
        }
      }
    }
    const final = run(current);
    return {
      invariant,
      originalLength: reps.length,
      minimizedLength: current.length,
      rules,
      reps: current,
      detail: final?.detail ?? "",
    };
  }
  const { rules, reps } = generateLiveSequence(spec);
  const run = (subset: LiveRepObservation[]) =>
    firstViolation(traceLive(rules, subset, mode), invariant);
  const first = run(reps);
  if (first === null) return null;
  let current = reps.slice(0, first.step + 1);
  const stillFails = (subset: LiveRepObservation[]) => run(subset)?.step === subset.length - 1;
  let progress = true;
  while (progress) {
    progress = false;
    for (let i = current.length - 2; i >= 0; i -= 1) {
      const candidate = [...current.slice(0, i), ...current.slice(i + 1)];
      if (stillFails(candidate)) {
        current = candidate;
        progress = true;
      }
    }
  }
  const final = run(current);
  return {
    invariant,
    originalLength: reps.length,
    minimizedLength: current.length,
    rules,
    reps: current,
    detail: final?.detail ?? "",
  };
}

// ---------------------------------------------------------- sessionEndLine

export interface SessionEndResult {
  seed: number;
  mode: InputMode;
  input: ReturnType<typeof generateSessionEndInput>;
  line: string;
  violations: Violation[];
  threw: string | null;
}

export function runSessionEndCampaign(
  mode: InputMode,
  count: number,
  baseSeed: number,
): SessionEndResult[] {
  const rows: SessionEndResult[] = [];
  for (let i = 0; i < count; i += 1) {
    const seed = sequenceSeed(baseSeed ^ 0x5e55, i);
    const input = generateSessionEndInput(seed, mode);
    try {
      const line = sessionEndLine(deepFreeze(structuredClone(input)));
      const again = sessionEndLine(input);
      const violations = checkSessionEndLine(input, line, mode);
      if (line !== again)
        violations.push({ invariant: "D1.determinism", strength: "hard", detail: "" });
      rows.push({ seed, mode, input, line, violations, threw: null });
    } catch (error) {
      rows.push({
        seed,
        mode,
        input,
        line: "",
        violations: [{ invariant: "X1.threw", strength: "hard", detail: String(error) }],
        threw: String(error),
      });
    }
  }
  return rows;
}
