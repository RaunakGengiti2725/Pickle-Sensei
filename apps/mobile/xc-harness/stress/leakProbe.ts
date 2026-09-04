/**
 * Shared instrumentation for the long-run leak stress suites
 * (`__tests__/stress/*.longRunLeak.stress.test.tsx`).
 *
 * A campaign mounts one unit N times in ONE Jest process and, every
 * `CHECKPOINT_EVERY` iterations, forces a full GC and records the heap, the
 * process's active libuv handles, the pending fake timers and the live
 * React Native event subscriptions. Every iteration is a pure function of its
 * 32-bit seed (`iterationSeed(base, index)`), so any row of the emitted JSON
 * table replays with `STRESS_REPLAY=<seed>`.
 *
 * Env:
 *   STRESS_ITER          iterations per suite (default DEFAULT_ITERATIONS)
 *   STRESS_SEED          base seed (default DEFAULT_BASE_SEED)
 *   STRESS_REPLAY        replay exactly one iteration seed
 *   STRESS_KEEP_MOCK_RECORDS=1  control run: do not clear jest.fn records
 *   STRESS_ARTIFACT_DIR  where the JSON tables go (default
 *                        <repo>/artifacts/stress/, gitignored)
 *
 * apps/mobile's tsconfig types only `jest` (no @types/node); the Node surface
 * used here is declared explicitly, the same way
 * `xc-harness/lifecycle-persistence/nodeShim.ts` does.
 */
declare const require: (id: string) => unknown;
declare const process: StressProcess;
declare const __dirname: string;
/** Node's global; left un-faked by the suites (`doNotFake: ['performance']`). */
declare const performance: { now(): number };

export interface StressProcess {
  env: Record<string, string | undefined>;
  version: string;
  memoryUsage(): {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
    arrayBuffers: number;
  };
  getActiveResourcesInfo?: () => string[];
}

interface NodeFs {
  mkdirSync(dir: string, options?: { recursive?: boolean }): void;
  writeFileSync(file: string, data: string): void;
  appendFileSync(file: string, data: string): void;
}
interface NodePath {
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
}

const fs = require('node:fs') as NodeFs;
const path = require('node:path') as NodePath;

export const DEFAULT_ITERATIONS = 150;
export const DEFAULT_BASE_SEED = 20260904;
export const CHECKPOINT_EVERY = 50;
/** LENS long-run-leak: a monotone heap slope above this is a finding. */
export const HEAP_SLOPE_LIMIT_PCT_PER_100 = 5;
/** Render-time drift: p50 of the last window vs the first post-warm-up window. */
export const DRIFT_RATIO_LIMIT = 3;

// ─── Seeds ───────────────────────────────────────────────────────────────────

/** mulberry32 — the same generator the lifecycle matrix uses. */
export function makePrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, items: readonly T[]): T {
  const index = Math.floor(rng() * items.length);
  return items[Math.min(index, items.length - 1)] as T;
}

export function chance(rng: () => number, probability: number): boolean {
  return rng() < probability;
}

