import { createHook } from "node:async_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * LONG-RUN LEAK probe shared by the stress campaigns in this directory.
 *
 * Measures what the `long-run-leak` lens asks for and nothing else:
 *   - heap after an explicit GC at every checkpoint (`--expose-gc`; when the
 *     process was started without it, `gcAvailable` is false and the heap
 *     slope is recorded but the slope assertion cannot be trusted — the
 *     campaign reports that honestly instead of asserting on noise),
 *   - live libuv handles per type (`process.getActiveResourcesInfo()`), so
 *     timers left behind by the unit show up as a `Timeout` delta,
 *   - process-level listeners (unhandledRejection / uncaughtException /
 *     warning) so a unit that installs and never removes one is visible,
 *   - wall-clock drift: the median invocation time of the last window vs the
 *     first window after warm-up.
 *
 * Scale is env-gated so the default suite stays fast:
 *   STRESS_ITER      iterations per campaign (default 60; the lens scale is ≥ 500)
 *   STRESS_SEED      base seed (default 1)
 *   STRESS_OUT       artifact dir (default <repo>/artifacts/stress/analysis-pipeline-long-run-leak)
 */

export const STRESS_ITER = Math.max(1, Number(process.env.STRESS_ITER ?? "60"));
export const STRESS_SEED = Number(process.env.STRESS_SEED ?? "1");
export const CHECKPOINT_EVERY = 50;
/** Lens threshold: a monotone heap slope above this is a finding. */
export const HEAP_SLOPE_LIMIT_PCT_PER_100 = 5;

export const STRESS_OUT = resolve(
  process.env.STRESS_OUT ??
    resolve(__dirname, "../../../../artifacts/stress/analysis-pipeline-long-run-leak"),
);

export const gcAvailable = typeof globalThis.gc === "function";

export function gcNow(): void {
  if (typeof globalThis.gc === "function") {
    globalThis.gc();
    globalThis.gc();
  }
}

export interface ResourceSnapshot {
  handles: Record<string, number>;
  processListeners: Record<string, number>;
}

const WATCHED_PROCESS_EVENTS = [
  "unhandledRejection",
  "uncaughtException",
  "warning",
  "exit",
  "beforeExit",
] as const;

export function resourceSnapshot(): ResourceSnapshot {
  const handles: Record<string, number> = {};
  for (const kind of process.getActiveResourcesInfo()) {
    handles[kind] = (handles[kind] ?? 0) + 1;
  }
  const processListeners: Record<string, number> = {};
  for (const name of WATCHED_PROCESS_EVENTS) {
    processListeners[name] = process.listenerCount(name);
  }
  return { handles, processListeners };
}

/** Per-kind delta (after − before) restricted to kinds whose count changed. */
export function resourceDelta(
  before: ResourceSnapshot,
  after: ResourceSnapshot,
): { handles: Record<string, number>; processListeners: Record<string, number> } {
  const handles: Record<string, number> = {};
  for (const kind of new Set([...Object.keys(before.handles), ...Object.keys(after.handles)])) {
    const delta = (after.handles[kind] ?? 0) - (before.handles[kind] ?? 0);
    if (delta !== 0) handles[kind] = delta;
  }
  const processListeners: Record<string, number> = {};
  for (const name of WATCHED_PROCESS_EVENTS) {
    const delta = (after.processListeners[name] ?? 0) - (before.processListeners[name] ?? 0);
    if (delta !== 0) processListeners[name] = delta;
  }
  return { handles, processListeners };
}

/** Only the kinds that GREW. A pre-existing timer (the test runner's own)
 * expiring during a probe shows up as a negative delta and is not a leak. */
export function resourceGrowth(
  before: ResourceSnapshot,
  after: ResourceSnapshot,
): { handles: Record<string, number>; processListeners: Record<string, number> } {
  const delta = resourceDelta(before, after);
  return {
    handles: Object.fromEntries(Object.entries(delta.handles).filter(([, n]) => n > 0)),
    processListeners: Object.fromEntries(
      Object.entries(delta.processListeners).filter(([, n]) => n > 0),
    ),
  };
}

