import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  REGRESSION_CONTRACT_ID,
  REGRESSION_CONTRACT_VERSION,
  TOLERANCE_CONFIG_VERSION,
  compareSummaries,
  formatCompareReport,
  identityDifferences,
  validateToleranceConfig,
  type BenchRecord,
  type MetricComparisonStatus,
  type RegressionSummary,
  type ToleranceConfig,
} from "../src/index.js";
import { bench, summary } from "./regressionFixtures.js";

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const OTHER_SHA = "1111111111111111111111111111111111111111";

function config(overrides: Partial<ToleranceConfig> = {}): ToleranceConfig {
  return {
    configVersion: TOLERANCE_CONFIG_VERSION,
    contract: REGRESSION_CONTRACT_ID,
    contractVersion: REGRESSION_CONTRACT_VERSION,
    unlistedMetricPolicy: "fail",
    lostMeasurementIsRegression: true,
    metrics: {
      "contact_replay.target_events": {
        direction: "informational",
        absoluteTolerance: 0,
        rationale: "corpus size",
      },
      "contact_replay.estimated": {
        direction: "higher_is_better",
        absoluteTolerance: 0,
        rationale: "more contacts estimated",
      },
      "contact_replay.median_error_ms": {
        direction: "lower_is_better",
        absoluteTolerance: 5,
        rationale: "timing error",
      },
      "contact_replay.p90_error_ms": {
        direction: "lower_is_better",
        absoluteTolerance: 0,
        rationale: "tail timing error",
      },
    },
    ...overrides,
  };
}

function candidateWith(
  metrics: Record<string, number | null>,
  benchOverrides: Partial<BenchRecord> = {},
): RegressionSummary {
  return summary(
    {
      runId: "candidate",
      provenance: { ...summary().provenance, gitSha: OTHER_SHA, gitBranch: "feature" },
    },
    [bench({ metrics, ...benchOverrides })],
  );
}

const BASE_METRICS = { target_events: 10, estimated: 7, median_error_ms: 27, p90_error_ms: null };

function statusOf(
  report: ReturnType<typeof compareSummaries>,
  metric: string,
): MetricComparisonStatus {
  const found = report.metrics.find((entry) => entry.metric === metric);
  if (!found) throw new Error(`metric ${metric} not in report`);
  return found.status;
}

describe("validateToleranceConfig", () => {
  it("accepts the committed regression.tolerances.json", () => {
    const raw: unknown = JSON.parse(
      readFileSync(join(PACKAGE_DIR, "regression.tolerances.json"), "utf8"),
    );
    const result = validateToleranceConfig(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.contractVersion).toBe(REGRESSION_CONTRACT_VERSION);
      expect(result.value.unlistedMetricPolicy).toBe("fail");
      expect(result.value.lostMeasurementIsRegression).toBe(true);
      expect(Object.keys(result.value.metrics).length).toBeGreaterThan(0);
      for (const entry of Object.values(result.value.metrics)) {
        expect(entry.rationale.length).toBeGreaterThan(10);
      }
    }
  });

  it("rejects malformed configs with a specific code", () => {
    const cases: Array<[unknown, string]> = [
      [null, "tolerances_not_object"],
      [{ ...config(), configVersion: 2 }, "tolerances_version"],
      [{ ...config(), contract: "mac-bench" }, "tolerances_contract"],
      [{ ...config(), contractVersion: 0 }, "tolerances_contract_version"],
      [{ ...config(), unlistedMetricPolicy: "ignore" }, "tolerances_unlisted_policy"],
      [{ ...config(), lostMeasurementIsRegression: "yes" }, "tolerances_lost_measurement"],
      [{ ...config(), metrics: [] }, "tolerances_metrics"],
      [{ ...config(), metrics: { x: 1 } }, "tolerance_entry"],
      [
        { ...config(), metrics: { x: { direction: "up", absoluteTolerance: 0, rationale: "r" } } },
        "tolerance_direction",
      ],
      [
        {
          ...config(),
          metrics: { x: { direction: "higher_is_better", absoluteTolerance: -1, rationale: "r" } },
        },
        "tolerance_value",
      ],
      [
        {
          ...config(),
          metrics: { x: { direction: "higher_is_better", absoluteTolerance: 0, rationale: " " } },
        },
        "tolerance_rationale",
      ],
    ];
    for (const [raw, code] of cases) {
      const result = validateToleranceConfig(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe(code);
    }
  });
});

