import type { PhaseKey, ShotTypeSlug } from "@pickle/shared-types";
import type { PoseSequence } from "@pickle/swing-domain";

/**
 * Benchmark dataset schema. A benchmark is a fixed, versioned set of cases
 * with ground truth and explicit provenance; regression policy compares a
 * candidate model's report on the SAME benchmark version against the
 * production model's report. Synthetic benchmarks are first-class but always
 * labeled — they can never masquerade as human data.
 */

export const BENCHMARK_PROVENANCES = [
  "synthetic",
  "consented_first_party",
  "commissioned",
  "licensed",
] as const;
export type BenchmarkProvenance = (typeof BENCHMARK_PROVENANCES)[number];

export interface BenchmarkDescriptor {
  id: string;
  version: string;
  task: string;
  provenance: BenchmarkProvenance;
  caseCount: number;
  notes: string;
}

export interface StrokeClassificationCase {
  caseId: string;
  pose: PoseSequence;
  truthStroke: ShotTypeSlug;
}

export interface PhaseSegmentationCase {
  caseId: string;
  pose: PoseSequence;
  window: { startMs: number; endMs: number; contactHintMs: number | null };
  truthBoundaries: Partial<Record<PhaseKey, { startMs: number; endMs: number }>>;
  truthContactMs: number;
}

export interface ScoringOrderingCase {
  caseId: string;
  /** Higher = objectively better execution under the benchmark's construction. */
  truthQualityRank: number;
  pose: PoseSequence;
  window: { startMs: number; endMs: number; contactHintMs: number | null };
  shotType: ShotTypeSlug;
}

export interface BenchmarkReport {
  benchmark: BenchmarkDescriptor;
  evaluatedAtIso: string;
  /** providerId@version of the model under evaluation. */
  subject: string;
  metrics: Record<string, number | null>;
  /** Cases the model abstained on — abstention is reported, never hidden. */
  abstainedCaseIds: string[];
}

/**
 * Regression gate: every metric listed in `mustNotDegrade` must be >= the
 * baseline minus tolerance. Returns the violations; empty means safe.
 */
export function regressionViolations(
  baseline: BenchmarkReport,
  candidate: BenchmarkReport,
  mustNotDegrade: string[],
  tolerance = 1e-9,
): Array<{ metric: string; baseline: number; candidate: number }> {
  const violations: Array<{ metric: string; baseline: number; candidate: number }> = [];
  for (const metric of mustNotDegrade) {
    const base = baseline.metrics[metric];
    const next = candidate.metrics[metric];
    if (typeof base !== "number") continue;
    if (typeof next !== "number" || next < base - tolerance) {
      violations.push({ metric, baseline: base, candidate: typeof next === "number" ? next : NaN });
    }
  }
  return violations;
}
