/**
 * Heap/latency statistics for the media-worker soak harness. Kept local to the
 * service (no cross-package test imports) and intentionally tiny.
 */

export interface LinearFit {
  slope: number;
  intercept: number;
  r: number;
  n: number;
}

export function linearFit(points: ReadonlyArray<{ x: number; y: number }>): LinearFit {
  const n = points.length;
  if (n === 0) return { slope: 0, intercept: 0, r: Number.NaN, n: 0 };
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of points) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const r = sxx === 0 || syy === 0 ? Number.NaN : sxy / Math.sqrt(sxx * syy);
  return { slope, intercept: my - slope * mx, r, n };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const hi = sorted[mid];
  const lo = sorted[mid - 1];
  if (hi === undefined) return Number.NaN;
  return sorted.length % 2 === 1 || lo === undefined ? hi : (lo + hi) / 2;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1] ?? Number.NaN;
}

export interface HeapWindow {
  fromCycle: number;
  toCycle: number;
  cycles: number;
  medianHeapUsed: number;
  minHeapUsed: number;
  maxHeapUsed: number;
  growthVsPreviousPct: number | null;
}

export interface HeapVerdict {
  gcAvailable: boolean;
  warmupCycles: number;
  fit: LinearFit;
  baselineHeapUsed: number;
  slopeBytesPerCycle: number;
  slopePer100CyclesPct: number;
  windows: HeapWindow[];
  monotoneAcrossWindows: boolean;
  maxWindowGrowthPct: number;
  thresholdPer100CyclesPct: number;
  leakSuspected: boolean;
  netDeltaBytes: number;
}

export function heapVerdict(
  heapUsedByCycle: readonly number[],
  options: {
    warmupCycles: number;
    windowCycles: number;
    thresholdPer100CyclesPct: number;
    gc: boolean;
  },
): HeapVerdict {
  const warm = heapUsedByCycle.slice(options.warmupCycles);
  const fit = linearFit(warm.map((y, x) => ({ x, y })));
  const windows: HeapWindow[] = [];
  for (let start = 0; start < warm.length; start += options.windowCycles) {
    const slice = warm.slice(start, start + options.windowCycles);
    if (slice.length === 0) break;
    const med = median(slice);
    const previous = windows[windows.length - 1];
    windows.push({
      fromCycle: options.warmupCycles + start,
      toCycle: options.warmupCycles + start + slice.length - 1,
      cycles: slice.length,
      medianHeapUsed: med,
      minHeapUsed: Math.min(...slice),
      maxHeapUsed: Math.max(...slice),
      growthVsPreviousPct:
        previous && previous.medianHeapUsed > 0
          ? ((med - previous.medianHeapUsed) / previous.medianHeapUsed) * 100
          : null,
    });
  }
  const baseline = windows[0]?.medianHeapUsed ?? warm[0] ?? 0;
  const slopePer100CyclesPct = baseline > 0 ? ((fit.slope * 100) / baseline) * 100 : 0;
  const growths = windows.map((w) => w.growthVsPreviousPct).filter((g): g is number => g !== null);
  const monotone = growths.length > 0 && growths.every((g) => g >= 0);
  const maxWindowGrowthPct = growths.length > 0 ? Math.max(...growths) : 0;
  const first = warm[0] ?? 0;
  const last = warm[warm.length - 1] ?? first;
  return {
    gcAvailable: options.gc,
    warmupCycles: options.warmupCycles,
    fit,
    baselineHeapUsed: baseline,
    slopeBytesPerCycle: fit.slope,
    slopePer100CyclesPct,
    windows,
    monotoneAcrossWindows: monotone,
    maxWindowGrowthPct,
    thresholdPer100CyclesPct: options.thresholdPer100CyclesPct,
    leakSuspected:
      options.gc &&
      monotone &&
      (slopePer100CyclesPct > options.thresholdPer100CyclesPct ||
        maxWindowGrowthPct > options.thresholdPer100CyclesPct),
    netDeltaBytes: last - first,
  };
}

export function gcAvailable(): boolean {
  return typeof globalThis.gc === "function";
}

export function collectHeapUsed(): number {
  if (gcAvailable()) {
    globalThis.gc?.();
    globalThis.gc?.();
  }
  return process.memoryUsage().heapUsed;
}