describe("compareSummaries", () => {
  it("reports an identical candidate as clean (exit 0) with git sha as the expected change", () => {
    const report = compareSummaries(summary(), candidateWith(BASE_METRICS), config());
    expect(report.comparable).toBe(true);
    expect(report.exitCode).toBe(0);
    expect(report.regressions).toEqual([]);
    expect(report.improvements).toEqual([]);
    expect(statusOf(report, "contact_replay.estimated")).toBe("unchanged");
    expect(statusOf(report, "contact_replay.target_events")).toBe("informational");
    expect(statusOf(report, "contact_replay.p90_error_ms")).toBe("unmeasured_both");
    expect(report.identityDifferences).toEqual([
      {
        field: "provenance.gitSha",
        baseline: summary().provenance.gitSha,
        candidate: OTHER_SHA,
        severity: "expected",
      },
    ]);
    expect(report.benches).toEqual([
      {
        benchId: "contact_replay",
        status: "ok",
        failing: false,
        baselineWallClockMs: 44,
        candidateWallClockMs: 44,
      },
    ]);
  });

  it("flags a worse higher_is_better metric as a regression (exit 1)", () => {
    const report = compareSummaries(
      summary(),
      candidateWith({ ...BASE_METRICS, estimated: 6 }),
      config(),
    );
    expect(report.exitCode).toBe(1);
    expect(statusOf(report, "contact_replay.estimated")).toBe("regressed");
    expect(report.regressions).toEqual([
      "contact_replay.estimated: 7 → 6 (Δ -1) regressed [higher_is_better, tol 0]",
    ]);
  });

  it("flags a better metric as an improvement without failing", () => {
    const report = compareSummaries(
      summary(),
      candidateWith({ ...BASE_METRICS, estimated: 8 }),
      config(),
    );
    expect(report.exitCode).toBe(0);
    expect(statusOf(report, "contact_replay.estimated")).toBe("improved");
    expect(report.improvements).toHaveLength(1);
  });

  it("honours lower_is_better direction and absolute tolerance boundaries", () => {
    const within = compareSummaries(
      summary(),
      candidateWith({ ...BASE_METRICS, median_error_ms: 32 }),
      config(),
    );
    expect(statusOf(within, "contact_replay.median_error_ms")).toBe("within_tolerance");
    expect(within.exitCode).toBe(0);

    const beyond = compareSummaries(
      summary(),
      candidateWith({ ...BASE_METRICS, median_error_ms: 33 }),
      config(),
    );
    expect(statusOf(beyond, "contact_replay.median_error_ms")).toBe("regressed");
    expect(beyond.exitCode).toBe(1);

    const better = compareSummaries(
      summary(),
      candidateWith({ ...BASE_METRICS, median_error_ms: 20 }),
      config(),
    );
    expect(statusOf(better, "contact_replay.median_error_ms")).toBe("improved");

    const smallBetter = compareSummaries(
      summary(),
      candidateWith({ ...BASE_METRICS, median_error_ms: 25 }),
      config(),
    );
    expect(statusOf(smallBetter, "contact_replay.median_error_ms")).toBe("within_tolerance");
    expect(smallBetter.improvements).toEqual([]);
  });

  it("never treats informational metrics as regressions", () => {
    const report = compareSummaries(
      summary(),
      candidateWith({ ...BASE_METRICS, target_events: 3 }),
      config(),
    );
    expect(statusOf(report, "contact_replay.target_events")).toBe("informational");
    expect(report.exitCode).toBe(0);
  });

  it("treats a measurement that became null as lost, failing only when configured", () => {
    const lostFails = compareSummaries(
      summary(),
      candidateWith({ ...BASE_METRICS, median_error_ms: null }),
      config(),
    );
    expect(statusOf(lostFails, "contact_replay.median_error_ms")).toBe("measurement_lost");
    expect(lostFails.exitCode).toBe(1);

    const lostWarns = compareSummaries(
      summary(),
      candidateWith({ ...BASE_METRICS, median_error_ms: null }),
      config({ lostMeasurementIsRegression: false }),
    );
    expect(statusOf(lostWarns, "contact_replay.median_error_ms")).toBe("measurement_lost");
    expect(lostWarns.exitCode).toBe(0);
    expect(lostWarns.warnings.some((line) => line.includes("measurement_lost"))).toBe(true);
  });

  it("reports newly measured metrics as warnings, never as improvements", () => {
    const report = compareSummaries(
      summary(),
      candidateWith({ ...BASE_METRICS, p90_error_ms: 128 }),
      config(),
    );
    expect(statusOf(report, "contact_replay.p90_error_ms")).toBe("newly_measured");
    expect(report.exitCode).toBe(0);
    expect(report.improvements).toEqual([]);
    expect(report.warnings).toContain(
      "contact_replay.p90_error_ms: newly_measured — no baseline to judge against",
    );
  });

  it("fails on a metric missing from the candidate when it is guarded, and applies the unlisted policy", () => {
    const { median_error_ms: _dropped, ...rest } = BASE_METRICS;
    const missing = compareSummaries(summary(), candidateWith(rest), config());
    expect(statusOf(missing, "contact_replay.median_error_ms")).toBe("missing_in_candidate");
    expect(missing.exitCode).toBe(1);

    const unlistedFail = compareSummaries(
      summary(),
      candidateWith({ ...BASE_METRICS, brand_new: 1 }),
      config(),
    );
    expect(statusOf(unlistedFail, "contact_replay.brand_new")).toBe("missing_in_baseline");
    expect(unlistedFail.exitCode).toBe(0);

    const both = compareSummaries(
      summary({}, [bench({ metrics: { ...BASE_METRICS, brand_new: 1 } })]),
      candidateWith({ ...BASE_METRICS, brand_new: 1 }),
      config(),
    );
    expect(statusOf(both, "contact_replay.brand_new")).toBe("unlisted");
    expect(both.exitCode).toBe(1);

    const informationalPolicy = compareSummaries(
      summary({}, [bench({ metrics: { ...BASE_METRICS, brand_new: 1 } })]),
      candidateWith({ ...BASE_METRICS, brand_new: 0 }),
      config({ unlistedMetricPolicy: "informational" }),
    );
    expect(statusOf(informationalPolicy, "contact_replay.brand_new")).toBe("informational");
    expect(informationalPolicy.exitCode).toBe(0);
  });

  it("fails when a bench failed or vanished in the candidate, without double counting its metrics", () => {
    const failed = compareSummaries(
      summary(),
      candidateWith({}, { status: "failed", error: "gold file missing", exitCode: null }),
      config(),
    );
    expect(failed.exitCode).toBe(1);
    expect(failed.benches[0]).toMatchObject({
      benchId: "contact_replay",
      status: "failed_in_candidate",
      failing: true,
    });
    expect(failed.regressions).toEqual(["bench contact_replay: failed_in_candidate"]);
    expect(failed.metrics.every((metric) => !metric.failing)).toBe(true);

    const vanished = compareSummaries(
      summary(),
      summary({ runId: "candidate" }, [bench({ id: "coach_gates", metrics: { gates_pass: 3 } })]),
      config(),
    );
    expect(vanished.exitCode).toBe(1);
    expect(vanished.regressions).toEqual(["bench contact_replay: missing_in_candidate"]);
    expect(vanished.warnings).toContain(
      "bench coach_gates: new_in_candidate — no baseline to judge against",
    );
  });

  it("fails when a bench failed on both sides — no candidate measurement can read as clean", () => {
    const both = compareSummaries(
      summary({}, [bench({ status: "failed", error: "boom", metrics: {} })]),
      candidateWith({}, { status: "failed", error: "still boom", metrics: {} }),
      config(),
    );
    expect(both.exitCode).toBe(1);
    expect(both.benches[0]).toMatchObject({
      benchId: "contact_replay",
      status: "failed_in_both",
      failing: true,
    });
    expect(both.regressions).toEqual(["bench contact_replay: failed_in_both"]);
    expect(both.warnings.some((line) => line.includes("failed_in_both"))).toBe(false);
  });

  it("does not fail on a bench that failed in the baseline but recovered", () => {
    const recovered = compareSummaries(
      summary({}, [bench({ status: "failed", error: "boom", metrics: {} })]),
      candidateWith(BASE_METRICS),
      config(),
    );
    expect(recovered.exitCode).toBe(0);
    expect(recovered.benches[0]?.status).toBe("failed_in_baseline");
    expect(recovered.metrics.every((metric) => metric.status === "missing_in_baseline")).toBe(true);
  });

  it("refuses to compare documents from different contracts (exit 3)", () => {
    const other = candidateWith(BASE_METRICS);
    const cases: RegressionSummary[] = [
      { ...other, contractVersion: REGRESSION_CONTRACT_VERSION + 1 },
      { ...other, schemaVersion: 2 as unknown as typeof other.schemaVersion },
      {
        ...other,
        provenance: {
          ...other.provenance,
          evidenceClass: "mac_device" as unknown as typeof other.provenance.evidenceClass,
        },
      },
    ];
    for (const candidate of cases) {
      const report = compareSummaries(summary(), candidate, config());
      expect(report.comparable).toBe(false);
      expect(report.exitCode).toBe(3);
      expect(report.metrics).toEqual([]);
      expect(report.warnings[0]).toMatch(/^NON-COMPARABLE /);
    }
    const configMismatch = compareSummaries(summary(), other, config({ contractVersion: 2 }));
    expect(configMismatch.exitCode).toBe(3);
    expect(configMismatch.warnings[0]).toContain("config.contractVersion");
  });

  it("surfaces dataset, runner and dirty-tree differences as confounds without aborting", () => {
    const candidate = candidateWith({ ...BASE_METRICS, estimated: 8 });
    candidate.provenance.datasetsTreeSha = OTHER_SHA;
    candidate.provenance.datasetReleases = [];
    candidate.provenance.gitDirty = true;
    candidate.provenance.modelVersions = { contactEstimator: "contact-evidence-5.0" };
    candidate.runner = { ...candidate.runner, node: "v20.19.0" };
    const diffs = identityDifferences(summary(), candidate, config());
    expect(diffs.map((diff) => [diff.field, diff.severity])).toEqual([
      ["provenance.datasetsTreeSha", "confound"],
      ["provenance.datasetReleases", "confound"],
      ["runner.node", "confound"],
      ["provenance.gitDirty", "confound"],
      ["provenance.modelVersions.contactEstimator", "expected"],
      ["provenance.gitSha", "expected"],
    ]);
    const report = compareSummaries(summary(), candidate, config());
    expect(report.comparable).toBe(true);
    expect(report.exitCode).toBe(0);
    expect(report.warnings.filter((line) => line.startsWith("CONFOUND "))).toHaveLength(4);
    expect(report.improvements).toHaveLength(1);
  });

  it("flags a dirty BASELINE tree as a confound too", () => {
    const dirtyBaseline = summary();
    dirtyBaseline.provenance.gitDirty = true;
    const diffs = identityDifferences(dirtyBaseline, candidateWith(BASE_METRICS), config());
    expect(diffs).toContainEqual({
      field: "provenance.gitDirty",
      baseline: "true",
      candidate: "false",
      severity: "confound",
    });
    const report = compareSummaries(dirtyBaseline, candidateWith(BASE_METRICS), config());
    expect(report.exitCode).toBe(0);
    expect(report.warnings.some((line) => line.startsWith("CONFOUND provenance.gitDirty"))).toBe(
      true,
    );
  });

  it("formats a human-readable report that names the result and exit code", () => {
    const clean = compareSummaries(summary(), candidateWith(BASE_METRICS), config());
    const text = formatCompareReport(summary(), candidateWith(BASE_METRICS), clean);
    expect(text).toContain("RESULT: NO REGRESSIONS BEYOND DECLARED TOLERANCES (exit 0)");
    expect(text).toContain("contact_replay.p90_error_ms");
    expect(text).toContain("null → null");

    const bad = candidateWith({ ...BASE_METRICS, estimated: 5 });
    const badReport = compareSummaries(summary(), bad, config());
    expect(formatCompareReport(summary(), bad, badReport)).toContain(
      "RESULT: REGRESSIONS BEYOND DECLARED TOLERANCES (exit 1)",
    );

    const nonComparable = compareSummaries(summary(), { ...bad, contractVersion: 99 }, config());
    expect(formatCompareReport(summary(), bad, nonComparable)).toContain(
      "RESULT: NON-COMPARABLE (exit 3)",
    );
  });
});
