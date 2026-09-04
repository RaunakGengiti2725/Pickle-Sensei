/**
 * Long-run leak probe shared by the `__tests__/stress/*` campaigns.
 *
 * Everything here is deliberately independent of fake timers: the wall clock
 * is captured from `process.hrtime.bigint` at module load (before any suite
 * calls `jest.useFakeTimers()`), so per-iteration durations measure real CPU
 * time even while Date/setTimeout/performance are faked.
 *
 * apps/mobile's tsconfig types only `jest` (no @types/node), so the Node
 * surface used here is declared explicitly, like xc-harness/nodeShim.
 */
import { nodeProcess } from '../xc-harness/lifecycle-persistence/nodeShim';

declare const process: {
  hrtime: { bigint(): bigint };
  getActiveResourcesInfo?: () => string[];
};

declare const globalThis: { gc?: () => void };

const hrtimeBigint: () => bigint = process.hrtime.bigint.bind(process.hrtime);

/** Real (never faked) monotonic milliseconds. */
export function realNowMs(): number {
  return Number(hrtimeBigint()) / 1e6;
}

/** True when this process was started with `node --expose-gc`. */
export function gcExposed(): boolean {
  return typeof globalThis.gc === 'function';
}

/**
 * Runs a full GC a few times so the heap sample reflects live objects, not
 * garbage awaiting collection. Returns false when `gc` is not exposed.
 */
export function forceGc(rounds = 3): boolean {
  const gc = globalThis.gc;
  if (typeof gc !== 'function') return false;
  for (let i = 0; i < rounds; i += 1) gc();
  return true;
}

/** Counts of `process.getActiveResourcesInfo()` entries by resource type. */
export function activeResources(): Record<string, number> {
  const info = process.getActiveResourcesInfo;
  if (typeof info !== 'function') return {};
  const counts: Record<string, number> = {};
  for (const kind of info()) counts[kind] = (counts[kind] ?? 0) + 1;
  return counts;
}

export interface HeapSample {
  iteration: number;
  gcForced: boolean;
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  /** Node's live libuv handles/requests by type at the checkpoint. */
  activeResources: Record<string, number>;
  /** Pending fake timers at the checkpoint (`jest.getTimerCount()`). */
  fakeTimers: number;
  /** Any harness-specific counters worth trending with the heap. */
  extra: Record<string, number>;
}

export function heapSample(
  iteration: number,
  extra: Record<string, number> = {},
): HeapSample {
  const gcForced = forceGc();
  const usage = nodeProcess.memoryUsage();
  return {
    iteration,
    gcForced,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    rss: usage.rss,
    external: usage.external,
    activeResources: activeResources(),
    fakeTimers: jest.getTimerCount(),
    extra,
  };
}

export interface SlopeReport {
  /** Checkpoints used (the first `skip` are treated as warm-up). */
  points: number;
  firstIteration: number;
  lastIteration: number;
  firstBytes: number;
  lastBytes: number;
  minBytes: number;
  maxBytes: number;
  /** Least-squares slope in bytes per iteration. */
  slopeBytesPerIteration: number;
  /** Slope expressed as % of the first steady-state sample per 100 iterations. */
  slopePctPer100: number;
  /** Total growth first→last as % of the first sample. */
  growthPct: number;
  /** Every consecutive checkpoint delta was >= 0. */
  monotoneNonDecreasing: boolean;
  /** Every consecutive checkpoint delta was > 0. */
  strictlyIncreasing: boolean;
  /** The lens threshold: monotone AND > 5 % per 100 iterations. */
  leakSuspected: boolean;
}

export const LEAK_SLOPE_PCT_PER_100 = 5;

/**
 * Least-squares slope over the checkpoints after `skip` warm-up samples
 * (module transforms, JIT and React's first-mount caches all land in the
 * first ~100 iterations). Needs at least four steady-state checkpoints —
 * i.e. a campaign of >= 250 iterations at the 50-iteration cadence — so the
 * quick in-suite smoke never judges a slope it cannot see.
 */
export function slopeReport(
  samples: readonly HeapSample[],
  pick: (sample: HeapSample) => number,
  skip = 2,
): SlopeReport | null {
  const steady = samples.slice(skip);
  if (steady.length < 4) return null;
  const xs = steady.map(s => s.iteration);
  const ys = steady.map(pick);
  const n = steady.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i]! - meanX;
    sxy += dx * (ys[i]! - meanY);
    sxx += dx * dx;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const first = ys[0]!;
  const last = ys[n - 1]!;
  let monotone = true;
  let strict = true;
  for (let i = 1; i < n; i += 1) {
    const delta = ys[i]! - ys[i - 1]!;
    if (delta < 0) monotone = false;
    if (delta <= 0) strict = false;
  }
  const slopePctPer100 = first === 0 ? 0 : ((slope * 100) / first) * 100;
  return {
    points: n,
    firstIteration: xs[0]!,
    lastIteration: xs[n - 1]!,
    firstBytes: first,
    lastBytes: last,
    minBytes: Math.min(...ys),
    maxBytes: Math.max(...ys),
    slopeBytesPerIteration: Math.round(slope),
    slopePctPer100: round2(slopePctPer100),
    growthPct: round2(first === 0 ? 0 : ((last - first) / first) * 100),
    monotoneNonDecreasing: monotone,
    strictlyIncreasing: strict,
    leakSuspected: monotone && slopePctPer100 > LEAK_SLOPE_PCT_PER_100,
  };
}

