/**
 * Seeded cancellation stress for the regression runner (lens:
 * randomized-seeded, property "cancellation honoured").
 *
 * Each iteration derives from its seed: the signal (SIGINT/SIGTERM), the
 * subprocess bench, and WHEN the signal lands — either a fixed delay after
 * spawn (before the bench child may exist) or a delay after the bench child
 * appears. The contract under test (run.ts `runRegression` doc comment):
 * an interrupted run kills every live child process group, removes its
 * scratch dir, writes no summary and leaves nothing behind; the CLI exits
 * 128 + signal.
 *
 * Default is 2 iterations so the suite stays fast; scale with
 *   STRESS_CANCEL_ITER=40 STRESS_CANCEL_OUT=/tmp/cancel.json \
 *     pnpm --filter @pickle/evaluation test -- stress.cancellation
 *
 * The second test targets the start-up window between the summary
 * reservation and the signal handlers being installed, whose width is the
 * runner's initial `git` calls. It is opt-in because it needs a `git` shim
 * that sleeps STRESS_CANCEL_SLOW_GIT_MS before exec'ing the real git (the
 * environment of a cold or very large checkout):
 *   STRESS_CANCEL_SLOW_GIT_MS=300 pnpm --filter @pickle/evaluation test -- stress.cancellation
 *
 * Linux-only (pgrep), like test/regressionAdjudication.test.ts.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { HANDLED_SIGNALS, type HandledSignal } from "../src/regression/run.js";
import { validateRegressionSummary } from "../src/regression/summarySchema.js";
import { REPO_ROOT } from "./stress/model.js";
import { SeededRng, deriveSeed } from "./stress/seededRng.js";

const TSX_BIN = join(REPO_ROOT, "packages/evaluation/node_modules/.bin/tsx");
const CLI = join(REPO_ROOT, "packages/evaluation/src/regression/cli.ts");

const ITERATIONS = Number.parseInt(process.env.STRESS_CANCEL_ITER ?? "2", 10);
const SEED_BASE = Number.parseInt(process.env.STRESS_CANCEL_SEED ?? "20260904", 10) >>> 0;
const OUT = process.env.STRESS_CANCEL_OUT ?? null;
const SLOW_GIT_MS = Number.parseInt(process.env.STRESS_CANCEL_SLOW_GIT_MS ?? "0", 10);

/** Subprocess benches and the script name their child shows in `ps`. */
const SUBPROCESS_BENCHES: ReadonlyArray<{ id: string; childPattern: string }> = [
  { id: "event_recall", childPattern: "eventRecallBench.ts" },
  { id: "completion_bench", childPattern: "eventCompletionBench.ts" },
  { id: "ball_hard_slice", childPattern: "ballHardSliceEval.ts" },
  { id: "phase_gold_d3_05", childPattern: "d3-05-measure-gold.ts" },
];

const scratch = mkdtempSync(join(tmpdir(), "pickle-stress-cancel-"));
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

/** Never leave the working tree dirty even if the runner misbehaves. */
afterEach(() => {
  for (const file of untrackedDatasetFiles()) unlinkSync(join(REPO_ROOT, file));
});

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