export function intBetween(rng: () => number, min: number, max: number) {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Per-iteration seed: a splitmix-style hash of (base, index), 32-bit. */
export function iterationSeed(base: number, index: number): number {
  let x = (base ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

export interface CampaignPlan {
  iterations: number;
  baseSeed: number;
  /** Seeds in execution order. */
  seeds: number[];
  replaySeed: number | null;
}

/**
 * Every `jest.fn` (the RN preset mocks NativeAnimatedModule, UIManager,
 * AccessibilityInfo, … with them) appends to `mock.calls`/`mock.results` on
 * each call, so a mount/unmount loop grows the heap by the size of those
 * records unless they are cleared. That growth is Jest bookkeeping, not the
 * unit's; the suites clear it per iteration. STRESS_KEEP_MOCK_RECORDS=1 keeps
 * it (control run: shows the bookkeeping slope for comparison).
 */
export function shouldClearMockRecords(): boolean {
  return process.env['STRESS_KEEP_MOCK_RECORDS'] !== '1';
}

/** Heap slots retained per iteration by the canary (≈ 64 KB of JS heap). */
export const CANARY_SLOTS_PER_ITERATION = 8 * 1024;
const canaryHoard: number[][] = [];

/**
 * Detector self-test. STRESS_CANARY=1 makes every iteration retain a plain
 * JS array (on-heap, unlike ArrayBuffers) forever — a synthetic leak the
 * size of a small screen tree. A healthy harness must then report a heap
 * finding and FAIL, proving the slope judge sees a leak of that size at the
 * configured scale. Off by default.
 */
export function canaryRetain(index: number): boolean {
  if (process.env['STRESS_CANARY'] !== '1') return false;
  canaryHoard.push(
    Array.from({ length: CANARY_SLOTS_PER_ITERATION }, (_, i) => i ^ index),
  );
  return true;
}

export function planCampaign(): CampaignPlan {
  const replay = process.env['STRESS_REPLAY'];
  const baseSeed =
    Number(process.env['STRESS_SEED'] ?? DEFAULT_BASE_SEED) >>> 0;
  if (replay !== undefined && replay !== '') {
    const seed = Number(replay) >>> 0;
    return { iterations: 1, baseSeed, seeds: [seed], replaySeed: seed };
  }
  const requested = Number(process.env['STRESS_ITER'] ?? DEFAULT_ITERATIONS);
  const iterations =
    Number.isFinite(requested) && requested > 0
      ? Math.floor(requested)
      : DEFAULT_ITERATIONS;
  return {
    iterations,
    baseSeed,
    seeds: Array.from({ length: iterations }, (_, i) =>
      iterationSeed(baseSeed, i),
    ),
    replaySeed: null,
  };
}

// ─── GC + heap ───────────────────────────────────────────────────────────────

/**
 * `global.gc` when Jest ran under `node --expose-gc`; otherwise the V8 flag
 * is flipped at runtime and `gc` pulled out of a fresh context so the heap
 * checkpoints are meaningful in a plain `npx jest` run too.
 */
export function acquireGc(): { gc: () => void; source: string } | null {
  const fromGlobal = (globalThis as { gc?: unknown }).gc;
  if (typeof fromGlobal === 'function') {
    return { gc: fromGlobal as () => void, source: 'global.gc (--expose-gc)' };
  }
  try {
    const v8 = require('node:v8') as {
      setFlagsFromString(flag: string): void;
    };
    const vm = require('node:vm') as {
      runInNewContext(code: string): unknown;
    };
    v8.setFlagsFromString('--expose-gc');
    const fn = vm.runInNewContext('gc');
    if (typeof fn === 'function') {
      return { gc: fn as () => void, source: 'v8.setFlagsFromString + vm' };
    }
  } catch {
    // fall through
  }
  return null;
}

export interface HeapSample {
  iteration: number;
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  arrayBuffers: number;
  /** libuv handle/request counts by type (process.getActiveResourcesInfo). */
  activeResources: Record<string, number>;
  /** Pending fake timers at the checkpoint. */
  timers: number;
  /** Live RN event subscriptions by source at the checkpoint. */
  listeners: Record<string, number>;
}

export function activeResources(): Record<string, number> {
  const info = process.getActiveResourcesInfo?.() ?? [];
  const counts: Record<string, number> = {};
  for (const kind of info) counts[kind] = (counts[kind] ?? 0) + 1;
  return counts;
}

export function takeHeapSample(
  iteration: number,
  gc: (() => void) | null,
  timers: number,
  listeners: Record<string, number>,
): HeapSample {
  if (gc) {
    gc();
    gc();
  }
  const usage = process.memoryUsage();
  return {
    iteration,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    rss: usage.rss,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
    activeResources: activeResources(),
    timers,
    listeners,
  };
}

export interface HeapVerdict {
  samples: number;
  /** Least-squares slope of heapUsed over iterations, as % of the first
   * post-warm-up sample per 100 iterations. null with < 3 samples. */
  slopePctPer100: number | null;
  /** Every checkpoint after the first strictly higher than the one before. */
  monotone: boolean;
  /** (last − first) / first, in %. */
  deltaPct: number | null;
  firstHeapUsed: number | null;
  lastHeapUsed: number | null;
  /** LENS rule: monotone AND slope > HEAP_SLOPE_LIMIT_PCT_PER_100. */
  finding: boolean;
  /** Slope over the limit but not monotone — recorded, not asserted. */
  suspect: boolean;
}

/** The first checkpoint is the warm-up (module caches, JIT) and anchors the
 * percentage; the slope is fitted over every checkpoint including it. */
export function judgeHeap(samples: readonly HeapSample[]): HeapVerdict {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last || samples.length < 2) {
    return {
      samples: samples.length,
      slopePctPer100: null,
      monotone: false,
      deltaPct: null,
      firstHeapUsed: first?.heapUsed ?? null,
      lastHeapUsed: last?.heapUsed ?? null,
      finding: false,
      suspect: false,
    };
  }
  let monotone = true;
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1];
    const cur = samples[i];
    if (!prev || !cur || cur.heapUsed <= prev.heapUsed) {
      monotone = false;
      break;
    }
  }
  const deltaPct = ((last.heapUsed - first.heapUsed) / first.heapUsed) * 100;
  let slopePctPer100: number | null = null;
  if (samples.length >= 3) {
    const n = samples.length;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (const s of samples) {
      sx += s.iteration;
      sy += s.heapUsed;
      sxx += s.iteration * s.iteration;
      sxy += s.iteration * s.heapUsed;
    }
    const denom = n * sxx - sx * sx;
    if (denom !== 0) {
      const slopePerIteration = (n * sxy - sx * sy) / denom;
      slopePctPer100 = ((slopePerIteration * 100) / first.heapUsed) * 100;
    }
  }
  const overLimit =
    slopePctPer100 !== null && slopePctPer100 > HEAP_SLOPE_LIMIT_PCT_PER_100;
  return {
    samples: samples.length,
    slopePctPer100,
    monotone,
    deltaPct,
    firstHeapUsed: first.heapUsed,
    lastHeapUsed: last.heapUsed,
    finding: overLimit && monotone,
    suspect: overLimit && !monotone,
  };
}

