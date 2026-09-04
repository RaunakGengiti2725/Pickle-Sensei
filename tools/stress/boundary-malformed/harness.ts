import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Rng, iterationSeed } from "./rng.js";
import {
  describeMutation,
  describeValue,
  type Category,
  type Mutation,
  type PathSegment,
} from "./payloads.js";

/**
 * Seeded boundary/malformed-input stress harness shared by the ops-bundle
 * packages (first-party-intake, hard-case-queue, incident-response,
 * release-ops, rollout, slo).
 *
 * Contract under test, per API call with a malformed input:
 *   - it is REJECTED with a typed / explicit error (or an explicit
 *     NOT_EVALUABLE-style result), never with a native engine error
 *     (TypeError, RangeError, …) escaping the API;
 *   - it never produces an output that violates the API's own documented
 *     invariants (`returned-invalid`);
 *   - it never writes / mutates state on the rejected path (checked by the
 *     package-specific executors and reported as `violations`);
 *   - the same seed produces the same classification twice (`replayConsistent`).
 *
 * Surfaces. A `boundary` case feeds bytes / parsed JSON / persisted records
 * into the API, so every mutation is fair game. A `typed` case calls a
 * TypeScript-typed in-process API whose only callers are typed code; there,
 * a failure whose minimized repro needs a mutation that breaks the runtime
 * SHAPE of the fixture (wrong primitive/array/object kind, deleted field) is
 * recorded as `shapeViolation` so the package test can document it as one
 * consolidated "no runtime guards on typed input" gap — while failures
 * reached with shape-correct values (NaN in a number, an unknown enum string,
 * a 64 KiB string, an extra `__proto__` own key) stay individually visible.
 *
 * Environment:
 *   STRESS_ITER=<n>     iterations per package (default 60 — fast enough for the suite)
 *   STRESS_SEED=<n>     campaign base seed (default 0x5eed0b0d)
 *   STRESS_REPLAY=<n>   run exactly one iteration with this per-iteration seed
 *   STRESS_OUT=<dir>    where the JSON seed→outcome table is written
 *                       (default <repo>/artifacts/stress/boundary-malformed)
 *   STRESS_TRACE=1      print every case (seed, api, mutations) to stderr before it runs,
 *                       so a hang can be attributed to a seed
 */

export type Outcome =
  | "accepted"
  | "rejected-typed"
  | "rejected-error"
  | "rejected-io"
  | "crash-native"
  | "returned-invalid";

export interface ExecResult {
  outcome: Outcome;
  /** Bounded, JSON-safe explanation (error message or invariant note). */
  detail: string;
  /** Invariant violations observed alongside the outcome (empty when none). */
  violations: string[];
  errorName?: string;
  /** Length of the thrown error message, when one was thrown. */
  messageLength?: number;
}

export interface ExecContext {
  seed: number;
  /** Fresh, empty scratch directory for this single execution. */
  tmpDir: string;
}

export interface GeneratedCase<TBase> {
  category: Category;
  base: TBase;
  mutations: Mutation[];
}

export type Surface = "boundary" | "typed";

export interface StressCase<TBase> {
  api: string;
  /** Default `boundary`; see the surface note in the file header. */
  surface?: Surface;
  /** Relative selection weight (default 1). */
  weight?: number;
  /**
   * The value the mutations are applied to (defaults to `base` itself); used
   * for shape analysis when `base` wraps several fixtures.
   */
  mutationRoot?(base: TBase): unknown;
  generate(rng: Rng): GeneratedCase<TBase>;
  execute(base: TBase, mutations: readonly Mutation[], ctx: ExecContext): ExecResult;
}

export interface Row {
  seed: number;
  iteration: number;
  pkg: string;
  api: string;
  category: Category;
  mutations: string[];
  outcome: Outcome;
  detail: string;
  errorName: string | null;
  messageLength: number | null;
  violations: string[];
  replayConsistent: boolean;
  replayDetail: string | null;
  failure: boolean;
  signature: string;
  surface: Surface;
  /**
   * True when the minimized repro needs a mutation that breaks the runtime
   * shape of the fixture (see the surface note). Only computed for failures.
   */
  shapeViolation: boolean;
  knownGap: string | null;
  minimized: string[] | null;
  durationMs: number;
}

export interface KnownGap {
  id: string;
  /** Human-readable statement of the reproduced, documented behaviour. */
  finding: string;
  matches(row: Row): boolean;
}

