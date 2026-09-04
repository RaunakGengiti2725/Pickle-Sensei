/**
 * Fine-grained signal-timing sweep against the regression runner CLI.
 *
 * Spawns `cli.ts run --only event_recall` once per delay in
 * [from, to] (ms, `step` apart), sends `signal` after that delay and reports
 * what the interrupted run left behind: summary files (with byte sizes) in
 * its --out-dir and `pickle-regression-*` scratch dirs in its TMPDIR. One
 * JSON line per attempt; a line with a 0-byte summary or a scratch dir is a
 * cancellation-contract violation.
 *
 *   pnpm --filter @pickle/evaluation exec tsx test/stress/cancellationSweep.ts \
 *     --from 212 --to 248 --step 1 --signal SIGTERM --passes 3
 *
 * The vulnerable window (summary reserved, signal handlers not yet
 * installed) is only as wide as the runner's start-up `git` calls, so on a
 * warm checkout it is a few milliseconds and machine-speed dependent.
 * `--slow-git-ms N` puts a `git` shim first on the child's PATH that sleeps
 * N ms before exec'ing the real git — the environment of a cold or very
 * large checkout — which widens the window enough to hit deterministically:
 *
 *   pnpm --filter @pickle/evaluation exec tsx test/stress/cancellationSweep.ts \
 *     --from 250 --to 1450 --step 100 --signal SIGTERM --slow-git-ms 300
 *
 * The sweep is a reproduction aid, not a suite test.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./model.js";

const TSX_BIN = join(REPO_ROOT, "packages/evaluation/node_modules/.bin/tsx");
const CLI = join(REPO_ROOT, "packages/evaluation/src/regression/cli.ts");

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value ?? fallback;
}

const from = Number(flag("from", "200"));
const to = Number(flag("to", "260"));
const step = Number(flag("step", "2"));
const passes = Number(flag("passes", "1"));
const signal = flag("signal", "SIGTERM") as "SIGINT" | "SIGTERM";
const bench = flag("bench", "event_recall");
const slowGitMs = Number(flag("slow-git-ms", "0"));

function slowGitPath(): string | null {
  if (slowGitMs <= 0) return null;
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const dir = mkdtempSync(join(tmpdir(), "pickle-slow-git-"));
  const shim = join(dir, "git");
  writeFileSync(
    shim,
    `#!/bin/sh\nsleep ${(slowGitMs / 1000).toFixed(3)}\nexec "${realGit}" "$@"\n`,
  );
  chmodSync(shim, 0o755);
  return dir;
}

const shimDir = slowGitPath();
const childPath = shimDir ? `${shimDir}:${process.env.PATH ?? ""}` : process.env.PATH;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Attempt {
  pass: number;
  slowGitMs: number;
  delayMs: number;
  elapsedMs: number;
  code: number | null;
  signal: string | null;
  summaryFiles: string[];
  scratchDirs: string[];
  stderrLast: string;
  violation: boolean;
}

async function attempt(pass: number, index: number, delayMs: number): Promise<Attempt> {
  const base = mkdtempSync(join(tmpdir(), "pickle-cancel-sweep-"));
  const outDir = join(base, "out");
  const tmp = join(base, "tmp");
  mkdirSync(tmp, { recursive: true });
  const runId = `sweep-${pass}-${index}`;
  const startedAt = Date.now();
  const child = spawn(
    TSX_BIN,
    [CLI, "run", "--only", bench, "--out-dir", outDir, "--run-id", runId],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, TMPDIR: tmp, PATH: childPath },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("exit", (code, exitSignal) => resolve({ code, signal: exitSignal })),
  );
  await sleep(delayMs);
  child.kill(signal);
  const result = await done;
  await sleep(300);
  const summaryFiles = existsSync(outDir)
    ? readdirSync(outDir).map((name) => `${name}:${statSync(join(outDir, name)).size}`)
    : [];
  const scratchDirs = readdirSync(tmp).filter((name) => name.startsWith("pickle-regression-"));
  const violation = scratchDirs.length > 0 || summaryFiles.some((entry) => entry.endsWith(":0"));
  if (!violation) rmSync(base, { recursive: true, force: true });
  return {
    pass,
    slowGitMs,
    delayMs,
    elapsedMs: Date.now() - startedAt,
    code: result.code,
    signal: result.signal,
    summaryFiles: violation ? summaryFiles.map((entry) => join(outDir, entry)) : summaryFiles,
    scratchDirs: violation ? scratchDirs.map((name) => join(tmp, name)) : scratchDirs,
    stderrLast: stderr.trim().split("\n").pop() ?? "",
    violation,
  };
}

async function main(): Promise<void> {
  let violations = 0;
  for (let pass = 1; pass <= passes; pass += 1) {
    let index = 0;
    for (let delayMs = from; delayMs <= to; delayMs += step, index += 1) {
      const row = await attempt(pass, index, delayMs);
      if (row.violation) violations += 1;
      process.stdout.write(`${JSON.stringify(row)}\n`);
    }
  }
  if (shimDir) rmSync(shimDir, { recursive: true, force: true });
  process.stderr.write(`${violations} violation(s)\n`);
  process.exitCode = violations > 0 ? 1 : 0;
}

void main();
