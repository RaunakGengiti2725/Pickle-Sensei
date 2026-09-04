/**
 * Long-run-leak campaign runner (lens `long-run-leak`).
 *
 * Invokes a pure scenario N times in ONE process, replaying every seed twice
 * for determinism, and records after every `sampleEvery` iterations:
 *  - heap after a forced `gc()` (requires `--expose-gc`; recorded as
 *    unavailable otherwise — never silently skipped),
 *  - active handles/requests by type (`process.getActiveResourcesInfo`) and
 *    process-level listener counts, which must return to baseline,
 *  - per-bucket invocation-time percentiles for drift.
 *
 * Every output object is scanned for NaN/±Infinity. Verdict thresholds live in
 * `analyzeCampaign` and are reported alongside the raw samples so a reviewer
 * can re-derive them from the JSON table.
 */
import { performance } from "node:perf_hooks";
import { mixSeed } from "./rng.js";

export interface ScenarioResult {
  /** Everything the unit returned this iteration; fingerprinted and scanned. */
  outputs: unknown;
  /** Property violations observed (empty when the iteration HELD). */
  violations: string[];
  /** Counters for the report (number of sub-invocations, abstentions…). */
  stats: Record<string, number>;
}

export type Scenario = (seed: number) => ScenarioResult;

export interface CampaignOptions {
  name: string;
  baseSeed: number;
  iterations: number;
  sampleEvery: number;
  scenario: Scenario;
  /** Iterations treated as warm-up (JIT, lazy module state) and excluded from
   * the slope/drift verdicts; their samples are still recorded. */
  warmupIterations: number;
}

export interface HeapSample {
  iteration: number;
  gcForced: boolean;
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  arrayBuffers: number;
  handles: Record<string, number>;
  processListeners: Record<string, number>;
}

export interface TimingBucket {
  fromIteration: number;
  toIteration: number;
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  meanMs: number;
}

/**
 * Retained per iteration for the seed → outcome table. Kept deliberately
 * small (no per-row stats; a shared empty violations list) so the table
 * itself does not register as heap growth — per-row stats are folded into
 * `statsTotals`, and any seed replays to its full stats via STRESS_REPLAY_SEED.
 */
export interface IterationRow {
  iteration: number;
  seed: number;
  fingerprint: string;
  outcome: "HELD" | "BROKEN";
  violations: readonly string[];
  durationMs: number;
}

const NO_VIOLATIONS: readonly string[] = Object.freeze([]);

export interface HeapAnalysis {
  samples: number;
  steadySamples: number;
  slopeBytesPerIteration: number | null;
  slopePercentPer100Iterations: number | null;
  steadySlopeBytesPerIteration: number | null;
  steadySlopePercentPer100Iterations: number | null;
  /** Fraction of consecutive steady-state samples where heapUsed grew. */
  steadyMonotoneFraction: number | null;
  firstHeapUsed: number;
  lastHeapUsed: number;
  minHeapUsed: number;
  maxHeapUsed: number;
}

export interface CampaignReport {
  name: string;
  baseSeed: number;
  iterations: number;
  sampleEvery: number;
  warmupIterations: number;
  gcAvailable: boolean;
  node: string;
  startedAt: string;
  finishedAt: string;
  wallMs: number;
  rows: IterationRow[];
  heapSamples: HeapSample[];
  heapAnalysis: HeapAnalysis;
  timingBuckets: TimingBucket[];
  timingDrift: {
    baselineBucketP50Ms: number | null;
    finalBucketP50Ms: number | null;
    ratio: number | null;
  };
  handleBaseline: Record<string, number>;
  handleFinal: Record<string, number>;
  handleDelta: Record<string, number>;
  listenerBaseline: Record<string, number>;
  listenerFinal: Record<string, number>;
  listenerDelta: Record<string, number>;
  determinismReplays: Array<{ seed: number; recorded: string; replayed: string; equal: boolean }>;
  nonFinitePaths: Array<{ seed: number; path: string; value: string }>;
  statsTotals: Record<string, number>;
  verdicts: CampaignVerdicts;
}

export interface CampaignVerdicts {
  allIterationsHeld: boolean;
  deterministic: boolean;
  noNonFinite: boolean;
  handlesReturnedToBaseline: boolean;
  listenersReturnedToBaseline: boolean;
  /** Steady-state heap slope ≤ 5 % per 100 iterations (assignment threshold). */
  heapSlopeWithinBudget: boolean | null;
  /** Final-bucket p50 within 1.5× the first steady bucket p50. */
  invocationTimeStable: boolean | null;
}

