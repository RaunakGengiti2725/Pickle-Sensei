/**
 * ATTACK S5 — run only `contact_replay` and compare against the committed
 * baseline. A partial run must NOT be able to pass the gate: the eight
 * benches that did not run must surface as failing `missing_in_candidate`
 * bench comparisons and the CLI must exit 1.
 *
 * Extra probes:
 *   - the same with `--json` (machine consumers see the same verdict);
 *   - a partial run that is ALSO regressed on its one bench still exits 1;
 *   - swapping baseline/candidate (partial as baseline) must not exit 0
 *     silently either (new_in_candidate is non-failing by design — recorded).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { RegressionSummary } from "../../src/index.js";
import { BASELINE_PATH, makeTempDir, runCli, writeEvidence } from "./attackUtil.js";

interface JsonReport {
  exitCode: number;
  comparable: boolean;
  benches: Array<{ benchId: string; status: string; failing: boolean }>;
  metrics: Array<{ metric: string; status: string; failing: boolean }>;
  counts: Record<string, number>;
  warnings: string[];
  regressions: unknown[];
}

describe("S5: --only contact_replay compared against the full baseline", () => {
  let outDir = "";
  let candidatePath = "";
  let runExit: number | null = null;
  let runStdout = "";

  beforeAll(() => {
    outDir = makeTempDir("attack-s5");
    const run = runCli([
      "run",
      "--out-dir",
      outDir,
      "--run-id",
      "partial",
      "--only",
      "contact_replay",
    ]);
    runExit = run.exitCode;
    runStdout = run.stdout;
    candidatePath = join(outDir, "partial.json");
  });

  it("the partial run itself succeeds (exit 0) and self-declares the partial caveat", () => {
    expect(runExit).toBe(0);
    const candidate = JSON.parse(readFileSync(candidatePath, "utf8")) as RegressionSummary;
    expect(candidate.benches.map((b) => b.id)).toEqual(["contact_replay"]);
    expect(candidate.caveats.some((c) => c.startsWith("Partial run: only contact_replay"))).toBe(
      true,
    );
  });

  it("compare exits 1 with exactly 8 failing missing_in_candidate bench rows", () => {
    const human = runCli(["compare", BASELINE_PATH, candidatePath]);
    const json = runCli(["compare", BASELINE_PATH, candidatePath, "--json"]);
    const report = JSON.parse(json.stdout) as JsonReport;
    const missing = report.benches.filter((b) => b.status === "missing_in_candidate");
    expect(json.exitCode).toBe(1);
    expect(human.exitCode).toBe(1);
    expect(report.exitCode).toBe(1);
    expect(missing).toHaveLength(8);
    expect(missing.every((b) => b.failing)).toBe(true);
    expect(missing.map((b) => b.benchId).sort()).toEqual(
      [
        "ball_hard_slice",
        "coach_gates",
        "completion_bench",
        "event_bounds_e13",
        "event_recall",
        "ownership_dual_frame",
        "phase_gold_d3_05",
        "stroke_heuristic",
      ].sort(),
    );
    // Metrics of the missing benches are reported once at bench level, not double counted.
    const missingMetricsFailing = report.metrics.filter(
      (m) => m.status === "missing_in_candidate" && m.failing,
    );
    expect(missingMetricsFailing).toHaveLength(0);
    expect(human.stdout).toMatch(/RESULT: .*exit 1/);
    writeEvidence("s5-partial-run-gate", {
      scenario: "S5",
      classification: "HELD",
      runExit,
      runStdout,
      compareExit: json.exitCode,
      missingBenches: missing,
      counts: report.counts,
      warnings: report.warnings,
      humanReport: human.stdout,
    });
  });

  it("a partial run that also regresses its one bench still exits 1 (never masks the regression)", () => {
    const candidate = JSON.parse(readFileSync(candidatePath, "utf8")) as RegressionSummary;
    const bench = candidate.benches[0]!;
    const estimated = bench.metrics.estimated;
    if (typeof estimated !== "number") throw new Error("fixture: estimated not numeric");
    bench.metrics.estimated = estimated - 1;
    candidate.metrics["contact_replay.estimated"] = estimated - 1;
    const path = join(outDir, "partial-regressed.json");
    writeFileSync(path, JSON.stringify(candidate));
    const json = runCli(["compare", BASELINE_PATH, path, "--json"]);
    const report = JSON.parse(json.stdout) as JsonReport;
    expect(json.exitCode).toBe(1);
    expect(report.regressions.length).toBeGreaterThanOrEqual(1);
  });

  it("reversed roles: partial summary as BASELINE → new_in_candidate is non-failing (exit 0) — recorded, by design", () => {
    const json = runCli(["compare", candidatePath, BASELINE_PATH, "--json"]);
    const report = JSON.parse(json.stdout) as JsonReport;
    const fresh = report.benches.filter((b) => b.status === "new_in_candidate");
    expect(fresh).toHaveLength(8);
    writeEvidence("s5-reversed-roles", {
      scenario: "S5 (reversed)",
      note: "A partial baseline lets a full candidate pass with 8 new_in_candidate rows; the committed baseline is full, so this only matters if someone commits a partial baseline.",
      exitCode: json.exitCode,
      counts: report.counts,
      benches: report.benches,
    });
    expect(json.exitCode).toBe(0);
  });
});