// ─── Timing drift ────────────────────────────────────────────────────────────

export interface DriftVerdict {
  window: number;
  firstWindowP50Ms: number | null;
  lastWindowP50Ms: number | null;
  firstWindowP95Ms: number | null;
  lastWindowP95Ms: number | null;
  ratio: number | null;
  overLimit: boolean;
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? null;
}

/** The first `window` iterations are warm-up; the window after them is the
 * reference and the final window the comparison. */
export function judgeDrift(durationsMs: readonly number[]): DriftVerdict {
  const n = durationsMs.length;
  const window = Math.max(5, Math.floor(n / 5));
  if (n < window * 3) {
    return {
      window,
      firstWindowP50Ms: percentile(durationsMs, 50),
      lastWindowP50Ms: null,
      firstWindowP95Ms: percentile(durationsMs, 95),
      lastWindowP95Ms: null,
      ratio: null,
      overLimit: false,
    };
  }
  const first = durationsMs.slice(window, window * 2);
  const last = durationsMs.slice(n - window);
  const firstP50 = percentile(first, 50);
  const lastP50 = percentile(last, 50);
  const ratio =
    firstP50 !== null && lastP50 !== null && firstP50 > 0
      ? lastP50 / firstP50
      : null;
  return {
    window,
    firstWindowP50Ms: firstP50,
    lastWindowP50Ms: lastP50,
    firstWindowP95Ms: percentile(first, 95),
    lastWindowP95Ms: percentile(last, 95),
    ratio,
    overLimit: ratio !== null && ratio > DRIFT_RATIO_LIMIT,
  };
}

export function nowMs(): number {
  return performance.now();
}

// ─── RN event-subscription ledger ────────────────────────────────────────────

interface Subscription {
  remove?: () => void;
}
type AddListener = (...args: unknown[]) => Subscription | void;

export interface ListenerTarget {
  name: string;
  host: Record<string, unknown>;
  method: string;
}

export interface ListenerLedger {
  /** Live (added, not yet removed) subscriptions per source. */
  live(): Record<string, number>;
  liveCount(): number;
  /** Every add ever seen per source (cumulative). */
  added(): Record<string, number>;
  /** Handlers currently registered for `source`, in registration order. */
  handlers(source: string): unknown[];
  /** Sources whose add-method was actually wrapped. */
  tracked(): string[];
  restore(): void;
}

/**
 * Wraps the RN global event sources the launch surfaces subscribe to
 * (AppState, Dimensions, Appearance, AccessibilityInfo, Keyboard, Linking,
 * DeviceEventEmitter) so the suite can prove every subscription an iteration
 * adds is removed again by its unmount. The wrapper forwards to the module's
 * own implementation (the RN jest preset's mocks) and only tracks the
 * returned subscription's `remove`.
 */
export function trackListeners(targets: readonly ListenerTarget[]) {
  const live = new Map<string, Map<number, unknown>>();
  const added: Record<string, number> = {};
  let nextId = 0;
  const restores: (() => void)[] = [];
  const tracked: string[] = [];

  for (const target of targets) {
    const original = target.host[target.method];
    if (typeof original !== 'function') continue;
    const originalFn = original as AddListener;
    live.set(target.name, new Map());
    added[target.name] = 0;
    const wrapped: AddListener = (...args: unknown[]) => {
      const result = originalFn.apply(target.host, args) as
        Subscription | undefined;
      const id = nextId++;
      live.get(target.name)?.set(id, args[1]);
      added[target.name] = (added[target.name] ?? 0) + 1;
      const originalRemove = result?.remove;
      const subscription: Subscription = {
        ...(result ?? {}),
        remove: () => {
          live.get(target.name)?.delete(id);
          if (typeof originalRemove === 'function') {
            originalRemove.call(result);
          }
        },
      };
      return subscription;
    };
    target.host[target.method] = wrapped;
    if (target.host[target.method] !== wrapped) {
      live.delete(target.name);
      delete added[target.name];
      continue;
    }
    tracked.push(target.name);
    restores.push(() => {
      target.host[target.method] = originalFn;
    });
  }

  const ledger: ListenerLedger = {
    live: () => {
      const out: Record<string, number> = {};
      for (const [name, map] of live) out[name] = map.size;
      return out;
    },
    liveCount: () => {
      let total = 0;
      for (const map of live.values()) total += map.size;
      return total;
    },
    added: () => ({ ...added }),
    handlers: source => [...(live.get(source)?.values() ?? [])],
    tracked: () => [...tracked],
    restore: () => {
      for (const restore of restores) restore();
    },
  };
  return ledger;
}