export interface DriftReport {
  samples: number;
  /** Iterations dropped from the head as JIT / module warm-up. */
  warmupDropped: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  /** Median of the first decile vs the last decile (after warm-up). */
  headMedianMs: number;
  tailMedianMs: number;
  /** tail / head; > 1 means later iterations got slower. */
  driftRatio: number;
  /** Least-squares slope in ms per 100 iterations. */
  slopeMsPer100: number;
}

export function driftReport(
  durationsMs: readonly number[],
  warmup = 20,
): DriftReport | null {
  const dropped = Math.min(warmup, Math.max(durationsMs.length - 20, 0));
  const body = durationsMs.slice(dropped);
  if (body.length < 10) return null;
  const decile = Math.max(1, Math.floor(body.length / 10));
  const head = body.slice(0, decile);
  const tail = body.slice(body.length - decile);
  const sorted = [...body].sort((a, b) => a - b);
  const n = body.length;
  const meanX = (n - 1) / 2;
  const meanY = body.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (i - meanX) * (body[i]! - meanY);
    sxx += (i - meanX) * (i - meanX);
  }
  const headMedian = median(head);
  const tailMedian = median(tail);
  return {
    samples: n,
    warmupDropped: dropped,
    p50Ms: round2(median(sorted)),
    p95Ms: round2(sorted[Math.min(n - 1, Math.floor(n * 0.95))]!),
    maxMs: round2(sorted[n - 1]!),
    headMedianMs: round2(headMedian),
    tailMedianMs: round2(tailMedian),
    driftRatio: round2(headMedian === 0 ? 0 : tailMedian / headMedian),
    slopeMsPer100: round2(sxx === 0 ? 0 : (sxy / sxx) * 100),
  };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Campaign size. Small default so the suite stays fast; the long-run leak
 * lens is executed with STRESS_ITER=500 (or more) explicitly.
 */
export function stressIterations(defaultCount: number): number {
  const raw = nodeProcess.env['STRESS_ITER'];
  if (!raw) return defaultCount;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : defaultCount;
}

/**
 * jest.fn() mocks (the preset's NativeAnimatedModule, StatusBar, ...) record
 * every call forever; that history is harness retention, not the unit's, so
 * campaigns drop it after each iteration. STRESS_KEEP_MOCK_HISTORY=1 keeps it
 * so the two heap curves can be compared.
 */
export function keepMockHistory(): boolean {
  return nodeProcess.env['STRESS_KEEP_MOCK_HISTORY'] === '1';
}

/** Optional single-seed replay: STRESS_SEED=<n> runs only that seed. */
export function stressSeedFilter(): number | null {
  const raw = nodeProcess.env['STRESS_SEED'];
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Heap checkpoint cadence (the lens asks for every 50 iterations). */
export const HEAP_CHECKPOINT_EVERY = 50;

/**
 * Tracks live `Animated.Value` listeners without touching production code:
 * wraps addListener/removeListener/removeAllListeners on the prototype and
 * keeps a per-instance live count.
 */
export interface AnimatedListenerLedger {
  live(): number;
  added: number;
  removed: number;
  restore(): void;
}

export interface ListenerHost {
  addListener(callback: (state: { value: number }) => void): string;
  removeListener(id: string): void;
  removeAllListeners(): void;
}

export function trackAnimatedListeners(
  prototype: ListenerHost,
): AnimatedListenerLedger {
  const original = {
    addListener: prototype.addListener,
    removeListener: prototype.removeListener,
    removeAllListeners: prototype.removeAllListeners,
  };
  const counts = new Map<ListenerHost, number>();
  const ledger: AnimatedListenerLedger = {
    added: 0,
    removed: 0,
    live: () => {
      let total = 0;
      for (const count of counts.values()) total += count;
      return total;
    },
    restore: () => {
      prototype.addListener = original.addListener;
      prototype.removeListener = original.removeListener;
      prototype.removeAllListeners = original.removeAllListeners;
    },
  };
  prototype.addListener = function addListener(
    this: ListenerHost,
    callback: (state: { value: number }) => void,
  ): string {
    const id = original.addListener.call(this, callback);
    ledger.added += 1;
    counts.set(this, (counts.get(this) ?? 0) + 1);
    return id;
  };
  prototype.removeListener = function removeListener(
    this: ListenerHost,
    id: string,
  ): void {
    const before = countListeners(this);
    original.removeListener.call(this, id);
    const after = countListeners(this);
    if (after < before) {
      ledger.removed += before - after;
      const next = (counts.get(this) ?? 0) - (before - after);
      if (next <= 0) counts.delete(this);
      else counts.set(this, next);
    }
  };
  prototype.removeAllListeners = function removeAllListeners(
    this: ListenerHost,
  ): void {
    const before = countListeners(this);
    original.removeAllListeners.call(this);
    ledger.removed += before;
    counts.delete(this);
  };
  return ledger;
}

function countListeners(host: ListenerHost): number {
  const listeners = (host as { _listeners?: Map<string, unknown> })._listeners;
  return listeners ? listeners.size : 0;
}
