import type { CheckpointKey, FaultDirection } from "@pickle/shared-types";
import {
  correctionPhrase,
  DEFAULT_CUE_RULES,
  DEFAULT_LIVE_CUE_RULES,
  formatSpokenScore,
  improvementPhrase,
  INITIAL_COACH_STATE,
  INITIAL_LIVE_COACH_STATE,
  selectCue,
  selectLiveCue,
  sessionEndLine,
  worstCheckpoint,
  type CoachState,
  type CueRules,
  type LiveCheckpointObservation,
  type LiveCoachSessionState,
  type LiveCueRules,
  type LiveRepObservation,
  type RepObservation,
} from "../../src/index.js";
import {
  describeValue,
  malformedJsonText,
  mutate,
  mutateRules,
  NUMERIC_BOUNDARY,
  STRING_BOUNDARY,
  validCheckpoint,
  validCoachState,
  validLiveRep,
  validLiveRules,
  validLiveState,
  validRep,
  validRules,
  type MutationKind,
} from "./boundaryPayloads.js";
import { scenarioSeed, SeededRng } from "./seededRng.js";

/**
 * Boundary / malformed-input stress campaign for @pickle/audio-coach-core.
 *
 * Each scenario is replayable from (campaignSeed, index) → scenarioSeed. The
 * runner never asserts; it records outcomes so the test layer can decide
 * which invariants are HELD (must pass) and which are KNOWN BROKEN (tracked
 * by minimized repro tests) — a NEW violation class fails the suite.
 */

export type Target =
  | "selectLiveCue"
  | "selectCue"
  | "worstCheckpoint"
  | "sessionEndLine"
  | "formatSpokenScore"
  | "phrases"
  | "hydrateState";

export const TARGETS: readonly Target[] = [
  "selectLiveCue",
  "selectCue",
  "worstCheckpoint",
  "sessionEndLine",
  "formatSpokenScore",
  "phrases",
  "hydrateState",
];

export type Violation =
  | "threw-on-boundary-value" // well-typed input, boundary number/string → exception
  | "threw-on-wrong-type" // typed contract violated → exception (TypeError is the graceful form)
  | "threw-non-typeerror" // wrong-type input but a non-TypeError escaped
  | "non-finite-in-text" // spoken text contains NaN / Infinity / exponent
  | "garbage-in-text" // spoken text contains undefined/null/[object/function/control chars
  | "non-string-phrase" // a phrase/text function returned something other than a string
  | "text-too-long" // spoken text longer than any legitimate phrase
  | "negative-zero-in-text" // "-0.0" spoken
  | "non-finite-announced-score"
  | "non-finite-in-state"
  | "empty-live-text" // live coach must always speak
  | "silence-text-mismatch" // sparse coach: SILENCE ⇔ text === null
  | "non-deterministic"
  | "input-mutated"
  | "state-not-json-stable" // nextState changes behaviour after JSON round trip
  | "proto-polluted"
  | "hydrate-accepted-malformed"; // JSON.parse accepted text a schema should reject and engine misbehaved

export interface ScenarioRecord {
  id: string;
  index: number;
  seed: number;
  target: Target;
  mutations: MutationKind[];
  notes: string[];
  outcome: "HELD" | "BROKEN";
  violations: Violation[];
  error: string | null;
  /** Spoken text produced (truncated) when the engine returned. */
  text: string | null;
}

export interface CampaignSummary {
  campaignSeed: number;
  iterationsPerTarget: number;
  executed: number;
  held: number;
  broken: number;
  byViolation: Record<string, number>;
  byMutation: Record<string, { executed: number; broken: number }>;
  byTarget: Record<string, { executed: number; broken: number }>;
  brokenSeeds: Array<{ id: string; seed: number; target: Target; violations: Violation[] }>;
}

export interface CampaignResult {
  summary: CampaignSummary;
  records: ScenarioRecord[];
}

