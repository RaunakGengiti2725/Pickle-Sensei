import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

/**
 * Long-run leak probe shared by the stress campaigns in this package.
 *
 * Everything here is deterministic and dependency-free: a seeded PRNG so every
 * iteration is replayable from its seed, heap/handle snapshots taken after a
 * forced GC (when the process runs with `--expose-gc`), and a least-squares
 * slope so "heap grows monotonically" is a number, not a feeling.
 *
 * Campaign knobs (all optional):
 *   STRESS_ITER   iterations per unit (default STRESS_DEFAULT_ITER — fast enough for CI)
 *   STRESS_SEED   campaign base seed (default 20260905)
 *   STRESS_SEEDS  comma-separated iteration seeds to replay instead of the sequence
 *   STRESS_OUT    write the JSON results table (seed -> outcome) to this path
 *
 * Heap/handle measurement requires `NODE_OPTIONS=--expose-gc`; when GC is not
 * exposed the functional invariants still run but the heap slope is reported
 * as not measured (never as a pass).
 */

/** Two warm-up windows plus a 200-iteration fit window; a few seconds per unit. */
export const STRESS_DEFAULT_ITER = 300;
export const HEAP_SAMPLE_EVERY = 50;
/** Monotone heap growth above this per 100 iterations is a finding. */
export const HEAP_SLOPE_LIMIT_PCT_PER_100 = 5;
/** Later iterations slower than early ones by more than this ratio is drift. */
export const TIME_DRIFT_LIMIT_RATIO = 2;

