/**
 * Long-run leak stress harness for packages/evaluation (runner + comparator).
 *
 * Every campaign invokes one unit N times in THIS process, forces a full GC
 * every `probeEvery` iterations and records heap, RSS, active libuv resources
 * and process signal listeners. Every iteration is replayable from its seed
 * (`deriveSeed(campaignSeed, index)`); the per-iteration table plus the heap
 * table are written as JSON so a failing seed can be re-run in isolation.
 *
 * Verdicts (per campaign):
 *  - any iteration outcome other than the expected one          -> BROKEN
 *  - signal listeners / active resources not back at baseline   -> BROKEN
 *  - post-warmup heap slope > HEAP_SLOPE_LIMIT_PCT_PER_100 iters -> BROKEN
 *  - otherwise                                                   -> HELD
 *
 * Standalone (full campaign, GC exposed by node):
 *   NODE_OPTIONS=--expose-gc packages/evaluation/node_modules/.bin/tsx \
 *     packages/evaluation/test/stress/longRunLeak.ts --iterations 500 --seed 20260904 \
 *     --out-dir artifacts/stress/pkg-evaluation-long-run-leak
 * The vitest wrapper (test/stressLongRunLeak.test.ts) runs the same campaigns
 * at STRESS_ITER (small default) and obtains `gc` through v8 flags when the
 * worker was not started with --expose-gc.
 */
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { REPO_ROOT, benchDefinitions } from "../../src/regression/benches.js";
import { main as cliMain } from "../../src/regression/cli.js";
import { compareSummaries, formatCompareReport } from "../../src/regression/compare.js";
import {
  HANDLED_SIGNALS,
  RunInterruptedError,
  runRegression,
  type HandledSignal,
} from "../../src/regression/run.js";
import {
  flattenBenchMetrics,
  validateRegressionSummary,
  type BenchRecord,
  type RegressionSummary,
} from "../../src/regression/summarySchema.js";
import { validateToleranceConfig, type ToleranceConfig } from "../../src/regression/tolerances.js";

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) + per-iteration seed derivation (splitmix-style hash)
// ---------------------------------------------------------------------------

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function deriveSeed(campaignSeed: number, index: number): number {
  let h = (campaignSeed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

function int(rng: Rng, minInclusive: number, maxExclusive: number): number {
  return minInclusive + Math.floor(rng() * (maxExclusive - minInclusive));
}

// ---------------------------------------------------------------------------
// GC + resource probes
// ---------------------------------------------------------------------------

type GcFn = () => void;

/** `global.gc` when node ran with --expose-gc, else exposed at runtime. */
export function obtainGc(): { gc: GcFn; source: "expose-gc-flag" | "v8-runtime-flag" } {
  const existing = (globalThis as { gc?: GcFn }).gc;
  if (typeof existing === "function") return { gc: existing, source: "expose-gc-flag" };
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as GcFn;
  if (typeof gc !== "function") throw new Error("could not obtain a gc() function");
  return { gc, source: "v8-runtime-flag" };
}

export interface ResourceProbe {
  iteration: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  rssBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  /** Count per libuv resource type (process.getActiveResourcesInfo()). */
  activeResources: Record<string, number>;
  signalListeners: Record<HandledSignal, number>;
}

function countBy(items: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items.sort()) counts[item] = (counts[item] ?? 0) + 1;
  return counts;
}

const settle = (): Promise<void> => new Promise((done) => setImmediate(done));

/** Two macrotask turns let closed handles (ChildProcess/Pipe) leave the
 *  active-resource list, then a double GC gives a stable heapUsed. */
export async function probe(gc: GcFn, iteration: number): Promise<ResourceProbe> {
  await settle();
  await settle();
  gc();
  gc();
  const memory = process.memoryUsage();
  const listeners = {} as Record<HandledSignal, number>;
  for (const signal of HANDLED_SIGNALS) listeners[signal] = process.listenerCount(signal);
  return {
    iteration,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    rssBytes: memory.rss,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    activeResources: countBy([...process.getActiveResourcesInfo()]),
    signalListeners: listeners,
  };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export const HEAP_SLOPE_LIMIT_PCT_PER_100 = 5;
export const TIME_DRIFT_LIMIT_RATIO = 1.5;
/** Below this median an iteration is dominated by hrtime/GC/scheduler jitter
 *  (tens of microseconds), so a ratio there is reported but not judged. */
export const TIME_DRIFT_MIN_MEDIAN_MS = 1;

export interface HeapAnalysis {
  samples: number;
  warmupSamplesSkipped: number;
  firstHeapUsedBytes: number | null;
  lastHeapUsedBytes: number | null;
  /** Least-squares slope over post-warmup samples, bytes per iteration. */
  slopeBytesPerIteration: number | null;
  /** slope * 100 iterations, as a % of the first post-warmup heap. */
  slopePctPer100Iterations: number | null;
  netGrowthPct: number | null;
  /** Every post-warmup sample strictly above its predecessor. */
  monotoneIncreasing: boolean | null;
  verdict: "HELD" | "BROKEN" | "INSUFFICIENT_SAMPLES";
}

/** Fewer probes than this, or a span shorter than this many iterations,
 *  cannot support a "% per 100 iterations" statement (it would be a
 *  >10x extrapolation from JIT/cache warm-up noise). */
export const MIN_HEAP_SAMPLES = 3;
export const MIN_HEAP_SPAN_ITERATIONS = 100;

export function analyseHeap(probes: ResourceProbe[], warmupSamples: number): HeapAnalysis {
  const kept = probes.slice(warmupSamples);
  const span = kept.length > 0 ? kept.at(-1)!.iteration - kept[0]!.iteration : 0;
  if (kept.length < MIN_HEAP_SAMPLES || span < MIN_HEAP_SPAN_ITERATIONS) {
    return {
      samples: probes.length,
      warmupSamplesSkipped: warmupSamples,
      firstHeapUsedBytes: kept[0]?.heapUsedBytes ?? null,
      lastHeapUsedBytes: kept.at(-1)?.heapUsedBytes ?? null,
      slopeBytesPerIteration: null,
      slopePctPer100Iterations: null,
      netGrowthPct: null,
      monotoneIncreasing: null,
      verdict: "INSUFFICIENT_SAMPLES",
    };
  }
  const n = kept.length;
  const meanX = kept.reduce((sum, p) => sum + p.iteration, 0) / n;
  const meanY = kept.reduce((sum, p) => sum + p.heapUsedBytes, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const p of kept) {
    sxy += (p.iteration - meanX) * (p.heapUsedBytes - meanY);
    sxx += (p.iteration - meanX) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const first = kept[0]!.heapUsedBytes;
  const last = kept.at(-1)!.heapUsedBytes;
  const slopePct = ((slope * 100) / first) * 100;
  let monotone = true;
  for (let i = 1; i < kept.length; i += 1) {
    if (kept[i]!.heapUsedBytes <= kept[i - 1]!.heapUsedBytes) monotone = false;
  }
  return {
    samples: probes.length,
    warmupSamplesSkipped: warmupSamples,
    firstHeapUsedBytes: first,
    lastHeapUsedBytes: last,
    slopeBytesPerIteration: slope,
    slopePctPer100Iterations: slopePct,
    netGrowthPct: ((last - first) / first) * 100,
    monotoneIncreasing: monotone,
    verdict: slopePct > HEAP_SLOPE_LIMIT_PCT_PER_100 ? "BROKEN" : "HELD",
  };
}

export interface TimingAnalysis {
  iterations: number;
  medianFirstFifthMs: number | null;
  medianLastFifthMs: number | null;
  driftRatio: number | null;
  verdict: "HELD" | "DRIFT" | "INSUFFICIENT_SAMPLES" | "BELOW_RESOLUTION";
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function analyseTiming(durationsMs: number[]): TimingAnalysis {
  if (durationsMs.length < 10) {
    return {
      iterations: durationsMs.length,
      medianFirstFifthMs: null,
      medianLastFifthMs: null,
      driftRatio: null,
      verdict: "INSUFFICIENT_SAMPLES",
    };
  }
  const fifth = Math.max(1, Math.floor(durationsMs.length / 5));
  // Skip the very first iteration: it pays module/JIT warm-up.
  const head = median(durationsMs.slice(1, 1 + fifth));
  const tail = median(durationsMs.slice(-fifth));
  const ratio = head === 0 ? (tail === 0 ? 1 : Number.POSITIVE_INFINITY) : tail / head;
  let verdict: TimingAnalysis["verdict"];
  if (head < TIME_DRIFT_MIN_MEDIAN_MS && tail < TIME_DRIFT_MIN_MEDIAN_MS) {
    verdict = "BELOW_RESOLUTION";
  } else {
    verdict = ratio > TIME_DRIFT_LIMIT_RATIO ? "DRIFT" : "HELD";
  }
  return {
    iterations: durationsMs.length,
    medianFirstFifthMs: head,
    medianLastFifthMs: tail,
    driftRatio: ratio,
    verdict,
  };
}

export interface ResourceDelta {
  field: string;
  baseline: number;
  final: number;
  /** Only growth can be a leak of the unit; a decrease means something the
   *  host (e.g. a test runner timer) held at baseline went away. */
  leaked: boolean;
}

/** Resources/listeners that did not return to their pre-campaign counts. */
export function resourceDeltas(baseline: ResourceProbe, final: ResourceProbe): ResourceDelta[] {
  const deltas: ResourceDelta[] = [];
  const keys = new Set([
    ...Object.keys(baseline.activeResources),
    ...Object.keys(final.activeResources),
  ]);
  for (const key of [...keys].sort()) {
    const a = baseline.activeResources[key] ?? 0;
    const b = final.activeResources[key] ?? 0;
    if (a !== b) {
      deltas.push({ field: `activeResources.${key}`, baseline: a, final: b, leaked: b > a });
    }
  }
  for (const signal of HANDLED_SIGNALS) {
    const a = baseline.signalListeners[signal];
    const b = final.signalListeners[signal];
    if (a !== b) {
      deltas.push({ field: `signalListeners.${signal}`, baseline: a, final: b, leaked: b > a });
    }
  }
  return deltas;
}

// ---------------------------------------------------------------------------
// Campaign scaffolding
// ---------------------------------------------------------------------------

/** In-memory row: fixed-size fields only, so the harness's own bookkeeping
 *  adds a few dozen bytes per iteration and cannot masquerade as a leak of
 *  the unit. Free-text detail goes to the JSONL sidecar (`rowsPath`) and is
 *  kept in memory only for rows with an unexpected outcome. */
export interface IterationRow {
  index: number;
  seed: number;
  outcome: string;
  durationMs: number;
}

export interface FailingRow extends IterationRow {
  detail: string;
}

export interface CampaignReport {
  campaign: string;
  unit: string;
  campaignSeed: number;
  iterationsRequested: number;
  iterationsExecuted: number;
  probeEvery: number;
  gcSource: string;
  expectedOutcomes: string[];
  outcomeCounts: Record<string, number>;
  failingSeeds: FailingRow[];
  /** Full seed -> outcome table, one row per executed iteration. */
  rows: IterationRow[];
  /** JSONL sidecar with per-row detail, when `rowsPath` was given. */
  rowsPath: string | null;
  probes: ResourceProbe[];
  baselineProbe: ResourceProbe;
  finalProbe: ResourceProbe;
  resourceDeltas: ResourceDelta[];
  heap: HeapAnalysis;
  timing: TimingAnalysis;
  extraChecks: { name: string; ok: boolean; detail: string }[];
  verdict: "HELD" | "BROKEN";
  reasons: string[];
  wallClockMs: number;
}

export interface CampaignOptions {
  iterations: number;
  campaignSeed: number;
  probeEvery?: number;
  /** Heap samples ignored for the slope (module caches / JIT warm-up). */
  warmupSamples?: number;
  /** Append one JSON line per iteration (index, seed, outcome, ms, detail). */
  rowsPath?: string;
  log?: (line: string) => void;
}

interface CampaignSpec {
  campaign: string;
  unit: string;
  expectedOutcomes: string[];
  /** One warm-up iteration is run before the baseline probe so first-touch
   *  module state (dataset loaders, JIT) is not mistaken for a leak. */
  warmup: (rng: Rng) => Promise<void>;
  iterate: (index: number, seed: number, rng: Rng) => Promise<{ outcome: string; detail: string }>;
  /** Assertions evaluated once after the loop (e.g. no stray files). */
  finalChecks?: () => Promise<{ name: string; ok: boolean; detail: string }[]>;
}

async function runCampaign(spec: CampaignSpec, options: CampaignOptions): Promise<CampaignReport> {
  const started = Date.now();
  const log = options.log ?? (() => {});
  const probeEvery = options.probeEvery ?? 50;
  const warmupSamples = options.warmupSamples ?? 2;
  const { gc, source } = obtainGc();

  const rowsPath = options.rowsPath ?? null;
  if (rowsPath !== null) writeFileSync(rowsPath, "");
  const expected = new Set(spec.expectedOutcomes);

  await spec.warmup(mulberry32(deriveSeed(options.campaignSeed, -1)));
  const baselineProbe = await probe(gc, 0);
  const probes: ResourceProbe[] = [baselineProbe];
  const rows: IterationRow[] = [];
  const failingSeeds: FailingRow[] = [];
  const durations: number[] = [];

  for (let index = 0; index < options.iterations; index += 1) {
    const seed = deriveSeed(options.campaignSeed, index);
    const rng = mulberry32(seed);
    const t0 = process.hrtime.bigint();
    let outcome: string;
    let detail: string;
    try {
      ({ outcome, detail } = await spec.iterate(index, seed, rng));
    } catch (error) {
      outcome = "threw";
      detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    }
    const durationMs = Number(process.hrtime.bigint() - t0) / 1e6;
    durations.push(durationMs);
    rows.push({ index, seed, outcome, durationMs });
    if (!expected.has(outcome)) failingSeeds.push({ index, seed, outcome, durationMs, detail });
    if (rowsPath !== null) {
      appendFileSync(rowsPath, `${JSON.stringify({ index, seed, outcome, durationMs, detail })}\n`);
    }
    if ((index + 1) % probeEvery === 0) {
      const p = await probe(gc, index + 1);
      probes.push(p);
      log(
        `[${spec.campaign}] iter ${index + 1}/${options.iterations} heapUsed=${(p.heapUsedBytes / 1048576).toFixed(2)}MiB rss=${(p.rssBytes / 1048576).toFixed(1)}MiB resources=${JSON.stringify(p.activeResources)} listeners=${JSON.stringify(p.signalListeners)}`,
      );
    }
  }
  const finalProbe = await probe(gc, options.iterations);
  if (options.iterations % probeEvery !== 0) probes.push(finalProbe);

  const outcomeCounts: Record<string, number> = {};
  for (const row of rows) outcomeCounts[row.outcome] = (outcomeCounts[row.outcome] ?? 0) + 1;
  const deltas = resourceDeltas(baselineProbe, finalProbe);
  const heap = analyseHeap(probes, warmupSamples);
  const timing = analyseTiming(durations);
  const extraChecks = spec.finalChecks ? await spec.finalChecks() : [];

  const reasons: string[] = [];
  if (failingSeeds.length > 0) {
    reasons.push(
      `${failingSeeds.length} iteration(s) with unexpected outcome: ${[...new Set(failingSeeds.map((r) => r.outcome))].join(", ")}`,
    );
  }
  const leaked = deltas.filter((d) => d.leaked);
  if (leaked.length > 0) {
    reasons.push(
      `resources above baseline: ${leaked.map((d) => `${d.field} ${d.baseline}->${d.final}`).join(", ")}`,
    );
  }
  if (heap.verdict === "BROKEN") {
    reasons.push(
      `heap slope ${heap.slopePctPer100Iterations!.toFixed(2)}% per 100 iterations > ${HEAP_SLOPE_LIMIT_PCT_PER_100}%`,
    );
  }
  for (const check of extraChecks) if (!check.ok) reasons.push(`${check.name}: ${check.detail}`);

  return {
    campaign: spec.campaign,
    unit: spec.unit,
    campaignSeed: options.campaignSeed,
    iterationsRequested: options.iterations,
    iterationsExecuted: rows.length,
    probeEvery,
    gcSource: source,
    expectedOutcomes: spec.expectedOutcomes,
    outcomeCounts,
    failingSeeds,
    rows,
    rowsPath,
    probes,
    baselineProbe,
    finalProbe,
    resourceDeltas: deltas,
    heap,
    timing,
    extraChecks,
    verdict: reasons.length === 0 ? "HELD" : "BROKEN",
    reasons,
    wallClockMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Walks any JSON-like value and returns paths holding NaN / ±Infinity. */
export function nonFinitePaths(value: unknown, path = "$"): string[] {
  if (typeof value === "number") return Number.isFinite(value) ? [] : [path];
  if (Array.isArray(value))
    return value.flatMap((item, i) => nonFinitePaths(item, `${path}[${i}]`));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => nonFinitePaths(v, `${path}.${k}`));
  }
  return [];
}

const BOUNDED_UNIT_INTERVAL =
  /(\.|^)(coverage|abstention_rate|accuracy|accuracy_when_answering|recall|contact_inside_rate|wrong_marker_rate_of_estimated)$/;
const NON_NEGATIVE_COUNT =
  /(\.|^)(abstained|estimated|target_events|n|gold_events|l1_abstained|l2_abstained)$/;

/** Metric-domain invariants that hold by construction for every bench. */
export function metricDomainViolations(metrics: Record<string, number | null>): string[] {
  const violations: string[] = [];
  for (const [key, value] of Object.entries(metrics)) {
    if (value === null) continue;
    if (BOUNDED_UNIT_INTERVAL.test(key) && (value < 0 || value > 1)) {
      violations.push(`${key}=${value} outside [0,1]`);
    }
    if (NON_NEGATIVE_COUNT.test(key) && (!Number.isInteger(value) || value < 0)) {
      violations.push(`${key}=${value} not a non-negative integer`);
    }
  }
  const t = metrics["contact_replay.target_events"];
  const e = metrics["contact_replay.estimated"];
  const a = metrics["contact_replay.abstained"];
  if (typeof t === "number" && typeof e === "number" && typeof a === "number" && e + a !== t) {
    violations.push(`contact_replay estimated+abstained=${e + a} != target_events=${t}`);
  }
  return violations;
}

function benchIdsByKind(): { inProcess: string[]; subprocess: string[] } {
  const defs = benchDefinitions(() => Promise.reject(new Error("not run")), "/nonexistent");
  return {
    inProcess: defs.filter((d) => d.kind === "in_process").map((d) => d.id),
    subprocess: defs.filter((d) => d.kind === "subprocess").map((d) => d.id),
  };
}

function untrackedDatasetFiles(): string[] {
  return execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "datasets"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3));
}

function scratchDirsIn(dir: string): string[] {
  return existsSync(dir)
    ? readdirSync(dir).filter((name) => name.startsWith("pickle-regression-"))
    : [];
}

/** Metrics/labels only: wallClockMs and generatedAt legitimately vary. */
function stableBenchView(bench: BenchRecord): string {
  return JSON.stringify({
    status: bench.status,
    exitCode: bench.exitCode,
    error: bench.error,
    metrics: bench.metrics,
    labels: bench.labels,
  });
}

interface RunnerContext {
  outDir: string;
  tmpDir: string;
  /** First-seen stable view per bench id: later runs must match exactly. */
  expected: Map<string, string>;
}

async function runOnce(
  ctx: RunnerContext,
  only: string[],
  runId: string,
): Promise<{ outcome: string; detail: string }> {
  const result = await runRegression({ outDir: ctx.outDir, only, runId, log: () => {} });
  try {
    if (result.exitCode !== 0) {
      const failed = result.summary.benches.filter((b) => b.status === "failed");
      return {
        outcome: "bench_failed",
        detail: failed.map((b) => `${b.id}: ${b.error?.split("\n")[0]}`).join(" | "),
      };
    }
    const onDisk: unknown = JSON.parse(readFileSync(result.outPath, "utf8"));
    const validated = validateRegressionSummary(onDisk);
    if (!validated.ok) return { outcome: "invalid_summary", detail: validated.failure.message };
    const ids = result.summary.benches.map((b) => b.id);
    if (ids.join(",") !== only.join(",")) {
      return { outcome: "wrong_bench_set", detail: `${ids.join(",")} != ${only.join(",")}` };
    }
    const nonFinite = nonFinitePaths(result.summary);
    if (nonFinite.length > 0) return { outcome: "non_finite", detail: nonFinite.join(", ") };
    const domain = metricDomainViolations(result.summary.metrics);
    if (domain.length > 0) return { outcome: "metric_domain", detail: domain.join("; ") };
    for (const bench of result.summary.benches) {
      const view = stableBenchView(bench);
      const seen = ctx.expected.get(bench.id);
      if (seen === undefined) ctx.expected.set(bench.id, view);
      else if (seen !== view) {
        return { outcome: "nondeterministic", detail: `${bench.id}: ${seen} != ${view}` };
      }
    }
    const scratch = scratchDirsIn(ctx.tmpDir);
    if (scratch.length > 0) return { outcome: "scratch_left", detail: scratch.join(",") };
    return { outcome: "ok", detail: `${only.join(",")} ${result.summary.totalWallClockMs}ms` };
  } finally {
    rmSync(result.outPath, { force: true });
  }
}

function withTmpDir<T>(tmpDir: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = tmpDir;
  return body().finally(() => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  });
}

function orderedSubset(rng: Rng, ordered: readonly string[]): string[] {
  const chosen = ordered.filter(() => rng() < 0.5);
  return chosen.length > 0 ? chosen : [pick(rng, ordered)];
}

// ---------------------------------------------------------------------------
// Campaign A: runRegression, in-process benches only
// ---------------------------------------------------------------------------

export async function campaignRunnerInProcess(options: CampaignOptions): Promise<CampaignReport> {
  const { inProcess } = benchIdsByKind();
  const root = mkdtempSync(join(tmpdir(), "stress-eval-inproc-"));
  const ctx: RunnerContext = {
    outDir: join(root, "out"),
    tmpDir: join(root, "tmp"),
    expected: new Map(),
  };
  mkdirSync(ctx.tmpDir, { recursive: true });
  try {
    return await withTmpDir(ctx.tmpDir, () =>
      runCampaign(
        {
          campaign: "runner_in_process",
          unit: "runRegression({only: <seeded subset of in-process benches>})",
          expectedOutcomes: ["ok"],
          warmup: async () => {
            await runOnce(ctx, inProcess, "warmup");
          },
          iterate: (index, seed, rng) => runOnce(ctx, orderedSubset(rng, inProcess), `s${seed}`),
          finalChecks: async () => [
            {
              name: "no summary files left in out dir",
              ok: readdirSync(ctx.outDir).length === 0,
              detail: readdirSync(ctx.outDir).join(","),
            },
            {
              name: "no scratch dirs left",
              ok: scratchDirsIn(ctx.tmpDir).length === 0,
              detail: scratchDirsIn(ctx.tmpDir).join(","),
            },
          ],
        },
        options,
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Campaign B: runRegression, one seeded subprocess bench per iteration
// ---------------------------------------------------------------------------

export async function campaignRunnerSubprocess(options: CampaignOptions): Promise<CampaignReport> {
  const { subprocess } = benchIdsByKind();
  const root = mkdtempSync(join(tmpdir(), "stress-eval-subproc-"));
  const ctx: RunnerContext = {
    outDir: join(root, "out"),
    tmpDir: join(root, "tmp"),
    expected: new Map(),
  };
  mkdirSync(ctx.tmpDir, { recursive: true });
  const before = untrackedDatasetFiles();
  try {
    return await withTmpDir(ctx.tmpDir, () =>
      runCampaign(
        {
          campaign: "runner_subprocess",
          unit: "runRegression({only: [<seeded subprocess bench>]}) — spawns tsx child per iteration",
          expectedOutcomes: ["ok"],
          warmup: async () => {
            await runOnce(ctx, [subprocess[0]!], "warmup");
          },
          iterate: (index, seed, rng) => runOnce(ctx, [pick(rng, subprocess)], `s${seed}`),
          finalChecks: async () => {
            const after = untrackedDatasetFiles().filter((f) => !before.includes(f));
            return [
              {
                name: "no untracked files under datasets/",
                ok: after.length === 0,
                detail: after.join(","),
              },
              {
                name: "no scratch dirs left",
                ok: scratchDirsIn(ctx.tmpDir).length === 0,
                detail: scratchDirsIn(ctx.tmpDir).join(","),
              },
              {
                name: "no bench child alive",
                ok: pidsMatching(ctx.tmpDir).length === 0,
                detail: pidsMatching(ctx.tmpDir).join(","),
              },
            ];
          },
        },
        options,
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Processes whose command line mentions `marker` (the campaign's private
 *  TMPDIR appears in every report-writing bench child's argv). */
function pidsMatching(marker: string): number[] {
  try {
    return execFileSync("pgrep", ["-f", marker], { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(Number)
      .filter((pid) => pid !== process.pid);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Campaign C: cancellation — SIGINT/SIGTERM to self while a child bench runs
// ---------------------------------------------------------------------------

export async function campaignRunnerCancel(options: CampaignOptions): Promise<CampaignReport> {
  const { subprocess } = benchIdsByKind();
  const root = mkdtempSync(join(tmpdir(), "stress-eval-cancel-"));
  const outDir = join(root, "out");
  const tmpDir = join(root, "tmp");
  mkdirSync(tmpDir, { recursive: true });
  let lateSignals = 0;
  // A signal that lands after the runner removed its handlers must not kill
  // the harness; the guard turns it into a counted "completed" outcome.
  const guard = (): void => {
    lateSignals += 1;
  };
  for (const signal of HANDLED_SIGNALS) process.on(signal, guard);
  const before = untrackedDatasetFiles();
  const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
  try {
    return await withTmpDir(tmpDir, () =>
      runCampaign(
        {
          campaign: "runner_cancel",
          unit: "runRegression + process.kill(self, SIGINT|SIGTERM) at a seeded delay",
          expectedOutcomes: ["interrupted", "completed_before_signal"],
          warmup: async () => {
            const r = await runRegression({
              outDir,
              only: [subprocess[0]!],
              runId: "warmup",
              log: () => {},
            });
            rmSync(r.outPath, { force: true });
          },
          iterate: async (index, seed, rng) => {
            const only = [pick(rng, subprocess)];
            const signal: HandledSignal = pick(rng, HANDLED_SIGNALS);
            const delayMs = int(rng, 0, 700);
            const runId = `s${seed}`;
            const outPath = join(outDir, `${runId}.json`);
            let timer: NodeJS.Timeout | null = null;
            let fired = false;
            const lateBefore = lateSignals;
            let result: "interrupted" | "completed" | "threw" = "threw";
            let caught: unknown = null;
            try {
              await runRegression({
                outDir,
                only,
                runId,
                log: () => {
                  // Called once, right before the runner installs its handlers.
                  timer ??= setTimeout(() => {
                    fired = true;
                    process.kill(process.pid, signal);
                  }, delayMs);
                },
              });
              result = "completed";
            } catch (error) {
              caught = error;
              result = error instanceof RunInterruptedError ? "interrupted" : "threw";
            } finally {
              if (timer !== null) clearTimeout(timer);
            }
            // Let a signal that raced the end of the run reach the guard.
            await sleep(5);
            const detailBase = `${only[0]} ${signal} delay=${delayMs}ms`;
            if (result === "threw") {
              return {
                outcome: "threw",
                detail: `${detailBase}: ${caught instanceof Error ? caught.message : String(caught)}`,
              };
            }
            const summaryExists = existsSync(outPath);
            const scratch = scratchDirsIn(tmpDir);
            const children = pidsMatching(tmpDir);
            rmSync(outPath, { force: true });
            if (result === "interrupted") {
              const error = caught as RunInterruptedError;
              if (error.signal !== signal) {
                return { outcome: "wrong_signal", detail: `${detailBase}: got ${error.signal}` };
              }
              if (summaryExists) return { outcome: "summary_after_cancel", detail: detailBase };
              if (scratch.length > 0) {
                return { outcome: "scratch_after_cancel", detail: `${detailBase}: ${scratch}` };
              }
              if (children.length > 0) {
                return { outcome: "child_survived_cancel", detail: `${detailBase}: ${children}` };
              }
              if (error.exitCode !== (signal === "SIGINT" ? 130 : 143)) {
                return { outcome: "wrong_exit_code", detail: `${detailBase}: ${error.exitCode}` };
              }
              return { outcome: "interrupted", detail: detailBase };
            }
            // Completed: the signal must have landed late (guard) or not at all yet.
            if (!fired || lateSignals > lateBefore) {
              if (!summaryExists)
                return { outcome: "completed_without_summary", detail: detailBase };
              return { outcome: "completed_before_signal", detail: detailBase };
            }
            return { outcome: "signal_ignored", detail: `${detailBase}: fired but run completed` };
          },
          finalChecks: async () => {
            const after = untrackedDatasetFiles().filter((f) => !before.includes(f));
            return [
              {
                name: "no untracked files under datasets/",
                ok: after.length === 0,
                detail: after.join(","),
              },
              {
                name: "no scratch dirs left",
                ok: scratchDirsIn(tmpDir).length === 0,
                detail: scratchDirsIn(tmpDir).join(","),
              },
              {
                name: "no bench child alive",
                ok: pidsMatching(tmpDir).length === 0,
                detail: pidsMatching(tmpDir).join(","),
              },
            ];
          },
        },
        options,
      ),
    );
  } finally {
    for (const signal of HANDLED_SIGNALS) process.off(signal, guard);
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Campaign D: comparator (compareSummaries + formatCompareReport + CLI compare)
// ---------------------------------------------------------------------------

export const BASELINE_PATH = join(REPO_ROOT, "datasets/reports/regression/baseline.json");
export const TOLERANCES_PATH = join(REPO_ROOT, "packages/evaluation/regression.tolerances.json");

export function loadCommittedBaseline(): RegressionSummary {
  const validated = validateRegressionSummary(JSON.parse(readFileSync(BASELINE_PATH, "utf8")));
  if (!validated.ok) throw new Error(`baseline invalid: ${validated.failure.message}`);
  return validated.value;
}

export function loadCommittedTolerances(): ToleranceConfig {
  const validated = validateToleranceConfig(JSON.parse(readFileSync(TOLERANCES_PATH, "utf8")));
  if (!validated.ok) throw new Error(`tolerances invalid: ${validated.failure.message}`);
  return validated.value;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const METRIC_OPS = [
  "nudge_within_tolerance",
  "nudge_beyond_tolerance",
  "set_null",
  "delete",
  "add_new",
  "extreme_magnitude",
  "flip_sign",
] as const;

const IDENTITY_OPS = [
  "none",
  "none",
  "none",
  "git_sha",
  "model_version",
  "dataset_tree_sha",
  "runner_node",
  "git_dirty",
  "contract_version",
  "release_manifest",
] as const;

export interface CandidateMutation {
  metricOps: { key: string; op: (typeof METRIC_OPS)[number] }[];
  identityOp: (typeof IDENTITY_OPS)[number];
  failedBench: string | null;
  droppedBench: string | null;
}

/** Deterministically derives a candidate summary from the committed baseline. */
export function mutateCandidate(
  baseline: RegressionSummary,
  config: ToleranceConfig,
  rng: Rng,
): { candidate: RegressionSummary; mutation: CandidateMutation } {
  const candidate = clone(baseline);
  candidate.runId = `cand-${Math.floor(rng() * 1e9)}`;
  candidate.generatedAtIso = new Date(
    Date.UTC(2026, 8, 4, 0, 0, Math.floor(rng() * 60)),
  ).toISOString();
  // summary.metrics must stay the flattened view of the benches (validator
  // invariant), so every metric op edits a bench and re-flattens at the end.
  const slots = candidate.benches.flatMap((bench) =>
    Object.keys(bench.metrics)
      .sort()
      .map((metric) => ({ bench, metric })),
  );
  const metricOps: CandidateMutation["metricOps"] = [];
  const count = int(rng, 0, 9);
  for (let i = 0; i < count; i += 1) {
    const { bench, metric } = pick(rng, slots);
    const key = `${bench.id}.${metric}`;
    const op = pick(rng, METRIC_OPS);
    metricOps.push({ key, op });
    const current = bench.metrics[metric];
    const tolerance = config.metrics[key]?.absoluteTolerance ?? 0;
    switch (op) {
      case "nudge_within_tolerance":
        if (typeof current === "number") bench.metrics[metric] = current + tolerance * rng();
        break;
      case "nudge_beyond_tolerance":
        if (typeof current === "number") {
          bench.metrics[metric] = current + (rng() < 0.5 ? -1 : 1) * (tolerance + 1 + rng() * 10);
        }
        break;
      case "set_null":
        bench.metrics[metric] = null;
        break;
      case "delete":
        delete bench.metrics[metric];
        break;
      case "add_new":
        bench.metrics[`${metric}_synthetic_${int(rng, 0, 1000)}`] = rng() < 0.3 ? null : rng();
        break;
      case "extreme_magnitude":
        bench.metrics[metric] = (rng() < 0.5 ? -1 : 1) * Number.MAX_VALUE * rng();
        break;
      case "flip_sign":
        if (typeof current === "number") bench.metrics[metric] = -current;
        break;
    }
  }
  const identityOp = pick(rng, IDENTITY_OPS);
  switch (identityOp) {
    case "none":
      break;
    case "git_sha":
      candidate.provenance.gitSha = "f".repeat(40);
      break;
    case "model_version":
      candidate.provenance.modelVersions[
        pick(rng, Object.keys(candidate.provenance.modelVersions))
      ] = `stress-${int(rng, 0, 100)}`;
      break;
    case "dataset_tree_sha":
      candidate.provenance.datasetsTreeSha = "0".repeat(40);
      break;
    case "runner_node":
      candidate.runner.node = `v${int(rng, 18, 30)}.0.0`;
      break;
    case "git_dirty":
      candidate.provenance.gitDirty = true;
      break;
    case "contract_version":
      candidate.contractVersion = baseline.contractVersion + 1;
      break;
    case "release_manifest":
      if (candidate.provenance.datasetReleases.length > 0) {
        candidate.provenance.datasetReleases[0]!.manifestSha256 = "1".repeat(64);
      }
      break;
  }
  let failedBench: string | null = null;
  let droppedBench: string | null = null;
  if (rng() < 0.15 && candidate.benches.length > 0) {
    const bench = pick(rng, candidate.benches);
    bench.status = "failed";
    bench.error = "stress: synthetic failure";
    bench.exitCode = bench.kind === "subprocess" ? 1 : null;
    bench.metrics = {};
    bench.labels = {};
    failedBench = bench.id;
  } else if (rng() < 0.1 && candidate.benches.length > 1) {
    const idx = int(rng, 0, candidate.benches.length);
    droppedBench = candidate.benches[idx]!.id;
    candidate.benches.splice(idx, 1);
  }
  candidate.metrics = flattenBenchMetrics(candidate.benches);
  return { candidate, mutation: { metricOps, identityOp, failedBench, droppedBench } };
}

function captureStdout<T>(body: () => T): { value: T; output: string } {
  const original = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { value: body(), output: chunks.join("") };
  } finally {
    process.stdout.write = original;
  }
}

export async function campaignComparator(options: CampaignOptions): Promise<CampaignReport> {
  const baseline = loadCommittedBaseline();
  const config = loadCommittedTolerances();
  const root = mkdtempSync(join(tmpdir(), "stress-eval-compare-"));
  const candidatePath = join(root, "candidate.json");
  const iterate = async (
    _index: number,
    _seed: number,
    rng: Rng,
  ): Promise<{ outcome: string; detail: string }> => {
    const { candidate, mutation } = mutateCandidate(baseline, config, rng);
    const detail = JSON.stringify(mutation);
    const validated = validateRegressionSummary(clone(candidate));
    if (!validated.ok)
      return { outcome: "candidate_invalid", detail: `${detail} ${validated.failure.message}` };

    const first = compareSummaries(baseline, candidate, config);
    const second = compareSummaries(baseline, candidate, config);
    if (JSON.stringify(first) !== JSON.stringify(second)) {
      return { outcome: "nondeterministic_report", detail };
    }
    if (![0, 1, 3].includes(first.exitCode)) return { outcome: "bad_exit_code", detail };
    if (first.comparable !== (first.exitCode !== 3))
      return { outcome: "comparable_mismatch", detail };
    const nonComparableExpected = mutation.identityOp === "contract_version";
    if (nonComparableExpected !== !first.comparable) {
      return { outcome: "identity_misjudged", detail: `${detail} comparable=${first.comparable}` };
    }
    const nonFinite = nonFinitePaths(first);
    if (nonFinite.length > 0)
      return { outcome: "non_finite_in_report", detail: `${detail} ${nonFinite}` };
    if (first.comparable) {
      const total = Object.values(first.counts).reduce((s, n) => s + n, 0);
      if (total !== first.metrics.length) return { outcome: "counts_mismatch", detail };
      if ((first.exitCode === 1) !== first.regressions.length > 0) {
        return { outcome: "exit_vs_regressions", detail };
      }
      for (const metric of first.metrics) {
        if (metric.failing && !first.regressions.some((r) => r.startsWith(`${metric.metric}:`))) {
          return { outcome: "failing_metric_unlisted", detail: `${detail} ${metric.metric}` };
        }
        if (metric.status === "regressed" && !metric.failing) {
          return { outcome: "regressed_not_failing", detail: `${detail} ${metric.metric}` };
        }
      }
      for (const bench of first.benches) {
        if (
          bench.failing &&
          !first.regressions.includes(`bench ${bench.benchId}: ${bench.status}`)
        ) {
          return { outcome: "failing_bench_unlisted", detail: `${detail} ${bench.benchId}` };
        }
      }
      if (mutation.failedBench !== null) {
        const bench = first.benches.find((b) => b.benchId === mutation.failedBench);
        if (!bench || bench.status !== "failed_in_candidate" || !bench.failing) {
          return { outcome: "failed_bench_missed", detail };
        }
      }
      if (mutation.droppedBench !== null) {
        const bench = first.benches.find((b) => b.benchId === mutation.droppedBench);
        if (!bench || bench.status !== "missing_in_candidate" || !bench.failing) {
          return { outcome: "dropped_bench_missed", detail };
        }
      }
    }
    const textA = formatCompareReport(baseline, candidate, first);
    const textB = formatCompareReport(baseline, candidate, second);
    if (textA !== textB) return { outcome: "nondeterministic_text", detail };
    const expectedResultLine =
      first.exitCode === 0
        ? "RESULT: NO REGRESSIONS BEYOND DECLARED TOLERANCES (exit 0)"
        : first.exitCode === 1
          ? "RESULT: REGRESSIONS BEYOND DECLARED TOLERANCES (exit 1)"
          : "RESULT: NON-COMPARABLE (exit 3)";
    if (!textA.includes(expectedResultLine)) return { outcome: "text_result_mismatch", detail };

    // Reverse direction: non-comparability must be symmetric.
    const reverse = compareSummaries(candidate, baseline, config);
    if (reverse.comparable !== first.comparable)
      return { outcome: "asymmetric_comparability", detail };

    // Same document through the CLI (file round trip, --json).
    writeFileSync(candidatePath, JSON.stringify(candidate));
    const cli = captureStdout(() =>
      cliMain(["compare", BASELINE_PATH, candidatePath, "--tolerances", TOLERANCES_PATH, "--json"]),
    );
    const cliExit = await cli.value;
    if (cliExit !== first.exitCode) {
      return {
        outcome: "cli_exit_mismatch",
        detail: `${detail} cli=${cliExit} lib=${first.exitCode}`,
      };
    }
    const cliReport = JSON.parse(cli.output) as { exitCode: number; regressions: string[] };
    if (
      cliReport.exitCode !== first.exitCode ||
      cliReport.regressions.join("\n") !== first.regressions.join("\n")
    ) {
      return { outcome: "cli_report_mismatch", detail };
    }
    return {
      outcome: `ok_exit${first.exitCode}`,
      detail: `${detail} regressions=${first.regressions.length}`,
    };
  };
  try {
    return await runCampaign(
      {
        campaign: "comparator",
        unit: "compareSummaries + formatCompareReport + cli main(compare --json) over seeded candidates",
        expectedOutcomes: ["ok_exit0", "ok_exit1", "ok_exit3"],
        warmup: async (rng) => {
          await iterate(-1, -1, rng);
        },
        iterate,
      },
      options,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Campaign E: validator fuzz — validateRegressionSummary / validateToleranceConfig
// must return a Result for arbitrary JSON-ish input and never throw.
// ---------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const JUNK: readonly Json[] = [
  null,
  true,
  false,
  0,
  -1,
  1.5,
  Number.MAX_SAFE_INTEGER,
  "",
  "x",
  "../escape",
  [],
  {},
  [null],
  { a: 1 },
];

function mutateJson(value: Json, rng: Rng, depth = 0): Json {
  if (rng() < 0.08 || depth > 6) return pick(rng, JUNK);
  if (Array.isArray(value)) {
    const out = value.map((item) => (rng() < 0.3 ? mutateJson(item, rng, depth + 1) : item));
    if (rng() < 0.1) out.push(pick(rng, JUNK));
    if (rng() < 0.1 && out.length > 0) out.splice(int(rng, 0, out.length), 1);
    return out;
  }
  if (typeof value === "object" && value !== null) {
    const out: { [key: string]: Json } = {};
    for (const [key, child] of Object.entries(value)) {
      if (rng() < 0.05) continue; // drop key
      out[key] = rng() < 0.3 ? mutateJson(child, rng, depth + 1) : child;
    }
    if (rng() < 0.1) out[`extra_${int(rng, 0, 1000)}`] = pick(rng, JUNK);
    return out;
  }
  if (typeof value === "number") {
    const r = rng();
    if (r < 0.2) return -value;
    if (r < 0.4) return value + 0.5;
    if (r < 0.6) return Number.MAX_VALUE;
    return value;
  }
  if (typeof value === "string") {
    const r = rng();
    if (r < 0.3) return "";
    if (r < 0.5) return `${value}!`;
    return value;
  }
  return value;
}

/** Non-JSON values (NaN/Infinity/undefined) that a JSON file cannot carry
 *  but an in-process caller could pass. */
function injectNonJson(value: Json, rng: Rng): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const out: Record<string, unknown> = { ...value };
  const metrics = out.metrics;
  if (typeof metrics === "object" && metrics !== null && !Array.isArray(metrics)) {
    const m = { ...(metrics as Record<string, unknown>) };
    const keys = Object.keys(m);
    if (keys.length > 0) {
      m[pick(rng, keys)] = pick(rng, [
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        undefined,
      ]);
    }
    out.metrics = m;
  }
  return out;
}

export async function campaignValidatorFuzz(options: CampaignOptions): Promise<CampaignReport> {
  const baselineJson = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Json;
  const tolerancesJson = JSON.parse(readFileSync(TOLERANCES_PATH, "utf8")) as Json;
  const iterate = async (
    _index: number,
    _seed: number,
    rng: Rng,
  ): Promise<{ outcome: string; detail: string }> => {
    const which = rng();
    if (which < 0.6) {
      const mutated = mutateJson(baselineJson, rng);
      const input = rng() < 0.2 ? injectNonJson(mutated, rng) : mutated;
      const result = validateRegressionSummary(input);
      if (result.ok) {
        // Accepted documents must round-trip: validating the accepted value
        // again must accept, and nothing non-finite may be inside.
        const again = validateRegressionSummary(JSON.parse(JSON.stringify(result.value)));
        if (!again.ok) return { outcome: "accepted_not_idempotent", detail: again.failure.message };
        const nonFinite = nonFinitePaths(result.value);
        if (nonFinite.length > 0)
          return { outcome: "accepted_non_finite", detail: nonFinite.join(",") };
        return { outcome: "ok", detail: "summary accepted" };
      }
      if (typeof result.failure.code !== "string" || result.failure.code.length === 0) {
        return { outcome: "failure_without_code", detail: JSON.stringify(result.failure) };
      }
      return { outcome: "ok", detail: `summary rejected: ${result.failure.code}` };
    }
    if (which < 0.9) {
      const mutated = mutateJson(tolerancesJson, rng);
      const result = validateToleranceConfig(mutated);
      if (result.ok) {
        const nonFinite = nonFinitePaths(result.value);
        if (nonFinite.length > 0)
          return { outcome: "accepted_non_finite", detail: nonFinite.join(",") };
        return { outcome: "ok", detail: "tolerances accepted" };
      }
      return { outcome: "ok", detail: `tolerances rejected: ${result.failure.code}` };
    }
    // Unmodified committed documents must always validate.
    const summary = validateRegressionSummary(clone(baselineJson));
    const tolerances = validateToleranceConfig(clone(tolerancesJson));
    if (!summary.ok)
      return { outcome: "committed_baseline_rejected", detail: summary.failure.message };
    if (!tolerances.ok)
      return { outcome: "committed_tolerances_rejected", detail: tolerances.failure.message };
    return { outcome: "ok", detail: "committed documents accepted" };
  };
  return runCampaign(
    {
      campaign: "validator_fuzz",
      unit: "validateRegressionSummary / validateToleranceConfig over seeded JSON mutations",
      expectedOutcomes: ["ok"],
      warmup: async (rng) => {
        await iterate(-1, -1, rng);
      },
      iterate,
    },
    options,
  );
}

// ---------------------------------------------------------------------------
// Registry + CLI
// ---------------------------------------------------------------------------

export const CAMPAIGNS = {
  runner_in_process: campaignRunnerInProcess,
  runner_subprocess: campaignRunnerSubprocess,
  runner_cancel: campaignRunnerCancel,
  comparator: campaignComparator,
  validator_fuzz: campaignValidatorFuzz,
} as const;
export type CampaignName = keyof typeof CAMPAIGNS;

export interface StressSummary {
  campaignSeed: number;
  node: string;
  gitSha: string;
  campaigns: {
    campaign: string;
    iterationsExecuted: number;
    verdict: string;
    reasons: string[];
    heapSlopePctPer100: number | null;
    timeDriftRatio: number | null;
    outcomeCounts: Record<string, number>;
    wallClockMs: number;
  }[];
  totalIterations: number;
  verdict: "HELD" | "BROKEN";
}

export function summarise(campaignSeed: number, reports: CampaignReport[]): StressSummary {
  return {
    campaignSeed,
    node: process.version,
    gitSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim(),
    campaigns: reports.map((r) => ({
      campaign: r.campaign,
      iterationsExecuted: r.iterationsExecuted,
      verdict: r.verdict,
      reasons: r.reasons,
      heapSlopePctPer100: r.heap.slopePctPer100Iterations,
      timeDriftRatio: r.timing.driftRatio,
      outcomeCounts: r.outcomeCounts,
      wallClockMs: r.wallClockMs,
    })),
    totalIterations: reports.reduce((s, r) => s + r.iterationsExecuted, 0),
    verdict: reports.every((r) => r.verdict === "HELD") ? "HELD" : "BROKEN",
  };
}

function parseCliArgs(argv: string[]): {
  campaigns: CampaignName[];
  iterations: number;
  seed: number;
  outDir: string;
  probeEvery: number;
} {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${arg} requires a value`);
    flags.set(arg.slice(2), value);
    i += 1;
  }
  const names =
    (flags.get("campaign") ?? "all") === "all"
      ? (Object.keys(CAMPAIGNS) as CampaignName[])
      : (flags.get("campaign")!.split(",") as CampaignName[]);
  for (const name of names) if (!(name in CAMPAIGNS)) throw new Error(`unknown campaign ${name}`);
  const outDirRaw = flags.get("out-dir") ?? "artifacts/stress/pkg-evaluation-long-run-leak";
  return {
    campaigns: names,
    iterations: Number(flags.get("iterations") ?? 500),
    seed: Number(flags.get("seed") ?? 20260904),
    outDir: isAbsolute(outDirRaw) ? outDirRaw : resolve(REPO_ROOT, outDirRaw),
    probeEvery: Number(flags.get("probe-every") ?? 50),
  };
}

async function cli(argv: string[]): Promise<number> {
  const args = parseCliArgs(argv);
  mkdirSync(args.outDir, { recursive: true });
  const reports: CampaignReport[] = [];
  const log = (line: string): void => console.error(line);
  log(
    `long-run-leak stress: campaigns=${args.campaigns.join(",")} iterations=${args.iterations} seed=${args.seed} gc=${obtainGc().source}`,
  );
  for (const name of args.campaigns) {
    const report = await CAMPAIGNS[name]({
      iterations: args.iterations,
      campaignSeed: args.seed,
      probeEvery: args.probeEvery,
      rowsPath: join(args.outDir, `${name}.rows.jsonl`),
      log,
    });
    reports.push(report);
    writeFileSync(join(args.outDir, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
    log(
      `[${name}] ${report.verdict} — ${report.iterationsExecuted} iterations, heap slope ${report.heap.slopePctPer100Iterations?.toFixed(3) ?? "n/a"}%/100, drift x${report.timing.driftRatio?.toFixed(2) ?? "n/a"}, outcomes ${JSON.stringify(report.outcomeCounts)}${report.reasons.length ? `\n    ${report.reasons.join("\n    ")}` : ""}`,
    );
  }
  const summary = summarise(args.seed, reports);
  writeFileSync(join(args.outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  log(
    `wrote ${args.outDir}/summary.json — ${summary.verdict} (${summary.totalIterations} iterations)`,
  );
  return summary.verdict === "HELD" ? 0 : 1;
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  void cli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exitCode = 2;
    },
  );
}
