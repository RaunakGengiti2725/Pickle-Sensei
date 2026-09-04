/**
 * Long-run leak harness (stress lens `long-run-leak`).
 *
 * Invokes one unit N times in THIS process, forcing a full GC and sampling
 * heap + active resources + listener counts every `checkpointEvery`
 * iterations, and records the wall time of every invocation. Every
 * iteration is driven by a seed derived from the campaign seed so any row
 * of the emitted JSON table replays with `replayIteration(unit, seed)`.
 *
 * Verdicts (computed, never asserted here — the test decides):
 *  - heap: linear-regression slope of post-GC heapUsed over checkpoints
 *    (warm-up checkpoint excluded), expressed as % growth per 100
 *    iterations relative to the first counted checkpoint, plus whether the
 *    series is strictly monotone. `leak` = monotone AND > 5 %/100 it.
 *  - resources: `process.getActiveResourcesInfo()` counts by type and
 *    process-level listener counts must equal the post-warm-up baseline at
 *    the final checkpoint.
 *  - time: mean invocation time of the last block vs the first counted
 *    block; `drift` = ratio > 1.5 with monotone non-decreasing block means.
 *  - determinism: the first `replaySeeds` seeds are replayed after the
 *    campaign and their output hashes must match the original rows.
 */
import { createHash } from "node:crypto";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

export interface IterationResult {
  /** Structural output of the unit (hashed for determinism; may be large). */
  output: unknown;
  /** Unit-specific abstention marker (recorded as a rate, never asserted). */
  abstained: boolean;
  /** Paths inside `output` holding NaN/±Infinity that the unit does NOT
   *  explicitly allow (allowed ones — e.g. anchor-free contactMs — are
   *  filtered by the unit before reporting). */
  nonFinite: string[];
  /** Free-form invariant violations detected by the unit (empty = ok). */
  violations: string[];
}

export interface StressUnit {
  id: string;
  /** Optional per-campaign setup (fixtures on disk, fake scripts). */
  setup?: () => Promise<void> | void;
  teardown?: () => Promise<void> | void;
  iterate: (seed: number) => Promise<IterationResult> | IterationResult;
}

export interface IterationRow {
  index: number;
  seed: number;
  outcome: "ok" | "fail";
  durationMs: number;
  hash: string;
  abstained: boolean;
  detail: string | null;
}

export interface ResourceSnapshot {
  activeResources: Record<string, number>;
  listeners: Record<string, number>;
}

export interface Checkpoint {
  iteration: number;
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  arrayBuffers: number;
  blockMeanMs: number;
  blockP95Ms: number;
  resources: ResourceSnapshot;
}

export interface CampaignReport {
  unit: string;
  campaignSeed: number;
  iterations: number;
  executed: number;
  checkpointEvery: number;
  gcMode: "expose-gc" | "v8-flag";
  rows: IterationRow[];
  checkpoints: Checkpoint[];
  baseline: ResourceSnapshot;
  failures: number;
  abstentionRate: number;
  heap: {
    verdict: "ok" | "leak" | "insufficient_checkpoints";
    slopeBytesPerIteration: number;
    slopePctPer100: number;
    monotone: boolean;
    firstCountedHeap: number;
    lastHeap: number;
  };
  resources: {
    /** `leaked` when any resource/listener count ENDS above baseline. Counts
     *  below baseline (ambient runner timers expiring) are reported in
     *  `finalDelta` but are not a leak. */
    verdict: "ok" | "leaked";
    finalDelta: Record<string, number>;
    leaked: Record<string, number>;
  };
  time: {
    verdict: "ok" | "drift" | "insufficient_checkpoints";
    firstBlockMeanMs: number;
    lastBlockMeanMs: number;
    ratio: number;
    monotone: boolean;
  };
  determinism: {
    verdict: "ok" | "mismatch";
    replayed: number;
    mismatches: Array<{ seed: number; original: string; replay: string }>;
  };
}

export const LEAK_SLOPE_PCT_PER_100 = 5;
export const TIME_DRIFT_RATIO = 1.5;
const MIN_CHECKPOINTS_FOR_SLOPE = 4;

type GcFn = () => void;

let cachedGc: { fn: GcFn; mode: "expose-gc" | "v8-flag" } | null = null;

/** `global.gc` when launched with --expose-gc, else enable the flag at runtime. */
export function forceGc(): "expose-gc" | "v8-flag" {
  if (!cachedGc) {
    const exposed = (globalThis as { gc?: GcFn }).gc;
    if (typeof exposed === "function") {
      cachedGc = { fn: exposed, mode: "expose-gc" };
    } else {
      setFlagsFromString("--expose-gc");
      const fn = runInNewContext("gc") as GcFn;
      cachedGc = { fn, mode: "v8-flag" };
    }
  }
  cachedGc.fn();
  cachedGc.fn();
  return cachedGc.mode;
}