// ─── Seeded PRNG (mulberry32) ────────────────────────────────────────────────

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Iteration seed derived from the campaign seed — stable across runs. */
export function iterationSeed(baseSeed: number, index: number): number {
  let h = (baseSeed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (index + 0x7f4a7c15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

export function between(rng: Rng, lo: number, hi: number): number {
  return lo + (hi - lo) * rng();
}

export function intBetween(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

// ─── Campaign configuration from the environment ─────────────────────────────

export interface CampaignOptions {
  iterations: number;
  baseSeed: number;
  /** Explicit seeds to replay (minimisation / flake re-runs). */
  explicitSeeds: number[] | null;
  /** True when STRESS_ITER or STRESS_SEEDS was set — a deliberate campaign. */
  explicit: boolean;
  outPath: string | null;
}

export function readCampaignOptions(env: NodeJS.ProcessEnv = process.env): CampaignOptions {
  const iterRaw = env.STRESS_ITER;
  const iterations =
    iterRaw !== undefined && Number.isFinite(Number(iterRaw)) && Number(iterRaw) > 0
      ? Math.floor(Number(iterRaw))
      : STRESS_DEFAULT_ITER;
  const seedRaw = env.STRESS_SEED;
  const baseSeed =
    seedRaw !== undefined && Number.isFinite(Number(seedRaw)) ? Number(seedRaw) >>> 0 : 20260905;
  const seedsRaw = env.STRESS_SEEDS;
  const explicitSeeds =
    seedsRaw !== undefined && seedsRaw.trim() !== ""
      ? seedsRaw
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n))
          .map((n) => n >>> 0)
      : null;
  return {
    iterations,
    baseSeed,
    explicitSeeds,
    explicit: iterRaw !== undefined || explicitSeeds !== null,
    outPath: env.STRESS_OUT && env.STRESS_OUT.trim() !== "" ? env.STRESS_OUT : null,
  };
}

export function seedsFor(options: CampaignOptions): number[] {
  if (options.explicitSeeds) return options.explicitSeeds;
  const seeds: number[] = [];
  for (let i = 0; i < options.iterations; i += 1) seeds.push(iterationSeed(options.baseSeed, i));
  return seeds;
}

// ─── GC / heap / handle snapshots ────────────────────────────────────────────

type GcFn = () => void;

export function exposedGc(): GcFn | null {
  const candidate = (globalThis as { gc?: unknown }).gc;
  return typeof candidate === "function" ? (candidate as GcFn) : null;
}

export function forceGc(gc: GcFn | null): boolean {
  if (!gc) return false;
  // Two passes so objects only reachable through finalizers/weak refs are
  // released too.
  gc();
  gc();
  return true;
}

export interface HeapSample {
  iteration: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  rss: number;
  /** WeakRefs registered ≥ HEAP_SAMPLE_EVERY iterations ago that are still alive. */
  retainedOutputs: number;
  /** Distinct iterations (oldest first, at most 20) whose outputs are still alive. */
  retainedIterations: number[];
}

export interface HandleSnapshot {
  activeResources: string[];
  activeHandles: number | null;
  activeRequests: number | null;
  processListeners: Record<string, number>;
}

interface ProcessInternals {
  _getActiveHandles?: () => unknown[];
  _getActiveRequests?: () => unknown[];
}

export function snapshotHandles(): HandleSnapshot {
  const internals = process as unknown as ProcessInternals;
  const listeners: Record<string, number> = {};
  for (const name of process.eventNames()) {
    listeners[String(name)] = process.listenerCount(name);
  }
  return {
    activeResources: [...process.getActiveResourcesInfo()].sort(),
    activeHandles: internals._getActiveHandles ? internals._getActiveHandles().length : null,
    activeRequests: internals._getActiveRequests ? internals._getActiveRequests().length : null,
    processListeners: listeners,
  };
}

function countBy(items: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return counts;
}

/**
 * Anything the campaign ADDED and left behind (resources, handles, requests,
 * process listeners) is a problem. Resources owned by the test runner that
 * retire on their own during the run (e.g. its per-test timeout) are not.
 */
export function handleDiff(before: HandleSnapshot, after: HandleSnapshot): string[] {
  const problems: string[] = [];
  const beforeCounts = countBy(before.activeResources);
  for (const [kind, afterCount] of countBy(after.activeResources)) {
    const beforeCount = beforeCounts.get(kind) ?? 0;
    if (afterCount > beforeCount) {
      problems.push(`active resource "${kind}" ${beforeCount} -> ${afterCount}`);
    }
  }
  if (
    before.activeHandles !== null &&
    after.activeHandles !== null &&
    after.activeHandles > before.activeHandles
  ) {
    problems.push(`activeHandles ${before.activeHandles} -> ${after.activeHandles}`);
  }
  if (
    before.activeRequests !== null &&
    after.activeRequests !== null &&
    after.activeRequests > before.activeRequests
  ) {
    problems.push(`activeRequests ${before.activeRequests} -> ${after.activeRequests}`);
  }
  const names = new Set([
    ...Object.keys(before.processListeners),
    ...Object.keys(after.processListeners),
  ]);
  for (const name of names) {
    const b = before.processListeners[name] ?? 0;
    const a = after.processListeners[name] ?? 0;
    if (a !== b) problems.push(`process listener "${name}" ${b} -> ${a}`);
  }
  return problems;
}

/**
 * Tracks outputs of past iterations by WeakRef. After a forced GC, anything
 * older than one sampling window that is still alive is being retained by
 * something other than the harness — the most direct leak signal available.
 */
export class RetentionTracker {
  private readonly refs: Array<{ iteration: number; ref: WeakRef<object> }> = [];

  track(iteration: number, value: object): void {
    this.refs.push({ iteration, ref: new WeakRef(value) });
  }

  /** Refs registered at least `minAge` iterations before `now` still alive; drops dead ones. */
  retainedOlderThan(now: number, minAge: number): { count: number; iterations: number[] } {
    let count = 0;
    const iterations = new Set<number>();
    for (let i = this.refs.length - 1; i >= 0; i -= 1) {
      const entry = this.refs[i]!;
      if (entry.ref.deref() === undefined) {
        this.refs.splice(i, 1);
        continue;
      }
      if (now - entry.iteration >= minAge) {
        count += 1;
        iterations.add(entry.iteration);
      }
    }
    return { count, iterations: [...iterations].sort((a, b) => a - b).slice(0, 20) };
  }
}

/** Yields to the macrotask queue so the microtask checkpoint completes. */
export function macrotaskBoundary(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

export async function sampleHeap(
  iteration: number,
  gc: GcFn | null,
  retention: RetentionTracker,
): Promise<HeapSample> {
  // WeakRef targets are kept alive until the end of the current job (the
  // microtask checkpoint that a chain of awaits never leaves). Cross a real
  // macrotask boundary first so only genuinely retained objects survive GC.
  await macrotaskBoundary();
  forceGc(gc);
  const usage = process.memoryUsage();
  const retained = gc
    ? retention.retainedOlderThan(iteration, HEAP_SAMPLE_EVERY)
    : { count: -1, iterations: [] };
  return {
    iteration,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
    rss: usage.rss,
    retainedOutputs: retained.count,
    retainedIterations: retained.iterations,
  };
}

// ─── Statistics ──────────────────────────────────────────────────────────────

export interface HeapTrend {
  measured: boolean;
  samples: number;
  /** Least-squares slope of heapUsed vs iteration, in bytes per iteration. */
  slopeBytesPerIteration: number | null;
  /** Slope expressed as % of the first retained sample's heapUsed per 100 iterations. */
  slopePctPer100: number | null;
  firstHeapUsed: number | null;
  lastHeapUsed: number | null;
  minHeapUsed: number | null;
  maxHeapUsed: number | null;
  /** Fraction of consecutive sample pairs where heapUsed increased (1 = strictly monotone). */
  monotoneFraction: number | null;
  maxRetainedOutputs: number | null;
}

/**
 * Fits over samples after `warmupSamples` (module caches + JIT code settle
 * first). A slope is only meaningful over at least one "per 100 iterations"
 * window; shorter runs (single-seed replays) report `measured: false`.
 */
export function heapTrend(samples: readonly HeapSample[], warmupSamples = 2): HeapTrend {
  const fit = samples.slice(Math.min(warmupSamples, Math.max(samples.length - 2, 0)));
  const span = fit.length >= 2 ? fit[fit.length - 1]!.iteration - fit[0]!.iteration : 0;
  if (fit.length < 2 || span < 100) {
    return {
      measured: false,
      samples: samples.length,
      slopeBytesPerIteration: null,
      slopePctPer100: null,
      firstHeapUsed: samples[0]?.heapUsed ?? null,
      lastHeapUsed: samples[samples.length - 1]?.heapUsed ?? null,
      minHeapUsed: null,
      maxHeapUsed: null,
      monotoneFraction: null,
      maxRetainedOutputs: null,
    };
  }
  const n = fit.length;
  const meanX = fit.reduce((s, p) => s + p.iteration, 0) / n;
  const meanY = fit.reduce((s, p) => s + p.heapUsed, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of fit) {
    sxx += (p.iteration - meanX) ** 2;
    sxy += (p.iteration - meanX) * (p.heapUsed - meanY);
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const first = fit[0]!.heapUsed;
  let increases = 0;
  for (let i = 1; i < n; i += 1) if (fit[i]!.heapUsed > fit[i - 1]!.heapUsed) increases += 1;
  return {
    measured: true,
    samples: samples.length,
    slopeBytesPerIteration: slope,
    slopePctPer100: first > 0 ? ((slope * 100) / first) * 100 : null,
    firstHeapUsed: first,
    lastHeapUsed: fit[n - 1]!.heapUsed,
    minHeapUsed: Math.min(...fit.map((p) => p.heapUsed)),
    maxHeapUsed: Math.max(...fit.map((p) => p.heapUsed)),
    monotoneFraction: increases / (n - 1),
    maxRetainedOutputs: Math.max(...fit.map((p) => p.retainedOutputs)),
  };
}

/**
 * The lens criterion: MONOTONE growth above HEAP_SLOPE_LIMIT_PCT_PER_100.
 * Post-GC heapUsed jitters by a few percent between samples (code space,
 * string tables), so a steep slope alone is not enough; the samples must also
 * mostly rise. Returns the problems found (empty = HELD).
 */
export function heapLeakProblems(trend: HeapTrend): string[] {
  if (!trend.measured) return [];
  const problems: string[] = [];
  if (trend.maxRetainedOutputs !== null && trend.maxRetainedOutputs > 0) {
    problems.push(`${trend.maxRetainedOutputs} outputs still alive one window after GC`);
  }
  if (
    trend.slopePctPer100 !== null &&
    trend.slopePctPer100 > HEAP_SLOPE_LIMIT_PCT_PER_100 &&
    (trend.monotoneFraction ?? 0) >= 0.5
  ) {
    problems.push(
      `heap grows ${trend.slopePctPer100.toFixed(2)}% per 100 iterations ` +
        `(monotone fraction ${(trend.monotoneFraction ?? 0).toFixed(2)})`,
    );
  }
  return problems;
}

export interface TimingStats {
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  /** Median of the early window (after warm-up). */
  earlyMedianMs: number;
  /** Median of the late window. */
  lateMedianMs: number;
  /** late / early — > 1 means iterations got slower over the run. */
  driftRatio: number;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}

function median(values: readonly number[]): number {
  return percentile(
    [...values].sort((a, b) => a - b),
    0.5,
  );
}

export function timingStats(durationsMs: readonly number[]): TimingStats {
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const n = durationsMs.length;
  const warmup = Math.min(Math.max(Math.floor(n * 0.1), 0), Math.max(n - 4, 0));
  const window = Math.max(Math.floor((n - warmup) * 0.2), 1);
  const early = durationsMs.slice(warmup, warmup + window);
  const late = durationsMs.slice(Math.max(n - window, warmup));
  const earlyMedian = median(early);
  const lateMedian = median(late);
  return {
    count: n,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[n - 1] ?? 0,
    earlyMedianMs: earlyMedian,
    lateMedianMs: lateMedian,
    driftRatio: earlyMedian > 0 ? lateMedian / earlyMedian : 1,
  };
}

export function now(): number {
  return performance.now();
}

// ─── Result table ────────────────────────────────────────────────────────────

export interface CampaignReport<Outcome> {
  unit: string;
  node: string;
  startedAtIso: string;
  wallClockMs: number;
  gcExposed: boolean;
  options: CampaignOptions;
  iterationsExecuted: number;
  seedsFailed: number[];
  heapSamples: HeapSample[];
  heapTrend: HeapTrend;
  handlesBefore: HandleSnapshot;
  handlesAfter: HandleSnapshot;
  handleProblems: string[];
  timing: TimingStats;
  results: Array<{ seed: number; outcome: Outcome }>;
}

export interface IterationResult<Outcome> {
  outcome: Outcome;
  /** Invariant violations found for this seed (empty = HELD). */
  violations: string[];
  /** Objects the iteration produced; tracked by WeakRef to prove they are released. */
  retain: object[];
}

export interface CampaignSpec<Outcome> {
  unit: string;
  options: CampaignOptions;
  seeds: readonly number[];
  iterate: (seed: number) => Promise<IterationResult<Outcome>>;
}

interface CampaignState<Outcome> {
  retention: RetentionTracker;
  durations: number[];
  results: Array<{ seed: number; outcome: Outcome }>;
  seedsFailed: number[];
}

/**
 * One iteration in its own frame: the campaign loop below never holds the
 * iteration's outputs in a local, so the only thing that can keep them alive
 * past this call is the unit under test.
 */
async function runIteration<Outcome>(
  spec: CampaignSpec<Outcome>,
  seed: number,
  index: number,
  state: CampaignState<Outcome>,
): Promise<void> {
  const t0 = now();
  const result = await spec.iterate(seed);
  state.durations.push(now() - t0);
  for (const obj of result.retain) state.retention.track(index, obj);
  state.results.push({ seed, outcome: result.outcome });
  if (result.violations.length > 0) state.seedsFailed.push(seed);
}

/**
 * Runs every seed in ONE process, sampling heap + retention after every
 * HEAP_SAMPLE_EVERY iterations (and once at the end), and snapshots handles/
 * listeners before and after so anything left behind shows up in the report.
 */
export async function runCampaign<Outcome>(
  spec: CampaignSpec<Outcome>,
): Promise<CampaignReport<Outcome>> {
  const gc = exposedGc();
  const startedAtIso = new Date().toISOString();
  const wallStart = now();
  const retention = new RetentionTracker();
  const heapSamples: HeapSample[] = [];
  const state: CampaignState<Outcome> = {
    retention,
    durations: [],
    results: [],
    seedsFailed: [],
  };

  await macrotaskBoundary();
  const handlesBefore = snapshotHandles();
  heapSamples.push(await sampleHeap(0, gc, retention));

  let executed = 0;
  for (let i = 0; i < spec.seeds.length; i += 1) {
    await runIteration(spec, spec.seeds[i]!, executed + 1, state);
    executed += 1;
    if (executed % HEAP_SAMPLE_EVERY === 0) {
      heapSamples.push(await sampleHeap(executed, gc, retention));
    }
  }
  if (executed % HEAP_SAMPLE_EVERY !== 0) {
    heapSamples.push(await sampleHeap(executed, gc, retention));
  }

  // Let any stray microtasks/timers the unit might have scheduled surface.
  await macrotaskBoundary();
  const handlesAfter = snapshotHandles();

  return {
    unit: spec.unit,
    node: process.version,
    startedAtIso,
    wallClockMs: now() - wallStart,
    gcExposed: gc !== null,
    options: spec.options,
    iterationsExecuted: executed,
    seedsFailed: state.seedsFailed,
    heapSamples,
    heapTrend: heapTrend(heapSamples),
    handlesBefore,
    handlesAfter,
    handleProblems: handleDiff(handlesBefore, handlesAfter),
    timing: timingStats(state.durations),
    results: state.results,
  };
}

export function writeReport<Outcome>(path: string | null, report: CampaignReport<Outcome>): void {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2));
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function inUnitInterval(value: unknown): boolean {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

/** Recursively finds non-finite numbers anywhere in a JSON-ish value. */
export function nonFinitePaths(value: unknown, path = "$", out: string[] = []): string[] {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) out.push(path);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => nonFinitePaths(item, `${path}[${i}]`, out));
    return out;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      nonFinitePaths(v, `${path}.${k}`, out);
    }
  }
  return out;
}

/** Key-order-independent structural fingerprint for determinism checks. */
export function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    if (typeof v === "number" && !Number.isFinite(v)) return `__nonfinite:${String(v)}`;
    return v;
  });
}
