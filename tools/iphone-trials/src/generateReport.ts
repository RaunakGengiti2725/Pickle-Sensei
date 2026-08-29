/**
 * Trial-report assembly (`iphone-trial-report-v1`).
 *
 * Pure function over parsed trial documents + the device matrix, so the whole
 * report path is testable on Linux with zero devices. Honesty rules:
 * - Only valid DEVICE_MEASUREMENT trials enter measured statistics.
 * - SAMPLE_FIXTURE trials are counted, named, and NEVER aggregated: with only
 *   samples present the report's overall verdict stays BLOCKED_EXTERNAL.
 * - Invalid trial files fail the report loudly (listed with their errors),
 *   never silently skipped.
 * - Empty latency phases report `null` summaries plus an explicit
 *   unmeasured reason — absence is explained, never zeroed.
 */

import {
  validateDeviceMatrix,
  DEVICE_TIERS,
  type DeviceMatrixV1,
  type DeviceTier,
} from "./deviceMatrix.js";
import {
  validateIphoneTrial,
  type IphoneTrialV1,
  type Metric,
  type IphoneTrialMetricsV1,
} from "./trialSchema.js";
import {
  IPHONE_LATENCY_TARGETS,
  latencyVerdict,
  type IphoneLatencyTargetsV1,
  type LatencyVerdict,
} from "./latencyTargets.js";
import { summarizeLatencies, type LatencySummary } from "./latencyStats.js";

export const TRIAL_REPORT_SCHEMA_VERSION = "iphone-trial-report-v1" as const;

export interface TrialFileInput {
  fileName: string;
  data: unknown;
}

export interface InvalidTrialFile {
  fileName: string;
  errors: string[];
}

export interface PhaseLatencyReport {
  summary: LatencySummary | null;
  /** Required non-null when summary is null. */
  unmeasuredReason: string | null;
  /** Verdict on the judged percentile; null when unmeasured. */
  verdict: LatencyVerdict | null;
}

export interface TierCoverageReport {
  tier: DeviceTier;
  matrixDeviceIds: string[];
  measuredTrialCount: number;
  covered: boolean;
}

export interface MetricCoverageRow {
  metric: string;
  measuredCount: number;
  unmeasuredCount: number;
  unmeasuredReasons: string[];
}

export type ReportVerdict =
  "BLOCKED_EXTERNAL_NO_DEVICE_TRIALS" | "PARTIAL_MATRIX_COVERAGE" | "FULL_MATRIX_COVERAGE";

export interface IphoneTrialReportV1 {
  schemaVersion: typeof TRIAL_REPORT_SCHEMA_VERSION;
  generatedAtIso: string;
  targets: IphoneLatencyTargetsV1;
  totals: {
    filesRead: number;
    deviceMeasurementTrials: number;
    sampleFixtureTrials: number;
    invalidFiles: number;
  };
  invalidFiles: InvalidTrialFile[];
  sampleFixtureFiles: string[];
  primaryLatency: {
    cold: PhaseLatencyReport;
    warm: PhaseLatencyReport;
  };
  tierCoverage: TierCoverageReport[];
  metricCoverage: MetricCoverageRow[];
  verdict: ReportVerdict;
  notes: string[];
}

function isMetric(value: unknown): value is Metric<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { measured?: unknown }).measured === "boolean"
  );
}

/** Walk the metrics tree and tally measured/unmeasured leaves by dotted path. */
function collectMetricCoverage(trials: readonly IphoneTrialV1[]): MetricCoverageRow[] {
  const rows = new Map<string, MetricCoverageRow>();
  const tally = (path: string, metric: Metric<unknown>): void => {
    let row = rows.get(path);
    if (!row) {
      row = {
        metric: path,
        measuredCount: 0,
        unmeasuredCount: 0,
        unmeasuredReasons: [],
      };
      rows.set(path, row);
    }
    if (metric.measured) {
      row.measuredCount += 1;
    } else {
      row.unmeasuredCount += 1;
      if (!row.unmeasuredReasons.includes(metric.unmeasuredReason)) {
        row.unmeasuredReasons.push(metric.unmeasuredReason);
      }
    }
  };
  const walk = (path: string, node: unknown): void => {
    if (isMetric(node)) {
      tally(path, node);
      return;
    }
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      walk(path.length === 0 ? key : `${path}.${key}`, value);
    }
  };
  for (const trial of trials) {
    walk("", trial.metrics satisfies IphoneTrialMetricsV1);
  }
  return [...rows.values()].sort((a, b) => a.metric.localeCompare(b.metric));
}

