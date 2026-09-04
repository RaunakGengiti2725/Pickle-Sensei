import { fs, nodeProcess, path } from '../lifecycle-persistence/nodeShim';

declare const __dirname: string;
declare const global: {
  gc?: () => void;
  __zustandActiveSubscriptions?: number;
};

/**
 * Process-level probes for the long-run-leak lens: heap after a forced GC,
 * live libuv handles, and a least-squares slope over the heap samples. The
 * campaign is only meaningful under `node --expose-gc`; `gcAvailable` is
 * reported so a run without it is never mistaken for a pass.
 */

interface ProcessWithHandles {
  _getActiveHandles?: () => unknown[];
  _getActiveRequests?: () => unknown[];
  getActiveResourcesInfo?: () => string[];
}

export function gcAvailable(): boolean {
  return typeof global.gc === 'function';
}

/** Two full collections back to back so weak targets are reliably released. */
export function forceGc(): void {
  if (typeof global.gc === 'function') {
    global.gc();
    global.gc();
  }
}

export interface HeapSample {
  iteration: number;
  heapUsedMb: number;
  heapTotalMb: number;
  rssMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  activeHandles: number;
  activeRequests: number;
  activeResources: Record<string, number>;
}

function mb(bytes: number): number {
  return Math.round((bytes / 1048576) * 1000) / 1000;
}

export function activeResources(): Record<string, number> {
  const proc = nodeProcess as unknown as ProcessWithHandles;
  const counts: Record<string, number> = {};
  if (typeof proc.getActiveResourcesInfo === 'function') {
    for (const kind of proc.getActiveResourcesInfo()) {
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
  }
  return counts;
}

export function sampleHeap(iteration: number): HeapSample {
  forceGc();
  const usage = nodeProcess.memoryUsage() as ReturnType<
    typeof nodeProcess.memoryUsage
  > & { arrayBuffers?: number };
  const proc = nodeProcess as unknown as ProcessWithHandles;
  return {
    iteration,
    heapUsedMb: mb(usage.heapUsed),
    heapTotalMb: mb(usage.heapTotal),
    rssMb: mb(usage.rss),
    externalMb: mb(usage.external),
    arrayBuffersMb: mb(usage.arrayBuffers ?? 0),
    activeHandles:
      typeof proc._getActiveHandles === 'function'
        ? proc._getActiveHandles().length
        : -1,
    activeRequests:
      typeof proc._getActiveRequests === 'function'
        ? proc._getActiveRequests().length
        : -1,
    activeResources: activeResources(),
  };
}

export interface SlopeReport {
  /** Samples used (warm-up excluded). */
  points: number;
  /** Least-squares slope, MB per 100 iterations. */
  slopeMbPer100: number;
  /** Slope as a percentage of the first retained sample, per 100 iterations. */
  slopePctPer100: number;
  /** Fraction of consecutive sample pairs where heap grew. 1 = monotone. */
  monotoneFraction: number;
  firstMb: number;
  lastMb: number;
  minMb: number;
  maxMb: number;
}

export function heapSlope(
  samples: HeapSample[],
  warmupIterations: number,
): SlopeReport | null {
  const kept = samples.filter(sample => sample.iteration >= warmupIterations);
  if (kept.length < 3) return null;
  const n = kept.length;
  const meanX = kept.reduce((sum, s) => sum + s.iteration, 0) / n;
  const meanY = kept.reduce((sum, s) => sum + s.heapUsedMb, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (const s of kept) {
    numerator += (s.iteration - meanX) * (s.heapUsedMb - meanY);
    denominator += (s.iteration - meanX) ** 2;
  }
  const slopePerIteration = denominator === 0 ? 0 : numerator / denominator;
  const slopeMbPer100 = slopePerIteration * 100;
  const first = kept[0]!.heapUsedMb;
  let grew = 0;
  for (let i = 1; i < n; i += 1) {
    if (kept[i]!.heapUsedMb > kept[i - 1]!.heapUsedMb) grew += 1;
  }
  const values = kept.map(s => s.heapUsedMb);
  return {
    points: n,
    slopeMbPer100: round3(slopeMbPer100),
    slopePctPer100: round3(first === 0 ? 0 : (slopeMbPer100 / first) * 100),
    monotoneFraction: round3(grew / (n - 1)),
    firstMb: first,
    lastMb: kept[n - 1]!.heapUsedMb,
    minMb: Math.min(...values),
    maxMb: Math.max(...values),
  };
}

export interface DriftReport {
  headMedianMs: number;
  tailMedianMs: number;
  ratio: number;
  headP95Ms: number;
  tailP95Ms: number;
  overallMedianMs: number;
  overallP95Ms: number;
  overallMaxMs: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
  return sorted[idx]!;
}

/** Compares the first and last `windowFraction` of the per-iteration times. */
export function timingDrift(
  durationsMs: number[],
  warmupIterations: number,
  windowFraction = 0.2,
): DriftReport | null {
  const kept = durationsMs.slice(warmupIterations);
  if (kept.length < 10) return null;
  const window = Math.max(5, Math.floor(kept.length * windowFraction));
  const head = kept.slice(0, window).sort((a, b) => a - b);
  const tail = kept.slice(-window).sort((a, b) => a - b);
  const all = [...kept].sort((a, b) => a - b);
  const headMedian = quantile(head, 0.5);
  const tailMedian = quantile(tail, 0.5);
  return {
    headMedianMs: round3(headMedian),
    tailMedianMs: round3(tailMedian),
    ratio: round3(headMedian === 0 ? 0 : tailMedian / headMedian),
    headP95Ms: round3(quantile(head, 0.95)),
    tailP95Ms: round3(quantile(tail, 0.95)),
    overallMedianMs: round3(quantile(all, 0.5)),
    overallP95Ms: round3(quantile(all, 0.95)),
    overallMaxMs: round3(all[all.length - 1]!),
  };
}

export function nowMs(): number {
  const hrtime = (
    nodeProcess as unknown as { hrtime: { bigint(): bigint } }
  ).hrtime.bigint();
  return Number(hrtime) / 1e6;
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Active zustand subscriptions, maintained by the `zustand/vanilla` shim. */
export function zustandSubscriptions(): number {
  return global.__zustandActiveSubscriptions ?? -1;
}

/** `<repo>/artifacts/stress/` (gitignored). Override with STRESS_ARTIFACT_DIR. */
export function stressArtifactDir(): string {
  const configured = nodeProcess.env['STRESS_ARTIFACT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(__dirname, '../../../../artifacts/stress');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeStressArtifact(name: string, value: unknown): string {
  const file = path.join(stressArtifactDir(), name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}

export function envInt(name: string, fallback: number): number {
  const raw = nodeProcess.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return parsed;
}

export function envIntList(name: string): number[] {
  const raw = nodeProcess.env[name];
  if (raw === undefined || raw.trim() === '') return [];
  return raw.split(',').map(part => {
    const parsed = Number(part.trim());
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error(`${name} entries must be non-negative integers`);
    }
    return parsed;
  });
}

/** Stable per-iteration seed derived from the campaign seed and the index. */
export function iterationSeed(campaignSeed: number, index: number): number {
  let h = (campaignSeed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (index + 0x7f4a7c15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