const PROCESS_EVENTS = [
  "exit",
  "beforeExit",
  "uncaughtException",
  "unhandledRejection",
  "warning",
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
] as const;

export function snapshotResources(): ResourceSnapshot {
  // Listener counts first: touching process.stdout/stderr lazily creates
  // their pipe handles, which must be part of every snapshot alike.
  const listeners: Record<string, number> = {};
  for (const event of PROCESS_EVENTS) listeners[`process.${event}`] = process.listenerCount(event);
  listeners["process.stdout.error"] = process.stdout.listenerCount("error");
  listeners["process.stderr.error"] = process.stderr.listenerCount("error");
  const activeResources: Record<string, number> = {};
  for (const kind of process.getActiveResourcesInfo()) {
    activeResources[kind] = (activeResources[kind] ?? 0) + 1;
  }
  return { activeResources, listeners };
}

export function resourceDelta(
  baseline: ResourceSnapshot,
  current: ResourceSnapshot,
): Record<string, number> {
  const delta: Record<string, number> = {};
  const keys = new Set([
    ...Object.keys(baseline.activeResources),
    ...Object.keys(current.activeResources),
  ]);
  for (const key of keys) {
    const diff = (current.activeResources[key] ?? 0) - (baseline.activeResources[key] ?? 0);
    if (diff !== 0) delta[`resource.${key}`] = diff;
  }
  for (const key of Object.keys(baseline.listeners)) {
    const diff = (current.listeners[key] ?? 0) - (baseline.listeners[key] ?? 0);
    if (diff !== 0) delta[`listener.${key}`] = diff;
  }
  return delta;
}

export function hashOutput(value: unknown): string {
  return createHash("sha1")
    .update(JSON.stringify(value) ?? "undefined")
    .digest("hex");
}

/** Every path holding a non-finite number (JSON round-trip would hide them). */
export function findNonFinite(value: unknown, path = "$", out: string[] = []): string[] {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) out.push(path);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findNonFinite(entry, `${path}[${index}]`, out));
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      findNonFinite(entry, `${path}.${key}`, out);
    }
  }
  return out;
}

/** Deterministic LCG (same constants as the package's property suites). */
export function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Seed of iteration `index` under campaign seed `campaignSeed` (32-bit, replayable). */
export function iterationSeed(campaignSeed: number, index: number): number {
  return (Math.imul(campaignSeed ^ 0x9e3779b9, 2654435761) + Math.imul(index + 1, 40503)) >>> 0;
}

function linearSlope(points: Array<{ x: number; y: number }>): number {
  const n = points.length;
  if (n < 2) return 0;
  const meanX = points.reduce((sum, p) => sum + p.x, 0) / n;
  const meanY = points.reduce((sum, p) => sum + p.y, 0) / n;
  let cov = 0;
  let varX = 0;
  for (const p of points) {
    cov += (p.x - meanX) * (p.y - meanY);
    varX += (p.x - meanX) * (p.x - meanX);
  }
  return varX === 0 ? 0 : cov / varX;
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
  return sorted[idx]!;
}

