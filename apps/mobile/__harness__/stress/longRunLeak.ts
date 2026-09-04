/**
 * Long-run leak instrumentation shared by the stress suites under
 * `__tests__/stress/`. Pure Node helpers — no React, no React Native — so the
 * numbers they produce are attributable to the unit under stress, not to the
 * harness.
 *
 *   - `createSeededRng` / `deriveIterationSeed`: every iteration is replayable
 *     from one 32-bit seed (mulberry32; the campaign seed derives one
 *     iteration seed per index, so `STRESS_REPLAY_SEEDS=<seed>` re-runs
 *     exactly one iteration).
 *   - `sampleHeap`: forces a full GC when the process was started with
 *     `--expose-gc` and reports `heapUsed`. Without `--expose-gc` the sample is
 *     still recorded but flagged `gcForced:false`, and a heap verdict is never
 *     derived from it (an unmeasured invariant is not a held invariant).
 *   - `assessHeapSlope`: least-squares slope over the GC'd samples, expressed as
 *     % of the first sample per 100 iterations, plus a monotonicity check.
 *   - `timingDrift`: median of the last window vs the first window.
 *   - `openHandleSnapshot`: libuv handles/requests visible to this process.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as v8 from 'node:v8';

export interface SeededRng {
  readonly seed: number;
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
}

/** mulberry32 — small, fast, and good enough to fan a seed into choices. */
export function createSeededRng(seed: number): SeededRng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    seed: seed >>> 0,
    next,
    int: maxExclusive => Math.floor(next() * maxExclusive),
    pick: items => {
      if (items.length === 0) throw new Error('pick() on an empty list');
      return items[Math.floor(next() * items.length)]!;
    },
  };
}

