/**
 * Adjudication reproductions for the regression runner / comparator
 * (pkg-evaluation-bench). Each test states the EXPECTED behaviour; on
 * 4d812e1a the marked tests fail and pin the confirmed findings:
 *
 *   EVAL-BENCH-01  runCapturingNewFile leaves stray files in committed
 *                  datasets/ dirs on concurrent failure and SIGTERM; the
 *                  child survives the runner; scratch dir is orphaned.
 *   EVAL-BENCH-02  same --run-id / --out-dir race silently overwrites.
 *   EVAL-BENCH-04  unknown / misspelled flags are silently accepted.
 *   EVAL-BENCH-05  validator accepts status "ok" with a non-zero exitCode.
 *
 * Linux-only (uses pgrep); the bench itself is Linux-only.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/regression/benches.js";
import { main, parseArgs } from "../src/regression/cli.js";
import { validateRegressionSummary } from "../src/index.js";
import { bench, summary } from "./regressionFixtures.js";

const TSX_BIN = join(REPO_ROOT, "packages/evaluation/node_modules/.bin/tsx");
const CLI = join(REPO_ROOT, "packages/evaluation/src/regression/cli.ts");
const WAVE_E = join(REPO_ROOT, "datasets/experiments/wave-e");

const scratch = mkdtempSync(join(tmpdir(), "pickle-regression-adjudication-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function untrackedDatasetFiles(): string[] {
  return execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "datasets"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3));
}

/** Never leave the working tree dirty even while the runner is broken. */
afterEach(() => {
  for (const file of untrackedDatasetFiles()) unlinkSync(join(REPO_ROOT, file));
});

interface Finished {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function startRunner(args: string[], env: NodeJS.ProcessEnv = {}): ChildProcess {
  return spawn(TSX_BIN, [CLI, "run", ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env, FORCE_COLOR: "0", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function finished(child: ChildProcess): Promise<Finished> {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise((resolve) =>
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr })),
  );
}

function pidsOf(pattern: string): number[] {
  try {
    return execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("EVAL-BENCH-01 runCapturingNewFile hygiene (event_recall writes into datasets/experiments/wave-e)", () => {
  it("two concurrent runners leave no stray files behind, whatever their bench status", async () => {
    expect(untrackedDatasetFiles()).toEqual([]);
    const a = startRunner([
      "--only",
      "event_recall",
      "--out-dir",
      join(scratch, "a"),
      "--run-id",
      "a",
    ]);
    const b = startRunner([
      "--only",
      "event_recall",
      "--out-dir",
      join(scratch, "b"),
      "--run-id",
      "b",
    ]);
    const [ra, rb] = await Promise.all([finished(a), finished(b)]);
    expect([ra.code, rb.code]).not.toContain(null);
    // A failed bench is acceptable under contention; a dirty tree is not.
    expect(untrackedDatasetFiles()).toEqual([]);
  }, 60_000);

  it("SIGTERM during a subprocess bench kills the child, removes the scratch dir and leaves no stray file", async () => {
    const tmp = join(scratch, "tmp-sigterm");
    execFileSync("mkdir", ["-p", tmp]);
    const runner = startRunner(
      ["--only", "event_recall", "--out-dir", join(scratch, "sig"), "--run-id", "sig"],
      { TMPDIR: tmp },
    );
    let child: number[] = [];
    for (let i = 0; i < 400 && child.length === 0; i += 1) {
      await sleep(10);
      child = pidsOf("eventRecallBench.ts");
    }
    expect(child.length, "bench child never appeared").toBeGreaterThan(0);
    runner.kill("SIGTERM");
    const result = await finished(runner);
    expect(result.code === null ? result.signal : result.code).not.toBe(0);
    await sleep(3_000);
    expect(pidsOf("eventRecallBench.ts"), "child outlived the runner").toEqual([]);
    expect(readdirSync(tmp).filter((name) => name.startsWith("pickle-regression-"))).toEqual([]);
    expect(untrackedDatasetFiles()).toEqual([]);
    expect(existsSync(WAVE_E)).toBe(true);
  }, 60_000);
});

describe("EVAL-BENCH-02 same --run-id race", () => {
  it("exactly one of two concurrent runners with the same run id succeeds; the other is refused", async () => {
    const outDir = join(scratch, "same");
    const args = ["--only", "coach_gates", "--out-dir", outDir, "--run-id", "same"];
    const [r1, r2] = await Promise.all([finished(startRunner(args)), finished(startRunner(args))]);
    const codes = [r1.code, r2.code].sort();
    expect(codes).toEqual([0, 2]);
    expect(`${r1.stderr}${r2.stderr}`).toMatch(/refusing to overwrite/);
    expect(readdirSync(outDir)).toEqual(["same.json"]);
  }, 60_000);
});

describe("EVAL-BENCH-04 CLI rejects unknown flags", () => {
  it("parseArgs / main reject misspelled flags instead of silently using defaults", () => {
    expect(() => parseArgs(["compare", "a.json", "b.json", "--tolerance", "t.json"])).toThrow(
      /unknown flag/i,
    );
    expect(() => parseArgs(["run", "--out-dirr", "/tmp/x"])).toThrow(/unknown flag/i);
    const baseline = join(REPO_ROOT, "datasets/reports/regression/baseline.json");
    const stderr = console.error;
    console.error = () => {};
    try {
      expect(main(["compare", baseline, baseline, "--tolerance", "/nonexistent.json"])).toBe(2);
    } finally {
      console.error = stderr;
    }
  });
});

describe("EVAL-BENCH-05 summary validator: bench status must agree with the subprocess exit code", () => {
  const subprocessOk = bench({
    id: "event_recall",
    kind: "subprocess",
    command: "tsx src/eventRecallBench.ts",
    cwd: "packages/swing-lab",
  });

  it("rejects status ok with a non-zero exitCode", () => {
    const result = validateRegressionSummary(summary({}, [{ ...subprocessOk, exitCode: 137 }]));
    expect(result.ok).toBe(false);
  });

  it("rejects status failed with exitCode 0", () => {
    const result = validateRegressionSummary(
      summary({}, [{ ...subprocessOk, status: "failed", exitCode: 0, error: "x", metrics: {} }]),
    );
    expect(result.ok).toBe(false);
  });

  it("still accepts the consistent pairs", () => {
    expect(validateRegressionSummary(summary({}, [{ ...subprocessOk, exitCode: 0 }])).ok).toBe(
      true,
    );
    expect(
      validateRegressionSummary(
        summary({}, [{ ...subprocessOk, status: "failed", exitCode: 1, error: "x", metrics: {} }]),
      ).ok,
    ).toBe(true);
  });
});