/**
 * Exact live-timer accounting via async_hooks. `getActiveResourcesInfo()` is
 * process-wide, so an unrelated timer (the test runner's own) expiring during
 * a probe masks a timer the unit left behind — a `Timeout` delta of 0 can hide
 * `+1 unit, −1 runner`. This tracker counts only timers CREATED after
 * `enable()` that have not been destroyed (fired-and-not-rearmed or cleared).
 * Node emits `destroy` asynchronously, so every read first lets the destroy
 * queue flush across a few immediates.
 *
 * `mark()` snapshots the live ids; `leakedSince(mark)` counts timers created
 * AFTER the mark that are still alive — a pre-existing timer expiring inside
 * the window cannot offset a retained one (a plain count delta could go −1).
 * Timers whose creation stack is inside the test runner itself (vitest's
 * birpc `sendCall` timeout fires from the worker at arbitrary moments) are
 * attributed to the runner and excluded; everything else — first-party source
 * or any dependency it calls — counts.
 */
const RUNNER_FRAME = /node_modules\/(?:\.pnpm\/)?(?:vitest|vite|@vitest|birpc|tinypool)[@/]/;

export class TimeoutTracker {
  /** live timer id → creation stack (for attributing a retained timer). */
  private readonly live = new Map<number, string>();
  private readonly hook = createHook({
    init: (id, type) => {
      if (type === "Timeout") {
        this.live.set(
          id,
          (new Error().stack ?? "")
            .split("\n")
            .slice(1)
            .filter((line) => !line.includes("node:internal") && !line.includes("leakProbe"))
            .slice(0, 4)
            .map((line) => line.trim())
            .join(" <- "),
        );
      }
    },
    destroy: (id) => {
      this.live.delete(id);
    },
  });

  enable(): this {
    this.hook.enable();
    return this;
  }

  disable(): void {
    this.hook.disable();
  }

  private async flushDestroys(): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  async mark(): Promise<ReadonlySet<number>> {
    await this.flushDestroys();
    return new Set(this.live.keys());
  }

  /** Creation stacks of timers created after `mark` that are still alive. */
  async leakedSince(mark: ReadonlySet<number>): Promise<string[]> {
    await this.flushDestroys();
    const stacks: string[] = [];
    for (const [id, stack] of this.live) {
      if (!mark.has(id) && !RUNNER_FRAME.test(stack)) stacks.push(stack);
    }
    return stacks;
  }
}

export interface HeapCheckpoint {
  iteration: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  rssBytes: number;
  elapsedMs: number;
  handles: Record<string, number>;
}

export function heapCheckpoint(iteration: number, startedAt: number): HeapCheckpoint {
  gcNow();
  const usage = process.memoryUsage();
  return {
    iteration,
    heapUsedBytes: usage.heapUsed,
    heapTotalBytes: usage.heapTotal,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
    rssBytes: usage.rss,
    elapsedMs: performance.now() - startedAt,
    handles: resourceSnapshot().handles,
  };
}

export interface HeapSlope {
  /** Least-squares slope of heapUsed vs iteration, bytes per iteration. */
  bytesPerIteration: number;
  /** Slope expressed as % of the first post-warm-up checkpoint per 100 iterations. */
  pctPer100: number;
  /** Fraction of consecutive checkpoint pairs where heapUsed increased. */
  monotoneFraction: number;
  checkpointsUsed: number;
  firstHeapUsedBytes: number;
  lastHeapUsedBytes: number;
  maxHeapUsedBytes: number;
}

/**
 * Slope over checkpoints after dropping the first `warmup` (JIT + module
 * caches settle in the first window). With fewer than 3 usable checkpoints
 * the slope is reported as 0 with `checkpointsUsed` telling the reader why.
 */
