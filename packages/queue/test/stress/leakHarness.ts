/**
 * Long-run leak harness: drives a unit N times in ONE process, forces GC and
 * samples heap + open handles every `sampleEvery` iterations, then fits a
 * linear slope to the post-GC heap. Timers / sockets / listeners are compared
 * against the pre-campaign baseline. Nothing here is queue-specific.
 *
 * Requires `--expose-gc` (packages/queue/vitest.config.ts passes it to the
 * fork pool). Without it the harness throws — a leak check that cannot force
 * GC is not a leak check.
 */

export interface HeapSample {
  iteration: number;
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  arrayBuffers: number;
  /** process.getActiveResourcesInfo() counts by type. */
  resources: Record<string, number>;
  processListeners: number;
  /** Median per-iteration duration (ms) over the window since the last sample. */
  windowMedianMs: number;
  windowP95Ms: number;
}

export interface LeakVerdict {
  iterations: number;
  samples: HeapSample[];
  /** Least-squares slope of heapUsed vs iteration, expressed per 100 iterations as a fraction of the first sample. */
  heapSlopePer100: number;
  heapSlopeBytesPer100: number;
  heapFirst: number;
  heapLast: number;
  heapPeak: number;
  /** Resource counts after the campaign minus the pre-campaign baseline. */
  resourceDelta: Record<string, number>;
  processListenerDelta: number;
  /** Median iteration time in the first vs last sampling window. */
  timeDrift: { firstWindowMedianMs: number; lastWindowMedianMs: number; ratio: number };
  thresholds: { heapSlopePer100: number; timeDriftRatio: number };
  heapHeld: boolean;
  timeHeld: boolean;
  resourcesHeld: boolean;
  held: boolean;
}

type GcFn = () => void;

export function forceGc(): void {
  const gc = (globalThis as { gc?: GcFn }).gc;
  if (typeof gc !== "function") {
    throw new Error(
      "leakHarness needs --expose-gc (see packages/queue/vitest.config.ts poolOptions.forks.execArgv)",
    );
  }
  // Two passes: the first can leave finalization-registry / weak-ref cleanup
  // for the next cycle.
  gc();
  gc();
}

export function activeResources(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const kind of process.getActiveResourcesInfo()) counts[kind] = (counts[kind] ?? 0) + 1;
  return counts;
}

export function processListenerCount(): number {
  let total = 0;
  for (const name of process.eventNames()) total += process.listenerCount(name);
  return total;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

export function takeSample(iteration: number, windowDurationsMs: number[]): HeapSample {
  forceGc();
  const mem = process.memoryUsage();
  const sorted = [...windowDurationsMs].sort((a, b) => a - b);
  return {
    iteration,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    rss: mem.rss,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers,
    resources: activeResources(),
    processListeners: processListenerCount(),
    windowMedianMs: percentile(sorted, 0.5),
    windowP95Ms: percentile(sorted, 0.95),
  };
}

function leastSquaresSlope(points: Array<{ x: number; y: number }>): number {
  const n = points.length;
  if (n < 2) return 0;
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) * (p.x - mx);
  }
  return den === 0 ? 0 : num / den;
}

export interface CampaignOptions {
  iterations: number;
  sampleEvery: number;
  /** Iterations run (and discarded) before the baseline sample, so JIT/SDK lazy init does not read as growth. */
  warmup: number;
  thresholds?: Partial<LeakVerdict["thresholds"]>;
  /** Resource kinds whose growth counts as a leak (others are reported only). */
  trackedResources: readonly string[];
  /** Absolute tolerance on tracked-resource deltas (e.g. one keep-alive socket a long-lived client is entitled to). */
  resourceTolerance: number;
}

export const DEFAULT_THRESHOLDS: LeakVerdict["thresholds"] = {
  // Lens rule: monotone heap slope > 5 % per 100 iterations is a finding.
  heapSlopePer100: 0.05,
  // Last-window median more than 2x the first-window median = invocation time drift.
  timeDriftRatio: 2,
};

/**
 * Runs `iterate(i)` `options.iterations` times, sampling every `sampleEvery`.
 * `iterate` receives the 0-based iteration index and must be fully
 * replayable from it (derive its RNG from the iteration seed).
 */
export async function runLeakCampaign(
  options: CampaignOptions,
  iterate: (iteration: number) => Promise<void>,
): Promise<LeakVerdict> {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  for (let w = 0; w < options.warmup; w++) await iterate(-1 - w);

  forceGc();
  const baselineResources = activeResources();
  const baselineListeners = processListenerCount();

  const samples: HeapSample[] = [];
  let window: number[] = [];
  samples.push(takeSample(0, []));
  for (let i = 0; i < options.iterations; i++) {
    const start = process.hrtime.bigint();
    await iterate(i);
    window.push(Number(process.hrtime.bigint() - start) / 1e6);
    if ((i + 1) % options.sampleEvery === 0 || i + 1 === options.iterations) {
      samples.push(takeSample(i + 1, window));
      window = [];
    }
  }

  const heapPoints = samples.map((s) => ({ x: s.iteration, y: s.heapUsed }));
  const slopeBytesPerIter = leastSquaresSlope(heapPoints);
  const heapFirst = samples[0]?.heapUsed ?? 1;
  const heapSlopeBytesPer100 = slopeBytesPerIter * 100;
  const heapSlopePer100 = heapSlopeBytesPer100 / heapFirst;

  const last = samples[samples.length - 1];
  const resourceDelta: Record<string, number> = {};
  const kinds = new Set([...Object.keys(baselineResources), ...Object.keys(last?.resources ?? {})]);
  for (const kind of kinds) {
    resourceDelta[kind] = (last?.resources[kind] ?? 0) - (baselineResources[kind] ?? 0);
  }
  const processListenerDelta = (last?.processListeners ?? 0) - baselineListeners;

  const windows = samples.slice(1);
  const firstWindowMedianMs = windows[0]?.windowMedianMs ?? 0;
  const lastWindowMedianMs = windows[windows.length - 1]?.windowMedianMs ?? 0;
  const ratio = firstWindowMedianMs > 0 ? lastWindowMedianMs / firstWindowMedianMs : 1;

  const heapHeld = heapSlopePer100 <= thresholds.heapSlopePer100;
  const timeHeld = ratio <= thresholds.timeDriftRatio;
  const resourcesHeld =
    options.trackedResources.every(
      (kind) => Math.abs(resourceDelta[kind] ?? 0) <= options.resourceTolerance,
    ) && processListenerDelta <= 0;

  return {
    iterations: options.iterations,
    samples,
    heapSlopePer100,
    heapSlopeBytesPer100,
    heapFirst,
    heapLast: last?.heapUsed ?? 0,
    heapPeak: Math.max(...samples.map((s) => s.heapUsed)),
    resourceDelta,
    processListenerDelta,
    timeDrift: { firstWindowMedianMs, lastWindowMedianMs, ratio },
    thresholds,
    heapHeld,
    timeHeld,
    resourcesHeld,
    held: heapHeld && timeHeld && resourcesHeld,
  };
}

export function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} is not a finite number: ${String(value)}`);
  }
}

export function stressIterations(defaultIterations: number): number {
  const raw = process.env["STRESS_ITER"];
  if (!raw) return defaultIterations;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`STRESS_ITER must be a positive integer, got ${raw}`);
  return n;
}