function phaseReport(
  latencies: readonly number[],
  phase: "cold" | "warm",
  deviceTrialCount: number,
  targets: IphoneLatencyTargetsV1,
): PhaseLatencyReport {
  const summary = summarizeLatencies(latencies);
  if (summary === null) {
    return {
      summary: null,
      unmeasuredReason:
        deviceTrialCount === 0
          ? `no DEVICE_MEASUREMENT trials exist (physical iPhone BLOCKED_EXTERNAL); ${phase} latency unmeasured`
          : `no DEVICE_MEASUREMENT trial carried a measured ${phase}-run primary latency observation`,
      verdict: null,
    };
  }
  return {
    summary,
    unmeasuredReason: null,
    verdict: latencyVerdict(summary.p95Ms, targets),
  };
}

export interface GenerateReportArgs {
  matrix: unknown;
  trialFiles: readonly TrialFileInput[];
  generatedAtIso: string;
  targets?: IphoneLatencyTargetsV1;
}

export function generateTrialReport(args: GenerateReportArgs): IphoneTrialReportV1 {
  const targets = args.targets ?? IPHONE_LATENCY_TARGETS;
  const matrixErrors = validateDeviceMatrix(args.matrix);
  if (matrixErrors.length > 0) {
    throw new Error(`generateTrialReport: invalid device matrix:\n${matrixErrors.join("\n")}`);
  }
  const matrix = args.matrix as DeviceMatrixV1;

  const invalidFiles: InvalidTrialFile[] = [];
  const deviceTrials: IphoneTrialV1[] = [];
  const sampleFixtureFiles: string[] = [];
  const knownDeviceIds = new Set(matrix.devices.map((d) => d.deviceId));

  for (const file of args.trialFiles) {
    const errors = validateIphoneTrial(file.data);
    if (errors.length > 0) {
      invalidFiles.push({ fileName: file.fileName, errors });
      continue;
    }
    const trial = file.data as IphoneTrialV1;
    if (!knownDeviceIds.has(trial.device.matrixDeviceId)) {
      invalidFiles.push({
        fileName: file.fileName,
        errors: [
          `device.matrixDeviceId "${trial.device.matrixDeviceId}" not in device-matrix.json — append the device to the manifest first`,
        ],
      });
      continue;
    }
    if (trial.provenance === "SAMPLE_FIXTURE_NOT_A_MEASUREMENT") {
      sampleFixtureFiles.push(file.fileName);
    } else {
      deviceTrials.push(trial);
    }
  }

  const coldLatencies: number[] = [];
  const warmLatencies: number[] = [];
  for (const trial of deviceTrials) {
    const primary = trial.metrics.analysisLatency.primary;
    if (primary.measured) {
      if (primary.value.runKind === "cold") {
        coldLatencies.push(primary.value.latencyMs);
      } else {
        warmLatencies.push(primary.value.latencyMs);
      }
    }
  }

  const tierCoverage: TierCoverageReport[] = DEVICE_TIERS.map((tier) => {
    const matrixDeviceIds = matrix.devices.filter((d) => d.tier === tier).map((d) => d.deviceId);
    const measuredTrialCount = deviceTrials.filter((t) => t.device.tier === tier).length;
    return {
      tier,
      matrixDeviceIds,
      measuredTrialCount,
      covered: measuredTrialCount >= matrix.requiredDevicesPerTier,
    };
  });

  let verdict: ReportVerdict;
  if (deviceTrials.length === 0) {
    verdict = "BLOCKED_EXTERNAL_NO_DEVICE_TRIALS";
  } else if (tierCoverage.every((t) => t.covered)) {
    verdict = "FULL_MATRIX_COVERAGE";
  } else {
    verdict = "PARTIAL_MATRIX_COVERAGE";
  }

  const notes: string[] = [];
  if (sampleFixtureFiles.length > 0) {
    notes.push(
      `${sampleFixtureFiles.length} SAMPLE_FIXTURE_NOT_A_MEASUREMENT file(s) were read to exercise the pipeline and are EXCLUDED from every statistic above.`,
    );
  }
  if (deviceTrials.length === 0) {
    notes.push(
      "No physical-iPhone evidence exists. Every latency and correctness statistic is unmeasured; nothing in this report may be quoted as a device measurement.",
    );
  }

  return {
    schemaVersion: TRIAL_REPORT_SCHEMA_VERSION,
    generatedAtIso: args.generatedAtIso,
    targets,
    totals: {
      filesRead: args.trialFiles.length,
      deviceMeasurementTrials: deviceTrials.length,
      sampleFixtureTrials: sampleFixtureFiles.length,
      invalidFiles: invalidFiles.length,
    },
    invalidFiles,
    sampleFixtureFiles: [...sampleFixtureFiles].sort(),
    primaryLatency: {
      cold: phaseReport(coldLatencies, "cold", deviceTrials.length, targets),
      warm: phaseReport(warmLatencies, "warm", deviceTrials.length, targets),
    },
    tierCoverage,
    metricCoverage: collectMetricCoverage(deviceTrials),
    verdict,
    notes,
  };
}
