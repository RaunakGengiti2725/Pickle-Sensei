import type { RegressionSummary } from "./summarySchema.js";
import type { MetricTolerance, ToleranceConfig } from "./tolerances.js";

/**
 * Baseline -> candidate comparison over two validated regression summaries.
 *
 * Per-metric statuses are exhaustive and never coerce a missing or null
 * measurement into a number:
 *  - improved / regressed / unchanged / within_tolerance: both sides numeric.
 *  - informational: both numeric, metric declared informational (or unlisted
 *    under the "informational" policy).
 *  - unlisted: both numeric, metric absent from the config, policy "fail".
 *  - measurement_lost: baseline numeric, candidate null.
 *  - newly_measured: baseline null, candidate numeric.
 *  - unmeasured_both: null on both sides.
 *  - missing_in_candidate / missing_in_baseline: key absent on one side.
 */
export const METRIC_COMPARISON_STATUSES = [
  "improved",
  "regressed",
  "unchanged",
  "within_tolerance",
  "informational",
  "unlisted",
  "measurement_lost",
  "newly_measured",
  "unmeasured_both",
  "missing_in_candidate",
  "missing_in_baseline",
] as const;
export type MetricComparisonStatus = (typeof METRIC_COMPARISON_STATUSES)[number];

export interface MetricComparison {
  metric: string;
  baseline: number | null | undefined;
  candidate: number | null | undefined;
  /** candidate - baseline when both numeric, else null. */
  delta: number | null;
  status: MetricComparisonStatus;
  /** Counts toward the non-zero exit code. */
  failing: boolean;
  tolerance: MetricTolerance | null;
}

export type BenchComparisonStatus =
  | "ok"
  | "failed_in_candidate"
  | "failed_in_baseline"
  | "failed_in_both"
  | "missing_in_candidate"
  | "new_in_candidate";

export interface BenchComparison {
  benchId: string;
  status: BenchComparisonStatus;
  failing: boolean;
  baselineWallClockMs: number | null;
  candidateWallClockMs: number | null;
}

/** Identity facts that decide whether two summaries measure the same thing. */
export interface IdentityDifference {
  field: string;
  baseline: string;
  candidate: string;
  /** `non_comparable` aborts the comparison; `confound` is reported and
   *  makes every metric delta suspect; `expected` is the change under test. */
  severity: "non_comparable" | "confound" | "expected";
}

export interface CompareReport {
  comparable: boolean;
  identityDifferences: IdentityDifference[];
  benches: BenchComparison[];
  metrics: MetricComparison[];
  counts: Record<MetricComparisonStatus, number>;
  regressions: string[];
  improvements: string[];
  warnings: string[];
  /** 0 = clean, 1 = regressions, 3 = non-comparable documents. */
  exitCode: 0 | 1 | 3;
}

function toleranceFor(metric: string, config: ToleranceConfig): MetricTolerance | null {
  return config.metrics[metric] ?? null;
}

function compareMetric(
  metric: string,
  baseline: number | null | undefined,
  candidate: number | null | undefined,
  config: ToleranceConfig,
): MetricComparison {
  const tolerance = toleranceFor(metric, config);
  const base = (status: MetricComparisonStatus, failing: boolean): MetricComparison => ({
    metric,
    baseline,
    candidate,
    delta:
      typeof baseline === "number" && typeof candidate === "number" ? candidate - baseline : null,
    status,
    failing,
    tolerance,
  });

  const informational = tolerance?.direction === "informational";
  const unlistedFails = tolerance === null && config.unlistedMetricPolicy === "fail";
  const guarded = tolerance !== null && !informational;

  if (baseline === undefined) return base("missing_in_baseline", false);
  if (candidate === undefined) return base("missing_in_candidate", guarded || unlistedFails);
  if (baseline === null && candidate === null) return base("unmeasured_both", false);
  if (baseline === null) return base("newly_measured", false);
  if (candidate === null) {
    return base(
      "measurement_lost",
      (guarded || unlistedFails) && config.lostMeasurementIsRegression,
    );
  }
  if (tolerance === null) {
    return base(
      config.unlistedMetricPolicy === "fail" ? "unlisted" : "informational",
      unlistedFails,
    );
  }
  if (informational) return base("informational", false);

  const delta = candidate - baseline;
  if (delta === 0) return base("unchanged", false);
  const good = tolerance.direction === "higher_is_better" ? delta > 0 : delta < 0;
  if (Math.abs(delta) <= tolerance.absoluteTolerance) return base("within_tolerance", false);
  return good ? base("improved", false) : base("regressed", true);
}