const MAX_LEGIT_TEXT_LENGTH = 160;
const NON_FINITE_TEXT = /\b(NaN|Infinity)\b|\d[eE][+-]?\d/;
// C0 controls (minus \t \n \r), DEL, RTL override, BOM — built from codepoints so the
// literal never contains raw control characters.
const CONTROL_CLASS = `[${String.fromCodePoint(0)}-${String.fromCodePoint(8)}${String.fromCodePoint(0x0b)}${String.fromCodePoint(0x0c)}${String.fromCodePoint(0x0e)}-${String.fromCodePoint(0x1f)}${String.fromCodePoint(0x7f)}\u202E\uFEFF]`;
const GARBAGE_TEXT = new RegExp(`\\b(undefined|null|function)\\b|\\[object |${CONTROL_CLASS}`);
const NEGATIVE_ZERO_TEXT = /(^|[^\d.])-0\.0\b/;

const PROTO_SENTINELS = ["polluted", "__proto__", "constructor", "prototype", "toString"] as const;

// ─── Output invariants ──────────────────────────────────────────────────────

function textViolations(text: unknown, target: Target): Violation[] {
  const out: Violation[] = [];
  if (typeof text !== "string") return out;
  if (NON_FINITE_TEXT.test(text)) out.push("non-finite-in-text");
  if (GARBAGE_TEXT.test(text)) out.push("garbage-in-text");
  if (text.length > MAX_LEGIT_TEXT_LENGTH) out.push("text-too-long");
  if (NEGATIVE_ZERO_TEXT.test(text)) out.push("negative-zero-in-text");
  if (target === "selectLiveCue" && text.length === 0) out.push("empty-live-text");
  return out;
}

function hasNonFiniteNumber(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (typeof value === "number") return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some((item) => hasNonFiniteNumber(item, depth + 1));
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((item) => hasNonFiniteNumber(item, depth + 1));
  }
  return false;
}

