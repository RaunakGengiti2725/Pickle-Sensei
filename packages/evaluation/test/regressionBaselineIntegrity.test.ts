/**
 * Integrity pins for the committed Linux regression reference
 * (`datasets/reports/regression/baseline.json`) and its tolerance config.
 *
 * These tests read the committed documents and the current checkout; they never write
 * under `datasets/` or `packages/evaluation`. If one fails, the fix is to regenerate the
 * baseline from a clean checkout (see datasets/reports/regression/README.md) or to
 * correct the tolerance entry — never to relax the assertion.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, collectModelVersions } from "../src/regression/benches.js";
import { collectDatasetReleases, datasetsInputTreeSha } from "../src/regression/run.js";
import {
  REGRESSION_CONTRACT_ID,
  REGRESSION_CONTRACT_VERSION,
  REGRESSION_SUMMARY_SCHEMA_VERSION,
  compareSummaries,
  flattenBenchMetrics,
} from "../src/index.js";
import {
  buildScenarios,
  loadCommittedBaseline,
  loadCommittedTolerances,
  minimalUnit,
  runScenario,
} from "./harness/baselineIntegrityHarness.js";

const README_PATH = join(REPO_ROOT, "datasets/reports/regression/README.md");
const BENCH_IDS = [
  "stroke_heuristic",
  "contact_replay",
  "event_bounds_e13",
  "event_recall",
  "completion_bench",
  "ownership_dual_frame",
  "ball_hard_slice",
  "phase_gold_d3_05",
  "coach_gates",
] as const;

const baseline = loadCommittedBaseline();
const config = loadCommittedTolerances();

/** Metric-name fragments that denote a quality signal a code change can move. */
const QUALITY_NAME =
  /(^|[._])(hits|misses|wrong[a-z_]*|correct|accuracy[a-z_]*|recall|violations|estimated|strict_hits|acceptable_hits|median[a-z_]*_ms|p\d+_error_ms|mis_bounded|missed|proposed_ok|contact_inside(_rate)?|false_[a-z_]+|unmatched_proposals|low_amplitude_proposals|early_stops|[a-z_]+_lost|mean_trailing_excess_ms|mean_best_overlap[a-z_]*|[a-z_]+_segmented|gates_pass|gates_fail|invalid_review_files|confidently_wrong|wrong_marker_rate[a-z_]*)$/;

/**
 * Informational entries whose name carries a quality word but which the bench itself
 * defines as a reference / context row rather than the candidate under test. Every
 * exemption here has a matching `rationale` in regression.tolerances.json.
 */
const INFORMATIONAL_EXEMPTIONS = [
  /^completion_bench\.fixed\./, // shipped constant post-roll policy = reference row
  /^ball_hard_slice\.bucket\.uncertain_excluded\./, // excluded from slice quality by the bench
  /^event_bounds_e13\.other_(proposed_ok|missed)$/, // other-owner rows replay the TARGET wrist
];