/** One iteration seed per campaign index — stable across runs and machines. */
export function deriveIterationSeed(
  campaignSeed: number,
  index: number,
): number {
  let h = (campaignSeed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (index + 1), 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

export function parseSeedList(raw: string | undefined): number[] | null {
  if (!raw || raw.trim() === '') return null;
  const seeds = raw
    .split(',')
    .map(s => s.trim())
    .filter(s => s !== '')
    .map(s => Number.parseInt(s, 10));
  if (seeds.some(s => !Number.isFinite(s) || s < 0)) {
    throw new Error(`Invalid seed list: ${raw}`);
  }
  return seeds;
}

export function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${raw}`);
  }
  return value;
}

// ─── Heap ────────────────────────────────────────────────────────────────────

export interface HeapSample {
  iteration: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  rss: number;
  gcForced: boolean;
}

type GcGlobal = typeof globalThis & { gc?: () => void };

export function gcAvailable(): boolean {
  return typeof (globalThis as GcGlobal).gc === 'function';
}

export function sampleHeap(iteration: number): HeapSample {
  const gc = (globalThis as GcGlobal).gc;
  const forced = typeof gc === 'function';
  if (forced) {
    // Two passes: the first releases young objects, the second collects what
    // the first pass' finalizers made unreachable (React fiber trees, weak
    // caches in the navigator, Animated node registries).
    gc();
    gc();
  }
  const usage = process.memoryUsage();
  return {
    iteration,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
    rss: usage.rss,
    gcForced: forced,
  };
}

/**
 * Writes a V8 heap snapshot to `$STRESS_OUT/<name>.heapsnapshot` when
 * `STRESS_HEAP_SNAPSHOTS=1` — the attribution tool for a failing slope
 * (diff two snapshots by constructor name to see WHAT is retained). Off by
 * default: snapshots are hundreds of MB and take seconds each.
 */
export function writeHeapSnapshotArtifact(name: string): string | null {
  const dir = process.env.STRESS_OUT;
  if (!dir || process.env.STRESS_HEAP_SNAPSHOTS !== '1') return null;
  fs.mkdirSync(dir, { recursive: true });
  return v8.writeHeapSnapshot(path.join(dir, `${name}.heapsnapshot`));
}

export interface HeapSlopeAssessment {
  assessed: boolean;
  reason?: string;
  sampleCount: number;
  firstHeapUsed: number;
  lastHeapUsed: number;
  /** Least-squares slope, bytes per iteration. */
  slopeBytesPerIteration: number;
  /** slope × 100 iterations, as % of the first sample. */
  slopePctPer100Iterations: number;
  /** Total growth first → last, as % of the first sample. */
  totalGrowthPct: number;
  /** Every sample ≥ its predecessor (strictly monotone non-decreasing). */
  monotoneIncreasing: boolean;
  /** Longest run of consecutive increases. */
  longestIncreasingRun: number;
  /** Fraction of steps that increased. */
  increasingStepFraction: number;
}

export function assessHeapSlope(
  samples: readonly HeapSample[],
  options: { warmupSamples?: number } = {},
): HeapSlopeAssessment {
  const warmup = options.warmupSamples ?? 0;
  const gcSamples = samples.filter(s => s.gcForced).slice(warmup);
  const base = {
    sampleCount: gcSamples.length,
    firstHeapUsed: gcSamples[0]?.heapUsed ?? 0,
    lastHeapUsed: gcSamples[gcSamples.length - 1]?.heapUsed ?? 0,
  };
  if (gcSamples.length < 3) {
    return {
      assessed: false,
      reason: samples.some(s => !s.gcForced)
        ? 'global.gc unavailable — run jest under `node --expose-gc`'
        : `need ≥3 GC samples after warmup, got ${gcSamples.length}`,
      ...base,
      slopeBytesPerIteration: 0,
      slopePctPer100Iterations: 0,
      totalGrowthPct: 0,
      monotoneIncreasing: false,
      longestIncreasingRun: 0,
      increasingStepFraction: 0,
    };
  }
  const n = gcSamples.length;
  const meanX = gcSamples.reduce((a, s) => a + s.iteration, 0) / n;
  const meanY = gcSamples.reduce((a, s) => a + s.heapUsed, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const s of gcSamples) {
    sxx += (s.iteration - meanX) ** 2;
    sxy += (s.iteration - meanX) * (s.heapUsed - meanY);
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  let monotone = true;
  let run = 0;
  let longestRun = 0;
  let increases = 0;
  for (let i = 1; i < n; i += 1) {
    const delta = gcSamples[i]!.heapUsed - gcSamples[i - 1]!.heapUsed;
    if (delta < 0) monotone = false;
    if (delta > 0) {
      increases += 1;
      run += 1;
      longestRun = Math.max(longestRun, run);
    } else {
      run = 0;
    }
  }
  return {
    assessed: true,
    ...base,
    slopeBytesPerIteration: slope,
    slopePctPer100Iterations: (slope * 100 * 100) / base.firstHeapUsed,
    totalGrowthPct:
      ((base.lastHeapUsed - base.firstHeapUsed) * 100) / base.firstHeapUsed,
    monotoneIncreasing: monotone,
    longestIncreasingRun: longestRun,
    increasingStepFraction: increases / (n - 1),
  };
}

// ─── Timing drift ────────────────────────────────────────────────────────────

/** Monotonic wall-clock milliseconds from `process.hrtime.bigint()` — the
 *  suites fake `Date`/timers but keep `hrtime` real, so this measures the
 *  actual CPU time a mount/unmount took. */
export function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[rank]!;
}

export interface TimingDrift {
  window: number;
  firstWindowMedianMs: number;
  lastWindowMedianMs: number;
  /** lastMedian / firstMedian (1.0 = no drift). */
  driftRatio: number;
  overallMedianMs: number;
  p95Ms: number;
  maxMs: number;
}

export function timingDrift(
  samplesMs: readonly number[],
  window: number,
): TimingDrift {
  const w = Math.max(1, Math.min(window, Math.floor(samplesMs.length / 2)));
  const first = median(samplesMs.slice(0, w));
  const last = median(samplesMs.slice(samplesMs.length - w));
  return {
    window: w,
    firstWindowMedianMs: first,
    lastWindowMedianMs: last,
    driftRatio: first === 0 ? Number.NaN : last / first,
    overallMedianMs: median(samplesMs),
    p95Ms: percentile(samplesMs, 95),
    maxMs: samplesMs.length === 0 ? Number.NaN : Math.max(...samplesMs),
  };
}

// ─── Open handles ────────────────────────────────────────────────────────────

export interface OpenHandleSnapshot {
  handles: number;
  requests: number;
  handleTypes: Record<string, number>;
}

interface ProcessWithHandles {
  _getActiveHandles?: () => object[];
  _getActiveRequests?: () => object[];
}

export function openHandleSnapshot(): OpenHandleSnapshot {
  const proc = process as unknown as ProcessWithHandles;
  const handles = proc._getActiveHandles?.() ?? [];
  const requests = proc._getActiveRequests?.() ?? [];
  const handleTypes: Record<string, number> = {};
  for (const handle of handles) {
    const name = handle?.constructor?.name ?? 'unknown';
    handleTypes[name] = (handleTypes[name] ?? 0) + 1;
  }
  return { handles: handles.length, requests: requests.length, handleTypes };
}

// ─── Artifacts ───────────────────────────────────────────────────────────────

/**
 * Writes `value` as JSON to `$STRESS_OUT/<name>` when `STRESS_OUT` is set.
 * Returns the path written, or null when artifacts are disabled (the default
 * in the regular suite, so the repo never accumulates run output).
 */
export function writeStressArtifact(
  name: string,
  value: unknown,
): string | null {
  const dir = process.env.STRESS_OUT;
  if (!dir) return null;
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, name);
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  return target;
}
