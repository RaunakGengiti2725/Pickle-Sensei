/**
 * Latency statistics for SLO reporting.
 *
 * Nearest-rank percentiles (ceil(p/100 * n)th smallest sample) —
 * deterministic, no interpolation, defined for any n >= 1 (same convention as
 * tools/mac-bench and tools/iphone-trials). Small-n honesty: with fewer than
 * 20 samples P95 equals the max; the summary always carries `sampleCount` so
 * a reader can judge how much a percentile means.
 */

export interface LatencySummary {
  sampleCount: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  p50Ms: number;
  p75Ms: number;
  p90Ms: number;
  p95Ms: number;
}

export function nearestRankPercentile(sorted: readonly number[], percentile: number): number {
  if (sorted.length === 0) {
    throw new Error("nearestRankPercentile: empty sample set");
  }
  if (percentile <= 0 || percentile > 100) {
    throw new Error(`nearestRankPercentile: percentile ${percentile} out of (0, 100]`);
  }
  const rank = Math.ceil((percentile / 100) * sorted.length);
  const value = sorted[Math.min(rank, sorted.length) - 1];
  if (value === undefined) {
    throw new Error("nearestRankPercentile: rank out of bounds");
  }
  return value;
}

export function summarizeLatencies(wallMs: readonly number[]): LatencySummary | null {
  if (wallMs.length === 0) return null;
  for (const value of wallMs) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`summarizeLatencies: invalid sample ${value}`);
    }
  }
  const sorted = [...wallMs].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) return null;
  return {
    sampleCount: sorted.length,
    minMs: first,
    maxMs: last,
    meanMs: sum / sorted.length,
    p50Ms: nearestRankPercentile(sorted, 50),
    p75Ms: nearestRankPercentile(sorted, 75),
    p90Ms: nearestRankPercentile(sorted, 90),
    p95Ms: nearestRankPercentile(sorted, 95),
  };
}