export interface FailureGroup {
  signature: string;
  api: string;
  outcome: Outcome;
  violations: string[];
  count: number;
  knownGap: string | null;
  seeds: number[];
  exampleSeed: number;
  exampleMutations: string[];
  minimizedMutations: string[] | null;
  detail: string;
}

export interface CampaignReport {
  pkg: string;
  lens: "boundary-malformed";
  baseSeed: number;
  iterations: number;
  replaySeed: number | null;
  node: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  summary: {
    byOutcome: Record<string, number>;
    byCategory: Record<string, number>;
    byApi: Record<string, number>;
    failures: number;
    unknownFailures: number;
    knownGapHits: Record<string, number>;
    nondeterministic: number;
    prototypePolluted: number;
    maxErrorMessageLength: number;
  };
  knownGaps: { id: string; finding: string; hits: number }[];
  failureGroups: FailureGroup[];
  rows: Row[];
}

export interface CampaignOptions<TBase> {
  pkg: string;
  cases: readonly StressCase<TBase>[];
  knownGaps?: readonly KnownGap[];
  /** Override for tests; defaults come from the STRESS_* environment. */
  iterations?: number;
  baseSeed?: number;
}

export const DEFAULT_ITERATIONS = 60;
export const DEFAULT_BASE_SEED = 0x5eed0b0d;

export function envIterations(): number {
  const raw = process.env["STRESS_ITER"];
  if (raw === undefined || raw === "") return DEFAULT_ITERATIONS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`STRESS_ITER must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/**
 * Vitest per-test budget for a campaign: every case runs twice (replay check)
 * and failures are minimized, so allow ~50 ms per iteration with a generous
 * floor. Pass as the timeout argument of the `it()` that runs the campaign.
 */
export function campaignTimeoutMs(iterations = envIterations()): number {
  return Math.max(30_000, iterations * 50);
}

export function envBaseSeed(): number {
  const raw = process.env["STRESS_SEED"];
  if (raw === undefined || raw === "") return DEFAULT_BASE_SEED;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff) {
    throw new Error(`STRESS_SEED must be a uint32, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export function envReplaySeed(): number | null {
  const raw = process.env["STRESS_REPLAY"];
  if (raw === undefined || raw === "") return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff) {
    throw new Error(`STRESS_REPLAY must be a uint32, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export function outputDir(repoRoot: string): string {
  const raw = process.env["STRESS_OUT"];
  return resolve(
    raw !== undefined && raw !== "" ? raw : join(repoRoot, "artifacts/stress/boundary-malformed"),
  );
}

/* ------------------------------------------------------------------------ */
/* Error classification                                                      */
/* ------------------------------------------------------------------------ */

const NATIVE_ERRORS: readonly (new (...args: never[]) => Error)[] = [
  TypeError,
  RangeError,
  ReferenceError,
  EvalError,
  URIError,
];

export const DETAIL_LIMIT = 240;

export function bounded(text: string, limit = DETAIL_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…(+${text.length - limit} chars)`;
}

/** Classifies a thrown value against the "typed rejection, never a native crash" contract. */
export function classifyThrown(thrown: unknown): ExecResult {
  if (!(thrown instanceof Error)) {
    return {
      outcome: "crash-native",
      detail: `non-Error value thrown: ${bounded(String(thrown))}`,
      violations: [],
      errorName: typeof thrown,
      messageLength: 0,
    };
  }
  const code = (thrown as Error & { code?: unknown }).code;
  const base = {
    detail: bounded(`${thrown.name}: ${thrown.message}`),
    violations: [] as string[],
    errorName: thrown.name,
    messageLength: thrown.message.length,
  };
  if (typeof code === "string" && /^(E[A-Z0-9]+|ERR_[A-Z0-9_]+)$/.test(code)) {
    return { outcome: "rejected-io", ...base, errorName: `${thrown.name}[${code}]` };
  }
  if (NATIVE_ERRORS.some((ctor) => thrown instanceof ctor)) {
    return { outcome: "crash-native", ...base };
  }
  if (thrown instanceof SyntaxError) {
    // JSON.parse at a documented "throws on malformed JSON" boundary.
    return { outcome: "rejected-error", ...base };
  }
  if (thrown.name !== "Error" && thrown.constructor !== Error) {
    return { outcome: "rejected-typed", ...base };
  }
  return { outcome: "rejected-error", ...base };
}

/**
 * Runs `fn`; on return, `validate` may report invariant violations of the
 * returned value (→ `returned-invalid`); on throw, the error is classified.
 */
export function runGuarded<T>(fn: () => T, validate?: (value: T) => string[]): ExecResult {
  let value: T;
  try {
    value = fn();
  } catch (thrown) {
    return classifyThrown(thrown);
  }
  const problems = validate ? validate(value) : [];
  if (problems.length > 0) {
    return { outcome: "returned-invalid", detail: bounded(problems.join("; ")), violations: [] };
  }
  return { outcome: "accepted", detail: "", violations: [] };
}

/* ------------------------------------------------------------------------ */
/* Shared invariant helpers                                                  */
/* ------------------------------------------------------------------------ */

/** True when a number is finite and not NaN (Infinity/NaN in outputs is a violation). */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * JSON.stringify that cannot throw on hostile values (BigInt, Symbol, cycles,
 * pathological depth): non-JSON leaves are replaced by their description and
 * any serializer failure degrades to a description of the whole value. Used
 * for before/after state snapshots inside executors.
 */
export function stableJson(value: unknown): string {
  try {
    const text = JSON.stringify(value, (_key, v: unknown) =>
      typeof v === "bigint" || typeof v === "symbol" || typeof v === "function"
        ? describeValue(v)
        : v,
    );
    return text === undefined ? "undefined" : text;
  } catch (thrown) {
    return `<unserializable ${describeValue(thrown)} ${describeValue(value)}>`;
  }
}

/** Walks a JSON-ish value and reports any NaN / ±Infinity reachable in it. */
export function findNonFinite(value: unknown, path = "$", out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;
  if (typeof value === "number" && !Number.isFinite(value)) {
    out.push(`${path}=${String(value)}`);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => findNonFinite(item, `${path}[${index}]`, out, depth + 1));
  } else if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      findNonFinite((value as Record<string, unknown>)[key], `${path}.${key}`, out, depth + 1);
    }
  }
  return out;
}