interface Finished {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function finished(child: ChildProcess): Promise<Finished> {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function waitUntilGone(pattern: string, timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let pids = pidsOf(pattern);
  while (pids.length > 0 && Date.now() < deadline) {
    await sleep(50);
    pids = pidsOf(pattern);
  }
  return pids;
}

export interface CancellationRow {
  index: number;
  seed: number;
  runId: string;
  signal: HandledSignal;
  bench: string;
  phase: "after_spawn" | "after_child";
  delayMs: number;
  childSeen: boolean;
  killedAtMs: number;
  exitCode: number | null;
  exitSignal: string | null;
  completedBeforeSignal: boolean;
  outcome: "cancelled" | "completed_before_signal" | "completed_during_signal";
  summaryFiles: string[];
  summaryFileBytes: number | null;
  summaryValid: boolean | null;
  scratchDirs: string[];
  orphanChildren: number[];
  orphanRunners: number[];
  untrackedDatasetFiles: string[];
  stderrTail: string;
  ok: boolean;
  problems: string[];
}

async function runIteration(index: number): Promise<CancellationRow> {
  const seed = deriveSeed(SEED_BASE, index);
  const rng = new SeededRng(seed);
  const signal = rng.pick(HANDLED_SIGNALS);
  const bench = rng.pick(SUBPROCESS_BENCHES);
  const phase = rng.bool(0.4) ? "after_spawn" : "after_child";
  const delayMs = phase === "after_spawn" ? rng.int(0, 600) : rng.int(0, 300);
  const runId = `stress-cancel-${seed.toString(16)}-${index}`;
  const outDir = join(scratch, `out-${index}`);
  const tmp = join(scratch, `tmp-${index}`);
  mkdirSync(tmp, { recursive: true });

  const startedAt = Date.now();
  const runner = spawn(
    TSX_BIN,
    [CLI, "run", "--only", bench.id, "--out-dir", outDir, "--run-id", runId],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, TMPDIR: tmp, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const done = finished(runner);
  let childSeen = false;
  let exited = false;
  void done.then(() => (exited = true));
  if (phase === "after_child") {
    const deadline = Date.now() + 20_000;
    while (!childSeen && !exited && Date.now() < deadline) {
      await sleep(10);
      childSeen = pidsOf(bench.childPattern).length > 0;
    }
  }
  await sleep(delayMs);
  const killedAtMs = Date.now() - startedAt;
  const completedBeforeSignal = exited;
  if (!exited) runner.kill(signal);
  const result = await done;

  const orphanChildren = await waitUntilGone(bench.childPattern, 5_000);
  const orphanRunners = await waitUntilGone(`run-id ${runId}`, 5_000);
  const summaryFiles = existsSync(outDir) ? readdirSync(outDir) : [];
  const summaryPath = join(outDir, `${runId}.json`);
  const summaryFileBytes = existsSync(summaryPath) ? statSync(summaryPath).size : null;
  const scratchDirs = readdirSync(tmp).filter((name) => name.startsWith("pickle-regression-"));
  const untracked = untrackedDatasetFiles();

  // A run whose summary is already on disk may still be tearing down when the
  // signal lands; it then exits 0 (or 128+signal once its handlers are gone)
  // and the ONLY acceptable residue is that complete, schema-valid summary.
  let summaryValid: boolean | null = null;
  if (summaryFileBytes !== null) {
    let parsedJson: unknown = null;
    try {
      parsedJson = JSON.parse(readFileSync(summaryPath, "utf8"));
    } catch {
      parsedJson = null;
    }
    const parsed = validateRegressionSummary(parsedJson);
    summaryValid = parsed.ok && parsed.value.runId === runId;
  }
  const expectedCode = 128 + (signal === "SIGINT" ? 2 : 15);
  const outcome: CancellationRow["outcome"] = completedBeforeSignal
    ? "completed_before_signal"
    : summaryValid === true && (result.code === 0 || result.code === expectedCode)
      ? "completed_during_signal"
      : "cancelled";

  const problems: string[] = [];
  if (outcome === "cancelled") {
    const diedBySignal = result.code === null && result.signal === signal;
    if (result.code !== expectedCode && !diedBySignal) {
      problems.push(
        `exit ${String(result.code)}/${String(result.signal)}, expected ${expectedCode} or death by ${signal}`,
      );
    }
    if (summaryFiles.length > 0)
      problems.push(
        `stray summary file(s) after cancellation: ${summaryFiles.join()} (${summaryFileBytes ?? 0} bytes)`,
      );
  } else {
    if (summaryFiles.join() !== `${runId}.json`)
      problems.push(`completed run did not leave exactly its summary: ${summaryFiles.join()}`);
    if (summaryValid !== true)
      problems.push(`completed run left an invalid summary (${summaryFileBytes ?? 0} bytes)`);
  }
  if (scratchDirs.length > 0) problems.push(`orphaned scratch dir(s): ${scratchDirs.join()}`);
  if (orphanChildren.length > 0)
    problems.push(`bench child outlived the runner: ${orphanChildren.join()}`);
  if (orphanRunners.length > 0)
    problems.push(`runner process outlived the CLI: ${orphanRunners.join()}`);
  if (untracked.length > 0) problems.push(`untracked files under datasets/: ${untracked.join()}`);

  for (const pid of [...orphanChildren, ...orphanRunners]) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }

  return {
    index,
    seed,
    runId,
    signal,
    bench: bench.id,
    phase,
    delayMs,
    childSeen,
    killedAtMs,
    exitCode: result.code,
    exitSignal: result.signal,
    completedBeforeSignal,
    outcome,
    summaryFiles,
    summaryFileBytes,
    summaryValid,
    scratchDirs,
    orphanChildren,
    orphanRunners,
    untrackedDatasetFiles: untracked,
    stderrTail: result.stderr.split("\n").slice(-3).join("\n"),
    ok: problems.length === 0,
    problems,
  };
}

function slowGitShimDir(delayMs: number): string {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const dir = join(scratch, "slow-git");
  mkdirSync(dir, { recursive: true });
  const shim = join(dir, "git");
  writeFileSync(shim, `#!/bin/sh\nsleep ${(delayMs / 1000).toFixed(3)}\nexec "${realGit}" "$@"\n`);
  chmodSync(shim, 0o755);
  return dir;
}

interface StartupWindowRow {
  signal: HandledSignal;
  delayMs: number;
  exitCode: number | null;
  exitSignal: string | null;
  summaryFiles: string[];
  scratchDirs: string[];
  problems: string[];
}

/** Signals the runner while its start-up `git` calls are still running. */
async function runStartupWindow(
  signal: HandledSignal,
  delayMs: number,
  shimDir: string,
): Promise<StartupWindowRow> {
  const runId = `stress-cancel-startup-${signal}-${delayMs}`;
  const outDir = join(scratch, `startup-out-${signal}-${delayMs}`);
  const tmp = join(scratch, `startup-tmp-${signal}-${delayMs}`);
  mkdirSync(tmp, { recursive: true });
  const runner = spawn(
    TSX_BIN,
    [CLI, "run", "--only", "event_recall", "--out-dir", outDir, "--run-id", runId],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, TMPDIR: tmp, PATH: `${shimDir}:${process.env.PATH ?? ""}` },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const done = finished(runner);
  await sleep(delayMs);
  runner.kill(signal);
  const result = await done;
  await waitUntilGone(`run-id ${runId}`, 5_000);
  const summaryFiles = existsSync(outDir)
    ? readdirSync(outDir).map((name) => `${name}:${statSync(join(outDir, name)).size}`)
    : [];
  const scratchDirs = readdirSync(tmp).filter((name) => name.startsWith("pickle-regression-"));
  const problems: string[] = [];
  if (summaryFiles.length > 0)
    problems.push(`stray summary file(s) after cancellation: ${summaryFiles.join()}`);
  if (scratchDirs.length > 0) problems.push(`orphaned scratch dir(s): ${scratchDirs.join()}`);
  return {
    signal,
    delayMs,
    exitCode: result.code,
    exitSignal: result.signal,
    summaryFiles,
    scratchDirs,
    problems,
  };
}

describe("stress: seeded cancellation of the regression runner", () => {
  it(
    `honours SIGINT/SIGTERM at ${ITERATIONS} seeded instants (no summary, no scratch dir, no orphan child)`,
    async () => {
      const rows: CancellationRow[] = [];
      for (let index = 0; index < ITERATIONS; index += 1) {
        rows.push(await runIteration(index));
      }
      if (OUT) {
        const failing = rows.filter((row) => !row.ok);
        writeFileSync(
          OUT,
          `${JSON.stringify(
            {
              lens: "randomized-seeded",
              unit: "pkg-evaluation",
              property: "cancellation honoured",
              seedBase: SEED_BASE,
              iterations: rows.length,
              node: process.version,
              okCount: rows.length - failing.length,
              failedSeeds: failing.map((row) => row.seed),
              cancelledCount: rows.filter((row) => row.outcome === "cancelled").length,
              completedDuringSignalCount: rows.filter(
                (row) => row.outcome === "completed_during_signal",
              ).length,
              rows,
            },
            null,
            2,
          )}\n`,
        );
      }
      const failures = rows
        .filter((row) => !row.ok)
        .map(
          (row) =>
            `seed ${row.seed} (${row.signal} ${row.phase} +${row.delayMs}ms, ${row.bench}): ${row.problems.join("; ")}`,
        );
      expect(failures, "cancellation contract violations").toEqual([]);
    },
    Math.max(120_000, ITERATIONS * 30_000),
  );

  it.runIf(SLOW_GIT_MS > 0)(
    `leaves no summary or scratch dir when signalled during start-up (git delayed ${SLOW_GIT_MS}ms)`,
    async () => {
      const shimDir = slowGitShimDir(SLOW_GIT_MS);
      const rows: StartupWindowRow[] = [];
      for (const signal of HANDLED_SIGNALS) {
        for (const delayMs of [SLOW_GIT_MS, SLOW_GIT_MS * 2, SLOW_GIT_MS * 3]) {
          rows.push(await runStartupWindow(signal, delayMs, shimDir));
        }
      }
      const failures = rows
        .filter((row) => row.problems.length > 0)
        .map(
          (row) =>
            `${row.signal} +${row.delayMs}ms (exit ${String(row.exitCode)}/${String(row.exitSignal)}): ${row.problems.join("; ")}`,
        );
      expect(failures, "start-up window cancellation contract violations").toEqual([]);
    },
    120_000,
  );
});
