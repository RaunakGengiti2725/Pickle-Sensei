/**
 * S4 — in a scratch checkout (git worktree of the SAME commit, dependencies
 * installed prefer-offline from the pnpm store) delete
 * `packages/swing-lab/node_modules/.bin/tsx` and run the full regression.
 *
 * Expected: the four subprocess benches (event_recall, completion_bench,
 * ball_hard_slice, phase_gold_d3_05) fail with `spawn … ENOENT`, the five
 * in-process benches succeed, the runner exits 1 and STILL writes a valid
 * summary that the comparator then rejects with exit 1 (failed benches),
 * never exit 0. Also: no scratch temp dir is left behind, and the failed
 * benches carry NO metrics (schema rule).
 */
import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASELINE,
  OUT_DIR,
  REPO_ROOT,
  check,
  ensureOutDir,
  finish,
  headSha,
  readJson,
  runCommand,
  type Check,
} from "./harness.js";

interface Summary {
  benches: {
    id: string;
    status: string;
    exitCode: number | null;
    error: string | null;
    metrics: Record<string, unknown>;
  }[];
  metrics: Record<string, unknown>;
}

const SUBPROCESS = ["event_recall", "completion_bench", "ball_hard_slice", "phase_gold_d3_05"];
const IN_PROCESS = [
  "stroke_heuristic",
  "contact_replay",
  "event_bounds_e13",
  "ownership_dual_frame",
  "coach_gates",
];

const startedAtIso = new Date().toISOString();
const checks: Check[] = [];
const outDir = join(ensureOutDir(), "s4");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const worktree = join(tmpdir(), `pickle-s4-worktree-${process.pid}`);
const commit = headSha();

const scratchBefore = new Set(
  readdirSync(tmpdir()).filter((n) => n.startsWith("pickle-regression-")),
);