async function runOne(unit: StressUnit, index: number, seed: number): Promise<IterationRow> {
  const started = performance.now();
  try {
    const result = await unit.iterate(seed);
    const durationMs = performance.now() - started;
    const problems = [
      ...result.nonFinite.map((path) => `non_finite:${path}`),
      ...result.violations,
    ];
    return {
      index,
      seed,
      outcome: problems.length === 0 ? "ok" : "fail",
      durationMs,
      hash: hashOutput(result.output),
      abstained: result.abstained,
      detail: problems.length === 0 ? null : problems.slice(0, 20).join("; "),
    };
  } catch (error) {
    return {
      index,
      seed,
      outcome: "fail",
      durationMs: performance.now() - started,
      hash: "",
      abstained: false,
      detail: `threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    };
  }
}

/** Replay a single seed (used for minimisation / flake re-runs). */
export async function replayIteration(unit: StressUnit, seed: number): Promise<IterationRow> {
  return runOne(unit, -1, seed);
}

export interface CampaignOptions {
  iterations: number;
  campaignSeed: number;
  checkpointEvery?: number;
  replaySeeds?: number;
  onCheckpoint?: (checkpoint: Checkpoint) => void;
}

export async function runLongRunCampaign(
  unit: StressUnit,
  options: CampaignOptions,
): Promise<CampaignReport> {
  const checkpointEvery = options.checkpointEvery ?? 50;
  const replaySeeds = Math.min(options.replaySeeds ?? 10, options.iterations);
  await unit.setup?.();
  try {
    // Warm-up: one iteration so lazily-initialised module state (caches,
    // readline, readers) is counted in the baseline rather than as a leak.
    const warmSeed = iterationSeed(options.campaignSeed, -1);
    await runOne(unit, -1, warmSeed);
    const gcMode = forceGc();
    const baseline = snapshotResources();

    const rows: IterationRow[] = [];
    const checkpoints: Checkpoint[] = [];
    let blockDurations: number[] = [];

    const takeCheckpoint = (iteration: number) => {
      forceGc();
      const mem = process.memoryUsage();
      const sorted = [...blockDurations].sort((a, b) => a - b);
      const checkpoint: Checkpoint = {
        iteration,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        rss: mem.rss,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers,
        blockMeanMs:
          blockDurations.length === 0
            ? 0
            : blockDurations.reduce((s, v) => s + v, 0) / blockDurations.length,
        blockP95Ms: percentile(sorted, 0.95),
        resources: snapshotResources(),
      };
      checkpoints.push(checkpoint);
      options.onCheckpoint?.(checkpoint);
      blockDurations = [];
    };

    for (let index = 0; index < options.iterations; index += 1) {
      const row = await runOne(unit, index, iterationSeed(options.campaignSeed, index));
      rows.push(row);
      blockDurations.push(row.durationMs);
      if ((index + 1) % checkpointEvery === 0) takeCheckpoint(index + 1);
    }
    if (options.iterations % checkpointEvery !== 0) takeCheckpoint(options.iterations);

    // Determinism: same seed → same structural output, even after N runs.
    const mismatches: CampaignReport["determinism"]["mismatches"] = [];
    for (let index = 0; index < replaySeeds; index += 1) {
      const original = rows[index]!;
      const replay = await runOne(unit, index, original.seed);
      if (replay.hash !== original.hash) {
        mismatches.push({ seed: original.seed, original: original.hash, replay: replay.hash });
      }
    }

    // Heap slope over counted checkpoints (drop the first as warm-up).
    const counted = checkpoints.slice(1);
    const heapPoints = counted.map((c) => ({ x: c.iteration, y: c.heapUsed }));
    const slope = linearSlope(heapPoints);
    const firstCountedHeap = counted[0]?.heapUsed ?? checkpoints[0]?.heapUsed ?? 0;
    const lastHeap = checkpoints[checkpoints.length - 1]?.heapUsed ?? 0;
    const slopePctPer100 = firstCountedHeap === 0 ? 0 : ((slope * 100) / firstCountedHeap) * 100;
    const heapMonotone =
      counted.length >= 2 &&
      counted.every((c, i) => i === 0 || c.heapUsed > counted[i - 1]!.heapUsed);
    const heapVerdict: CampaignReport["heap"]["verdict"] =
      counted.length < MIN_CHECKPOINTS_FOR_SLOPE
        ? "insufficient_checkpoints"
        : heapMonotone && slopePctPer100 > LEAK_SLOPE_PCT_PER_100
          ? "leak"
          : "ok";

    const finalDelta =
      checkpoints.length === 0
        ? {}
        : resourceDelta(baseline, checkpoints[checkpoints.length - 1]!.resources);
    const leaked = Object.fromEntries(Object.entries(finalDelta).filter(([, diff]) => diff > 0));

    const means = counted.map((c) => c.blockMeanMs);
    const firstBlockMeanMs = means[0] ?? checkpoints[0]?.blockMeanMs ?? 0;
    const lastBlockMeanMs = means[means.length - 1] ?? firstBlockMeanMs;
    const ratio = firstBlockMeanMs === 0 ? 1 : lastBlockMeanMs / firstBlockMeanMs;
    const timeMonotone = means.length >= 2 && means.every((m, i) => i === 0 || m >= means[i - 1]!);
    const timeVerdict: CampaignReport["time"]["verdict"] =
      counted.length < MIN_CHECKPOINTS_FOR_SLOPE
        ? "insufficient_checkpoints"
        : timeMonotone && ratio > TIME_DRIFT_RATIO
          ? "drift"
          : "ok";

    const failures = rows.filter((row) => row.outcome === "fail").length;
    return {
      unit: unit.id,
      campaignSeed: options.campaignSeed,
      iterations: options.iterations,
      executed: rows.length,
      checkpointEvery,
      gcMode,
      rows,
      checkpoints,
      baseline,
      failures,
      abstentionRate: rows.length === 0 ? 0 : rows.filter((r) => r.abstained).length / rows.length,
      heap: {
        verdict: heapVerdict,
        slopeBytesPerIteration: slope,
        slopePctPer100,
        monotone: heapMonotone,
        firstCountedHeap,
        lastHeap,
      },
      resources: {
        verdict: Object.keys(leaked).length === 0 ? "ok" : "leaked",
        finalDelta,
        leaked,
      },
      time: {
        verdict: timeVerdict,
        firstBlockMeanMs,
        lastBlockMeanMs,
        ratio,
        monotone: timeMonotone,
      },
      determinism: {
        verdict: mismatches.length === 0 ? "ok" : "mismatch",
        replayed: replaySeeds,
        mismatches,
      },
    };
  } finally {
    await unit.teardown?.();
  }
}
