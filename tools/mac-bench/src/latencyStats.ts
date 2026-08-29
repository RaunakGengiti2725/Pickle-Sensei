/**
 * Latency statistics for mac-bench-results-v1.
 *
 * Nearest-rank percentiles (ceil(p/100 * n)th smallest sample) — deterministic,
 * no interpolation, defined for any n >= 1. Small-n honesty: with fewer than
 * 20 samples P95 equals the max; the summary always carries `sampleCount` so a
 * reader can judge how much a percentile means.
 */

export interface LatencyPercentiles {
  sampleCount: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
}

export interface StageSample {
  stage: string;
  caseId: string;
  /** 'cold' = first run after process/caches were fresh; 'warm' = subsequent. */
  phase: "cold" | "warm";
  /** 1-based iteration index within the phase. */
  iteration: number;
  wallMs: number;
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

export function summarizeLatencies(wallMs: readonly number[]): LatencyPercentiles | null {
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
    meanMs: Number((sum / sorted.length).toFixed(3)),
    p50Ms: nearestRankPercentile(sorted, 50),
    p90Ms: nearestRankPercentile(sorted, 90),
    p95Ms: nearestRankPercentile(sorted, 95),
  };
}

export interface StageLatencySummary {
  stage: string;
  unit: "ms";
  cold: LatencyPercentiles | null;
  warm: LatencyPercentiles | null;
  samples: StageSample[];
}

/** Groups raw samples by stage and summarizes cold/warm separately. Stages are
 * emitted in first-seen order so results are stable across runs. */
export function summarizeStages(samples: readonly StageSample[]): StageLatencySummary[] {
  const order: string[] = [];
  const byStage = new Map<string, StageSample[]>();
  for (const sample of samples) {
    const bucket = byStage.get(sample.stage);
    if (bucket) {
      bucket.push(sample);
    } else {
      byStage.set(sample.stage, [sample]);
      order.push(sample.stage);
    }
  }
  return order.map((stage) => {
    const stageSamples = byStage.get(stage) ?? [];
    const cold = stageSamples.filter((sample) => sample.phase === "cold");
    const warm = stageSamples.filter((sample) => sample.phase === "warm");
    return {
      stage,
      unit: "ms" as const,
      cold: summarizeLatencies(cold.map((sample) => sample.wallMs)),
      warm: summarizeLatencies(warm.map((sample) => sample.wallMs)),
      samples: [...stageSamples],
    };
  });
}
