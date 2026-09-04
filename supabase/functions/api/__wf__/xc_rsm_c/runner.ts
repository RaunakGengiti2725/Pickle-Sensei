// Campaign orchestration shared by the CLI script and the deno test wrapper.

import { captureAccessLog } from "../../http.ts";
import {
  type CampaignOptions,
  DEFAULT_OPTIONS,
  type Failure,
  type SeedResult,
  SeedRun,
} from "./campaign.ts";
import { installDeterministicDigest } from "./deterministicDigest.ts";
import { type EdgeIsolate, loadEdgeIsolate } from "./edgeIsolates.ts";
import { installVirtualClock, type VirtualClock } from "./virtualClock.ts";

export interface Isolates {
  solo: EdgeIsolate;
  cluster: EdgeIsolate[];
}

let isolatesPromise: Promise<Isolates> | null = null;

/** One solo isolate (no Redis) + three Redis-backed isolates, loaded once per
 * process: production keeps isolates alive across many requests too, and the
 * per-seed virtual clock jumps a full day so nothing leaks between seeds. */
export function isolates(): Promise<Isolates> {
  isolatesPromise ??= (async () => ({
    solo: await loadEdgeIsolate("solo", { redis: false }),
    cluster: [
      await loadEdgeIsolate("c1", { redis: true }),
      await loadEdgeIsolate("c2", { redis: true }),
      await loadEdgeIsolate("c3", { redis: true }),
    ],
  }))();
  return isolatesPromise;
}

let clock: VirtualClock | null = null;

export function virtualClock(): VirtualClock {
  if (!clock) {
    installDeterministicDigest();
    clock = installVirtualClock(Date.now());
  }
  return clock;
}

export interface SeedRunHooks {
  accessLogSink?: (line: string) => void;
  onRecord?: (run: SeedRun) => void;
}

export async function runSeed(
  seed: number,
  options: Partial<CampaignOptions> = {},
  hooks: SeedRunHooks = {},
): Promise<SeedResult> {
  const iso = await isolates();
  const vc = virtualClock();
  const run = new SeedRun(seed, vc, iso, {
    ...DEFAULT_OPTIONS,
    ...options,
    accessLogSink: hooks.accessLogSink,
  });
  const restore = captureAccessLog((line) => run.recordAccessLog(line));
  try {
    const result = await run.run();
    hooks.onRecord?.(run);
    return result;
  } finally {
    restore();
  }
}

export function parseSeeds(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const range = trimmed.match(/^(\d+)-(\d+)$/);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      for (let s = lo; s <= hi; s += 1) out.push(s);
    } else {
      out.push(Number(trimmed));
    }
  }
  return out;
}

export interface Aggregate {
  seeds: number;
  requests: number;
  perPhase: Record<string, number>;
  statusCounts: Record<string, number>;
  invariantViolations: Record<string, number>;
  hardFailures: number;
  softFailures: number;
  seedsWithHardFailures: number[];
  truthStatusMatrix: Record<string, Record<string, number>>;
  bearerKindStatusMatrix: Record<string, Record<string, number>>;
  reasonStatusMatrix: Record<string, Record<string, number>>;
  upstreamFaultMatrix: Record<string, Record<string, number>>;
  upstreamCalls: Record<string, number>;
  cacheHitsPredicted: number;
  clockForwardMsTotal: number;
  backwardJumps: number;
  wallMs: number;
  heap: { minHeapUsed: number; maxHeapUsed: number; maxRss: number; finalHeapUsed: number };
}

const merge = (into: Record<string, number>, from: Record<string, number>): void => {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
};

const mergeMatrix = (
  into: Record<string, Record<string, number>>,
  from: Record<string, Record<string, number>>,
): void => {
  for (const [row, cols] of Object.entries(from)) merge((into[row] ??= {}), cols);
};

export function aggregate(results: SeedResult[]): Aggregate {
  const agg: Aggregate = {
    seeds: results.length,
    requests: 0,
    perPhase: {},
    statusCounts: {},
    invariantViolations: {},
    hardFailures: 0,
    softFailures: 0,
    seedsWithHardFailures: [],
    truthStatusMatrix: {},
    bearerKindStatusMatrix: {},
    reasonStatusMatrix: {},
    upstreamFaultMatrix: {},
    upstreamCalls: {},
    cacheHitsPredicted: 0,
    clockForwardMsTotal: 0,
    backwardJumps: 0,
    wallMs: 0,
    heap: { minHeapUsed: Number.MAX_SAFE_INTEGER, maxHeapUsed: 0, maxRss: 0, finalHeapUsed: 0 },
  };
  for (const r of results) {
    agg.requests += r.requests;
    merge(agg.perPhase, r.perPhase);
    merge(agg.statusCounts, r.statusCounts);
    merge(agg.invariantViolations, r.invariantViolations);
    agg.hardFailures += r.hardFailures;
    agg.softFailures += r.softFailures;
    if (r.hardFailures > 0) agg.seedsWithHardFailures.push(r.seed);
    mergeMatrix(agg.truthStatusMatrix, r.truthStatusMatrix);
    mergeMatrix(agg.bearerKindStatusMatrix, r.bearerKindStatusMatrix);
    mergeMatrix(agg.reasonStatusMatrix, r.reasonStatusMatrix);
    mergeMatrix(agg.upstreamFaultMatrix, r.upstreamFaultMatrix);
    merge(agg.upstreamCalls, r.upstreamCalls);
    agg.cacheHitsPredicted += r.cacheHitsPredicted;
    agg.clockForwardMsTotal += r.clock.forwardMs;
    agg.backwardJumps += r.clock.backwardJumps;
    agg.wallMs += r.wallMs;
    agg.heap.minHeapUsed = Math.min(agg.heap.minHeapUsed, r.heap.heapUsed);
    agg.heap.maxHeapUsed = Math.max(agg.heap.maxHeapUsed, r.heap.heapUsed);
    agg.heap.maxRss = Math.max(agg.heap.maxRss, r.heap.rss);
    agg.heap.finalHeapUsed = r.heap.heapUsed;
  }
  return agg;
}

/** Group failures by invariant + detail shape so a 100-seed run reads as a
 * handful of distinct findings rather than thousands of lines. */
export function groupFailures(failures: Failure[]): Array<{
  invariant: string;
  soft: boolean;
  pattern: string;
  count: number;
  seeds: number[];
  example: Failure;
}> {
  const groups = new Map<
    string,
    {
      invariant: string;
      soft: boolean;
      pattern: string;
      count: number;
      seeds: Set<number>;
      example: Failure;
    }
  >();
  for (const f of failures) {
    const pattern = `${f.spec.phase}/${f.spec.route}/${f.spec.bearerKind}/${f.truthAtLaunch.kind}/status=${f.outcome.status}/limit=${f.outcome.rateLimit}`;
    const key = `${f.invariant}|${pattern}`;
    const g = groups.get(key);
    if (g) {
      g.count += 1;
      g.seeds.add(f.seed);
    } else {
      groups.set(key, {
        invariant: f.invariant,
        soft: f.soft,
        pattern,
        count: 1,
        seeds: new Set([f.seed]),
        example: f,
      });
    }
  }
  return [...groups.values()]
    .map((g) => ({ ...g, seeds: [...g.seeds].sort((a, b) => a - b) }))
    .sort((a, b) => b.count - a.count);
}
