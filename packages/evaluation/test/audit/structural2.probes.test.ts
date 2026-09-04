/**
 * STRUCTURAL AUDIT #2 — adversarial probes for the regression runner/compare.
 *
 * Each `it` states an expectation the audited code is SUSPECTED to violate at
 * 4d812e1a. A FAILING case here is a finding; a passing case means the
 * suspicion did not reproduce. Nothing in `src/` or the existing tests is
 * touched. Every probe that writes into a tracked `datasets/` directory
 * removes what it created in `finally`.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REPO_ROOT, benchDefinitions, type SubprocessSpec } from "../../src/regression/benches.js";
import { executeBench, runSubprocess, untrackedDatasetInputs } from "../../src/regression/run.js";
import {
  REGRESSION_CONTRACT_ID,
  REGRESSION_CONTRACT_VERSION,
  TOLERANCE_CONFIG_VERSION,
  compareSummaries,
  flattenBenchMetrics,
  type ToleranceConfig,
} from "../../src/index.js";
import { bench, summary } from "../regressionFixtures.js";

const scratch = mkdtempSync(join(tmpdir(), "pickle-audit-probes-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const ok = (stdout = ""): { exitCode: number; stdout: string; stderr: string } => ({
  exitCode: 0,
  stdout,
  stderr: "",
});

function config(
  metrics: ToleranceConfig["metrics"],
  overrides: Partial<ToleranceConfig> = {},
): ToleranceConfig {
  return {
    configVersion: TOLERANCE_CONFIG_VERSION,
    contract: REGRESSION_CONTRACT_ID,
    contractVersion: REGRESSION_CONTRACT_VERSION,
    unlistedMetricPolicy: "fail",
    lostMeasurementIsRegression: true,
    metrics,
    ...overrides,
  };
}

describe("runCapturingNewFile leaves stray files in tracked dataset dirs (benches.ts:264-278)", () => {
  const outDir = join(REPO_ROOT, "datasets/experiments/wave-e");
  const marker = `event-recall-audit-${process.pid}`;
  const strays = (): string[] => readdirSync(outDir).filter((name) => name.startsWith(marker));
  const cleanup = (): void => {
    for (const name of strays()) unlinkSync(join(outDir, name));
  };

  it("removes the captured file even when its JSON is unparsable (unlink only runs after a successful parse)", () => {
    const dirtyBefore = untrackedDatasetInputs();
    const fake = (_spec: SubprocessSpec) => {
      writeFileSync(join(outDir, `${marker}-a.json`), "{ not json");
      return ok();
    };
    try {
      const def = benchDefinitions(fake, scratch).find((d) => d.id === "event_recall")!;
      const record = executeBench(def, () => 0);
      expect(record.status).toBe("failed");
      expect(record.error).toMatch(/JSON/);
      // The stray is now an untracked bench INPUT: the next run reports gitDirty=true.
      expect(untrackedDatasetInputs()).toEqual(dirtyBefore);
      expect(strays()).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("does not strand both outputs when two files appear at once (two concurrent runs)", () => {
    const fake = (_spec: SubprocessSpec) => {
      writeFileSync(join(outDir, `${marker}-b.json`), JSON.stringify({ summary: {} }));
      writeFileSync(join(outDir, `${marker}-c.json`), JSON.stringify({ summary: {} }));
      return ok();
    };
    try {
      const def = benchDefinitions(fake, scratch).find((d) => d.id === "event_recall")!;
      const record = executeBench(def, () => 0);
      expect(record.status).toBe("failed");
      expect(record.error).toMatch(/expected exactly one new file/);
      expect(strays()).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("does not strand the output when the script wrote its file but exited non-zero", () => {
    const fake = (_spec: SubprocessSpec) => {
      writeFileSync(join(outDir, `${marker}-d.json`), JSON.stringify({ summary: {} }));
      return { exitCode: 1, stdout: "", stderr: "boom" };
    };
    try {
      const def = benchDefinitions(fake, scratch).find((d) => d.id === "event_recall")!;
      const record = executeBench(def, () => 1);
      expect(record.status).toBe("failed");
      expect(strays()).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("compare fails open on a partial baseline (compare.ts:257-283, run.ts:307-311)", () => {
  it("refuses a baseline the runner itself labelled 'Partial run … not comparable to a full baseline'", () => {
    const full = [bench(), bench({ id: "coach_gates", metrics: { gates_pass: 3 }, labels: {} })];
    const partial = [bench()];
    const baseline = summary(
      {
        caveats: ["Partial run: only contact_replay executed; not comparable to a full baseline."],
      },
      partial,
    );
    const candidate = summary({}, full);
    const report = compareSummaries(
      baseline,
      candidate,
      config({
        "contact_replay.target_events": {
          direction: "informational",
          absoluteTolerance: 0,
          rationale: "n",
        },
        "contact_replay.estimated": {
          direction: "higher_is_better",
          absoluteTolerance: 0,
          rationale: "r",
        },
        "contact_replay.median_error_ms": {
          direction: "lower_is_better",
          absoluteTolerance: 0,
          rationale: "r",
        },
        "contact_replay.p90_error_ms": {
          direction: "lower_is_better",
          absoluteTolerance: 0,
          rationale: "r",
        },
        "coach_gates.gates_pass": {
          direction: "higher_is_better",
          absoluteTolerance: 0,
          rationale: "r",
        },
      }),
    );
    // 1 of 2 benches is unjudged, yet the compare is clean.
    expect(report.benches.map((b) => b.status)).toContain("new_in_candidate");
    expect(report.exitCode).not.toBe(0);
  });
});

describe("unlistedMetricPolicy=fail does not gate NEW metrics (compare.ts:110 precedes :120)", () => {
  it("fails a candidate metric that is neither in the baseline nor in the tolerance file (docs/EVALUATION.md:127)", () => {
    const baseline = summary();
    const candidate = summary({}, [
      bench({ metrics: { ...bench().metrics, brand_new_rate: 0.5 } }),
    ]);
    candidate.metrics = flattenBenchMetrics(candidate.benches);
    const report = compareSummaries(
      baseline,
      candidate,
      config({
        "contact_replay.target_events": {
          direction: "informational",
          absoluteTolerance: 0,
          rationale: "n",
        },
        "contact_replay.estimated": {
          direction: "higher_is_better",
          absoluteTolerance: 0,
          rationale: "r",
        },
        "contact_replay.median_error_ms": {
          direction: "lower_is_better",
          absoluteTolerance: 0,
          rationale: "r",
        },
        "contact_replay.p90_error_ms": {
          direction: "lower_is_better",
          absoluteTolerance: 0,
          rationale: "r",
        },
      }),
    );
    const fresh = report.metrics.find((m) => m.metric === "contact_replay.brand_new_rate")!;
    expect(fresh.tolerance).toBeNull();
    // "a new metric must be classified before it can pass" (docs/EVALUATION.md:127)
    expect(fresh.status).toBe("unlisted");
    expect(report.exitCode).toBe(1);
  });
});

describe("runSubprocess has no timeout (run.ts:156-162)", () => {
  it("bounds a stuck child instead of blocking the whole run", () => {
    const script = join(scratch, "hang.ts");
    // Keeps the event loop alive for 4s; a runner timeout would cut it short.
    writeFileSync(script, "setTimeout(() => {}, 4000);\n");
    const started = Date.now();
    const result = runSubprocess({ script, args: [], cwd: scratch });
    expect(result.exitCode).toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
  }, 20_000);
});

describe("bench metadata contradicts the wrapped script (benches.ts:469)", () => {
  it("completion_bench.inputs names the file the script actually writes", () => {
    const source = readFileSync(
      join(REPO_ROOT, "packages/swing-lab/src/eventCompletionBench.ts"),
      "utf8",
    );
    const written = /`(completion[^`$]*)\$\{Date\.now\(\)\}\.json`/.exec(source)?.[1];
    expect(written).toBe("completion-");
    const def = benchDefinitions(() => ok(), scratch).find((d) => d.id === "completion_bench")!;
    const claim = def.inputs.find((line) => line.includes("<ts>.json"))!;
    expect(claim).toContain(`${written}<ts>.json`);
  });
});
