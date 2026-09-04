/**
 * Structural audit probes (pkg-evaluation-bench, pass 1) — compare semantics,
 * schema/validator parity, tolerance/baseline coverage.
 *
 * `it.fails(...)` = behaviour the contract/docs promise that does NOT hold on
 * 4d812e1aa699014cc0521fd92fde66908043aaa8 (green while broken, red once
 * fixed — flip to `it` then). Plain `it(...)` = invariant verified to hold.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../src/regression/benches.js";
import { DEFAULT_TOLERANCES_PATH, loadSummary, loadTolerances } from "../../src/regression/cli.js";
import { compareSummaries } from "../../src/regression/compare.js";
import { datasetsInputTreeSha } from "../../src/regression/run.js";
import {
  REGRESSION_CONTRACT_ID,
  REGRESSION_CONTRACT_VERSION,
  type ToleranceConfig,
  validateRegressionSummary,
} from "../../src/index.js";
import { bench, summary } from "../regressionFixtures.js";

const BASELINE_PATH = join(REPO_ROOT, "datasets/reports/regression/baseline.json");
const SCHEMA_PATH = join(REPO_ROOT, "packages/evaluation/regression.summary.schema.json");

function config(overrides: Partial<ToleranceConfig> = {}): ToleranceConfig {
  return {
    configVersion: 1,
    contract: REGRESSION_CONTRACT_ID,
    contractVersion: REGRESSION_CONTRACT_VERSION,
    unlistedMetricPolicy: "fail",
    lostMeasurementIsRegression: true,
    metrics: {
      "contact_replay.target_events": {
        direction: "informational",
        absoluteTolerance: 0,
        rationale: "count",
      },
      "contact_replay.estimated": {
        direction: "higher_is_better",
        absoluteTolerance: 0,
        rationale: "n",
      },
      "contact_replay.median_error_ms": {
        direction: "lower_is_better",
        absoluteTolerance: 0,
        rationale: "ms",
      },
      "contact_replay.p90_error_ms": {
        direction: "lower_is_better",
        absoluteTolerance: 0,
        rationale: "ms",
      },
    },
    ...overrides,
  };
}

const BASE_METRICS = bench().metrics;

describe("compare.ts — silent paths", () => {
  it.fails(
    "does not let a LISTED (informational) metric vanish from the candidate silently",
    () => {
      const { target_events: _dropped, ...rest } = BASE_METRICS;
      const report = compareSummaries(summary(), summary({}, [bench({ metrics: rest })]), config());
      const entry = report.metrics.find(
        (metric) => metric.metric === "contact_replay.target_events",
      );
      expect(entry?.status).toBe("missing_in_candidate");
      // docs/EVALUATION.md §1.3 table: "missing_in_candidate … fails: yes if
      // listed". Observed on 4d812e1a: failing=false AND no warning line — the
      // only trace is counts.missing_in_candidate=1 (compare.ts:111,325-331).
      expect(
        report.exitCode === 1 || report.warnings.some((w) => w.includes("target_events")),
      ).toBe(true);
    },
  );

  it.fails("surfaces a bench label change (bench version / gate verdict / spec sha)", () => {
    const baseline = summary({}, [
      bench({ id: "coach_gates", labels: { overallVerdict: "RELEASE_BLOCKED", specSha256: "a" } }),
    ]);
    const candidate = summary({}, [
      bench({ id: "coach_gates", labels: { overallVerdict: "RELEASE_OK", specSha256: "b" } }),
    ]);
    const report = compareSummaries(
      baseline,
      candidate,
      config({ unlistedMetricPolicy: "informational" }),
    );
    // Labels are declared "non-numeric facts worth carrying (bench versions,
    // gate verdicts)" (summarySchema.ts:80) yet compare.ts never reads them:
    // identical report, exit 0, no warning, no identity difference.
    expect(
      report.identityDifferences.length > 0 || report.warnings.some((w) => w.includes("label")),
    ).toBe(true);
  });

  it.fails(
    "fail-closes a brand-new unclassified metric as docs/EVALUATION.md §1.3 promises",
    () => {
      // "unlistedMetricPolicy ('fail' — a new metric must be classified before
      // it can pass)". Observed on 4d812e1a (and pinned as designed by
      // regressionCompare.test.ts:270-276): first appearance is
      // missing_in_baseline → never fails; only once it is ALSO in the baseline
      // does `unlisted` fire. The gate has a one-baseline-cycle hole.
      const report = compareSummaries(
        summary(),
        summary({}, [bench({ metrics: { ...BASE_METRICS, brand_new: 1 } })]),
        config(),
      );
      expect(report.exitCode).toBe(1);
    },
  );

  it("flags float noise at absoluteTolerance 0 (the committed config is all zeros)", () => {
    const report = compareSummaries(
      summary({}, [bench({ metrics: { ...BASE_METRICS, median_error_ms: 0.3 } })]),
      summary({}, [bench({ metrics: { ...BASE_METRICS, median_error_ms: 0.1 + 0.2 } })]),
      config(),
    );
    const entry = report.metrics.find(
      (metric) => metric.metric === "contact_replay.median_error_ms",
    );
    expect(entry?.status).toBe("regressed");
    expect(report.exitCode).toBe(1);
  });

  it("treats a cross-machine compare (node/platform/arch differ) as a CONFOUND, exit 0", () => {
    const report = compareSummaries(
      summary(),
      summary({ runner: { node: "v20.19.0", platform: "darwin", arch: "arm64" } }),
      config(),
    );
    expect(report.exitCode).toBe(0);
    expect(report.warnings.filter((w) => w.startsWith("CONFOUND runner."))).toHaveLength(3);
  });
});

describe("regression.summary.schema.json ⇄ validateRegressionSummary parity", () => {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as {
    properties: { runId: { pattern: string }; generatedAtIso: { format: string } };
  };

  it.fails("agree on which runIds are valid", () => {
    const schemaPattern = new RegExp(schema.properties.runId.pattern);
    for (const runId of ["../escape", "a b", "a/b", " ", "ok-run"]) {
      const runtimeAccepts = validateRegressionSummary(summary({ runId })).ok;
      // Observed on 4d812e1a: runtime accepts every non-empty string
      // (summarySchema.ts:439-441); the schema rejects "../escape", "a b",
      // "a/b" and " ". The two are documented as kept in lock-step.
      expect([runId, runtimeAccepts]).toEqual([runId, schemaPattern.test(runId)]);
    }
  });

  it.fails("agree that generatedAtIso must be an RFC 3339 date-time", () => {
    expect(schema.properties.generatedAtIso.format).toBe("date-time");
    for (const stamp of ["Sep 4 2026", "2026", "2026-09-04"]) {
      // Observed on 4d812e1a: Date.parse() accepts these, so the runtime
      // validator does too (summarySchema.ts:442-444) while the schema's
      // `format: date-time` would not.
      expect([stamp, validateRegressionSummary(summary({ generatedAtIso: stamp })).ok]).toEqual([
        stamp,
        false,
      ]);
    }
  });
});

describe("committed baseline + tolerances", () => {
  const baseline = loadSummary(BASELINE_PATH);
  const tolerances = loadTolerances(join(REPO_ROOT, DEFAULT_TOLERANCES_PATH));

  it("baseline validates, has 9 ok benches and 200 metrics", () => {
    expect(baseline.benches).toHaveLength(9);
    expect(baseline.benches.every((entry) => entry.status === "ok")).toBe(true);
    expect(Object.keys(baseline.metrics)).toHaveLength(200);
  });

  it("tolerance keys are exactly the baseline metric keys (no dead or uncovered entries)", () => {
    expect(Object.keys(tolerances.metrics).sort()).toEqual(Object.keys(baseline.metrics).sort());
  });

  it("every baseline metric key matches the schema's flattened-key pattern", () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as {
      properties: { metrics: { propertyNames: { pattern: string } } };
    };
    const pattern = new RegExp(schema.properties.metrics.propertyNames.pattern);
    expect(Object.keys(baseline.metrics).filter((key) => !pattern.test(key))).toEqual([]);
  });

  it("baseline datasetsTreeSha equals the dataset identity of this checkout", () => {
    expect(datasetsInputTreeSha()).toBe(baseline.provenance.datasetsTreeSha);
  });

  it("baseline compared with itself is clean and comparable", () => {
    const report = compareSummaries(baseline, baseline, tolerances);
    expect(report.exitCode).toBe(0);
    expect(report.regressions).toEqual([]);
    expect(report.counts.unchanged + report.counts.informational).toBe(200);
  });

  it("guarded and informational counts are the documented 104 / 96", () => {
    const directions = Object.values(tolerances.metrics).map((entry) => entry.direction);
    expect(directions.filter((direction) => direction === "informational")).toHaveLength(96);
    expect(directions.filter((direction) => direction !== "informational")).toHaveLength(104);
    expect(Object.values(tolerances.metrics).every((entry) => entry.absoluteTolerance === 0)).toBe(
      true,
    );
  });
});
