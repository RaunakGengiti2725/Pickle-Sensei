/**
 * Campaign runner for the boundary/malformed lens.
 *
 * One iteration = one 32-bit seed. The seed alone selects the surface,
 * builds the (possibly randomized) valid base payload, chooses and applies
 * the mutations, so `runSeed(seed)` replays any row of the results table.
 *
 * Per iteration the runner checks:
 *  - the surface never throws an undocumented error (validators: never at all);
 *  - payloads flagged must-reject are rejected;
 *  - typed outputs carry no NaN/±Infinity and confidences stay in [0, 1];
 *  - two invocations on the same payload agree (determinism);
 *  - the payload is not mutated by the surface;
 *  - Object.prototype / Array.prototype are untouched afterwards;
 *  - no fs write happened (counter supplied by the test file's fs mock).
 */
import { checkArtifactInvariants } from "../../../src/invariants.js";
import { mutatePayload, type Mutation } from "./mutators.js";
import { iterationSeed, makeRng } from "./rng.js";
import { SURFACES, type Surface } from "./surfaces.js";

export const OUTCOMES = [
  // HELD — behaviour matched the contract
  "HELD_REJECTED",
  "HELD_ACCEPTED_BENIGN",
  "HELD_OK_OUTPUT",
  "HELD_DOCUMENTED_THROW",
  "HELD_CALLER_ERROR_PROPAGATED",
  // OBSERVE — outside the contract the lens can assert (typed API given a
  // structurally impossible value); recorded, never counted as BROKEN
  "OBSERVE_TYPED_THREW_ON_INVALID_SHAPE",
  "OBSERVE_TYPED_NON_FINITE_FROM_INVALID_SHAPE",
  // BROKEN
  "BROKEN_THREW",
  "BROKEN_ACCEPTED_INVALID",
  "BROKEN_NON_FINITE_OUTPUT",
  "BROKEN_OUTPUT_INVARIANT",
  "BROKEN_NONDETERMINISTIC",
  "BROKEN_INPUT_MUTATED",
  "BROKEN_PROTOTYPE_POLLUTED",
  "BROKEN_FS_WRITE",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

export function isBroken(outcome: Outcome): boolean {
  return outcome.startsWith("BROKEN_");
}

export interface IterationRow {
  seed: number;
  surface: string;
  kind: Surface["kind"];
  mutations: Mutation[];
  mustReject: boolean;
  /** What the surface did. */
  result: "accepted" | "rejected" | "threw";
  outcome: Outcome;
  /** Secondary violations detected alongside the primary outcome. */
  flags: Outcome[];
  problems?: string[];
  error?: { name: string; message: string; frame: string | null };
  nonFinitePaths?: string[];
  outputInvariantViolations?: string[];
  durationMs: number;
  /** Payload could not be serialized for stability checks (hostile getter / depth). */
  stabilityChecked: boolean;
  replay: string;
}

export interface CampaignSummary {
  campaignSeed: number;
  iterations: number;
  bySurface: Record<string, number>;
  byCategory: Record<string, number>;
  byOutcome: Record<string, number>;
  brokenSeeds: number[];
  slowestMs: number;
  totalMs: number;
}

export interface CampaignResult {
  summary: CampaignSummary;
  rows: IterationRow[];
}

export interface RunnerHooks {
  /** Monotonic count of fs write-ish calls observed so far (from the fs mock). */
  fsWriteCount: () => number;
}

const NOOP_HOOKS: RunnerHooks = { fsWriteCount: () => 0 };

/* ------------------------------------------------------------------------ *
 * Stable serialization (NaN/-0/undefined/holes/cycles aware, depth-guarded)
 * ------------------------------------------------------------------------ */

class DepthExceeded extends Error {}

export function stableSerialize(value: unknown, maxDepth = 1500): string {
  const seen = new WeakSet<object>();
  const walk = (node: unknown, depth: number): string => {
    if (depth > maxDepth) throw new DepthExceeded();
    if (node === undefined) return "undefined";
    if (node === null) return "null";
    switch (typeof node) {
      case "number":
        if (Number.isNaN(node)) return "NaN";
        if (node === 0 && 1 / node < 0) return "-0";
        return String(node);
      case "bigint":
        return `${node}n`;
      case "string":
        return JSON.stringify(node);
      case "boolean":
        return String(node);
      case "symbol":
        return node.toString();
      case "function":
        return `[Function ${node.name}]`;
      default:
        break;
    }
    const object = node as object;
    if (seen.has(object)) return "<cycle>";
    seen.add(object);
    try {
      if (object instanceof Date) return `Date(${object.getTime()})`;
      if (object instanceof Map) {
        return `Map{${[...object.entries()].map(([k, v]) => `${walk(k, depth + 1)}=>${walk(v, depth + 1)}`).join(",")}}`;
      }
      if (object instanceof Set)
        return `Set{${[...object].map((v) => walk(v, depth + 1)).join(",")}}`;
      if (Array.isArray(object)) {
        const parts: string[] = [];
        for (let index = 0; index < object.length; index += 1) {
          parts.push(index in object ? walk(object[index], depth + 1) : "<hole>");
        }
        return `[${parts.join(",")}]`;
      }
      const keys = Object.keys(object).sort();
      const proto = Object.getPrototypeOf(object) as object | null;
      const protoTag = proto === Object.prototype || proto === null ? "" : "<proto>";
      return `${protoTag}{${keys
        .map(
          (key) =>
            `${JSON.stringify(key)}:${walk((object as Record<string, unknown>)[key], depth + 1)}`,
        )
        .join(",")}}`;
    } finally {
      seen.delete(object);
    }
  };
  return walk(value, 0);
}

function trySerialize(value: unknown): string | null {
  try {
    return stableSerialize(value);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------ *
 * Output checks
 * ------------------------------------------------------------------------ */

function collectNonFinite(value: unknown, allow: readonly RegExp[]): string[] {
  const out: string[] = [];
  const seen = new WeakSet<object>();
  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > 200) return;
    if (typeof node === "number") {
      if (!Number.isFinite(node) && !allow.some((pattern) => pattern.test(path))) {
        out.push(`${path}=${String(node)}`);
      }
      if (/confidence$/i.test(path) && Number.isFinite(node) && (node < 0 || node > 1)) {
        out.push(`${path}=${node} (confidence outside [0,1])`);
      }
      return;
    }
    if (typeof node !== "object" || node === null) return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}.[${index}]`, depth + 1));
      return;
    }
    if (node instanceof Map || node instanceof Set || node instanceof Date) return;
    for (const [key, child] of Object.entries(node))
      walk(child, path === "" ? key : `${path}.${key}`, depth + 1);
  };
  walk(value, "", 0);
  return out;
}

/** The artifact invariant walker is recursive; an output that echoes a
 * deeply nested input overflows it — that is the harness's probe failing,
 * not the surface, so it is recorded as unwalkable rather than a violation. */
function outputInvariantViolations(output: unknown): string[] {
  try {
    return checkArtifactInvariants(output).map((v) => `${v.rule}@${v.path}`);
  } catch (error) {
    if (error instanceof RangeError) return [];
    throw error;
  }
}

function prototypesClean(): boolean {
  const probe: Record<string, unknown> = {};
  return (
    Object.keys(Object.prototype).length === 0 &&
    Object.keys(Array.prototype).length === 0 &&
    !("polluted" in probe) &&
    !("isAdmin" in probe) &&
    !("polluted" in []) &&
    Object.getOwnPropertyNames(Object.prototype).every(
      (name) => name !== "polluted" && name !== "isAdmin",
    )
  );
}

function errorFrame(error: unknown): string | null {
  if (!(error instanceof Error) || !error.stack) return null;
  const frame = error.stack
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .find((line) => line.includes("/src/") || line.includes("packages/"));
  return frame ?? null;
}

function describeError(error: unknown): NonNullable<IterationRow["error"]> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message.slice(0, 300), frame: errorFrame(error) };
  }
  return { name: typeof error, message: String(error).slice(0, 300), frame: null };
}

/* ------------------------------------------------------------------------ *
 * Iteration
 * ------------------------------------------------------------------------ */

export const REPLAY_HINT = (seed: number): string =>
  `STRESS_SEED=${seed} pnpm --filter @pickle/swing-lab test -- boundaryMalformed`;

const STRUCTURAL_CATEGORIES = new Set<Mutation["category"]>([
  "wrong_type",
  "top_level_shape",
  "sparse_array",
  "empty_container",
  "prototype_pollution",
  "deep_nesting",
  "truncated_json",
  "malformed_json_text",
  "oversized_string",
  "null_bytes",
]);

const UNSTABLE_TOP_LEVEL_VARIANTS = new Set(["proxy_throwing_getter", "getter_object"]);

export function runSeed(
  seed: number,
  hooks: RunnerHooks = NOOP_HOOKS,
  surfaces: readonly Surface[] = SURFACES,
): IterationRow {
  const rng = makeRng(seed);
  const surface = rng.pick(surfaces);
  const base = surface.base(rng);
  const { payload, mutations } = mutatePayload(base, rng, surface.hints, surface.categories);

  const oracle = surface.mustReject?.(mutations);
  const mustReject =
    surface.kind === "validator" && (oracle ?? mutations.some((mutation) => mutation.mustReject));

  const unstableInput = mutations.some(
    (mutation) =>
      mutation.category === "top_level_shape" && UNSTABLE_TOP_LEVEL_VARIANTS.has(mutation.variant),
  );
  const structurallyInvalid = mutations.some((mutation) =>
    STRUCTURAL_CATEGORIES.has(mutation.category),
  );
  const before = unstableInput ? null : trySerialize(payload);
  const writesBefore = hooks.fsWriteCount();

  const started = performance.now();
  let first: { ok: true; value: ReturnType<Surface["invoke"]> } | { ok: false; error: unknown };
  try {
    first = { ok: true, value: surface.invoke(payload) };
  } catch (error) {
    first = { ok: false, error };
  }
  const durationMs = performance.now() - started;

  let second: { ok: true; value: ReturnType<Surface["invoke"]> } | { ok: false; error: unknown };
  try {
    second = { ok: true, value: surface.invoke(payload) };
  } catch (error) {
    second = { ok: false, error };
  }

  const after = unstableInput ? null : trySerialize(payload);
  const writesAfter = hooks.fsWriteCount();

  const flags: Outcome[] = [];
  const row: Partial<IterationRow> = {};

  // Primary outcome
  let outcome: Outcome;
  if (!first.ok) {
    row.error = describeError(first.error);
    const hostileGetter =
      first.error instanceof Error &&
      first.error.message === "stress: hostile getter" &&
      unstableInput;
    if (hostileGetter) outcome = "HELD_CALLER_ERROR_PROPAGATED";
    else if (surface.documentedThrow?.(first.error)) outcome = "HELD_DOCUMENTED_THROW";
    else if (surface.kind === "typed" && structurallyInvalid)
      outcome = "OBSERVE_TYPED_THREW_ON_INVALID_SHAPE";
    else outcome = "BROKEN_THREW";
    row.result = "threw";
  } else if (first.value.kind === "rejected") {
    row.result = "rejected";
    row.problems = first.value.problems.slice(0, 6).map((problem) => problem.slice(0, 200));
    outcome = "HELD_REJECTED";
  } else {
    row.result = "accepted";
    if (mustReject) {
      outcome = "BROKEN_ACCEPTED_INVALID";
    } else if (surface.kind === "typed") {
      const nonFinite = collectNonFinite(first.value.output, surface.allowNonFiniteOutput ?? []);
      const invariantViolations = outputInvariantViolations(first.value.output);
      if (nonFinite.length > 0) {
        row.nonFinitePaths = nonFinite.slice(0, 8);
        outcome = structurallyInvalid
          ? "OBSERVE_TYPED_NON_FINITE_FROM_INVALID_SHAPE"
          : "BROKEN_NON_FINITE_OUTPUT";
      } else if (invariantViolations.length > 0) {
        row.outputInvariantViolations = invariantViolations.slice(0, 8);
        outcome = "BROKEN_OUTPUT_INVARIANT";
      } else {
        outcome = "HELD_OK_OUTPUT";
      }
    } else {
      outcome = "HELD_ACCEPTED_BENIGN";
    }
  }

  // Stability checks
  if (!unstableInput) {
    const firstText = first.ok
      ? trySerialize(first.value)
      : `threw:${describeError(first.error).message}`;
    const secondText = second.ok
      ? trySerialize(second.value)
      : `threw:${describeError(second.error).message}`;
    if (firstText !== secondText) flags.push("BROKEN_NONDETERMINISTIC");
    if (before !== null && after !== null && before !== after) flags.push("BROKEN_INPUT_MUTATED");
  }
  if (!prototypesClean()) {
    flags.push("BROKEN_PROTOTYPE_POLLUTED");
    // Restore so one polluted iteration cannot cascade into every later row.
    for (const name of ["polluted", "isAdmin"]) {
      delete (Object.prototype as unknown as Record<string, unknown>)[name];
      delete (Array.prototype as unknown as Record<string, unknown>)[name];
    }
  }
  if (writesAfter !== writesBefore) flags.push("BROKEN_FS_WRITE");

  // A stability/side-effect violation outranks a held primary outcome.
  if (!isBroken(outcome) && flags.length > 0) outcome = flags[0] as Outcome;

  return {
    seed,
    surface: surface.name,
    kind: surface.kind,
    mutations,
    mustReject,
    result: row.result as IterationRow["result"],
    outcome,
    flags,
    ...(row.problems ? { problems: row.problems } : {}),
    ...(row.error !== undefined ? { error: row.error } : {}),
    ...(row.nonFinitePaths ? { nonFinitePaths: row.nonFinitePaths } : {}),
    ...(row.outputInvariantViolations
      ? { outputInvariantViolations: row.outputInvariantViolations }
      : {}),
    durationMs: Math.round(durationMs * 1000) / 1000,
    stabilityChecked: !unstableInput && before !== null,
    replay: REPLAY_HINT(seed),
  };
}

/* ------------------------------------------------------------------------ *
 * Campaign
 * ------------------------------------------------------------------------ */

export function runCampaign(options: {
  campaignSeed: number;
  iterations: number;
  hooks?: RunnerHooks;
  surfaces?: readonly Surface[];
  onRow?: (row: IterationRow, index: number) => void;
}): CampaignResult {
  const rows: IterationRow[] = [];
  const bySurface: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const byOutcome: Record<string, number> = {};
  const brokenSeeds: number[] = [];
  let slowestMs = 0;
  const started = performance.now();
  for (let index = 0; index < options.iterations; index += 1) {
    const seed = iterationSeed(options.campaignSeed, index);
    const row = runSeed(seed, options.hooks ?? NOOP_HOOKS, options.surfaces ?? SURFACES);
    rows.push(row);
    bySurface[row.surface] = (bySurface[row.surface] ?? 0) + 1;
    for (const mutation of row.mutations) {
      byCategory[mutation.category] = (byCategory[mutation.category] ?? 0) + 1;
    }
    byOutcome[row.outcome] = (byOutcome[row.outcome] ?? 0) + 1;
    for (const flag of row.flags) {
      if (flag !== row.outcome) byOutcome[flag] = (byOutcome[flag] ?? 0) + 1;
    }
    if (isBroken(row.outcome)) brokenSeeds.push(seed);
    slowestMs = Math.max(slowestMs, row.durationMs);
    options.onRow?.(row, index);
  }
  return {
    summary: {
      campaignSeed: options.campaignSeed,
      iterations: rows.length,
      bySurface,
      byCategory,
      byOutcome,
      brokenSeeds,
      slowestMs,
      totalMs: Math.round(performance.now() - started),
    },
    rows,
  };
}

/** Re-run one seed N times and report how often it comes out BROKEN. */
export function flakeRate(
  seed: number,
  runs = 10,
  hooks: RunnerHooks = NOOP_HOOKS,
): { broken: number; runs: number; outcomes: Outcome[] } {
  const outcomes: Outcome[] = [];
  for (let index = 0; index < runs; index += 1) outcomes.push(runSeed(seed, hooks).outcome);
  return { broken: outcomes.filter(isBroken).length, runs, outcomes };
}
