/**
 * S7 — run `pnpm --filter @pickle/evaluation test` (vitest, includes the
 * real in-process contact_replay run) concurrently with bench:regression,
 * several rounds, and check neither races the other on
 * datasets/experiments/wave-e / datasets/completion-bench outputs.
 *
 * Extra interleaving (seeded): TWO full runners started concurrently with a
 * random stagger — both write `event-recall-<Date.now()>.json` into the same
 * shared wave-e directory. Records whether either run fails with
 * "expected exactly one new file" and whether any file leaks into the tree.
 *
 * Seed: ATTACK_SEED env (default 20260904). Rounds: ATTACK_ROUNDS (default 3),
 * ATTACK_RACE_ROUNDS (default 8).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BASELINE,
  CLI,
  EVAL_TSX,
  EVALUATION_DIR,
  REPO_ROOT,
  WAVE_E_DIR,
  check,
  ensureOutDir,
  finish,
  gitStatusShort,
  readJson,
  type Check,
} from "./harness.js";

const COMPLETION_DIR = join(REPO_ROOT, "datasets/completion-bench");
const startedAtIso = new Date().toISOString();
const checks: Check[] = [];
const outDir = join(ensureOutDir(), "s7");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const seed = Number(process.env.ATTACK_SEED ?? "20260904");
const rounds = Number(process.env.ATTACK_ROUNDS ?? "3");
const raceRounds = Number(process.env.ATTACK_RACE_ROUNDS ?? "8");
let state = seed >>> 0;
const rand = () => {
  // mulberry32
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

interface Proc {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

function start(file: string, args: string[], cwd: string, delayMs = 0): Promise<Proc> {
  return new Promise((resolvePromise) => {
    setTimeout(() => {
      const startedAt = Date.now();
      const child = spawn(file, args, {
        cwd,
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", CI: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("close", (code) =>
        resolvePromise({ exitCode: code, stdout, stderr, durationMs: Date.now() - startedAt }),
      );
    }, delayMs);
  });
}

const timestamped = (dir: string, prefix: string) =>
  existsSync(dir)
    ? readdirSync(dir).filter((name) => new RegExp(`^${prefix}-\\d+\\.json$`).test(name))
    : [];

// datasets/completion-bench ships COMMITTED timestamped reports; only files
// that were not there before the attack count as leaks (and only those are
// ever removed by this script).
const waveBefore = new Set(timestamped(WAVE_E_DIR, "event-recall"));
const completionBefore = new Set(timestamped(COMPLETION_DIR, "completion"));
const newWave = () =>
  timestamped(WAVE_E_DIR, "event-recall").filter((name) => !waveBefore.has(name));
const newCompletion = () =>
  timestamped(COMPLETION_DIR, "completion").filter((name) => !completionBefore.has(name));

const baselineMetrics = readJson<{ metrics: Record<string, number | null> }>(BASELINE).metrics;
const statusBefore = gitStatusShort();

async function main(): Promise<void> {
  const untrackedBefore = gitStatusShort()
    .split("\n")
    .filter((line) => /datasets\/(experiments\/wave-e|completion-bench)\//.test(line));
  check(
    checks,
    "precondition: no untracked/modified bench outputs under wave-e or completion-bench before the attack",
    untrackedBefore.length === 0,
    `${untrackedBefore.join(" ; ") || "clean"} (pre-existing committed: wave-e=${waveBefore.size}, completion=${completionBefore.size})`,
    "clean",
  );

  // Part A: vitest ∥ runner, several rounds with a random stagger.
  for (let round = 0; round < rounds; round += 1) {
    const stagger = Math.floor(rand() * 1500);
    const runOut = join(outDir, `roundA-${round}`);
    const [vitest, runner] = await Promise.all([
      start("pnpm", ["--filter", "@pickle/evaluation", "test"], REPO_ROOT),
      start(
        EVAL_TSX,
        [CLI, "run", "--out-dir", runOut, "--run-id", "cand"],
        EVALUATION_DIR,
        stagger,
      ),
    ]);
    writeFileSync(join(outDir, `roundA-${round}.vitest.log`), `${vitest.stdout}\n${vitest.stderr}`);
    writeFileSync(join(outDir, `roundA-${round}.runner.log`), `${runner.stdout}\n${runner.stderr}`);
    const summaryPath = join(runOut, "cand.json");
    const summary = existsSync(summaryPath)
      ? readJson<{
          metrics: Record<string, number | null>;
          benches: { id: string; status: string }[];
        }>(summaryPath)
      : null;
    const drift = summary
      ? Object.keys(baselineMetrics).filter((key) => baselineMetrics[key] !== summary.metrics[key])
      : ["<no summary>"];
    const passedLine =
      vitest.stdout.split("\n").find((line) => /Tests\s+\d+ passed/.test(line)) ?? "";
    check(
      checks,
      `round ${round} (stagger ${stagger}ms): vitest exit 0 and runner exit 0 with baseline-identical metrics`,
      vitest.exitCode === 0 && runner.exitCode === 0 && drift.length === 0,
      `vitest exit ${vitest.exitCode} (${passedLine.trim()}), runner exit ${runner.exitCode}, metric drift ${drift.length}`,
      "0 / 0 / 0 drift",
    );
    const waveAfter = newWave();
    const completionAfter = newCompletion();
    check(
      checks,
      `round ${round}: no leaked timestamped outputs`,
      waveAfter.length === 0 && completionAfter.length === 0,
      `wave-e=${waveAfter.join(",") || "none"} completion=${completionAfter.join(",") || "none"}`,
      "none",
    );
  }

  // Part B: two full runners racing on the same shared output dirs.
  const raceResults: {
    stagger: number;
    a: number | null;
    b: number | null;
    aErr: string;
    bErr: string;
    leaked: string[];
  }[] = [];
  for (let round = 0; round < raceRounds; round += 1) {
    // The write→list window inside runCapturingNewFile is only a few ms wide,
    // so keep the stagger tight (0–30 ms) to actually overlap the two writes.
    const stagger = Math.floor(rand() * 30);
    const outA = join(outDir, `roundB-${round}-a`);
    const outB = join(outDir, `roundB-${round}-b`);
    const [a, b] = await Promise.all([
      start(
        EVAL_TSX,
        [CLI, "run", "--out-dir", outA, "--run-id", "a", "--only", "event_recall,completion_bench"],
        EVALUATION_DIR,
      ),
      start(
        EVAL_TSX,
        [CLI, "run", "--out-dir", outB, "--run-id", "b", "--only", "event_recall,completion_bench"],
        EVALUATION_DIR,
        stagger,
      ),
    ]);
    writeFileSync(join(outDir, `roundB-${round}.a.log`), `${a.stdout}\n${a.stderr}`);
    writeFileSync(join(outDir, `roundB-${round}.b.log`), `${b.stdout}\n${b.stderr}`);
    const firstError = (summaryPath: string) => {
      if (!existsSync(summaryPath)) return "<no summary>";
      const summary = readJson<{ benches: { id: string; status: string; error: string | null }[] }>(
        summaryPath,
      );
      return summary.benches
        .filter((bench) => bench.status !== "ok")
        .map((bench) => `${bench.id}: ${(bench.error ?? "").split("\n")[0]}`)
        .join(" | ");
    };
    const leaked = [...newWave(), ...newCompletion()];
    raceResults.push({
      stagger,
      a: a.exitCode,
      b: b.exitCode,
      aErr: firstError(join(outA, "a.json")),
      bErr: firstError(join(outB, "b.json")),
      leaked,
    });
    // Remove ONLY files this round leaked so later rounds start clean (the runner itself never removes them).
    for (const name of newWave()) rmSync(join(WAVE_E_DIR, name));
    for (const name of newCompletion()) rmSync(join(COMPLETION_DIR, name));
  }
  const anyRaceFailure = raceResults.some((entry) => entry.a !== 0 || entry.b !== 0);
  const anyLeak = raceResults.some((entry) => entry.leaked.length > 0);
  check(
    checks,
    `two concurrent runners on one checkout (${raceRounds} rounds, seed ${seed}): both exit 0 and nothing leaks`,
    !anyRaceFailure && !anyLeak,
    raceResults
      .map(
        (entry) =>
          `stagger=${entry.stagger}ms a=${entry.a} b=${entry.b} leaked=[${entry.leaked.join(",")}] aErr="${entry.aErr}" bErr="${entry.bErr}"`,
      )
      .join("\n                  "),
    "every round a=0 b=0 leaked=[] — or the runner must document/lock against concurrent runs",
  );

  const statusAfter = gitStatusShort();
  check(
    checks,
    "git status unchanged after attack",
    statusAfter === statusBefore,
    statusAfter || "<clean>",
    statusBefore || "<clean>",
  );

  finish("s7_concurrent_vitest_and_runner", startedAtIso, checks, {
    seed,
    rounds,
    raceRounds,
    raceResults,
    outDir,
  });
}

void main();
