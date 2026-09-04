import { readdirSync, readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { iterationSeed } from "./seededRng.js";

/**
 * Long-run leak harness: invokes a unit N times in ONE process, forces a
 * full GC every `sampleEvery` iterations and records heap, RSS, external /
 * ArrayBuffer memory, libuv active resources and live child processes, plus
 * per-iteration wall time. A campaign is replayable: iteration `i` of
 * campaign seed `s` always sees `iterationSeed(s, i)`.
 *
 * Leak criteria (all reported, the first two are the pass/fail gates):
 *  - heap slope: least-squares slope of post-GC heapUsed over iterations,
 *    expressed per 100 iterations relative to the FIRST post-GC sample;
 *    > `maxHeapSlopePer100` (default 5%) is a leak.
 *  - resources: libuv active-resource multiset and live child-process count
 *    after the campaign must equal the pre-campaign baseline.
 *  - time drift: median wall time of the last sample window vs the second
 *    window (the first is JIT warm-up); reported, gated at 1.5x AND > 1 ms.
 */

/** Force a full GC without requiring `node --expose-gc`. */
export function forceGc(): () => void {
  const global = globalThis as { gc?: () => void };
  if (typeof global.gc === "function") return global.gc;
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  return gc;
}

export interface ResourceSnapshot {
  /** Sorted libuv active resource type names (process.getActiveResourcesInfo). */
  activeResources: Record<string, number>;
  /** Live processes whose parent is this process (Linux /proc scan; -1 elsewhere). */
  childProcesses: number;
}

export function snapshotResources(): ResourceSnapshot {
  const counts: Record<string, number> = {};
  for (const name of process.getActiveResourcesInfo()) {
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return { activeResources: counts, childProcesses: countChildProcesses() };
}

function countChildProcesses(): number {
  if (process.platform !== "linux") return -1;
  let count = 0;
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return -1;
  }
  const self = String(process.pid);
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || entry === self) continue;
    try {
      const status = readFileSync(`/proc/${entry}/status`, "utf8");
      const match = /^PPid:\s+(\d+)/m.exec(status);
      if (match && match[1] === self) count += 1;
    } catch {
      // process vanished between readdir and read — not ours to count
    }
  }
  return count;
}

export interface HeapSample {
  iteration: number;
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  arrayBuffers: number;
  resources: ResourceSnapshot;
  /** Median wall time (ms) of the iterations since the previous sample. */
  windowMedianMs: number;
  windowMaxMs: number;
}

export interface IterationResult {
  iteration: number;
  seed: number;
  /** HELD when every invariant held; otherwise the first violated invariant. */
  outcome: "HELD" | "BROKEN";
  violations: string[];
  /** Scenario description compact enough to replay/minimize by hand. */
  scenario: string;
  durationMs: number;
}

export interface CampaignOptions {
  name: string;
  campaignSeed: number;
  iterations: number;
  sampleEvery?: number;
  maxHeapSlopePer100?: number;
  /** Runs once before the first iteration (fixture generation); excluded from timing. */
  setup?: () => void;
  teardown?: () => void;
  /**
   * One scenario. Return the invariant violations (empty = HELD) and a short
   * scenario string. Throwing counts as a violation ("threw: …").
   */
  iterate: (seed: number, iteration: number) => { violations: string[]; scenario: string };
}

export interface LeakVerdict {
  heapBaseline: number;
  heapFinal: number;
  /** Least-squares slope of heapUsed per 100 iterations, relative to baseline. */
  heapSlopePer100Relative: number;
  heapSlopeBytesPer100: number;
  heapLeak: boolean;
  monotoneIncreasingRuns: number;
  resourcesBaseline: ResourceSnapshot;
  resourcesFinal: ResourceSnapshot;
  resourcesReturnedToBaseline: boolean;
  timeDriftRatio: number | null;
  timeDrift: boolean;
}