try {
  const add = runCommand("git", ["worktree", "add", "--detach", "--quiet", worktree, commit], {
    cwd: REPO_ROOT,
  });
  check(
    checks,
    "scratch worktree created",
    add.exitCode === 0,
    `exit ${add.exitCode} ${add.stderr.trim().split("\n").pop() ?? ""}`,
    "exit 0",
  );

  const install = runCommand(
    "pnpm",
    ["install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts"],
    {
      cwd: worktree,
    },
  );
  writeFileSync(join(outDir, "pnpm-install.log"), `${install.stdout}\n${install.stderr}`);
  const swingLabTsx = join(worktree, "packages/swing-lab/node_modules/.bin/tsx");
  const evalTsx = join(worktree, "packages/evaluation/node_modules/.bin/tsx");
  check(
    checks,
    "prefer-offline install produced both tsx shims",
    install.exitCode === 0 && existsSync(swingLabTsx) && existsSync(evalTsx),
    `exit ${install.exitCode} swing-lab tsx=${existsSync(swingLabTsx)} evaluation tsx=${existsSync(evalTsx)}`,
    "exit 0, both present",
  );

  if (!existsSync(evalTsx)) throw new Error("scratch install failed; cannot run the attack");
  unlinkSync(swingLabTsx);
  check(checks, "swing-lab tsx removed", !existsSync(swingLabTsx), "removed", "removed");

  const runOut = join(outDir, "run");
  const run = runCommand(
    evalTsx,
    [
      join(worktree, "packages/evaluation/src/regression/cli.ts"),
      "run",
      "--out-dir",
      runOut,
      "--run-id",
      "s4",
    ],
    {
      cwd: join(worktree, "packages/evaluation"),
    },
  );
  writeFileSync(join(outDir, "run.stdout.log"), run.stdout);
  writeFileSync(join(outDir, "run.stderr.log"), run.stderr);
  check(
    checks,
    "runner exit 1 (not 0, not crash)",
    run.exitCode === 1,
    `exit ${run.exitCode} ${run.error ?? ""}`,
    "exit 1",
  );

  const summaryPath = join(runOut, "s4.json");
  check(
    checks,
    "summary still written",
    existsSync(summaryPath),
    existsSync(summaryPath) ? summaryPath : "absent",
    "written",
  );

  if (existsSync(summaryPath)) {
    const summary = readJson<Summary>(summaryPath);
    const byId = new Map(summary.benches.map((bench) => [bench.id, bench]));
    const subFailedEnoent = SUBPROCESS.filter((id) => {
      const bench = byId.get(id);
      return (
        bench?.status === "failed" &&
        /ENOENT/.test(bench.error ?? "") &&
        Object.keys(bench.metrics).length === 0
      );
    });
    check(
      checks,
      "all 4 subprocess benches failed with spawn ENOENT and no metrics",
      subFailedEnoent.length === SUBPROCESS.length,
      SUBPROCESS.map(
        (id) => `${id}=${byId.get(id)?.status}:${(byId.get(id)?.error ?? "").split("\n")[0]}`,
      ).join(" | "),
      "event_recall, completion_bench, ball_hard_slice, phase_gold_d3_05 all failed/ENOENT",
    );
    const inOk = IN_PROCESS.filter(
      (id) => byId.get(id)?.status === "ok" && Object.keys(byId.get(id)!.metrics).length > 0,
    );
    check(
      checks,
      "all 5 in-process benches ok with metrics",
      inOk.length === IN_PROCESS.length,
      IN_PROCESS.map((id) => `${id}=${byId.get(id)?.status}`).join(" "),
      "all ok",
    );
    const baselineMetrics = readJson<Summary>(BASELINE).metrics;
    const inProcessKeys = Object.keys(baselineMetrics).filter((key) =>
      IN_PROCESS.some((id) => key.startsWith(`${id}.`)),
    );
    const drift = inProcessKeys.filter((key) => baselineMetrics[key] !== summary.metrics[key]);
    check(
      checks,
      "in-process metrics identical to baseline (worktree replay deterministic)",
      drift.length === 0,
      drift.length === 0 ? `${inProcessKeys.length} keys equal` : drift.slice(0, 5).join(", "),
      "0 drift",
    );

    // comparator must refuse the partial summary
    const compare = runCommand(
      evalTsx,
      [
        join(worktree, "packages/evaluation/src/regression/cli.ts"),
        "compare",
        BASELINE,
        summaryPath,
        "--json",
      ],
      {
        cwd: join(worktree, "packages/evaluation"),
      },
    );
    let report: {
      exitCode: number;
      counts: Record<string, number>;
      benches: { benchId: string; failing: boolean }[];
    } | null = null;
    try {
      report = JSON.parse(compare.stdout);
    } catch {
      report = null;
    }
    writeFileSync(join(outDir, "compare.json"), compare.stdout);
    const failingBenches = (report?.benches ?? [])
      .filter((b) => b.failing)
      .map((b) => b.benchId)
      .sort();
    check(
      checks,
      "compare of the partial summary exits 1 with the 4 subprocess benches failing and their metrics missing_in_candidate",
      compare.exitCode === 1 &&
        JSON.stringify(failingBenches) === JSON.stringify([...SUBPROCESS].sort()) &&
        (report?.counts.missing_in_candidate ?? 0) ===
          Object.keys(baselineMetrics).length - inProcessKeys.length,
      `exit ${compare.exitCode} failing=${JSON.stringify(failingBenches)} missing_in_candidate=${report?.counts.missing_in_candidate}`,
      `exit 1 failing=${JSON.stringify([...SUBPROCESS].sort())} missing_in_candidate=${Object.keys(baselineMetrics).length - inProcessKeys.length}`,
    );
  }

  const scratchAfter = readdirSync(tmpdir()).filter(
    (n) => n.startsWith("pickle-regression-") && !scratchBefore.has(n),
  );
  check(
    checks,
    "runner scratch dir cleaned up on failure",
    scratchAfter.length === 0,
    scratchAfter.join(",") || "none",
    "none",
  );

  const wave = readdirSync(join(worktree, "datasets/experiments/wave-e")).filter((n) =>
    /^event-recall-\d+\.json$/.test(n),
  );
  check(
    checks,
    "no stray event-recall output in worktree wave-e",
    wave.length === 0,
    wave.join(",") || "none",
    "none",
  );
} finally {
  runCommand("git", ["worktree", "remove", "--force", worktree], { cwd: REPO_ROOT });
  rmSync(worktree, { recursive: true, force: true });
  runCommand("git", ["worktree", "prune"], { cwd: REPO_ROOT });
}

finish("s4_missing_swing_lab_tsx", startedAtIso, checks, {
  worktree,
  commit,
  outDir,
  logs: join(OUT_DIR, "s4"),
});
