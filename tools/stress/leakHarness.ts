import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

/**
 * Long-run leak harness shared by the ops-bundle stress suites.
 *
 * A campaign invokes a unit N times in ONE process with a seeded RNG (every
 * iteration is replayable from `baseSeed + iteration`), forces a GC at every
 * checkpoint and records heap / open-handle / listener counts plus per-window
 * invocation time so heap slope, handle drift and time drift can be judged
 * from a machine-readable table. Objects handed back through
 * `retainables` are tracked with WeakRefs: anything still alive at a
 * checkpoint after GC (other than the most recent iteration's) is a retained
 * object — the sharpest leak signal available without a heap snapshot.
 *
 * Nothing here touches production code; tests decide what to assert.
 */

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface IterationOutcome {
  /** Short deterministic label, e.g. "ACCEPTED" or "closed/4-evidence". */
  outcome: string;
  /** Deterministic digest of the iteration's observable output. */
  digest: string;
  /** Objects that must be collectable once the iteration is over. */
  retainables?: readonly object[];
  /** Small deterministic payload copied into the seed → outcome table. */
  detail?: Json;
}

export interface IterationRow {
  iteration: number;
  seed: number;
  outcome: string;
  digest: string;
  durationMs: number;
  detail?: Json;
  error?: string;
}

export interface ResourceSnapshot {
  activeResources: Record<string, number>;
  activeResourceTotal: number;
  processListeners: number;
}

export interface Checkpoint extends ResourceSnapshot {
  iteration: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  rssBytes: number;
  /** Tracked objects from PREVIOUS iterations still alive after GC. */
  retainedFromPriorIterations: number;
  windowMeanMs: number;
  windowP95Ms: number;
  elapsedMs: number;
}

export interface LeakCampaignReport {
  name: string;
  baseSeed: number;
  iterations: number;
  checkpointEvery: number;
  gcForced: boolean;
  /** Where the GC hook came from: the `--expose-gc` global, or v8 flags set at runtime. */
  gcSource: "expose-gc" | "v8-flags" | null;
  nodeVersion: string;
  execArgv: string[];
  startedAtIso: string;
  totalMs: number;
  checkpoints: Checkpoint[];
  rows: IterationRow[];
  failures: IterationRow[];
  heap: {
    firstCheckpointBytes: number;
    lastCheckpointBytes: number;
    slopeBytesPerIteration: number;
    slopePctPer100: number;
    monotoneIncreasing: boolean;
  };
  handles: {
    baseline: ResourceSnapshot;
    final: ResourceSnapshot;
    /** True when no handle kind (or the process listener count) grew. */
    returnedToBaseline: boolean;
    /** Every kind whose count changed; negatives are runner timers that fired. */
    delta: Record<string, number>;
    /** Kinds that grew — the actual leak signal. */
    grown: Record<string, number>;
  };
  timing: {
    firstWindowMeanMs: number;
    lastWindowMeanMs: number;
    driftRatio: number;
    monotoneIncreasing: boolean;
  };
  retained: {
    maxAtAnyCheckpoint: number;
    atFinalCheckpoint: number;
  };
}

export interface LeakCampaignOptions {
  name: string;
  baseSeed: number;
  iterations: number;
  checkpointEvery?: number;
  run: (seed: number, iteration: number) => IterationOutcome;
}