export const HEAP_SLOPE_BUDGET_PERCENT_PER_100 = 5;
export const TIME_DRIFT_BUDGET_RATIO = 1.5;

type GcFn = () => void;

function resolveGc(): GcFn | null {
  const candidate = (globalThis as { gc?: unknown }).gc;
  return typeof candidate === "function" ? (candidate as GcFn) : null;
}

/** Stable JSON: sorted object keys, so fingerprints ignore insertion order. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner instanceof Date)
      return { $date: Number.isNaN(inner.getTime()) ? "invalid" : inner.toISOString() };
    if (typeof inner === "number" && !Number.isFinite(inner)) return { $nonFinite: String(inner) };
    if (typeof inner === "bigint") return { $bigint: inner.toString() };
    if (inner instanceof Map) return { $map: [...inner.entries()] };
    if (inner instanceof Set) return { $set: [...inner.values()] };
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(inner as Record<string, unknown>).sort()) {
        sorted[key] = (inner as Record<string, unknown>)[key];
      }
      return sorted;
    }
    return inner;
  });
}

/** Two independent 32-bit FNV-1a lanes over UTF-16 code units, hex encoded. */
export function fingerprint(value: unknown): string {
  const text = stableStringify(value) ?? "undefined";
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ ((code * 0x9e37) & 0xffff) ^ (code >>> 8), 0x01000193) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

export function collectNonFinite(
  value: unknown,
  path = "$",
  out: Array<{ path: string; value: string }> = [],
): Array<{ path: string; value: string }> {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) out.push({ path, value: String(value) });
    return out;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) out.push({ path, value: "InvalidDate" });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectNonFinite(item, `${path}[${index}]`, out));
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      collectNonFinite(inner, `${path}.${key}`, out);
    }
  }
  return out;
}