/** Reports own `__proto__` / `constructor` / `prototype` keys persisted anywhere in a value. */
export function findOwnProtoKeys(
  value: unknown,
  path = "$",
  out: string[] = [],
  depth = 0,
): string[] {
  if (depth > 8 || typeof value !== "object" || value === null) return out;
  if (Array.isArray(value)) {
    value.forEach((item, index) => findOwnProtoKeys(item, `${path}[${index}]`, out, depth + 1));
    return out;
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      out.push(`${path}.${key}`);
    }
    findOwnProtoKeys((value as Record<string, unknown>)[key], `${path}.${key}`, out, depth + 1);
  }
  return out;
}

const OBJECT_PROTO_KEYS = Object.getOwnPropertyNames(Object.prototype).sort().join(",");
const ARRAY_PROTO_KEYS = Object.getOwnPropertyNames(Array.prototype).sort().join(",");

/** Detects global prototype pollution after an execution. */
export function globalPrototypeViolations(): string[] {
  const out: string[] = [];
  const probe = {} as { polluted?: unknown };
  if (probe.polluted !== undefined) out.push("Object.prototype.polluted is set");
  if (Object.getOwnPropertyNames(Object.prototype).sort().join(",") !== OBJECT_PROTO_KEYS) {
    out.push("Object.prototype own keys changed");
  }
  if (Object.getOwnPropertyNames(Array.prototype).sort().join(",") !== ARRAY_PROTO_KEYS) {
    out.push("Array.prototype own keys changed");
  }
  return out;
}

/** Error messages that echo unbounded attacker-controlled input are a log-bomb surface. */
export const OVERSIZED_MESSAGE_BYTES = 16_384;

/* ------------------------------------------------------------------------ */
/* Shape analysis                                                            */
/* ------------------------------------------------------------------------ */

type RuntimeKind =
  | "null"
  | "array"
  | "object"
  | "string"
  | "number"
  | "boolean"
  | "bigint"
  | "symbol"
  | "undefined"
  | "function";

function runtimeKind(value: unknown): RuntimeKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const type = typeof value;
  return type === "object" ? "object" : type;
}

function valueAt(
  root: unknown,
  path: readonly PathSegment[],
): { present: boolean; value: unknown } {
  let cursor: unknown = root;
  for (const segment of path) {
    if (typeof cursor !== "object" || cursor === null) return { present: false, value: undefined };
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) {
      return { present: false, value: undefined };
    }
    cursor = (cursor as Record<PathSegment, unknown>)[segment];
  }
  return { present: true, value: cursor };
}

