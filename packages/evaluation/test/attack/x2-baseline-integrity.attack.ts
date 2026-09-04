/**
 * EXTRA ATTACK X2 — committed baseline integrity and gold-corpus coverage.
 *
 * No labels are fabricated here. The baseline is checked against (a) the
 * summary schema, (b) the tolerance config (every metric listed or covered by
 * the unlisted policy), (c) the datasets/ input tree and release manifests
 * at the checked-out commit, and (d) the coverage figures that
 * docs/EVALUATION.md states as fact. Coverage counts are written to evidence
 * as a report of what the corpus currently measures.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareSummaries } from "../../src/regression/compare.js";
import { collectDatasetReleases, datasetsInputTreeSha } from "../../src/regression/run.js";
import {
  flattenBenchMetrics,
  validateRegressionSummary,
  type RegressionSummary,
} from "../../src/regression/summarySchema.js";
import { validateToleranceConfig, type ToleranceConfig } from "../../src/regression/tolerances.js";
import { BASELINE_PATH, git, REPO_ROOT, TOLERANCES_PATH, writeEvidence } from "./attackUtil.js";

function loadBaseline(): RegressionSummary {
  const validated = validateRegressionSummary(JSON.parse(readFileSync(BASELINE_PATH, "utf8")));
  if (!validated.ok) throw new Error(validated.failure.message);
  return validated.value;
}

function loadTolerances(): ToleranceConfig {
  const validated = validateToleranceConfig(JSON.parse(readFileSync(TOLERANCES_PATH, "utf8")));
  if (!validated.ok) throw new Error(validated.failure.message);
  return validated.value;
}

describe("X2: committed baseline integrity", () => {
  const baseline = loadBaseline();
  const config = loadTolerances();

  it("baseline validates, all 9 benches ok, flat metrics equal the flattened bench view, 200 metrics", () => {
    expect(baseline.benches).toHaveLength(9);
    expect(baseline.benches.every((bench) => bench.status === "ok")).toBe(true);
    expect(baseline.metrics).toEqual(flattenBenchMetrics(baseline.benches));
    expect(Object.keys(baseline.metrics)).toHaveLength(200);
    expect(baseline.caveats.some((c) => c.startsWith("Partial run"))).toBe(false);
    expect(baseline.provenance.gitDirty).toBe(false);
  });

  it("every baseline metric is explicitly listed in the tolerance config (nothing rides on the unlisted policy)", () => {
    const unlisted = Object.keys(baseline.metrics).filter((metric) => !(metric in config.metrics));
    const stale = Object.keys(config.metrics).filter((metric) => !(metric in baseline.metrics));
    writeEvidence("x2-tolerance-coverage", {
      unlistedMetricPolicy: config.unlistedMetricPolicy,
      unlistedInConfig: unlisted,
      configEntriesNotInBaseline: stale,
    });
    expect(unlisted).toEqual([]);
    expect(stale).toEqual([]);
  });

  it("baseline provenance matches the checked-out datasets tree and release manifests (no confound against itself)", () => {
    expect(baseline.provenance.datasetsTreeSha).toBe(datasetsInputTreeSha(REPO_ROOT));
    const releases = collectDatasetReleases(REPO_ROOT).map(
      (release) => `${release.releaseDir}:${release.releaseId}:${release.manifestSha256}`,
    );
    expect(
      baseline.provenance.datasetReleases
        .map((release) => `${release.releaseDir}:${release.releaseId}:${release.manifestSha256}`)
        .sort(),
    ).toEqual(releases.sort());
    // The baseline's gitSha is a real commit reachable in this clone.
    expect(git(["cat-file", "-t", baseline.provenance.gitSha])).toBe("commit");
    const self = compareSummaries(baseline, baseline, config);
    expect(self.exitCode).toBe(0);
    expect(self.identityDifferences.filter((d) => d.severity !== "expected")).toEqual([]);
  });

  it("gold-corpus coverage figures in the baseline agree with docs/EVALUATION.md (and are recorded)", () => {
    const docs = readFileSync(join(REPO_ROOT, "docs/EVALUATION.md"), "utf8");
    const metric = (id: string, name: string): number | null => {
      const bench = baseline.benches.find((b) => b.id === id);
      if (!bench) throw new Error(`bench ${id} missing`);
      const value = bench.metrics[name];
      if (value === undefined) throw new Error(`${id}.${name} missing`);
      return value;
    };
    const coverage = {
      "contact_replay.gold_events": metric("contact_replay", "gold_events"),
      "contact_replay.target_events": metric("contact_replay", "target_events"),
      "event_recall.gold_target_events": metric("event_recall", "gold_target_events"),
      "event_bounds_e13.non_events": metric("event_bounds_e13", "non_events"),
      "stroke_heuristic.gold_labels_total": metric("stroke_heuristic", "gold_labels_total"),
      "phase_gold_d3_05.anchored_total": metric("phase_gold_d3_05", "anchored_total"),
      "coach_gates.gates_total": metric("coach_gates", "gates_total"),
      "coach_gates.gates_pass": metric("coach_gates", "gates_pass"),
      "coach_gates.gates_fail": metric("coach_gates", "gates_fail"),
      "coach_gates.gates_not_evaluable": metric("coach_gates", "gates_not_evaluable"),
      "coach_gates.active_coaches": metric("coach_gates", "active_coaches"),
      "coach_gates.review_files": metric("coach_gates", "review_files"),
      coachVerdict: baseline.benches.find((b) => b.id === "coach_gates")?.labels.overallVerdict,
    };
    writeEvidence("x2-gold-coverage-report", {
      note: "Counts read from the committed baseline; small-n per docs. No labels created or altered.",
      coverage,
    });
    expect(docs).toContain("`event_recall` (16 gold events");
    expect(coverage["event_recall.gold_target_events"]).toBe(16);
    expect(docs).toContain(
      "`coach_gates`: 17 gates, 3 PASS / 0 FAIL / 14 NOT_EVALUABLE, `RELEASE_BLOCKED` with 0 active coaches",
    );
    expect(coverage["coach_gates.gates_total"]).toBe(17);
    expect(coverage["coach_gates.gates_pass"]).toBe(3);
    expect(coverage["coach_gates.gates_fail"]).toBe(0);
    expect(coverage["coach_gates.gates_not_evaluable"]).toBe(14);
    expect(coverage["coach_gates.active_coaches"]).toBe(0);
    expect(coverage.coachVerdict).toBe("RELEASE_BLOCKED");
  });
});