function emptyCounts(): Record<MetricComparisonStatus, number> {
  const counts = {} as Record<MetricComparisonStatus, number>;
  for (const status of METRIC_COMPARISON_STATUSES) counts[status] = 0;
  return counts;
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function identityDifferences(
  baseline: RegressionSummary,
  candidate: RegressionSummary,
  config: ToleranceConfig,
): IdentityDifference[] {
  const diffs: IdentityDifference[] = [];
  const push = (
    field: string,
    a: unknown,
    b: unknown,
    severity: IdentityDifference["severity"],
  ): void => {
    const sa = stringify(a);
    const sb = stringify(b);
    if (sa !== sb) diffs.push({ field, baseline: sa, candidate: sb, severity });
  };
  push("schemaVersion", baseline.schemaVersion, candidate.schemaVersion, "non_comparable");
  push("contract", baseline.contract, candidate.contract, "non_comparable");
  push("contractVersion", baseline.contractVersion, candidate.contractVersion, "non_comparable");
  push(
    "config.contractVersion",
    config.contractVersion,
    candidate.contractVersion,
    "non_comparable",
  );
  push(
    "provenance.evidenceClass",
    baseline.provenance.evidenceClass,
    candidate.provenance.evidenceClass,
    "non_comparable",
  );
  push(
    "provenance.datasetsTreeSha",
    baseline.provenance.datasetsTreeSha,
    candidate.provenance.datasetsTreeSha,
    "confound",
  );
  const releaseKey = (summary: RegressionSummary): string[] =>
    summary.provenance.datasetReleases
      .map((release) => `${release.releaseDir}:${release.releaseId}:${release.manifestSha256}`)
      .sort();
  push("provenance.datasetReleases", releaseKey(baseline), releaseKey(candidate), "confound");
  push("runner.node", baseline.runner.node, candidate.runner.node, "confound");
  push("runner.platform", baseline.runner.platform, candidate.runner.platform, "confound");
  push("runner.arch", baseline.runner.arch, candidate.runner.arch, "confound");
  if (baseline.provenance.gitDirty || candidate.provenance.gitDirty) {
    diffs.push({
      field: "provenance.gitDirty",
      baseline: String(baseline.provenance.gitDirty),
      candidate: String(candidate.provenance.gitDirty),
      severity: "confound",
    });
  }
  const modelKeys = new Set([
    ...Object.keys(baseline.provenance.modelVersions),
    ...Object.keys(candidate.provenance.modelVersions),
  ]);
  for (const key of [...modelKeys].sort()) {
    push(
      `provenance.modelVersions.${key}`,
      baseline.provenance.modelVersions[key] ?? "<absent>",
      candidate.provenance.modelVersions[key] ?? "<absent>",
      "expected",
    );
  }
  push("provenance.gitSha", baseline.provenance.gitSha, candidate.provenance.gitSha, "expected");
  return diffs;
}

export function compareSummaries(
  baseline: RegressionSummary,
  candidate: RegressionSummary,
  config: ToleranceConfig,
): CompareReport {
  const diffs = identityDifferences(baseline, candidate, config);
  const nonComparable = diffs.filter((diff) => diff.severity === "non_comparable");
  const warnings = diffs
    .filter((diff) => diff.severity === "confound")
    .map(
      (diff) =>
        `CONFOUND ${diff.field}: baseline=${diff.baseline} candidate=${diff.candidate} — metric deltas may not be attributable to the code change`,
    );

  if (nonComparable.length > 0) {
    return {
      comparable: false,
      identityDifferences: diffs,
      benches: [],
      metrics: [],
      counts: emptyCounts(),
      regressions: [],
      improvements: [],
      warnings: [
        ...nonComparable.map(
          (diff) =>
            `NON-COMPARABLE ${diff.field}: baseline=${diff.baseline} candidate=${diff.candidate}`,
        ),
        ...warnings,
      ],
      exitCode: 3,
    };
  }

  const benches: BenchComparison[] = [];
  const baselineBenches = new Map(baseline.benches.map((bench) => [bench.id, bench]));
  const candidateBenches = new Map(candidate.benches.map((bench) => [bench.id, bench]));
  const benchIds = [...new Set([...baselineBenches.keys(), ...candidateBenches.keys()])].sort();
  for (const benchId of benchIds) {
    const a = baselineBenches.get(benchId);
    const b = candidateBenches.get(benchId);
    let status: BenchComparisonStatus;
    let failing = false;
    if (a && !b) {
      status = "missing_in_candidate";
      failing = true;
    } else if (!a && b) {
      status = "new_in_candidate";
      failing = b.status === "failed";
    } else if (a && b) {
      if (a.status === "failed" && b.status === "failed") {
        // No candidate measurements exist, so nothing can be judged clean.
        status = "failed_in_both";
        failing = true;
      } else if (b.status === "failed") {
        status = "failed_in_candidate";
        failing = true;
      } else if (a.status === "failed") status = "failed_in_baseline";
      else status = "ok";
    } else {
      continue;
    }
    benches.push({
      benchId,
      status,
      failing,
      baselineWallClockMs: a?.wallClockMs ?? null,
      candidateWallClockMs: b?.wallClockMs ?? null,
    });
  }

  const metricKeys = [
    ...new Set([...Object.keys(baseline.metrics), ...Object.keys(candidate.metrics)]),
  ].sort();
  const metrics: MetricComparison[] = [];
  const counts = emptyCounts();
  for (const key of metricKeys) {
    const comparison = compareMetric(
      key,
      key in baseline.metrics ? baseline.metrics[key] : undefined,
      key in candidate.metrics ? candidate.metrics[key] : undefined,
      config,
    );
    // A metric that vanished because its whole bench failed is already
    // reported at bench level; do not double count it.
    const bench = benches.find((entry) => key.startsWith(`${entry.benchId}.`));
    if (
      comparison.status === "missing_in_candidate" &&
      bench &&
      (bench.status === "failed_in_candidate" ||
        bench.status === "failed_in_both" ||
        bench.status === "missing_in_candidate")
    ) {
      comparison.failing = false;
    }
    metrics.push(comparison);
    counts[comparison.status] += 1;
  }

  const regressions = [
    ...benches
      .filter((bench) => bench.failing)
      .map((bench) => `bench ${bench.benchId}: ${bench.status}`),
    ...metrics
      .filter((metric) => metric.failing)
      .map((metric) => `${metric.metric}: ${describeMetric(metric)}`),
  ];
  const improvements = metrics
    .filter((metric) => metric.status === "improved")
    .map((metric) => `${metric.metric}: ${describeMetric(metric)}`);

  for (const metric of metrics) {
    if (metric.status === "newly_measured" || metric.status === "missing_in_baseline") {
      warnings.push(`${metric.metric}: ${metric.status} — no baseline to judge against`);
    }
    if (metric.status === "measurement_lost" && !metric.failing) {
      warnings.push(`${metric.metric}: measurement_lost (not configured as a regression)`);
    }
  }
  for (const bench of benches) {
    if (bench.status === "failed_in_baseline") {
      warnings.push(`bench ${bench.benchId}: ${bench.status}`);
    }
    if (bench.status === "new_in_candidate" && !bench.failing) {
      warnings.push(`bench ${bench.benchId}: new_in_candidate — no baseline to judge against`);
    }
  }

  return {
    comparable: true,
    identityDifferences: diffs,
    benches,
    metrics,
    counts,
    regressions,
    improvements,
    warnings,
    exitCode: regressions.length > 0 ? 1 : 0,
  };
}

function fmt(value: number | null | undefined): string {
  if (value === undefined) return "<missing>";
  if (value === null) return "null";
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function describeMetric(metric: MetricComparison): string {
  const delta =
    metric.delta === null ? "" : ` (Δ ${metric.delta > 0 ? "+" : ""}${fmt(metric.delta)})`;
  const tol =
    metric.tolerance && metric.tolerance.direction !== "informational"
      ? ` [${metric.tolerance.direction}, tol ${fmt(metric.tolerance.absoluteTolerance)}]`
      : "";
  return `${fmt(metric.baseline)} → ${fmt(metric.candidate)}${delta} ${metric.status}${tol}`;
}

export function formatCompareReport(
  baseline: RegressionSummary,
  candidate: RegressionSummary,
  report: CompareReport,
): string {
  const lines: string[] = [];
  lines.push("═".repeat(78));
  lines.push("PICKLE SENSEI LINUX REGRESSION COMPARE");
  lines.push(
    `baseline  ${baseline.runId}  git ${baseline.provenance.gitSha.slice(0, 12)}${baseline.provenance.gitDirty ? " (dirty)" : ""}`,
  );
  lines.push(
    `candidate ${candidate.runId}  git ${candidate.provenance.gitSha.slice(0, 12)}${candidate.provenance.gitDirty ? " (dirty)" : ""}`,
  );
  lines.push(
    `evidence  ${candidate.provenance.evidenceClass} — Linux replay over committed artifacts, not the Mac cascade`,
  );
  lines.push("═".repeat(78));
  if (!report.comparable) {
    lines.push("RESULT: NON-COMPARABLE (exit 3)");
    for (const warning of report.warnings) lines.push(`  ${warning}`);
    return lines.join("\n");
  }
  const expected = report.identityDifferences.filter((diff) => diff.severity === "expected");
  if (expected.length > 0) {
    lines.push("identity changes under test:");
    for (const diff of expected) {
      lines.push(`  ${diff.field}: ${diff.baseline} → ${diff.candidate}`);
    }
  }
  lines.push("");
  lines.push("benches:");
  for (const bench of report.benches) {
    lines.push(
      `  ${bench.failing ? "FAIL" : "ok  "} ${bench.benchId.padEnd(24)} ${bench.status.padEnd(20)} wall ${fmt(bench.baselineWallClockMs)}ms → ${fmt(bench.candidateWallClockMs)}ms`,
    );
  }
  lines.push("");
  lines.push("metrics:");
  for (const metric of report.metrics) {
    const marker = metric.failing
      ? "REGRESSION"
      : metric.status === "improved"
        ? "improved  "
        : "          ";
    lines.push(`  ${marker} ${metric.metric.padEnd(52)} ${describeMetric(metric)}`);
  }
  lines.push("");
  lines.push(
    `counts: ${METRIC_COMPARISON_STATUSES.filter((status) => report.counts[status] > 0)
      .map((status) => `${status}=${report.counts[status]}`)
      .join("  ")}`,
  );
  if (report.warnings.length > 0) {
    lines.push("");
    lines.push("warnings:");
    for (const warning of report.warnings) lines.push(`  ${warning}`);
  }
  lines.push("");
  lines.push(`improvements: ${report.improvements.length}`);
  for (const line of report.improvements) lines.push(`  + ${line}`);
  lines.push(`regressions: ${report.regressions.length}`);
  for (const line of report.regressions) lines.push(`  - ${line}`);
  lines.push("");
  lines.push(
    report.exitCode === 0
      ? "RESULT: NO REGRESSIONS BEYOND DECLARED TOLERANCES (exit 0)"
      : "RESULT: REGRESSIONS BEYOND DECLARED TOLERANCES (exit 1)",
  );
  return lines.join("\n");
}