/**
 * True when `mutation` breaks the runtime shape of `base`: it replaces an
 * existing non-null value with one of a different runtime kind, or deletes an
 * existing field. Setting a same-kind value (NaN for a number, any string for
 * a string), adding a new key, or touching a `null` slot is NOT a shape break.
 */
export function breaksShape(base: unknown, mutation: Mutation): boolean {
  if (mutation.op === "text") return false;
  const existing = valueAt(base, mutation.path);
  if (!existing.present) return false;
  if (mutation.op === "delete") return true;
  const baseKind = runtimeKind(existing.value);
  if (baseKind === "null") return false;
  if (baseKind !== runtimeKind(mutation.value)) return true;
  if (baseKind === "object") {
    // Replacing an object with one that drops some of its fields is a
    // deletion in disguise; extra keys alone are not a shape break.
    const replacement = mutation.value as Record<string, unknown>;
    return Object.keys(existing.value as Record<string, unknown>).some(
      (key) => !Object.prototype.hasOwnProperty.call(replacement, key),
    );
  }
  return false;
}

/**
 * Known gap for `typed` surfaces: a native TypeError or an invalid result that
 * is only reachable by breaking the fixture's runtime shape. Rows with any
 * other violation (write, pollution, nondeterminism, oversized message) never
 * match, and neither do shape-correct repros.
 */
export function typedShapeGap(id: string, finding: string): KnownGap {
  return {
    id,
    finding,
    matches: (row) =>
      row.surface === "typed" &&
      row.shapeViolation &&
      row.violations.length === 0 &&
      ((row.outcome === "crash-native" && row.errorName === "TypeError") ||
        row.outcome === "returned-invalid"),
  };
}

/* ------------------------------------------------------------------------ */
/* Campaign runner                                                           */
/* ------------------------------------------------------------------------ */

function pickCase<TBase>(cases: readonly StressCase<TBase>[], rng: Rng): StressCase<TBase> {
  const total = cases.reduce((sum, c) => sum + (c.weight ?? 1), 0);
  let roll = rng.next() * total;
  for (const c of cases) {
    roll -= c.weight ?? 1;
    if (roll < 0) return c;
  }
  const last = cases[cases.length - 1];
  if (last === undefined) throw new Error("no stress cases registered");
  return last;
}

function normalizeDetail(detail: string, tmpDir: string): string {
  return detail.split(tmpDir).join("<tmp>");
}

function violationKinds(result: ExecResult): string {
  return [...new Set(result.violations.map((v) => v.split(":")[0] ?? v))].sort().join(",");
}

/** Coarse failure class: drives minimization (detail text may legitimately shrink). */
function failureClassOf(api: string, result: ExecResult): string {
  return `${api}|${result.outcome}|${violationKinds(result)}|${result.errorName ?? ""}`;
}

/** Grouping key: failure class plus a digit-stripped prefix of the detail. */
function signatureOf(api: string, result: ExecResult, tmpDir: string): string {
  const detailKey = normalizeDetail(result.detail, tmpDir)
    .replace(/\d+/g, "#")
    .replace(/[A-Za-z0-9+/=_-]{32,}/g, "<long>")
    .slice(0, 80);
  return `${failureClassOf(api, result)}|${detailKey}`;
}

function isFailure(result: ExecResult): boolean {
  return (
    result.outcome === "crash-native" ||
    result.outcome === "returned-invalid" ||
    result.violations.length > 0
  );
}

