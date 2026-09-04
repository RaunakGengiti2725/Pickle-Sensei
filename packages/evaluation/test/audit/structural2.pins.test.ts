/**
 * STRUCTURAL AUDIT #2 — invariants that were suspected weak but HOLD at
 * 4d812e1a. Kept as executable evidence (`verified_ok`); a failure here would
 * be a regression of behaviour that was not previously pinned by a test.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REPO_ROOT, benchDefinitions } from "../../src/regression/benches.js";
import { executeBench, runSubprocess } from "../../src/regression/run.js";
import { loadSummary, loadTolerances } from "../../src/regression/cli.js";
import { compareSummaries } from "../../src/index.js";
import { bench, summary } from "../regressionFixtures.js";

const scratch = mkdtempSync(join(tmpdir(), "pickle-audit-pins-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const BASELINE = join(REPO_ROOT, "datasets/reports/regression/baseline.json");
const TOLERANCES = join(REPO_ROOT, "packages/evaluation/regression.tolerances.json");

describe("committed baseline + tolerances", () => {
  it("baseline validates, is clean, detached, and lists every tolerance key exactly once", () => {
    const baseline = loadSummary(BASELINE);
    const config = loadTolerances(TOLERANCES);
    expect(baseline.provenance.gitDirty).toBe(false);
    expect(baseline.provenance.gitBranch).toBeNull();
    expect(baseline.benches.map((b) => b.status)).toEqual(Array(9).fill("ok"));
    expect(Object.keys(config.metrics).sort()).toEqual(Object.keys(baseline.metrics).sort());
    // 200 metrics, none null in the accepted baseline.
    expect(Object.values(baseline.metrics).filter((v) => v === null)).toEqual([]);
  });

  it("baseline gitSha is an ancestor of the audited commit and its datasetsTreeSha matches HEAD", () => {
    const baseline = loadSummary(BASELINE);
    const ancestor = spawnSync(
      "git",
      ["merge-base", "--is-ancestor", baseline.provenance.gitSha, "HEAD"],
      { cwd: REPO_ROOT },
    );
    expect(ancestor.status).toBe(0);
    const lsTree = spawnSync("git", ["ls-tree", "-r", "HEAD:datasets"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(lsTree.status).toBe(0);
    // git() in run.ts spawns with Node's default 1 MiB maxBuffer; record the headroom.
    expect(lsTree.stdout.length).toBeLessThan(1024 * 1024);
  });

  it("every bench id is dot-free so the compare's `${benchId}.` prefix lookup is unambiguous", () => {
    const baseline = loadSummary(BASELINE);
    const ids = baseline.benches.map((b) => b.id);
    for (const id of ids) {
      expect(id).not.toContain(".");
      expect(ids.filter((other) => other.startsWith(`${id}`))).toEqual([id]);
    }
  });
});

describe("compare fail-closed paths", () => {
  it("a --only candidate against the full baseline fails (missing_in_candidate at bench level)", () => {
    const baseline = loadSummary(BASELINE);
    const config = loadTolerances(TOLERANCES);
    const partial = {
      ...baseline,
      benches: baseline.benches.filter((b) => b.id === "contact_replay"),
      metrics: Object.fromEntries(
        Object.entries(baseline.metrics).filter(([k]) => k.startsWith("contact_replay.")),
      ),
    };
    const report = compareSummaries(baseline, partial, config);
    expect(report.exitCode).toBe(1);
    expect(report.benches.filter((b) => b.status === "missing_in_candidate")).toHaveLength(8);
    // metrics of the vanished benches are not double counted
    expect(report.metrics.filter((m) => m.failing)).toEqual([]);
  });

  it("contractVersion mismatch is the one reachable non-comparable path (validator pins the others)", () => {
    const report = compareSummaries(
      summary(),
      summary({ contractVersion: 2 }),
      loadTolerances(TOLERANCES),
    );
    expect(report.comparable).toBe(false);
    expect(report.exitCode).toBe(3);
  });

  it("a candidate bench that failed fails the compare even when it also failed in the baseline", () => {
    const failed = bench({ status: "failed", error: "x", metrics: {} });
    const report = compareSummaries(
      summary({}, [failed]),
      summary({}, [failed]),
      loadTolerances(TOLERANCES),
    );
    expect(report.exitCode).toBe(1);
    expect(report.benches[0]!.status).toBe("failed_in_both");
  });
});

describe("subprocess failure modes fail closed", () => {
  it("SIGKILL of the wrapped script surfaces as a non-zero exit (137 via tsx), never as ok", () => {
    const script = join(scratch, "sigkill.ts");
    writeFileSync(script, 'process.kill(process.pid, "SIGKILL");\n');
    const result = runSubprocess({ script, args: [], cwd: scratch });
    expect(result.exitCode).not.toBe(0);
  }, 20_000);

  it("stdout beyond the 64 MiB maxBuffer becomes a failed bench with exitCode -1", () => {
    const script = join(scratch, "flood.ts");
    writeFileSync(
      script,
      [
        'const chunk = "x".repeat(1024 * 1024);',
        "for (let i = 0; i < 70; i += 1) process.stdout.write(chunk);",
        "",
      ].join("\n"),
    );
    let lastExit: number | null = null;
    const tracked = (spec: Parameters<typeof runSubprocess>[0]) => {
      const result = runSubprocess(spec);
      lastExit = result.exitCode;
      return result;
    };
    const def = benchDefinitions(tracked, scratch).find((d) => d.id === "phase_gold_d3_05")!;
    const record = executeBench(
      {
        ...def,
        run: () => {
          tracked({ script, args: [], cwd: scratch });
          return { metrics: {}, labels: {} };
        },
      },
      () => lastExit,
    );
    expect(record.status).toBe("failed");
    expect(record.exitCode).toBe(-1);
    expect(record.error).toMatch(/ENOBUFS/);
  }, 60_000);

  it("phase_gold_d3_05 fails closed when a line follows the JSON summary (benches.ts:603-605)", () => {
    const stdout = 'row a\n{"anchored":"1/2","anchorFree":"3/4"}\nwarning: trailing\n';
    const fake = () => ({ exitCode: 0, stdout, stderr: "" });
    const def = benchDefinitions(fake, scratch).find((d) => d.id === "phase_gold_d3_05")!;
    const record = executeBench(def, () => 0);
    expect(record.status).toBe("failed");
    expect(record.metrics).toEqual({});
  });

  it("phase_gold_d3_05 parses the real script's final line shape", () => {
    const stdout = 'row a\nrow b\n{"anchored":"13/18","anchorFree":"9/18"}\n';
    const def = benchDefinitions(() => ({ exitCode: 0, stdout, stderr: "" }), scratch).find(
      (d) => d.id === "phase_gold_d3_05",
    )!;
    const record = executeBench(def, () => 0);
    expect(record.status).toBe("ok");
    expect(record.metrics).toEqual({
      anchored_segmented: 13,
      anchored_total: 18,
      anchor_free_segmented: 9,
      anchor_free_total: 18,
    });
  });
});

describe("docs ↔ code", () => {
  it("event_recall.inputs names the file eventRecallBench.ts actually writes", () => {
    const source = readFileSync(
      join(REPO_ROOT, "packages/swing-lab/src/eventRecallBench.ts"),
      "utf8",
    );
    const written = /`(event-recall[^`$]*)\$\{Date\.now\(\)\}\.json`/.exec(source)?.[1];
    expect(written).toBe("event-recall-");
    const def = benchDefinitions(() => ({ exitCode: 0, stdout: "", stderr: "" }), scratch).find(
      (d) => d.id === "event_recall",
    )!;
    expect(def.inputs.find((line) => line.includes("<ts>.json"))).toContain(`${written}<ts>.json`);
  });
});
