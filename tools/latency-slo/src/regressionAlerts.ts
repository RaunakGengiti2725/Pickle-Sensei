/**
 * Regression alerting between two latency-slo reports (same sliceKey space).
 *
 * Alert kinds:
 *  - MAX_THRESHOLD_EXCEEDED  slice p95 is above the frozen max (FAIL tier).
 *  - TIER_DEGRADED           slice tier is worse than in the baseline.
 *  - P95_REGRESSION          slice p95 grew by more than BOTH the relative
 *                            and absolute frozen floors.
 *  - SLICE_DISAPPEARED       a baseline slice has no counterpart (coverage
 *                            loss is a finding, not silence).
 *
 * Slices under `minSamplesForAlert` samples (in either report) downgrade to
 * severity WARNING with LOW_SAMPLE noted in the detail — small-n percentiles
 * must not page anyone, but they are never hidden either.
 */

import type { LatencySloReport, SloSliceSummary } from "./generateSloReport.js";
import {
  LATENCY_SLO_ALERT_CONFIG,
  isTierDegradation,
  type LatencySloAlertConfigV1,
} from "./sloThresholds.js";

export type SloAlertKind =
  "MAX_THRESHOLD_EXCEEDED" | "TIER_DEGRADED" | "P95_REGRESSION" | "SLICE_DISAPPEARED";

export type SloAlertSeverity = "ALERT" | "WARNING";

export interface SloAlert {
  kind: SloAlertKind;
  severity: SloAlertSeverity;
  sliceKey: string;
  baselineP95Ms: number | null;
  currentP95Ms: number | null;
  detail: string;
}

export interface SloComparison {
  alertConfig: LatencySloAlertConfigV1;
  baselineGeneratedAtIso: string;
  currentGeneratedAtIso: string;
  alerts: SloAlert[];
  /** Slices compared without any finding. */
  cleanSliceKeys: string[];
}

function severityFor(
  baseline: SloSliceSummary | undefined,
  current: SloSliceSummary | undefined,
  config: LatencySloAlertConfigV1,
): { severity: SloAlertSeverity; lowSampleNote: string } {
  const counts = [baseline?.summary.sampleCount, current?.summary.sampleCount].filter(
    (count): count is number => count !== undefined,
  );
  const lowSample = counts.some((count) => count < config.minSamplesForAlert);
  return lowSample
    ? {
        severity: "WARNING",
        lowSampleNote: ` LOW_SAMPLE (< ${config.minSamplesForAlert} samples): warning only.`,
      }
    : { severity: "ALERT", lowSampleNote: "" };
}

export function compareSloReports(
  baseline: LatencySloReport,
  current: LatencySloReport,
  config: LatencySloAlertConfigV1 = LATENCY_SLO_ALERT_CONFIG,
): SloComparison {
  const baselineByKey = new Map(baseline.slices.map((slice) => [slice.sliceKey, slice]));
  const currentByKey = new Map(current.slices.map((slice) => [slice.sliceKey, slice]));

  const alerts: SloAlert[] = [];
  const cleanSliceKeys: string[] = [];

  for (const currentSlice of current.slices) {
    const baselineSlice = baselineByKey.get(currentSlice.sliceKey);
    const { severity, lowSampleNote } = severityFor(baselineSlice, currentSlice, config);
    let found = false;

    if (currentSlice.tier === "FAIL") {
      found = true;
      alerts.push({
        kind: "MAX_THRESHOLD_EXCEEDED",
        severity,
        sliceKey: currentSlice.sliceKey,
        baselineP95Ms: baselineSlice?.summary.p95Ms ?? null,
        currentP95Ms: currentSlice.summary.p95Ms,
        detail:
          `p95 ${currentSlice.summary.p95Ms}ms exceeds frozen max ` +
          `${current.thresholds.maxMs}ms (${current.thresholds.version}).${lowSampleNote}`,
      });
    }

    if (baselineSlice) {
      if (isTierDegradation(baselineSlice.tier, currentSlice.tier)) {
        found = true;
        alerts.push({
          kind: "TIER_DEGRADED",
          severity,
          sliceKey: currentSlice.sliceKey,
          baselineP95Ms: baselineSlice.summary.p95Ms,
          currentP95Ms: currentSlice.summary.p95Ms,
          detail: `tier ${baselineSlice.tier} -> ${currentSlice.tier}.${lowSampleNote}`,
        });
      }
      const deltaMs = currentSlice.summary.p95Ms - baselineSlice.summary.p95Ms;
      const deltaPct =
        baselineSlice.summary.p95Ms > 0 ? (deltaMs / baselineSlice.summary.p95Ms) * 100 : Infinity;
      if (deltaMs > config.p95RegressionAbsMs && deltaPct > config.p95RegressionPct) {
        found = true;
        alerts.push({
          kind: "P95_REGRESSION",
          severity,
          sliceKey: currentSlice.sliceKey,
          baselineP95Ms: baselineSlice.summary.p95Ms,
          currentP95Ms: currentSlice.summary.p95Ms,
          detail:
            `p95 +${deltaMs.toFixed(1)}ms (+${deltaPct.toFixed(1)}%) exceeds frozen floors ` +
            `>${config.p95RegressionAbsMs}ms AND >${config.p95RegressionPct}% ` +
            `(${config.version}).${lowSampleNote}`,
        });
      }
    }

    if (!found) cleanSliceKeys.push(currentSlice.sliceKey);
  }

  for (const baselineSlice of baseline.slices) {
    if (currentByKey.has(baselineSlice.sliceKey)) continue;
    const { severity, lowSampleNote } = severityFor(baselineSlice, undefined, config);
    alerts.push({
      kind: "SLICE_DISAPPEARED",
      severity,
      sliceKey: baselineSlice.sliceKey,
      baselineP95Ms: baselineSlice.summary.p95Ms,
      currentP95Ms: null,
      detail: `slice present in baseline but missing from current report.${lowSampleNote}`,
    });
  }

  return {
    alertConfig: config,
    baselineGeneratedAtIso: baseline.generatedAtIso,
    currentGeneratedAtIso: current.generatedAtIso,
    alerts,
    cleanSliceKeys,
  };
}