function withScratch<T>(seed: number, fn: (ctx: ExecContext) => T): T {
  const tmpDir = mkdtempSync(join(tmpdir(), `stress-bm-${seed.toString(16)}-`));
  try {
    return fn({ seed, tmpDir });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function executeChecked<TBase>(
  stressCase: StressCase<TBase>,
  base: TBase,
  mutations: readonly Mutation[],
  seed: number,
): { result: ExecResult; tmpDir: string } {
  let tmpDirSeen = "";
  const result = withScratch(seed, (ctx) => {
    tmpDirSeen = ctx.tmpDir;
    let inner: ExecResult;
    try {
      inner = stressCase.execute(base, mutations, ctx);
    } catch (thrown) {
      // The executor itself must never throw; a throw here is a harness bug
      // surfaced loudly rather than a package finding.
      const classified = classifyThrown(thrown);
      inner = {
        ...classified,
        outcome: "crash-native",
        detail: `HARNESS EXECUTOR THREW: ${classified.detail}`,
        violations: ["harness-executor-threw"],
      };
    }
    const globals = globalPrototypeViolations();
    if (globals.length > 0)
      inner.violations.push(...globals.map((g) => `prototype-polluted: ${g}`));
    if ((inner.messageLength ?? 0) > OVERSIZED_MESSAGE_BYTES) {
      inner.violations.push(`oversized-error-message: ${inner.messageLength} chars`);
    }
    inner.detail = normalizeDetail(inner.detail, ctx.tmpDir);
    return inner;
  });
  return { result, tmpDir: tmpDirSeen };
}

function minimize<TBase>(
  stressCase: StressCase<TBase>,
  base: TBase,
  mutations: readonly Mutation[],
  seed: number,
  failureClass: string,
): Mutation[] {
  let current = [...mutations];
  let changed = true;
  let budget = mutations.length * mutations.length + 8;
  while (changed && budget > 0) {
    changed = false;
    for (let i = 0; i < current.length && budget > 0; i += 1) {
      budget -= 1;
      const candidate = current.filter((_, index) => index !== i);
      const { result } = executeChecked(stressCase, base, candidate, seed);
      if (failureClassOf(stressCase.api, result) === failureClass) {
        current = candidate;
        changed = true;
        break;
      }
    }
  }
  return current;
}

export function runCampaign<TBase>(options: CampaignOptions<TBase>): CampaignReport {
  const startedAt = new Date();
  const replaySeed = envReplaySeed();
  const baseSeed = options.baseSeed ?? envBaseSeed();
  const iterations = replaySeed !== null ? 1 : (options.iterations ?? envIterations());
  const knownGaps = options.knownGaps ?? [];
  const rows: Row[] = [];
  const minimizedBySignature = new Map<string, Mutation[]>();

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const seed = replaySeed ?? iterationSeed(baseSeed, iteration);
    const rng = new Rng(seed);
    const stressCase = pickCase(options.cases, rng);
    const generated = stressCase.generate(rng);
    if (process.env["STRESS_TRACE"] === "1") {
      process.stderr.write(
        `[stress] #${iteration} seed=${seed} api=${stressCase.api} ` +
          `${generated.mutations.map(describeMutation).join(" | ")}\n`,
      );
    }
    const t0 = performance.now();
    const first = executeChecked(stressCase, generated.base, generated.mutations, seed);
    const second = executeChecked(stressCase, generated.base, generated.mutations, seed);
    const durationMs = performance.now() - t0;
    const signature = signatureOf(stressCase.api, first.result, first.tmpDir);
    const replaySignature = signatureOf(stressCase.api, second.result, second.tmpDir);
    const replayConsistent = signature === replaySignature;
    const violations = [...first.result.violations];
    if (!replayConsistent) violations.push("nondeterministic");
    const result: ExecResult = { ...first.result, violations };
    const failure = isFailure(result);
    const finalSignature = signatureOf(stressCase.api, result, first.tmpDir);

    let minimized: Mutation[] | null = null;
    if (failure) {
      let reduced = minimizedBySignature.get(finalSignature);
      if (reduced === undefined) {
        reduced = minimize(
          stressCase,
          generated.base,
          generated.mutations,
          seed,
          failureClassOf(stressCase.api, result),
        );
        minimizedBySignature.set(finalSignature, reduced);
      }
      minimized = reduced;
    }
    const root = stressCase.mutationRoot ? stressCase.mutationRoot(generated.base) : generated.base;
    const shapeViolation =
      minimized !== null && minimized.some((mutation) => breaksShape(root, mutation));

    const row: Row = {
      seed,
      iteration,
      pkg: options.pkg,
      api: stressCase.api,
      category: generated.category,
      mutations: generated.mutations.map(describeMutation),
      outcome: result.outcome,
      detail: result.detail,
      errorName: result.errorName ?? null,
      messageLength: result.messageLength ?? null,
      violations: result.violations,
      replayConsistent,
      replayDetail: replayConsistent ? null : second.result.detail,
      failure,
      signature: finalSignature,
      surface: stressCase.surface ?? "boundary",
      shapeViolation,
      knownGap: null,
      minimized: minimized === null ? null : minimized.map(describeMutation),
      durationMs: Math.round(durationMs * 1000) / 1000,
    };
    if (failure) row.knownGap = knownGaps.find((gap) => gap.matches(row))?.id ?? null;
    rows.push(row);
  }

  const finishedAt = new Date();
  return {
    pkg: options.pkg,
    lens: "boundary-malformed",
    baseSeed,
    iterations,
    replaySeed,
    node: process.version,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    summary: summarize(rows, knownGaps),
    knownGaps: knownGaps.map((gap) => ({
      id: gap.id,
      finding: gap.finding,
      hits: rows.filter((row) => row.knownGap === gap.id).length,
    })),
    failureGroups: groupFailures(rows),
    rows,
  };
}

function count(rows: readonly Row[], key: (row: Row) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) out[key(row)] = (out[key(row)] ?? 0) + 1;
  return out;
}

