/**
 * Adversarial pass 3 — shared harness for the pkg-evaluation-bench attack
 * scripts. Every script is a standalone `tsx` program:
 *
 *   packages/evaluation/node_modules/.bin/tsx packages/evaluation/test/attack-pass3/<script>.ts
 *
 * Each script performs one attack against the regression runner/comparator,
 * prints a HELD / BROKEN verdict per check, writes a JSON evidence record to
 * `$ATTACK_OUT_DIR` (default `/tmp/attack-pass3`) and exits 0 iff every check
 * HELD. Nothing here touches production code; scripts that must alter the
 * tree do so in a scratch clone or restore the tree in `finally`.
 */
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const EVALUATION_DIR = join(REPO_ROOT, "packages/evaluation");
export const CLI = join(EVALUATION_DIR, "src/regression/cli.ts");
export const EVAL_TSX = join(EVALUATION_DIR, "node_modules/.bin/tsx");
export const SWING_LAB_TSX = join(REPO_ROOT, "packages/swing-lab/node_modules/.bin/tsx");
export const BASELINE = join(REPO_ROOT, "datasets/reports/regression/baseline.json");
export const TOLERANCES = join(EVALUATION_DIR, "regression.tolerances.json");
export const WAVE_E_DIR = join(REPO_ROOT, "datasets/experiments/wave-e");
export const OUT_DIR = process.env.ATTACK_OUT_DIR ?? "/tmp/attack-pass3";

export interface Check {
  name: string;
  held: boolean;
  observed: string;
  expected: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error: string | null;
  durationMs: number;
}

export function runCommand(
  file: string,
  args: string[],
  options: SpawnSyncOptions & { cwd?: string } = {},
): CommandResult {
  const started = Date.now();
  const result = spawnSync(file, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...options,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...(options.env ?? {}) },
  });
  return {
    exitCode: result.status ?? -1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    error: result.error ? `${result.error.name}: ${result.error.message}` : null,
    durationMs: Date.now() - started,
  };
}

/** Run the regression CLI directly through the evaluation package's tsx. */
export function cli(args: string[], options: SpawnSyncOptions & { cwd?: string } = {}) {
  return runCommand(EVAL_TSX, [CLI, ...args], { cwd: EVALUATION_DIR, ...options });
}

export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function ensureOutDir(): string {
  mkdirSync(OUT_DIR, { recursive: true });
  return OUT_DIR;
}

export function gitStatusShort(cwd: string = REPO_ROOT): string {
  return runCommand("git", ["status", "--short"], { cwd }).stdout.trim();
}

export function check(
  checks: Check[],
  name: string,
  held: boolean,
  observed: string,
  expected: string,
): void {
  checks.push({ name, held, observed, expected });
  console.error(
    `${held ? "HELD  " : "BROKEN"} ${name}\n        observed: ${observed}\n        expected: ${expected}`,
  );
}

export interface ScenarioRecord {
  scenario: string;
  commit: string;
  startedAtIso: string;
  finishedAtIso: string;
  verdict: "HELD" | "BROKEN";
  checks: Check[];
  artifacts: Record<string, unknown>;
}

export function headSha(cwd: string = REPO_ROOT): string {
  return runCommand("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();
}

/** Write the evidence record and exit with the aggregate verdict. */
export function finish(
  scenario: string,
  startedAtIso: string,
  checks: Check[],
  artifacts: Record<string, unknown>,
): never {
  const verdict: ScenarioRecord["verdict"] = checks.every((entry) => entry.held)
    ? "HELD"
    : "BROKEN";
  const record: ScenarioRecord = {
    scenario,
    commit: headSha(),
    startedAtIso,
    finishedAtIso: new Date().toISOString(),
    verdict,
    checks,
    artifacts,
  };
  const path = join(ensureOutDir(), `${scenario}.json`);
  writeJson(path, record);
  console.error(
    `\n${verdict}: ${scenario} — ${checks.filter((c) => c.held).length}/${checks.length} checks held → ${path}`,
  );
  process.exit(verdict === "HELD" ? 0 : 1);
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}
