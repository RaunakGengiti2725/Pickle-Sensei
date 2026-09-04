/**
 * Shared helpers for the adversarial attack suite (pass 3, tester #2) against
 * the regression runner / comparator / tolerances of @pickle/evaluation.
 *
 * Every attack writes a machine-readable evidence record to
 * `$ATTACK_EVIDENCE_DIR` (default `/tmp/attack/evidence`) so the observed
 * behaviour is preserved verbatim alongside the vitest verdict.
 *
 * Nothing in here touches production code, tolerances, datasets or the
 * committed baseline. Anything written under `datasets/` by an attack is
 * removed again by that attack (snapshot / diff / unlink).
 */
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ATTACK_DIR = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(ATTACK_DIR, "fixtures");
export const EVAL_DIR = resolve(ATTACK_DIR, "../..");
export const REPO_ROOT = resolve(EVAL_DIR, "../..");
export const CLI_PATH = join(EVAL_DIR, "src/regression/cli.ts");
export const EVAL_TSX_BIN = join(EVAL_DIR, "node_modules/.bin/tsx");
export const BASELINE_PATH = join(REPO_ROOT, "datasets/reports/regression/baseline.json");
export const TOLERANCES_PATH = join(EVAL_DIR, "regression.tolerances.json");

export const EVIDENCE_DIR = process.env.ATTACK_EVIDENCE_DIR ?? "/tmp/attack/evidence";

export function writeEvidence(name: string, record: unknown): string {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const path = join(EVIDENCE_DIR, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

export function writeEvidenceText(name: string, text: string): string {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const path = join(EVIDENCE_DIR, name);
  writeFileSync(path, text);
  return path;
}

export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

export interface CliResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function toCliResult(result: SpawnSyncReturns<string>): CliResult {
  if (result.error) throw result.error;
  return {
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** Run `tsx src/regression/cli.ts <args>` synchronously from packages/evaluation. */
export function runCli(args: string[], env: NodeJS.ProcessEnv = {}): CliResult {
  return toCliResult(
    spawnSync(EVAL_TSX_BIN, [CLI_PATH, ...args], {
      cwd: EVAL_DIR,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...env },
    }),
  );
}

/** Spawn the CLI asynchronously (for concurrency attacks). */
export function spawnCli(args: string[], env: NodeJS.ProcessEnv = {}): ChildProcess {
  return spawn(EVAL_TSX_BIN, [CLI_PATH, ...args], {
    cwd: EVAL_DIR,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export interface CollectedProcess {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export function collect(child: ChildProcess): Promise<CollectedProcess> {
  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      resolvePromise({ exitCode, signal, stdout, stderr });
    });
  });
}

export function git(args: string[], cwd: string = REPO_ROOT): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

/** Untracked (non-ignored) paths below `datasets/` in the main checkout. */
export function untrackedDatasetPaths(root: string = REPO_ROOT): string[] {
  const out = git(["ls-files", "--others", "--exclude-standard", "--", "datasets"], root);
  return out.length === 0 ? [] : out.split("\n");
}

export function snapshotDir(dir: string): Set<string> {
  return new Set(existsSync(dir) ? readdirSync(dir) : []);
}

/** Remove every entry in `dir` that was not present in `before`; returns removed names. */
export function removeNewEntries(dir: string, before: Set<string>): string[] {
  if (!existsSync(dir)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    if (before.has(name)) continue;
    rmSync(join(dir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** Deterministic seeded PRNG (mulberry32) so interleavings are reproducible. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