export interface CampaignReport {
  name: string;
  campaignSeed: number;
  iterations: number;
  executed: number;
  held: number;
  broken: number;
  results: IterationResult[];
  samples: HeapSample[];
  leak: LeakVerdict;
  node: string;
  startedAtIso: string;
  wallMs: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function leastSquaresSlope(points: Array<[number, number]>): number {
  if (points.length < 2) return 0;
  const n = points.length;
  let sumX = 0;
  let sumY = 0;
  for (const [x, y] of points) {
    sumX += x;
    sumY += y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of points) {
    num += (x - meanX) * (y - meanY);
    den += (x - meanX) * (x - meanX);
  }
  return den === 0 ? 0 : num / den;
}

function sameResources(a: ResourceSnapshot, b: ResourceSnapshot): boolean {
  if (a.childProcesses !== b.childProcesses) return false;
  const keys = new Set([...Object.keys(a.activeResources), ...Object.keys(b.activeResources)]);
  for (const key of keys) {
    if ((a.activeResources[key] ?? 0) !== (b.activeResources[key] ?? 0)) return false;
  }
  return true;
}

export function runCampaign(options: CampaignOptions): CampaignReport {
  const gc = forceGc();
  const sampleEvery = options.sampleEvery ?? 50;
  const maxSlope = options.maxHeapSlopePer100 ?? 0.05;
  const startedAtIso = new Date().toISOString();
  const wallStart = performance.now();

  options.setup?.();

  gc();
  gc();
  const resourcesBaseline = snapshotResources();
  const heapBaseline = process.memoryUsage().heapUsed;

  const results: IterationResult[] = [];
  const samples: HeapSample[] = [];
  let window: number[] = [];

  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    const seed = iterationSeed(options.campaignSeed, iteration);
    const t0 = performance.now();
    let violations: string[];
    let scenario: string;
    try {
      const out = options.iterate(seed, iteration);
      violations = out.violations;
      scenario = out.scenario;
    } catch (error) {
      violations = [`threw: ${error instanceof Error ? error.message : String(error)}`];
      scenario = "threw before scenario was described";
    }
    const durationMs = performance.now() - t0;
    window.push(durationMs);
    results.push({
      iteration,
      seed,
      outcome: violations.length === 0 ? "HELD" : "BROKEN",
      violations,
      scenario,
      durationMs,
    });

    if ((iteration + 1) % sampleEvery === 0 || iteration + 1 === options.iterations) {
      gc();
      gc();
      const mem = process.memoryUsage();
      samples.push({
        iteration: iteration + 1,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        rss: mem.rss,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers,
        resources: snapshotResources(),
        windowMedianMs: median(window),
        windowMaxMs: window.length > 0 ? Math.max(...window) : 0,
      });
      window = [];
    }
  }

  options.teardown?.();
  gc();
  gc();
  const resourcesFinal = snapshotResources();
  const heapFinal = process.memoryUsage().heapUsed;

  const slopeBytesPerIteration = leastSquaresSlope(
    samples.map((s) => [s.iteration, s.heapUsed] as [number, number]),
  );
  const heapSlopeBytesPer100 = slopeBytesPerIteration * 100;
  const heapSlopePer100Relative = heapBaseline > 0 ? heapSlopeBytesPer100 / heapBaseline : 0;

  let monotoneIncreasingRuns = 0;
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index]!.heapUsed > samples[index - 1]!.heapUsed) monotoneIncreasingRuns += 1;
  }

  let timeDriftRatio: number | null = null;
  let timeDrift = false;
  if (samples.length >= 3) {
    const reference = samples[1]!.windowMedianMs;
    const last = samples[samples.length - 1]!.windowMedianMs;
    timeDriftRatio = reference > 0 ? last / reference : null;
    timeDrift = timeDriftRatio !== null && timeDriftRatio > 1.5 && last - reference > 1;
  }

  const held = results.filter((r) => r.outcome === "HELD").length;
  return {
    name: options.name,
    campaignSeed: options.campaignSeed,
    iterations: options.iterations,
    executed: results.length,
    held,
    broken: results.length - held,
    results,
    samples,
    leak: {
      heapBaseline,
      heapFinal,
      heapSlopePer100Relative,
      heapSlopeBytesPer100,
      heapLeak: heapSlopePer100Relative > maxSlope,
      monotoneIncreasingRuns,
      resourcesBaseline,
      resourcesFinal,
      resourcesReturnedToBaseline: sameResources(resourcesBaseline, resourcesFinal),
      timeDriftRatio,
      timeDrift,
    },
    node: process.version,
    startedAtIso,
    wallMs: performance.now() - wallStart,
  };
}

/** Compact seed → outcome table (what gets uploaded as evidence). */
export function seedTable(report: CampaignReport): Array<{
  iteration: number;
  seed: number;
  outcome: "HELD" | "BROKEN";
  violations: string[];
  scenario: string;
}> {
  return report.results.map(({ iteration, seed, outcome, violations, scenario }) => ({
    iteration,
    seed,
    outcome,
    violations,
    scenario,
  }));
}

/** Canonical JSON that keeps non-finite numbers distinguishable from null. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === "number" && !Number.isFinite(v)) return `__nonfinite:${String(v)}`;
    if (typeof v === "number" && Object.is(v, -0)) return "__negzero";
    return v;
  });
}
