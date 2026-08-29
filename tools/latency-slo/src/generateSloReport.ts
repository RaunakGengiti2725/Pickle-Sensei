/**
 * pickle.latency-slo-report.v1 — sliced P50/P75/P90/P95 summaries of
 * MOVEMENT_COMPLETION -> RESULT_INTERACTIVE records, judged against the
 * frozen latency-slo-thresholds-v1 tiers.
 *
 * Slicing: overall per phase (cold/warm), plus one slice per
 * (dimension, value, phase) for device, os, stroke, modelVersion and
 * captureCondition. Slices are emitted in first-seen record order so reports
 * are stable across runs and comparable by sliceKey.
 *
 * HONESTY: when every record is LINUX_BENCH_NOT_DEVICE the report carries a
 * non-empty `linuxNotDeviceDisclaimer` and `deviceEvidence` is
 * BLOCKED_EXTERNAL_NO_DEVICE_MEASUREMENTS — these numbers are Linux trend
 * data, never iPhone evidence.
 */

import {
  LATENCY_SLO_METRIC,
  SLO_SLICE_DIMENSIONS,
  validateLatencySloRecord,
  type LatencySloRecord,
  type SloPhase,
  type SloProvenance,
  type SloSliceDimension,
} from "./sloRecord.js";
import { summarizeLatencies, type LatencySummary } from "./sloStats.js";
import {
  LATENCY_SLO_THRESHOLDS,
  sloTier,
  type LatencySloThresholdsV1,
  type SloTier,
} from "./sloThresholds.js";

export const LATENCY_SLO_REPORT_SCHEMA_VERSION = "pickle.latency-slo-report.v1";

export interface SloSliceSummary {
  /** Stable identity: "<dimension>=<value>|phase=<phase>" or "overall|phase=<phase>". */
  sliceKey: string;
  dimension: SloSliceDimension | "overall";
  value: string | null;
  phase: SloPhase;
  summary: LatencySummary;
  /** Tier of the judged percentile (p95) against the frozen thresholds. */
  tier: SloTier;
}

export type SloDeviceEvidence = "BLOCKED_EXTERNAL_NO_DEVICE_MEASUREMENTS" | "DEVICE_TRIALS_PRESENT";

export interface LatencySloReport {
  schemaVersion: typeof LATENCY_SLO_REPORT_SCHEMA_VERSION;
  generatedAtIso: string;
  metric: typeof LATENCY_SLO_METRIC;
  thresholds: LatencySloThresholdsV1;
  recordCounts: Record<SloProvenance, number>;
  deviceEvidence: SloDeviceEvidence;
  /** Non-empty whenever any LINUX_BENCH_NOT_DEVICE record contributed. */
  linuxNotDeviceDisclaimer: string | null;
  slices: SloSliceSummary[];
}

export const LINUX_NOT_DEVICE_DISCLAIMER =
  "Contains LINUX_BENCH_NOT_DEVICE samples: measured on a Linux CI/dev box, " +
  "NOT on a physical iPhone. Valid for regression trend tracking only — " +
  "never extrapolate to device latency or GATE B evidence.";

export function sliceKeyFor(
  dimension: SloSliceDimension | "overall",
  value: string | null,
  phase: SloPhase,
): string {
  return dimension === "overall"
    ? `overall|phase=${phase}`
    : `${dimension}=${value}|phase=${phase}`;
}

interface SliceBucket {
  dimension: SloSliceDimension | "overall";
  value: string | null;
  phase: SloPhase;
  wallMs: number[];
}

export function generateSloReport(
  records: readonly LatencySloRecord[],
  options: { generatedAtIso?: string; thresholds?: LatencySloThresholdsV1 } = {},
): LatencySloReport {
  const thresholds = options.thresholds ?? LATENCY_SLO_THRESHOLDS;
  records.forEach((record, index) => {
    const errors = validateLatencySloRecord(record, `records[${index}]`);
    if (errors.length > 0) {
      throw new Error(`generateSloReport: invalid record: ${errors.join("; ")}`);
    }
  });

  const order: string[] = [];
  const buckets = new Map<string, SliceBucket>();
  const add = (
    dimension: SloSliceDimension | "overall",
    value: string | null,
    phase: SloPhase,
    wallMs: number,
  ): void => {
    const key = sliceKeyFor(dimension, value, phase);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.wallMs.push(wallMs);
    } else {
      buckets.set(key, { dimension, value, phase, wallMs: [wallMs] });
      order.push(key);
    }
  };

  const recordCounts: Record<SloProvenance, number> = {
    LINUX_BENCH_NOT_DEVICE: 0,
    DEVICE_MEASUREMENT: 0,
  };
  for (const record of records) {
    recordCounts[record.provenance] += 1;
    add("overall", null, record.slice.phase, record.wallMs);
    for (const dimension of SLO_SLICE_DIMENSIONS) {
      add(dimension, record.slice[dimension], record.slice.phase, record.wallMs);
    }
  }

  const slices: SloSliceSummary[] = [];
  for (const key of order) {
    const bucket = buckets.get(key);
    if (!bucket) continue;
    const summary = summarizeLatencies(bucket.wallMs);
    if (summary === null) continue;
    slices.push({
      sliceKey: key,
      dimension: bucket.dimension,
      value: bucket.value,
      phase: bucket.phase,
      summary,
      tier: sloTier(summary.p95Ms, thresholds),
    });
  }

  return {
    schemaVersion: LATENCY_SLO_REPORT_SCHEMA_VERSION,
    generatedAtIso: options.generatedAtIso ?? new Date().toISOString(),
    metric: LATENCY_SLO_METRIC,
    thresholds,
    recordCounts,
    deviceEvidence:
      recordCounts.DEVICE_MEASUREMENT > 0
        ? "DEVICE_TRIALS_PRESENT"
        : "BLOCKED_EXTERNAL_NO_DEVICE_MEASUREMENTS",
    linuxNotDeviceDisclaimer:
      recordCounts.LINUX_BENCH_NOT_DEVICE > 0 ? LINUX_NOT_DEVICE_DISCLAIMER : null,
    slices,
  };
}