/** Type-tagged deterministic dump (distinguishes NaN, -0, undefined, holes). */
export function stableDump(value: unknown, depth = 0): string {
  if (depth > 12) return "<deep>";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "num:NaN";
    if (Object.is(value, -0)) return "num:-0";
    return `num:${value}`;
  }
  if (typeof value === "string") return `str:${JSON.stringify(value)}`;
  if (typeof value === "boolean") return `bool:${value}`;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "function") return "function";
  if (Array.isArray(value))
    return `[${value.map((item) => stableDump(item, depth + 1)).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    const record = value as Record<string, unknown>;
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableDump(record[k], depth + 1)}`).join(",")}}`;
  }
  return `other:${String(value)}`;
}

function protoPolluted(): boolean {
  const probe: Record<string, unknown> = {};
  for (const key of PROTO_SENTINELS) {
    if (key === "polluted" && key in probe) return true;
  }
  if (Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")) return true;
  if (Object.prototype.hasOwnProperty.call(Array.prototype, "polluted")) return true;
  return typeof ({} as { polluted?: unknown }).polluted !== "undefined";
}

function errorLabel(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.length > 120 ? `${error.message.slice(0, 120)}…` : error.message;
    return `${error.name}: ${message}`;
  }
  return `thrown:${describeValue(error)}`;
}

function throwViolation(error: unknown, mutations: MutationKind[]): Violation {
  const wrongTyped =
    mutations.includes("wrong-type") ||
    mutations.includes("structural") ||
    mutations.includes("future-schema") ||
    mutations.includes("proto-pollution");
  if (!wrongTyped) return "threw-on-boundary-value";
  return error instanceof TypeError ? "threw-on-wrong-type" : "threw-non-typeerror";
}

// ─── Per-target execution ───────────────────────────────────────────────────

interface Execution {
  violations: Violation[];
  error: string | null;
  text: string | null;
}

function runPure<TArgs extends unknown[]>(
  fn: (...args: TArgs) => unknown,
  args: TArgs,
  mutations: MutationKind[],
  target: Target,
  inspect: (result: unknown) => Violation[],
): Execution {
  const before = stableDump(args);
  let first: unknown;
  try {
    first = fn(...args);
  } catch (error) {
    const violations: Violation[] = [throwViolation(error, mutations)];
    if (stableDump(args) !== before) violations.push("input-mutated");
    if (protoPolluted()) violations.push("proto-polluted");
    return { violations, error: errorLabel(error), text: null };
  }
  const violations: Violation[] = [];
  let second: unknown;
  try {
    second = fn(...args);
  } catch {
    violations.push("non-deterministic");
  }
  if (second !== undefined && stableDump(first) !== stableDump(second)) {
    violations.push("non-deterministic");
  }
  if (stableDump(args) !== before) violations.push("input-mutated");
  if (protoPolluted()) violations.push("proto-polluted");
  violations.push(...inspect(first));
  const text = extractText(first, target);
  return { violations: dedupe(violations), error: null, text };
}

function extractText(result: unknown, target: Target): string | null {
  if (typeof result === "string") return truncate(result);
  if (typeof result === "object" && result !== null && "decision" in result) {
    const decision = (result as { decision: { text?: unknown } }).decision;
    if (typeof decision?.text === "string") return truncate(decision.text);
    if (decision?.text === null) return target === "selectCue" ? null : "<null>";
  }
  return null;
}

function truncate(text: string): string {
  return text.length > 80 ? `${text.slice(0, 80)}…(len=${text.length})` : text;
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function inspectLiveResult(result: unknown): Violation[] {
  const out: Violation[] = [];
  const typed = result as {
    decision: { text: unknown; announcedScore: unknown; category: unknown };
    nextState: LiveCoachSessionState;
  };
  out.push(...textViolations(typed.decision.text, "selectLiveCue"));
  if (typeof typed.decision.text !== "string") out.push("non-string-phrase");
  if (typed.decision.announcedScore !== null && !Number.isFinite(typed.decision.announcedScore)) {
    out.push("non-finite-announced-score");
  }
  if (hasNonFiniteNumber(typed.nextState)) out.push("non-finite-in-state");
  return out;
}

function inspectSparseResult(result: unknown): Violation[] {
  const out: Violation[] = [];
  const typed = result as {
    decision: { text: unknown; category: unknown };
    nextState: CoachState;
  };
  out.push(...textViolations(typed.decision.text, "selectCue"));
  const silence = typed.decision.category === "SILENCE";
  if (silence !== (typed.decision.text === null)) out.push("silence-text-mismatch");
  if (!silence && typeof typed.decision.text !== "string") out.push("non-string-phrase");
  if (!silence && typeof typed.decision.text === "string" && typed.decision.text.length === 0) {
    out.push("silence-text-mismatch");
  }
  if (hasNonFiniteNumber(typed.nextState)) out.push("non-finite-in-state");
  return out;
}

/** A follow-up valid rep run from nextState vs. from JSON.parse(JSON.stringify(nextState)). */
function liveJsonStability(nextState: unknown, rules: LiveCueRules): Violation[] {
  const follow: LiveRepObservation = {
    repIndex: 5,
    kind: "scored",
    overallScore: 7.5,
    checkpoints: [
      { key: "athletic_base", score: 62, direction: "low", severity: 0.35, applicable: true },
      { key: "contact_position", score: 80, direction: "none", severity: 0.05, applicable: true },
    ],
  };
  return jsonStability(
    (state) => selectLiveCue(state as LiveCoachSessionState, follow, rules).decision,
    nextState,
  );
}

function sparseJsonStability(nextState: unknown, rules: CueRules): Violation[] {
  const follow: RepObservation = {
    repIndex: 5,
    resultKind: "scored",
    overallScore: 7.5,
    focusCheckpoint: "athletic_base",
    focusScore: 62,
    focusDirection: "low",
    focusSeverity: 0.1,
  };
  return jsonStability(
    (state) => selectCue(state as CoachState, follow, rules).decision,
    nextState,
  );
}

function jsonStability(step: (state: unknown) => unknown, nextState: unknown): Violation[] {
  let direct: string;
  try {
    direct = stableDump(step(nextState));
  } catch {
    return []; // the follow-up itself threw — already covered by other invariants
  }
  let hydrated: unknown;
  try {
    hydrated = JSON.parse(JSON.stringify(nextState));
  } catch {
    return ["state-not-json-stable"];
  }
  try {
    return stableDump(step(hydrated)) === direct ? [] : ["state-not-json-stable"];
  } catch {
    return ["state-not-json-stable"];
  }
}

function runSelectLiveCue(
  rng: SeededRng,
): Omit<ScenarioRecord, "id" | "index" | "seed" | "target" | "outcome"> {
  const repIndex = rng.int(1, 40);
  const baseRep = validLiveRep(rng, repIndex);
  const baseState = rng.chance(0.3) ? INITIAL_LIVE_COACH_STATE : validLiveState(rng);
  const baseRules = rng.chance(0.5) ? DEFAULT_LIVE_CUE_RULES : validLiveRules(rng);

  const which = rng.next();
  let rep: unknown = baseRep;
  let state: unknown = baseState;
  let rules: unknown = baseRules;
  let mutations: MutationKind[] = [];
  let notes: string[] = [];
  if (which < 0.55) {
    const m = mutate(rng, baseRep, rng.int(1, 3));
    rep = m.value;
    mutations = m.mutations;
    notes = m.notes.map((n) => `rep.${n}`);
  } else if (which < 0.85) {
    const m = mutate(rng, baseState, rng.int(1, 3));
    state = m.value;
    mutations = m.mutations;
    notes = m.notes.map((n) => `state.${n}`);
  } else {
    const m = mutateRules(rng, baseRules);
    rules = m.value;
    mutations = m.mutations;
    notes = m.notes.map((n) => `rules.${n}`);
  }

  const execution = runPure(
    (s: unknown, r: unknown, ru: unknown) =>
      selectLiveCue(s as LiveCoachSessionState, r as LiveRepObservation, ru as LiveCueRules),
    [state, rep, rules],
    mutations,
    "selectLiveCue",
    (result) => {
      const violations = inspectLiveResult(result);
      const typed = result as { nextState: unknown };
      violations.push(...liveJsonStability(typed.nextState, DEFAULT_LIVE_CUE_RULES));
      return violations;
    },
  );
  return { mutations, notes, ...execution };
}

function runSelectCue(
  rng: SeededRng,
): Omit<ScenarioRecord, "id" | "index" | "seed" | "target" | "outcome"> {
  const repIndex = rng.int(1, 40);
  const baseRep = validRep(rng, repIndex);
  const baseState = rng.chance(0.3) ? INITIAL_COACH_STATE : validCoachState(rng);
  const baseRules = rng.chance(0.5) ? DEFAULT_CUE_RULES : validRules(rng);

  const which = rng.next();
  let rep: unknown = baseRep;
  let state: unknown = baseState;
  let rules: unknown = baseRules;
  let mutations: MutationKind[] = [];
  let notes: string[] = [];
  if (which < 0.55) {
    const m = mutate(rng, baseRep, rng.int(1, 3));
    rep = m.value;
    mutations = m.mutations;
    notes = m.notes.map((n) => `rep.${n}`);
  } else if (which < 0.85) {
    const m = mutate(rng, baseState, rng.int(1, 3));
    state = m.value;
    mutations = m.mutations;
    notes = m.notes.map((n) => `state.${n}`);
  } else {
    const m = mutateRules(rng, baseRules);
    rules = m.value;
    mutations = m.mutations;
    notes = m.notes.map((n) => `rules.${n}`);
  }

  const execution = runPure(
    (s: unknown, r: unknown, ru: unknown) =>
      selectCue(s as CoachState, r as RepObservation, ru as CueRules),
    [state, rep, rules],
    mutations,
    "selectCue",
    (result) => {
      const violations = inspectSparseResult(result);
      const typed = result as { nextState: unknown };
      violations.push(...sparseJsonStability(typed.nextState, DEFAULT_CUE_RULES));
      return violations;
    },
  );
  return { mutations, notes, ...execution };
}

function runWorstCheckpoint(
  rng: SeededRng,
): Omit<ScenarioRecord, "id" | "index" | "seed" | "target" | "outcome"> {
  const count = rng.int(0, 8);
  const base: LiveCheckpointObservation[] = [];
  for (let i = 0; i < count; i += 1) base.push(validCheckpoint(rng));
  const m = mutate(rng, base, rng.int(1, 3));
  const execution = runPure(
    (cps: unknown) => worstCheckpoint(cps as readonly LiveCheckpointObservation[]),
    [m.value],
    m.mutations,
    "worstCheckpoint",
    (result) => {
      const out: Violation[] = [];
      if (result !== null && typeof result !== "object") out.push("non-string-phrase");
      return out;
    },
  );
  return { mutations: m.mutations, notes: m.notes.map((n) => `checkpoints.${n}`), ...execution };
}

function runSessionEndLine(
  rng: SeededRng,
): Omit<ScenarioRecord, "id" | "index" | "seed" | "target" | "outcome"> {
  const scoredCount = rng.int(0, 30);
  const base = {
    scoredCount,
    startAverage:
      scoredCount === 0 || rng.chance(0.2) ? null : Math.round(rng.float(0, 10) * 10) / 10,
    endAverage: scoredCount < 2 || rng.chance(0.2) ? null : Math.round(rng.float(0, 10) * 10) / 10,
    best: scoredCount === 0 ? null : Math.round(rng.float(0, 10) * 10) / 10,
  };
  const m = mutate(rng, base, rng.int(1, 3));
  const execution = runPure(
    (input: unknown) => sessionEndLine(input as Parameters<typeof sessionEndLine>[0]),
    [m.value],
    m.mutations,
    "sessionEndLine",
    (result) => {
      const out = textViolations(result, "sessionEndLine");
      if (typeof result !== "string") out.push("non-string-phrase");
      else if (result.length === 0) out.push("garbage-in-text");
      return out;
    },
  );
  return { mutations: m.mutations, notes: m.notes, ...execution };
}

function runFormatSpokenScore(
  rng: SeededRng,
): Omit<ScenarioRecord, "id" | "index" | "seed" | "target" | "outcome"> {
  const roll = rng.next();
  let value: unknown;
  let mutations: MutationKind[];
  if (roll < 0.7) {
    value = rng.pick(NUMERIC_BOUNDARY);
    mutations = ["numeric-boundary"];
  } else if (roll < 0.85) {
    value = rng.pick(STRING_BOUNDARY);
    mutations = ["wrong-type"];
  } else {
    value = rng.pick([null, undefined, true, {}, [], [7], { toFixed: () => "x" }]);
    mutations = ["wrong-type"];
  }
  const execution = runPure(
    (score: unknown) => formatSpokenScore(score as number),
    [value],
    mutations,
    "formatSpokenScore",
    (result) => {
      const out = textViolations(result, "formatSpokenScore");
      if (typeof result !== "string") out.push("non-string-phrase");
      return out;
    },
  );
  return { mutations, notes: [`score=${describeValue(value)}`], ...execution };
}

function runPhrases(
  rng: SeededRng,
): Omit<ScenarioRecord, "id" | "index" | "seed" | "target" | "outcome"> {
  const useImprovement = rng.chance(0.4);
  const keyRoll = rng.next();
  let key: unknown;
  let mutations: MutationKind[];
  if (keyRoll < 0.6) {
    key = rng.pick(STRING_BOUNDARY);
    mutations = ["string-boundary"];
  } else if (keyRoll < 0.8) {
    key = rng.pick(["__proto__", "constructor", "prototype", "toString", "valueOf"]);
    mutations = ["proto-pollution"];
  } else {
    key = rng.pick([null, undefined, 7, {}, [], true]);
    mutations = ["wrong-type"];
  }
  const direction: unknown = rng.chance(0.7)
    ? rng.pick(["late", "low", "none", "unstable", "__proto__", "", "x".repeat(65536), "\u0000"])
    : rng.pick([null, undefined, 3, {}, []]);
  const execution = runPure(
    (k: unknown, d: unknown) =>
      useImprovement
        ? improvementPhrase(k as CheckpointKey)
        : correctionPhrase(k as CheckpointKey, d as FaultDirection),
    [key, direction],
    mutations,
    "phrases",
    (result) => {
      const out = textViolations(result, "phrases");
      if (typeof result !== "string") out.push("non-string-phrase");
      else if (result.length === 0) out.push("garbage-in-text");
      return out;
    },
  );
  return {
    mutations,
    notes: [
      `${useImprovement ? "improvementPhrase" : "correctionPhrase"}(${describeValue(key)}${useImprovement ? "" : `,${describeValue(direction)}`})`,
    ],
    ...execution,
  };
}

/**
 * Hydration boundary: a persistence layer hands back JSON text for the
 * (documented JSON-serializable) live state. JSON.parse rejecting it is the
 * graceful outcome; if it parses, the engine must still behave and Object.prototype
 * must stay clean.
 */
function runHydrateState(
  rng: SeededRng,
): Omit<ScenarioRecord, "id" | "index" | "seed" | "target" | "outcome"> {
  const valid = validLiveState(rng);
  const validJson = JSON.stringify(valid);
  const { text, note } = malformedJsonText(rng, validJson);
  const mutations: MutationKind[] = ["structural"];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      return {
        mutations,
        notes: [`json:${note}`],
        violations: ["threw-non-typeerror"],
        error: errorLabel(error),
        text: null,
      };
    }
    return {
      mutations,
      notes: [`json:${note}`, "rejected:SyntaxError"],
      violations: [],
      error: null,
      text: null,
    };
  }
  if (protoPolluted()) {
    return {
      mutations,
      notes: [`json:${note}`],
      violations: ["proto-polluted"],
      error: null,
      text: null,
    };
  }
  const rep = validLiveRep(rng, rng.int(1, 40));
  const execution = runPure(
    (s: unknown, r: unknown) => selectLiveCue(s as LiveCoachSessionState, r as LiveRepObservation),
    [parsed, rep],
    ["wrong-type"],
    "selectLiveCue",
    (result) => {
      const violations = inspectLiveResult(result);
      const typed = result as { nextState: unknown };
      violations.push(...liveJsonStability(typed.nextState, DEFAULT_LIVE_CUE_RULES));
      return violations.map((v) =>
        v === "threw-on-wrong-type" ? "hydrate-accepted-malformed" : v,
      );
    },
  );
  return { mutations, notes: [`json:${note}`, "parsed"], ...execution };
}

// ─── Campaign ───────────────────────────────────────────────────────────────

const RUNNERS: Record<
  Target,
  (rng: SeededRng) => Omit<ScenarioRecord, "id" | "index" | "seed" | "target" | "outcome">
> = {
  selectLiveCue: runSelectLiveCue,
  selectCue: runSelectCue,
  worstCheckpoint: runWorstCheckpoint,
  sessionEndLine: runSessionEndLine,
  formatSpokenScore: runFormatSpokenScore,
  phrases: runPhrases,
  hydrateState: runHydrateState,
};

export function runScenario(target: Target, seed: number, index = -1): ScenarioRecord {
  const rng = new SeededRng(seed);
  const partial = RUNNERS[target](rng);
  return {
    id: `${target}:${seed}`,
    index,
    seed,
    target,
    outcome: partial.violations.length === 0 ? "HELD" : "BROKEN",
    ...partial,
  };
}

export function runCampaign(options: {
  campaignSeed: number;
  iterationsPerTarget: number;
}): CampaignResult {
  const records: ScenarioRecord[] = [];
  let index = 0;
  for (const target of TARGETS) {
    for (let i = 0; i < options.iterationsPerTarget; i += 1) {
      const seed = scenarioSeed(options.campaignSeed, index);
      records.push(runScenario(target, seed, index));
      index += 1;
    }
  }
  return { summary: summarize(options, records), records };
}

function summarize(
  options: { campaignSeed: number; iterationsPerTarget: number },
  records: ScenarioRecord[],
): CampaignSummary {
  const byViolation: Record<string, number> = {};
  const byMutation: Record<string, { executed: number; broken: number }> = {};
  const byTarget: Record<string, { executed: number; broken: number }> = {};
  const brokenSeeds: CampaignSummary["brokenSeeds"] = [];
  for (const record of records) {
    const bucket = (byTarget[record.target] ??= { executed: 0, broken: 0 });
    bucket.executed += 1;
    for (const kind of new Set(record.mutations)) {
      const m = (byMutation[kind] ??= { executed: 0, broken: 0 });
      m.executed += 1;
      if (record.outcome === "BROKEN") m.broken += 1;
    }
    if (record.outcome === "BROKEN") {
      bucket.broken += 1;
      brokenSeeds.push({
        id: record.id,
        seed: record.seed,
        target: record.target,
        violations: record.violations,
      });
    }
    for (const violation of record.violations)
      byViolation[violation] = (byViolation[violation] ?? 0) + 1;
  }
  return {
    campaignSeed: options.campaignSeed,
    iterationsPerTarget: options.iterationsPerTarget,
    executed: records.length,
    held: records.filter((r) => r.outcome === "HELD").length,
    broken: brokenSeeds.length,
    byViolation,
    byMutation,
    byTarget,
    brokenSeeds,
  };
}