export function sameCounts(
  a: Record<string, number>,
  b: Record<string, number>,
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if ((a[key] ?? 0) !== (b[key] ?? 0)) return false;
  return true;
}

/** Handle kinds that a leaked timer/socket/child would show up as; the rest
 * (FSReqCallback, PipeWrap to the Jest parent) belong to the worker. */
export const APP_VISIBLE_RESOURCE_KINDS = [
  'Timeout',
  'Immediate',
  'TCPWrap',
  'TCPSocketWrap',
  'TTYWrap',
  'ProcessWrap',
  'TimerWrap',
  'MessagePort',
] as const;

export function resourceGrowth(
  baseline: Record<string, number>,
  current: Record<string, number>,
): Record<string, number> {
  const growth: Record<string, number> = {};
  for (const kind of APP_VISIBLE_RESOURCE_KINDS) {
    const delta = (current[kind] ?? 0) - (baseline[kind] ?? 0);
    if (delta > 0) growth[kind] = delta;
  }
  return growth;
}

// ─── Row table + artifacts ───────────────────────────────────────────────────

export type Outcome = 'HELD' | 'BROKEN';

/** The seed → outcome table row kept in memory for the whole campaign; the
 * verbose scenario/observed/checks record streams to the JSONL trace so the
 * harness's own retention stays at a few hundred bytes per iteration. */
export interface IterationRow {
  index: number;
  seed: number;
  outcome: Outcome;
  failed: string[];
  mountMs: number;
  unmountMs: number;
  totalMs: number;
}

export interface IterationTrace extends IterationRow {
  scenario: Record<string, unknown>;
  observed: Record<string, unknown>;
  checks: Record<string, boolean>;
}

export interface CampaignSummary {
  unit: string;
  lens: 'long-run-leak';
  suite: string;
  node: string;
  gc: string | null;
  plan: CampaignPlan;
  executed: number;
  held: number;
  broken: number;
  brokenSeeds: number[];
  heap: HeapVerdict;
  heapSamples: HeapSample[];
  mountDrift: DriftVerdict;
  totalDrift: DriftVerdict;
  trackedListenerSources: string[];
  /** jest.fn call records cleared per iteration (false = control run). */
  mockRecordsCleared: boolean;
  /** True when STRESS_CANARY=1 injected a synthetic leak (run must FAIL). */
  canaryLeakInjected: boolean;
  baseline: {
    timers: number;
    statusBarStack: number;
    listeners: Record<string, number>;
    activeResources: Record<string, number>;
  };
  final: {
    timers: number;
    statusBarStack: number;
    listeners: Record<string, number>;
    activeResources: Record<string, number>;
    resourceGrowth: Record<string, number>;
  };
  campaignChecks: Record<string, boolean>;
  campaignFailed: string[];
  wallMs: number;
  artifacts: { rows: string; trace: string; summary: string };
}

export function artifactDir(): string {
  const configured = process.env['STRESS_ARTIFACT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(__dirname, '../../../../artifacts/stress');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function artifactPath(name: string): string {
  return path.join(artifactDir(), name);
}

export function nodeVersion(): string {
  return process.version;
}

export function writeJsonArtifact(name: string, value: unknown): string {
  const file = artifactPath(name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}

/** Truncates `name` and returns an appender writing one JSON line per call. */
export function openJsonlArtifact(name: string): {
  file: string;
  append(value: unknown): void;
} {
  const file = artifactPath(name);
  fs.writeFileSync(file, '');
  return {
    file,
    append: value => fs.appendFileSync(file, JSON.stringify(value) + '\n'),
  };
}

export function judgeChecks(checks: Record<string, boolean>): {
  failed: string[];
  outcome: Outcome;
} {
  const failed = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  return { failed, outcome: failed.length === 0 ? 'HELD' : 'BROKEN' };
}

/** One-line replay hint for a failing row. */
export function replayHint(suite: string, seed: number): string {
  return `STRESS_REPLAY=${seed} NODE_OPTIONS=--expose-gc npx jest --ci --runInBand ${suite}`;
}