function countBy(items: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[item] = (out[item] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function activeHandles(): Record<string, number> {
  return countBy(process.getActiveResourcesInfo());
}

function processListeners(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of process.eventNames()) {
    out[String(name)] = process.listenerCount(name);
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function diffCounts(
  baseline: Record<string, number>,
  final: Record<string, number>,
): Record<string, number> {
  const keys = new Set([...Object.keys(baseline), ...Object.keys(final)]);
  const delta: Record<string, number> = {};
  for (const key of [...keys].sort()) {
    const d = (final[key] ?? 0) - (baseline[key] ?? 0);
    if (d !== 0) delta[key] = d;
  }
  return delta;
}

function takeHeapSample(iteration: number, gc: GcFn | null): HeapSample {
  if (gc) gc();
  const mem = process.memoryUsage();
  return {
    iteration,
    gcForced: gc !== null,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    rss: mem.rss,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers,
    handles: activeHandles(),
    processListeners: processListeners(),
  };
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] as number;
}

function bucketTimings(durations: readonly number[], size: number): TimingBucket[] {
  const buckets: TimingBucket[] = [];
  for (let start = 0; start < durations.length; start += size) {
    const slice = durations.slice(start, start + size);
    const sorted = [...slice].sort((a, b) => a - b);
    buckets.push({
      fromIteration: start + 1,
      toIteration: start + slice.length,
      count: slice.length,
      p50Ms: round(percentile(sorted, 0.5)),
      p95Ms: round(percentile(sorted, 0.95)),
      maxMs: round(sorted[sorted.length - 1] ?? Number.NaN),
      meanMs: round(slice.reduce((a, b) => a + b, 0) / slice.length),
    });
  }
  return buckets;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function linearSlope(points: ReadonlyArray<readonly [number, number]>): number | null {
  if (points.length < 2) return null;
  const n = points.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y] of points) {
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const denominator = n * sxx - sx * sx;
  if (denominator === 0) return null;
  return (n * sxy - sx * sy) / denominator;
}

export function analyzeHeap(
  samples: readonly HeapSample[],
  warmupIterations: number,
): HeapAnalysis {
  const used = samples.map((s) => s.heapUsed);
  const all = samples.map((s) => [s.iteration, s.heapUsed] as const);
  const steady = samples
    .filter((s) => s.iteration >= warmupIterations)
    .map((s) => [s.iteration, s.heapUsed] as const);
  const slope = linearSlope(all);
  const steadySlope = linearSlope(steady);
  const first = used[0] ?? 0;
  const steadyFirst = steady[0]?.[1] ?? 0;
  let grew = 0;
  for (let i = 1; i < steady.length; i += 1) {
    if ((steady[i]?.[1] ?? 0) > (steady[i - 1]?.[1] ?? 0)) grew += 1;
  }
  return {
    samples: samples.length,
    steadySamples: steady.length,
    slopeBytesPerIteration: slope,
    slopePercentPer100Iterations:
      slope === null || first === 0 ? null : (slope * 100 * 100) / first,
    steadySlopeBytesPerIteration: steadySlope,
    steadySlopePercentPer100Iterations:
      steadySlope === null || steadyFirst === 0 ? null : (steadySlope * 100 * 100) / steadyFirst,
    steadyMonotoneFraction: steady.length < 2 ? null : grew / (steady.length - 1),
    firstHeapUsed: first,
    lastHeapUsed: used[used.length - 1] ?? 0,
    minHeapUsed: used.length ? Math.min(...used) : 0,
    maxHeapUsed: used.length ? Math.max(...used) : 0,
  };
}

export function runCampaign(options: CampaignOptions): CampaignReport {
  const { name, baseSeed, iterations, sampleEvery, scenario, warmupIterations } = options;
  if (!Number.isInteger(iterations) || iterations < 1) throw new Error("iterations must be ≥ 1");
  if (!Number.isInteger(sampleEvery) || sampleEvery < 1) throw new Error("sampleEvery must be ≥ 1");
  const gc = resolveGc();
  const startedAt = new Date().toISOString();
  const wallStart = performance.now();

  // Warm the module graph once (lazy regex compilation, corpus imports) so the
  // iteration-0 handle/listener baseline reflects the unit at rest.
  scenario(mixSeed(baseSeed, 0));

  const heapSamples: HeapSample[] = [takeHeapSample(0, gc)];
  const handleBaseline = heapSamples[0]?.handles ?? {};
  const listenerBaseline = heapSamples[0]?.processListeners ?? {};

  const rows: IterationRow[] = [];
  const durations: number[] = [];
  const nonFinitePaths: CampaignReport["nonFinitePaths"] = [];
  const statsTotals: Record<string, number> = {};

  for (let i = 1; i <= iterations; i += 1) {
    const seed = mixSeed(baseSeed, i);
    const t0 = performance.now();
    const first = scenario(seed);
    const t1 = performance.now();
    const second = scenario(seed);
    const violations = [...first.violations];
    const fp1 = fingerprint(first.outputs);
    const fp2 = fingerprint(second.outputs);
    if (fp1 !== fp2) violations.push(`nondeterministic: same seed produced ${fp1} then ${fp2}`);
    const nonFinite = collectNonFinite(first.outputs);
    for (const hit of nonFinite) {
      violations.push(`non-finite output at ${hit.path} = ${hit.value}`);
      nonFinitePaths.push({ seed, ...hit });
    }
    for (const [key, value] of Object.entries(first.stats)) {
      statsTotals[key] = (statsTotals[key] ?? 0) + value;
    }
    durations.push(t1 - t0);
    rows.push({
      iteration: i,
      seed,
      fingerprint: fp1,
      outcome: violations.length === 0 ? "HELD" : "BROKEN",
      violations: violations.length === 0 ? NO_VIOLATIONS : violations,
      durationMs: round(t1 - t0),
    });
    if (i % sampleEvery === 0) heapSamples.push(takeHeapSample(i, gc));
  }
  if (iterations % sampleEvery !== 0) heapSamples.push(takeHeapSample(iterations, gc));

  // Cold replays after the whole campaign: the recorded fingerprint must be
  // reproducible once the process has churned through every other seed.
  const determinismReplays: CampaignReport["determinismReplays"] = [];
  for (const row of rows) {
    if (row.iteration % sampleEvery !== 0 && row.iteration !== iterations) continue;
    const replayed = fingerprint(scenario(row.seed).outputs);
    determinismReplays.push({
      seed: row.seed,
      recorded: row.fingerprint,
      replayed,
      equal: replayed === row.fingerprint,
    });
  }

  const finalSample = takeHeapSample(iterations, gc);
  const handleFinal = finalSample.handles;
  const listenerFinal = finalSample.processListeners;
  const handleDelta = diffCounts(handleBaseline, handleFinal);
  const listenerDelta = diffCounts(listenerBaseline, listenerFinal);

  const heapAnalysis = analyzeHeap(heapSamples, warmupIterations);
  const timingBuckets = bucketTimings(durations, sampleEvery);
  const steadyBuckets = timingBuckets.filter((b) => b.fromIteration > warmupIterations);
  const baselineBucket = steadyBuckets[0] ?? null;
  const finalBucket =
    steadyBuckets.length > 1 ? (steadyBuckets[steadyBuckets.length - 1] ?? null) : null;
  const driftRatio =
    baselineBucket && finalBucket && baselineBucket.p50Ms > 0
      ? round(finalBucket.p50Ms / baselineBucket.p50Ms)
      : null;

  const verdicts: CampaignVerdicts = {
    allIterationsHeld: rows.every((r) => r.outcome === "HELD"),
    deterministic:
      rows.every((r) => !r.violations.some((v) => v.startsWith("nondeterministic"))) &&
      determinismReplays.every((r) => r.equal),
    noNonFinite: nonFinitePaths.length === 0,
    handlesReturnedToBaseline: Object.keys(handleDelta).length === 0,
    listenersReturnedToBaseline: Object.keys(listenerDelta).length === 0,
    heapSlopeWithinBudget:
      gc === null || heapAnalysis.steadySlopePercentPer100Iterations === null
        ? null
        : heapAnalysis.steadySlopePercentPer100Iterations <= HEAP_SLOPE_BUDGET_PERCENT_PER_100,
    invocationTimeStable: driftRatio === null ? null : driftRatio <= TIME_DRIFT_BUDGET_RATIO,
  };

  return {
    name,
    baseSeed,
    iterations,
    sampleEvery,
    warmupIterations,
    gcAvailable: gc !== null,
    node: process.version,
    startedAt,
    finishedAt: new Date().toISOString(),
    wallMs: round(performance.now() - wallStart),
    rows,
    heapSamples,
    heapAnalysis,
    timingBuckets,
    timingDrift: {
      baselineBucketP50Ms: baselineBucket?.p50Ms ?? null,
      finalBucketP50Ms: finalBucket?.p50Ms ?? null,
      ratio: driftRatio,
    },
    handleBaseline,
    handleFinal,
    handleDelta,
    listenerBaseline,
    listenerFinal,
    listenerDelta,
    determinismReplays,
    nonFinitePaths,
    statsTotals,
    verdicts,
  };
}

/** Compact seed → outcome table for the uploaded artifact. */
export function seedTable(report: CampaignReport): Array<{
  iteration: number;
  seed: number;
  outcome: "HELD" | "BROKEN";
  fingerprint: string;
  durationMs: number;
  violations: string[];
}> {
  return report.rows.map((row) => ({
    iteration: row.iteration,
    seed: row.seed,
    outcome: row.outcome,
    fingerprint: row.fingerprint,
    durationMs: row.durationMs,
    violations: [...row.violations],
  }));
}

/**
 * Harness floor: a scenario that touches none of the unit. Running it with the
 * same iteration count quantifies the campaign's own retention (rows, timing
 * samples, V8 feedback), so the unit's slope can be read net of it.
 */
export const noopScenario: Scenario = (seed) => ({
  outputs: { seed },
  violations: [],
  stats: { noop: 1 },
});

export interface CampaignEnv {
  iterations: number;
  sampleEvery: number;
  baseSeed: number;
  replaySeed: number | null;
  outPath: string | null;
}

/**
 * STRESS_ITER  — iterations (default 20 so the file stays cheap in the suite;
 *                the assignment campaign is ≥ 500).
 * STRESS_SAMPLE_EVERY — heap sample cadence (default 50).
 * STRESS_SEED  — campaign base seed (default 20260904).
 * STRESS_REPLAY_SEED — replay exactly one iteration seed and report it.
 * STRESS_OUT   — write the full JSON report to this path.
 */
export function readCampaignEnv(env: NodeJS.ProcessEnv = process.env): CampaignEnv {
  const parse = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new Error(`invalid stress env value: ${raw}`);
    return n;
  };
  const replay = env.STRESS_REPLAY_SEED;
  return {
    iterations: parse(env.STRESS_ITER, 20),
    sampleEvery: parse(env.STRESS_SAMPLE_EVERY, 50),
    baseSeed: parse(env.STRESS_SEED, 20260904),
    replaySeed: replay === undefined || replay === "" ? null : Number(replay) >>> 0,
    outPath: env.STRESS_OUT && env.STRESS_OUT !== "" ? env.STRESS_OUT : null,
  };
}
