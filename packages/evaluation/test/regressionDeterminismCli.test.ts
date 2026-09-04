import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type DeterminismReport } from "../src/regression/determinism.js";
import { collectResourceUsage } from "../src/regression/determinismChild.js";
import { main, runHarness, type RepeatResult } from "../src/regression/determinismCli.js";
import { type RegressionSummary } from "../src/index.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "det-cli-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

describe("collectResourceUsage", () => {
  it("reports positive RSS/heap figures in the documented units", () => {
    const usage = collectResourceUsage();
    expect(usage.maxRssKb).toBeGreaterThan(0);
    expect(usage.heapUsedBytes).toBeGreaterThan(0);
    expect(usage.heapTotalBytes).toBeGreaterThanOrEqual(usage.heapUsedBytes);
    expect(usage.rssBytes).toBeGreaterThan(usage.heapUsedBytes);
    expect(usage.userCpuMs).toBeGreaterThanOrEqual(0);
    expect(usage.systemCpuMs).toBeGreaterThanOrEqual(0);
    // maxRSS is kB while rss is bytes; they must be the same order of magnitude
    expect(usage.maxRssKb * 1024).toBeGreaterThanOrEqual(usage.rssBytes * 0.5);
  });
});

describe("determinism CLI: usage errors", () => {
  it("exits 2 on missing --out-dir, bad --mode, bad --repeats, and unknown commands", async () => {
    const stderr: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(await main(["run"])).toBe(2);
      expect(await main(["run", "--out-dir", tempDir(), "--mode", "weird"])).toBe(2);
      expect(await main(["run", "--out-dir", tempDir(), "--repeats", "0"])).toBe(2);
      expect(await main(["run", "--out-dir", tempDir(), "--repeats", "1"])).toBe(2);
      expect(
        await main(["run", "--out-dir", tempDir(), "--mode", "in-process", "--concurrency", "2"]),
      ).toBe(2);
      expect(await main(["analyze", "--out", join(tempDir(), "r.json"), "only-one.json"])).toBe(2);
      expect(await main(["bogus"])).toBe(2);
      expect(await main(["--not-a-flag"])).toBe(2);
    } finally {
      process.stderr.write = original;
    }
    expect(stderr.join("")).toContain("usage:");
  });

  it("refuses to overwrite an existing summary", async () => {
    const outDir = tempDir();
    const first = await runHarness({
      repeats: 2,
      outDir,
      only: ["coach_gates"],
      mode: "in-process",
      concurrency: 1,
      labelPrefix: "x",
      log: () => {},
    });
    expect(first.exitCode).toBe(0);
    await expect(
      runHarness({
        repeats: 2,
        outDir,
        only: ["coach_gates"],
        mode: "in-process",
        concurrency: 1,
        labelPrefix: "x",
        log: () => {},
      }),
    ).rejects.toThrow(/refusing to overwrite/);
  });
});

describe("determinism CLI: real runner on a cheap bench subset", () => {
  it("in-process mode runs coach_gates 3x, writes summaries + report, and is deterministic", async () => {
    const outDir = tempDir();
    const lines: string[] = [];
    const result = await runHarness({
      repeats: 3,
      outDir,
      only: ["coach_gates"],
      mode: "in-process",
      concurrency: 1,
      labelPrefix: "ip",
      log: (line) => lines.push(line),
    });
    expect(result.exitCode).toBe(0);
    expect(result.repeats.map((r: RepeatResult) => r.label)).toEqual(["ip1", "ip2", "ip3"]);
    for (const repeat of result.repeats) {
      expect(repeat.exitCode).toBe(0);
      expect(existsSync(repeat.summaryPath)).toBe(true);
      expect(repeat.logPath && existsSync(repeat.logPath)).toBe(true);
      expect(repeat.rusage?.maxRssKb).toBeGreaterThan(0);
      expect(repeat.leakedDatasetFiles).toEqual([]);
      const summary = readJson<RegressionSummary>(repeat.summaryPath);
      expect(summary.runId).toBe(repeat.label);
      expect(summary.benches.map((b) => b.id)).toEqual(["coach_gates"]);
    }
    const report = readJson<DeterminismReport>(join(outDir, "report.json"));
    expect(report).toEqual(result.report);
    expect(report.deterministic).toBe(true);
    expect(report.allBenchesOk).toBe(true);
    expect(report.nondeterministicMetrics).toEqual([]);
    expect(report.metricMatrix.length).toBeGreaterThan(0);
    expect(new Set(report.runs.map((r) => r.stableSha256)).size).toBe(1);
    expect(report.timing.benches.map((row) => row.name)).toEqual(["coach_gates"]);
    expect(report.timing.maxRssKb?.values).toHaveLength(3);
    expect(report.replay?.benchIds).toEqual(["coach_gates"]);
    expect(existsSync(join(outDir, "repeats.json"))).toBe(true);
    expect(readFileSync(join(outDir, "report.txt"), "utf8")).toContain("IDENTICAL across 3 runs");
    expect(lines.join("\n")).toContain("IDENTICAL across 3 runs");
  }, 60_000);

  it("subprocess mode runs the real bench:regression CLI path and captures rusage sidecars", async () => {
    const outDir = tempDir();
    const result = await runHarness({
      repeats: 2,
      outDir,
      only: ["coach_gates", "event_bounds_e13"],
      mode: "subprocess",
      concurrency: 1,
      labelPrefix: "sp",
      log: () => {},
    });
    expect(result.exitCode).toBe(0);
    for (const repeat of result.repeats) {
      expect(repeat.exitCode).toBe(0);
      expect(repeat.outerWallMs).toBeGreaterThan(0);
      expect(existsSync(join(outDir, repeat.label, `${repeat.label}.rusage.json`))).toBe(true);
      expect(repeat.rusage?.maxRssKb).toBeGreaterThan(0);
      const log = readFileSync(repeat.logPath ?? "", "utf8");
      expect(log).toContain("coach_gates");
      expect(log).toContain("event_bounds_e13");
    }
    expect(result.report?.deterministic).toBe(true);
    // definition order, not --only order
    expect(result.report?.timing.benches.map((row) => row.name)).toEqual([
      "event_bounds_e13",
      "coach_gates",
    ]);
    expect(result.report?.timing.outerWallMs?.values).toHaveLength(2);
  }, 120_000);

  it("analyze re-reads written summaries and agrees with the run report", async () => {
    const outDir = tempDir();
    const result = await runHarness({
      repeats: 2,
      outDir,
      only: ["coach_gates"],
      mode: "in-process",
      concurrency: 1,
      labelPrefix: "a",
      log: () => {},
    });
    expect(result.exitCode).toBe(0);
    const reportPath = join(outDir, "analyze.json");
    const stdout: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    let code: number;
    try {
      code = await main([
        "analyze",
        "--out",
        reportPath,
        ...result.repeats.map((repeat) => repeat.summaryPath),
      ]);
    } finally {
      process.stdout.write = original;
    }
    expect(code).toBe(0);
    const report = readJson<DeterminismReport>(reportPath);
    expect(report.deterministic).toBe(true);
    expect(report.runs.map((r) => r.stableSha256)).toEqual(
      result.report?.runs.map((r) => r.stableSha256),
    );
    expect(report.metricMatrix).toEqual(result.report?.metricMatrix);
    expect(stdout.join("")).toContain("IDENTICAL across 2 runs");
  }, 60_000);
});