/** Iteration budget: STRESS_ITER (>= 1) when set, otherwise the small default. */
export function stressIterations(defaultIterations: number): number {
  const raw = process.env.STRESS_ITER;
  if (raw === undefined || raw.trim() === "") return defaultIterations;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`STRESS_ITER must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/** Deterministic 32-bit PRNG (mulberry32); identical seeds yield identical streams. */
export class SeededRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick from empty list");
    return items[this.int(0, items.length - 1)] as T;
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  hex(length: number): string {
    let out = "";
    while (out.length < length) out += this.int(0, 15).toString(16);
    return out;
  }
}

/** FNV-1a 32-bit digest of a JSON-serialisable value (stable key order not assumed — callers pass canonical data). */
export function digestOf(value: unknown): string {
  const text = JSON.stringify(value) ?? "undefined";
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Paths of every non-finite number in a nested value; empty when the output is clean. */
export function nonFinitePaths(value: unknown, path = "$"): string[] {
  if (typeof value === "number") return Number.isFinite(value) ? [] : [path];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => nonFinitePaths(item, `${path}[${index}]`));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
      nonFinitePaths(item, `${path}.${key}`),
    );
  }
  return [];
}

type GcFn = () => void;

let cachedGc: GcFn | null | undefined;
let cachedGcSource: "expose-gc" | "v8-flags" | null = null;

/** Resolve a real GC hook: `--expose-gc` when present, else via v8 flags in a throwaway context. */
export function resolveGc(): GcFn | null {
  if (cachedGc !== undefined) return cachedGc;
  const exposed = (globalThis as { gc?: GcFn }).gc;
  if (typeof exposed === "function") {
    cachedGc = exposed;
    cachedGcSource = "expose-gc";
    return cachedGc;
  }
  try {
    setFlagsFromString("--expose-gc");
    const fromContext = runInNewContext("gc") as unknown;
    cachedGc = typeof fromContext === "function" ? (fromContext as GcFn) : null;
    cachedGcSource = cachedGc === null ? null : "v8-flags";
  } catch {
    cachedGc = null;
  }
  return cachedGc;
}

export function gcSource(): "expose-gc" | "v8-flags" | null {
  resolveGc();
  return cachedGcSource;
}

export function snapshotResources(): ResourceSnapshot {
  const activeResources: Record<string, number> = {};
  for (const kind of process.getActiveResourcesInfo()) {
    activeResources[kind] = (activeResources[kind] ?? 0) + 1;
  }
  let processListeners = 0;
  for (const eventName of process.eventNames()) {
    processListeners += process.listenerCount(eventName);
  }
  return {
    activeResources,
    activeResourceTotal: Object.values(activeResources).reduce((acc, n) => acc + n, 0),
    processListeners,
  };
}

function resourceDelta(a: ResourceSnapshot, b: ResourceSnapshot): Record<string, number> {
  const delta: Record<string, number> = {};
  for (const kind of new Set([
    ...Object.keys(a.activeResources),
    ...Object.keys(b.activeResources),
  ])) {
    const diff = (b.activeResources[kind] ?? 0) - (a.activeResources[kind] ?? 0);
    if (diff !== 0) delta[kind] = diff;
  }
  if (b.processListeners !== a.processListeners) {
    delta.processListeners = b.processListeners - a.processListeners;
  }
  return delta;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((acc, v) => acc + v, 0) / values.length;
}

function p95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
}

function leastSquaresSlope(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length < 2) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dx = (xs[i] ?? 0) - mx;
    num += dx * ((ys[i] ?? 0) - my);
    den += dx * dx;
  }
  return den === 0 ? 0 : num / den;
}

function isMonotoneIncreasing(values: readonly number[]): boolean {
  if (values.length < 2) return false;
  for (let i = 1; i < values.length; i += 1) {
    if ((values[i] ?? 0) <= (values[i - 1] ?? 0)) return false;
  }
  return true;
}

function yieldToEventLoop(): Promise<void> {
  // WeakRef targets are kept alive until the end of the current job, so the
  // GC at a checkpoint must run in a fresh macrotask to see them as garbage.
  return new Promise((resolve) => setImmediate(resolve));
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Run a seeded long-run campaign in the current process. Never throws for a
 * failing iteration — failures are rows with `error` set, so the caller can
 * assert on `report.failures` and still upload the full table.
 */
export async function runLeakCampaign(options: LeakCampaignOptions): Promise<LeakCampaignReport> {
  const checkpointEvery = options.checkpointEvery ?? 50;
  const gc = resolveGc();
  const startedAt = performance.now();
  const startedAtIso = new Date().toISOString();

  // Warm-up: one untracked iteration so module-level lazy state (JIT, caches,
  // first ffmpeg spawn) does not masquerade as growth in the first window.
  try {
    options.run(options.baseSeed - 1, -1);
  } catch {
    // The warm-up outcome is irrelevant; the seeded iterations are judged.
  }
  await yieldToEventLoop();
  gc?.();
  const baselineResources = snapshotResources();

  const rows: IterationRow[] = [];
  const checkpoints: Checkpoint[] = [];
  let tracked: WeakRef<object>[] = [];
  let windowDurations: number[] = [];
  let maxRetained = 0;

  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    const seed = options.baseSeed + iteration;
    const t0 = performance.now();
    let row: IterationRow;
    let fresh: WeakRef<object>[] = [];
    try {
      const outcome = options.run(seed, iteration);
      const durationMs = performance.now() - t0;
      fresh = (outcome.retainables ?? []).map((target) => new WeakRef(target));
      row = { iteration, seed, outcome: outcome.outcome, digest: outcome.digest, durationMs };
      if (outcome.detail !== undefined) row.detail = outcome.detail;
    } catch (error) {
      row = {
        iteration,
        seed,
        outcome: "THREW",
        digest: "",
        durationMs: performance.now() - t0,
        error: errorText(error),
      };
    }
    rows.push(row);
    windowDurations.push(row.durationMs);

    if ((iteration + 1) % checkpointEvery === 0 || iteration + 1 === options.iterations) {
      await yieldToEventLoop();
      gc?.();
      await yieldToEventLoop();
      gc?.();
      // Only objects from iterations BEFORE this one count as retained: the
      // current iteration's outcome may still sit in a live stack slot.
      const retained = tracked.filter((ref) => ref.deref() !== undefined).length;
      maxRetained = Math.max(maxRetained, retained);
      const mem = process.memoryUsage();
      const resources = snapshotResources();
      checkpoints.push({
        iteration: iteration + 1,
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
        externalBytes: mem.external,
        arrayBuffersBytes: mem.arrayBuffers,
        rssBytes: mem.rss,
        retainedFromPriorIterations: retained,
        windowMeanMs: mean(windowDurations),
        windowP95Ms: p95(windowDurations),
        elapsedMs: performance.now() - startedAt,
        ...resources,
      });
      windowDurations = [];
      // Drop refs already proven dead; keep the live ones so a slow leak
      // (objects surviving several checkpoints) stays visible.
      tracked = tracked.filter((ref) => ref.deref() !== undefined);
    }
    tracked.push(...fresh);
  }

  await yieldToEventLoop();
  gc?.();
  const finalResources = snapshotResources();

  const xs = checkpoints.map((c) => c.iteration);
  const heaps = checkpoints.map((c) => c.heapUsedBytes);
  const firstHeap = heaps[0] ?? 0;
  const slope = leastSquaresSlope(xs, heaps);
  const windowMeans = checkpoints.map((c) => c.windowMeanMs);
  const firstWindow = windowMeans[0] ?? 0;
  const lastWindow = windowMeans[windowMeans.length - 1] ?? 0;
  const delta = resourceDelta(baselineResources, finalResources);
  const grown = Object.fromEntries(Object.entries(delta).filter(([, diff]) => diff > 0));
  const last = checkpoints[checkpoints.length - 1];

  return {
    name: options.name,
    baseSeed: options.baseSeed,
    iterations: rows.length,
    checkpointEvery,
    gcForced: gc !== null,
    gcSource: gcSource(),
    nodeVersion: process.version,
    execArgv: [...process.execArgv],
    startedAtIso,
    totalMs: performance.now() - startedAt,
    checkpoints,
    rows,
    failures: rows.filter((row) => row.error !== undefined),
    heap: {
      firstCheckpointBytes: firstHeap,
      lastCheckpointBytes: heaps[heaps.length - 1] ?? 0,
      slopeBytesPerIteration: slope,
      slopePctPer100: firstHeap === 0 ? 0 : ((slope * 100) / firstHeap) * 100,
      monotoneIncreasing: isMonotoneIncreasing(heaps),
    },
    handles: {
      baseline: baselineResources,
      final: finalResources,
      returnedToBaseline: Object.keys(grown).length === 0,
      delta,
      grown,
    },
    timing: {
      firstWindowMeanMs: firstWindow,
      lastWindowMeanMs: lastWindow,
      driftRatio: firstWindow === 0 ? 0 : lastWindow / firstWindow,
      monotoneIncreasing: isMonotoneIncreasing(windowMeans),
    },
    retained: {
      maxAtAnyCheckpoint: maxRetained,
      atFinalCheckpoint: last?.retainedFromPriorIterations ?? 0,
    },
  };
}

/**
 * Same-seed determinism check: run every listed seed twice and return the
 * seeds whose digest differed. Independent of the campaign so replays can be
 * asserted separately from leak metrics.
 */
export function nondeterministicSeeds(
  seeds: readonly number[],
  run: (seed: number, iteration: number) => IterationOutcome,
): number[] {
  const unstable: number[] = [];
  for (const seed of seeds) {
    const a = run(seed, 0).digest;
    const b = run(seed, 0).digest;
    if (a !== b) unstable.push(seed);
  }
  return unstable;
}

/** Persist a report under $STRESS_OUT (no-op when unset); returns the path written. */
export function writeReportIfRequested(report: LeakCampaignReport): string | null {
  const dir = process.env.STRESS_OUT;
  if (dir === undefined || dir.trim() === "") return null;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${report.name}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2));
  return path;
}

/** One-line human summary for test output / logs. */
export function summarizeReport(report: LeakCampaignReport): string {
  const kb = (bytes: number): string => `${(bytes / 1024).toFixed(0)}KiB`;
  return [
    `[${report.name}] iters=${report.iterations} gc=${report.gcForced ? `forced(${report.gcSource ?? "?"})` : "UNAVAILABLE"}`,
    `heap ${kb(report.heap.firstCheckpointBytes)}→${kb(report.heap.lastCheckpointBytes)}`,
    `slope=${report.heap.slopePctPer100.toFixed(2)}%/100it (${report.heap.slopeBytesPerIteration.toFixed(0)} B/it, monotone=${report.heap.monotoneIncreasing})`,
    `retained=${report.retained.maxAtAnyCheckpoint}`,
    `handles=${report.handles.returnedToBaseline ? "baseline" : `GREW ${JSON.stringify(report.handles.grown)}`}${
      Object.keys(report.handles.delta).length > 0
        ? ` delta=${JSON.stringify(report.handles.delta)}`
        : ""
    }`,
    `time ${report.timing.firstWindowMeanMs.toFixed(3)}→${report.timing.lastWindowMeanMs.toFixed(3)}ms (x${report.timing.driftRatio.toFixed(2)})`,
    `failures=${report.failures.length}`,
  ].join(" ");
}