export function heapSlope(checkpoints: readonly HeapCheckpoint[], warmup = 1): HeapSlope {
  const used = checkpoints.slice(Math.min(warmup, Math.max(0, checkpoints.length - 2)));
  const first = used[0]?.heapUsedBytes ?? 0;
  const last = used[used.length - 1]?.heapUsedBytes ?? 0;
  const max = used.reduce((acc, c) => Math.max(acc, c.heapUsedBytes), 0);
  if (used.length < 3) {
    return {
      bytesPerIteration: 0,
      pctPer100: 0,
      monotoneFraction: 0,
      checkpointsUsed: used.length,
      firstHeapUsedBytes: first,
      lastHeapUsedBytes: last,
      maxHeapUsedBytes: max,
    };
  }
  const n = used.length;
  const meanX = used.reduce((acc, c) => acc + c.iteration, 0) / n;
  const meanY = used.reduce((acc, c) => acc + c.heapUsedBytes, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const c of used) {
    sxx += (c.iteration - meanX) ** 2;
    sxy += (c.iteration - meanX) * (c.heapUsedBytes - meanY);
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  let increases = 0;
  for (let i = 1; i < n; i += 1) {
    if (used[i]!.heapUsedBytes > used[i - 1]!.heapUsedBytes) increases += 1;
  }
  return {
    bytesPerIteration: slope,
    pctPer100: first === 0 ? 0 : ((slope * 100) / first) * 100,
    monotoneFraction: increases / (n - 1),
    checkpointsUsed: n,
    firstHeapUsedBytes: first,
    lastHeapUsedBytes: last,
    maxHeapUsedBytes: max,
  };
}

export interface TimeDrift {
  firstWindowMedianMs: number;
  lastWindowMedianMs: number;
  /** lastWindowMedian / firstWindowMedian (1 = no drift). */
  ratio: number;
  maxMs: number;
  maxIteration: number;
  meanMs: number;
  windowSize: number;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Drift between the first and last `windowSize` invocations, skipping the
 * first `warmup` invocations. */
export function timeDrift(durationsMs: readonly number[], windowSize = 50, warmup = 10): TimeDrift {
  const usable = durationsMs.slice(Math.min(warmup, Math.max(0, durationsMs.length - 2)));
  const window = Math.max(1, Math.min(windowSize, Math.floor(usable.length / 2)));
  const first = usable.slice(0, window);
  const last = usable.slice(usable.length - window);
  let maxMs = -Infinity;
  let maxIteration = -1;
  durationsMs.forEach((d, i) => {
    if (d > maxMs) {
      maxMs = d;
      maxIteration = i;
    }
  });
  const firstMedian = median(first);
  const lastMedian = median(last);
  return {
    firstWindowMedianMs: firstMedian,
    lastWindowMedianMs: lastMedian,
    ratio: firstMedian === 0 ? 1 : lastMedian / firstMedian,
    maxMs: durationsMs.length === 0 ? 0 : maxMs,
    maxIteration,
    meanMs:
      durationsMs.length === 0 ? 0 : durationsMs.reduce((a, b) => a + b, 0) / durationsMs.length,
    windowSize: window,
  };
}

/** Every path (dot-joined) inside `value` holding a non-finite number. */
export function nonFinitePaths(value: unknown, path = "$", out: string[] = []): string[] {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) out.push(path);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => nonFinitePaths(entry, `${path}[${index}]`, out));
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      nonFinitePaths(entry, `${path}.${key}`, out);
    }
  }
  return out;
}

/** JSON with sorted object keys so two structurally-equal values stringify identically. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(entry as Record<string, unknown>).sort()) {
        sorted[key] = (entry as Record<string, unknown>)[key];
      }
      return sorted;
    }
    return entry;
  });
}

export function writeArtifact(name: string, value: unknown): string {
  mkdirSync(STRESS_OUT, { recursive: true });
  const file = resolve(STRESS_OUT, name);
  writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

export interface CampaignRuntime {
  node: string;
  gcAvailable: boolean;
  iterations: number;
  baseSeed: number;
  checkpointEvery: number;
  startedAtIso: string;
  durationMs: number;
}

export function campaignRuntime(iterations: number, startedAt: number): CampaignRuntime {
  return {
    node: process.version,
    gcAvailable,
    iterations,
    baseSeed: STRESS_SEED,
    checkpointEvery: CHECKPOINT_EVERY,
    startedAtIso: new Date().toISOString(),
    durationMs: performance.now() - startedAt,
  };
}