describe("committed baseline.json provenance", () => {
  it("validates against the summary contract and carries the documented identity", () => {
    expect(baseline.schemaVersion).toBe(REGRESSION_SUMMARY_SCHEMA_VERSION);
    expect(baseline.contract).toBe(REGRESSION_CONTRACT_ID);
    expect(baseline.contractVersion).toBe(REGRESSION_CONTRACT_VERSION);
    expect(baseline.runId).toBe("baseline");
    expect(baseline.provenance.evidenceClass).toBe("linux_replay_proxy");
    expect(baseline.provenance.gitDirty).toBe(false);
    expect(baseline.provenance.gitBranch).toBeNull();
    expect(baseline.provenance.gitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(baseline.provenance.datasetsTreeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(baseline.runner.platform).toBe("linux");
  });

  it("was measured at the commit the README documents", () => {
    const readme = readFileSync(README_PATH, "utf8");
    expect(readme).toContain(baseline.provenance.gitSha);
    expect(readme).toContain("`provenance.gitDirty: false`");
  });

  it("is verbatim runner output: metrics equal the flattened bench view", () => {
    expect(baseline.metrics).toEqual(flattenBenchMetrics(baseline.benches));
    expect(baseline.totalWallClockMs).toBeGreaterThanOrEqual(
      baseline.benches.reduce((total, bench) => total + bench.wallClockMs, 0),
    );
  });

  it("ran all nine benches successfully in the canonical order", () => {
    expect(baseline.benches.map((bench) => bench.id)).toEqual([...BENCH_IDS]);
    for (const bench of baseline.benches) {
      expect(bench.status, bench.id).toBe("ok");
      expect(bench.error, bench.id).toBeNull();
      expect(Object.keys(bench.metrics).length, bench.id).toBeGreaterThan(0);
      if (bench.kind === "subprocess") expect(bench.exitCode, bench.id).toBe(0);
      else expect(bench.exitCode, bench.id).toBeNull();
    }
  });

  it("has no null metric (every baseline metric is measurable, so a lost measurement can fail)", () => {
    const nulls = Object.entries(baseline.metrics)
      .filter(([, value]) => value === null)
      .map(([key]) => key);
    expect(nulls).toEqual([]);
    expect(Object.keys(baseline.metrics)).toHaveLength(200);
  });

  it("matches the dataset inputs, release manifests and model versions of this checkout", () => {
    expect(baseline.provenance.datasetsTreeSha).toBe(datasetsInputTreeSha());
    expect(baseline.provenance.datasetReleases).toEqual(collectDatasetReleases());
    expect(baseline.provenance.modelVersions).toEqual(collectModelVersions());
    for (const release of baseline.provenance.datasetReleases) {
      expect(release.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("compares to itself with zero movement and exit 0", () => {
    const report = compareSummaries(baseline, baseline, config);
    expect(report.exitCode).toBe(0);
    expect(report.regressions).toEqual([]);
    expect(report.improvements).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.counts.unchanged + report.counts.informational).toBe(200);
  });
});

describe("regression.tolerances.json cannot be gamed", () => {
  it("covers exactly the baseline metric set", () => {
    expect(Object.keys(config.metrics).sort()).toEqual(Object.keys(baseline.metrics).sort());
  });

  it("fails unlisted metrics and lost measurements", () => {
    expect(config.unlistedMetricPolicy).toBe("fail");
    expect(config.lostMeasurementIsRegression).toBe(true);
    expect(config.contract).toBe(baseline.contract);
    expect(config.contractVersion).toBe(baseline.contractVersion);
  });

  it("gives every guarded metric a tolerance tighter than the smallest step the bench can emit", () => {
    const tooLoose: string[] = [];
    for (const [key, tolerance] of Object.entries(config.metrics)) {
      if (tolerance.direction === "informational") continue;
      const value = baseline.metrics[key];
      if (typeof value !== "number") continue;
      if (tolerance.absoluteTolerance >= minimalUnit(value)) {
        tooLoose.push(`${key} tol=${tolerance.absoluteTolerance} unit=${minimalUnit(value)}`);
      }
    }
    expect(tooLoose).toEqual([]);
  });

  it("never marks a quality metric informational without a documented exemption", () => {
    const leaks: string[] = [];
    for (const [key, tolerance] of Object.entries(config.metrics)) {
      if (tolerance.direction !== "informational") continue;
      if (!QUALITY_NAME.test(key)) continue;
      if (INFORMATIONAL_EXEMPTIONS.some((pattern) => pattern.test(key))) continue;
      leaks.push(key);
    }
    expect(leaks).toEqual([]);
  });

  it("guards abstention where abstaining IS the correct behaviour", () => {
    // OCCLUDED gold frames: emitting a ball is a violation, abstaining is the hit.
    expect(config.metrics["ball_hard_slice.bucket.occluded.abstained"]?.direction).toBe(
      "higher_is_better",
    );
    expect(config.metrics["ball_hard_slice.bucket.occluded.violations"]?.direction).toBe(
      "lower_is_better",
    );
    // Coverage/answer-rate metrics are informational only where a correctness metric
    // over the same denominator is guarded.
    expect(config.metrics["contact_replay.coverage"]?.direction).toBe("higher_is_better");
    expect(config.metrics["contact_replay.wrong_marker_rate_of_estimated"]?.direction).toBe(
      "lower_is_better",
    );
  });

  it("gives every entry a non-empty rationale", () => {
    for (const [key, tolerance] of Object.entries(config.metrics)) {
      expect(tolerance.rationale.trim().length, key).toBeGreaterThan(10);
    }
  });
});

describe("adversarial candidates derived from the committed baseline", () => {
  const prepared = buildScenarios(baseline, config);
  const results = prepared.map((entry) => runScenario(baseline, config, entry));
  const byKind = (kind: string) => results.filter((result) => result.kind === kind);

  it("builds four scenarios per guarded metric plus structural probes", () => {
    const guarded = Object.values(config.metrics).filter(
      (tolerance) => tolerance.direction !== "informational",
    ).length;
    expect(guarded).toBe(104);
    expect(byKind("bad_unit")).toHaveLength(guarded);
    expect(byKind("good_unit")).toHaveLength(guarded);
    expect(byKind("measurement_lost")).toHaveLength(guarded);
    expect(byKind("drop_metric")).toHaveLength(guarded);
    expect(byKind("bench_failed")).toHaveLength(BENCH_IDS.length);
    expect(byKind("bench_missing")).toHaveLength(BENCH_IDS.length);
  });

  it("flags a one-unit move in the bad direction of EVERY guarded metric (exit 1)", () => {
    const misses = byKind("bad_unit").filter((result) => !result.pass);
    expect(misses.map((result) => `${result.id} exit=${result.actualExit}`)).toEqual([]);
  });

  it("reports a one-unit move in the good direction as an improvement (exit 0)", () => {
    const misses = byKind("good_unit").filter((result) => !result.pass);
    expect(misses.map((result) => result.id)).toEqual([]);
  });

  it("fails when any guarded metric becomes null or disappears", () => {
    const misses = [...byKind("measurement_lost"), ...byKind("drop_metric")].filter(
      (result) => !result.pass,
    );
    expect(misses.map((result) => result.id)).toEqual([]);
  });

  it("fails when any bench crashes or is omitted", () => {
    const misses = [...byKind("bench_failed"), ...byKind("bench_missing")].filter(
      (result) => !result.pass,
    );
    expect(misses.map((result) => result.id)).toEqual([]);
  });

  it("rejects a hand-edited metrics table before comparing (exit 2)", () => {
    const [tamper] = byKind("flatten_tamper");
    expect(tamper?.actualExit).toBe(2);
  });

  it("refuses a different contract version (exit 3)", () => {
    const [mismatch] = byKind("contract_mismatch");
    expect(mismatch?.actualExit).toBe(3);
  });

  it("documents the unguarded surface: informational-only and provenance-only changes exit 0", () => {
    for (const kind of [
      "informational_shift",
      "new_metric",
      "dirty_confound",
      "dataset_confound",
      "identity_only",
    ]) {
      const [result] = byKind(kind);
      expect(result?.pass, kind).toBe(true);
      expect(result?.actualExit, kind).toBe(0);
    }
    const [dirty] = byKind("dirty_confound");
    expect(dirty?.warnings.some((line) => line.startsWith("CONFOUND provenance.gitDirty"))).toBe(
      true,
    );
  });

  it("passes every scenario in the matrix", () => {
    expect(results.filter((result) => !result.pass).map((result) => result.id)).toEqual([]);
    expect(results.length).toBeGreaterThanOrEqual(441);
  });
});