function summarize(
  rows: readonly Row[],
  knownGaps: readonly KnownGap[],
): CampaignReport["summary"] {
  const failures = rows.filter((row) => row.failure);
  const knownGapHits: Record<string, number> = {};
  for (const gap of knownGaps) knownGapHits[gap.id] = 0;
  for (const row of failures) {
    if (row.knownGap !== null) knownGapHits[row.knownGap] = (knownGapHits[row.knownGap] ?? 0) + 1;
  }
  return {
    byOutcome: count(rows, (row) => row.outcome),
    byCategory: count(rows, (row) => row.category),
    byApi: count(rows, (row) => row.api),
    failures: failures.length,
    unknownFailures: failures.filter((row) => row.knownGap === null).length,
    knownGapHits,
    nondeterministic: rows.filter((row) => !row.replayConsistent).length,
    prototypePolluted: rows.filter((row) =>
      row.violations.some((v) => v.startsWith("prototype-polluted")),
    ).length,
    maxErrorMessageLength: rows.reduce((max, row) => Math.max(max, row.messageLength ?? 0), 0),
  };
}

function groupFailures(rows: readonly Row[]): FailureGroup[] {
  const groups = new Map<string, FailureGroup>();
  for (const row of rows) {
    if (!row.failure) continue;
    const existing = groups.get(row.signature);
    if (existing) {
      existing.count += 1;
      if (existing.seeds.length < 20) existing.seeds.push(row.seed);
      continue;
    }
    groups.set(row.signature, {
      signature: row.signature,
      api: row.api,
      outcome: row.outcome,
      violations: row.violations,
      count: 1,
      knownGap: row.knownGap,
      seeds: [row.seed],
      exampleSeed: row.seed,
      exampleMutations: row.mutations,
      minimizedMutations: row.minimized,
      detail: row.detail,
    });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

/** Failures not explained by a documented known gap — the harness's hard assertion. */
export function unexplainedFailures(report: CampaignReport): Row[] {
  return report.rows.filter((row) => row.failure && row.knownGap === null);
}

export function writeReport(report: CampaignReport, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${report.pkg}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

/**
 * Suite-facing verdict: `null` when every failure is a documented known gap
 * and the run was deterministic / pollution-free; otherwise a message that
 * lists the unexplained rows (seed, api, mutations, minimized repro).
 */
export function campaignVerdict(report: CampaignReport, reportPath: string): string | null {
  const problems: string[] = [];
  const unexplained = unexplainedFailures(report);
  if (unexplained.length > 0) {
    problems.push(`${unexplained.length} unexplained failure(s):\n${formatFailures(unexplained)}`);
  }
  if (report.summary.nondeterministic > 0) {
    problems.push(`${report.summary.nondeterministic} nondeterministic row(s)`);
  }
  if (report.summary.prototypePolluted > 0) {
    problems.push(`${report.summary.prototypePolluted} prototype-polluted row(s)`);
  }
  if (report.rows.length !== report.iterations) {
    problems.push(`ran ${report.rows.length} of ${report.iterations} iterations`);
  }
  if (problems.length === 0) return null;
  return `${report.pkg} boundary-malformed campaign (seed ${report.baseSeed}, report ${reportPath}):\n${problems.join("\n")}`;
}

/** Compact human-readable summary for assertion messages. */
export function formatFailures(rows: readonly Row[], limit = 8): string {
  return rows
    .slice(0, limit)
    .map(
      (row) =>
        `seed=${row.seed} api=${row.api} category=${row.category} outcome=${row.outcome} ` +
        `violations=[${row.violations.join(",")}] detail=${row.detail}\n  mutations: ${row.mutations.join(" | ")}` +
        (row.minimized ? `\n  minimized: ${row.minimized.join(" | ") || "(base alone)"}` : ""),
    )
    .join("\n");
}
