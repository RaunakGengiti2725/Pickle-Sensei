/**
 * Adversarial pass (pkg-evaluation-bench, pass 3) — runner / provenance attacks.
 *
 * These tests drive the REAL runner against the REAL checkout: concurrent
 * runs, cancellation mid-flight, untracked dataset inputs. Every file they
 * create under `datasets/` is recorded and removed again in `finally`; only
 * files that did not exist before the test are ever deleted.
 *
 * `it(...)` = behaviour that HELD; `it.fails(...)` = the behaviour the runner
 * SHOULD have, expected to fail today (documents a reproduced gap).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REPO_ROOT, TSX_BIN } from "../../src/regression/benches.js";
import { DEFAULT_TOLERANCES_PATH, loadTolerances } from "../../src/regression/cli.js";
import { compareSummaries } from "../../src/regression/compare.js";
import {
  datasetsInputTreeSha,
  isTreeDirty,
  runRegression,
  untrackedDatasetInputs,
} from "../../src/regression/run.js";

const CLI_PATH = join(REPO_ROOT, "packages/evaluation/src/regression/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "pickle-regression-attack-run-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const tolerances = loadTolerances(join(REPO_ROOT, DEFAULT_TOLERANCES_PATH));
const quiet = (): void => {};

/** Untracked bench-input files in the real checkout (what makes gitDirty flip). */
const strays = (): string[] => untrackedDatasetInputs(REPO_ROOT);
const removeStrays = (paths: string[]): void => {
  for (const rel of paths) {
    const abs = join(REPO_ROOT, rel);
    if (existsSync(abs)) unlinkSync(abs);
  }
};

interface Finished {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}
function startRunner(args: string[]): { child: ChildProcess; done: Promise<Finished> } {
  const child = spawn(TSX_BIN, [CLI_PATH, "run", ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const done = new Promise<Finished>((resolveDone) =>
    child.on("close", (status, signal) => resolveDone({ status, signal, stdout, stderr })),
  );
  return { child, done };
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const pgrep = (pattern: string): number[] =>
  (spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" }).stdout ?? "")
    .split("\n")
    .filter((line) => line.length > 0)
    .map(Number);

describe("S1 — concurrent runs leave strays; any later run is dirty until they are deleted", () => {
  it("reproduces the race, then gitDirty === true and CONFOUND provenance.gitDirty until cleanup", async () => {
    const preDirty = isTreeDirty(REPO_ROOT);
    const before = new Set(strays());
    const created: string[] = [];
    try {
      // Two runners start at the same instant; each file-capturing bench
      // writes a timestamped report into a COMMITTED dataset dir and expects
      // to be the only writer. Retry a few times — it is a real race.
      let raced = false;
      for (let attempt = 0; attempt < 3 && !raced; attempt += 1) {
        const outDir = join(scratch, `conc-${attempt}`);
        const runs = ["A", "B"].map((tag) =>
          startRunner(["--out-dir", outDir, "--run-id", tag, "--only", "event_recall"]),
        );
        const finished = await Promise.all(runs.map((run) => run.done));
        const fresh = strays().filter((path) => !before.has(path));
        created.push(...fresh.filter((path) => !created.includes(path)));
        raced = fresh.length > 0;
        if (raced) {
          expect(finished.some((run) => run.status === 1)).toBe(true);
          expect(finished.map((run) => run.stdout).join("")).toMatch(
            /expected exactly one new file in datasets\/experiments\/wave-e, found 2/,
          );
        }
      }
      if (!raced) {
        // Same end state the race leaves behind: an orphaned report in a committed input dir.
        const rel = "datasets/experiments/wave-e/event-recall-attack-stray.json";
        writeFileSync(join(REPO_ROOT, rel), "{}");
        created.push(rel);
      }
      process.stdout.write(
        `S1 race ${raced ? "reproduced" : "did not manifest (fallback stray)"}: ${created.join(", ")}\n`,
      );
      expect(strays().some((path) => created.includes(path))).toBe(true);

      const dirty = runRegression({
        outDir: join(scratch, "dirty"),
        only: ["coach_gates"],
        runId: "dirty",
        log: quiet,
      });
      expect(dirty.summary.provenance.gitDirty).toBe(true);
      const cleanCandidate = runRegression({
        outDir: join(scratch, "reference"),
        only: ["coach_gates"],
        runId: "reference",
        log: quiet,
      });
      const report = compareSummaries(cleanCandidate.summary, dirty.summary, tolerances);
      expect(report.warnings).toContainEqual(
        expect.stringMatching(/^CONFOUND provenance\.gitDirty: baseline=true candidate=true/),
      );

      removeStrays(created);
      expect(strays().filter((path) => created.includes(path))).toEqual([]);
      const clean = runRegression({
        outDir: join(scratch, "clean"),
        only: ["coach_gates"],
        runId: "clean",
        log: quiet,
      });
      expect(clean.summary.provenance.gitDirty).toBe(preDirty);
      const afterReport = compareSummaries(clean.summary, clean.summary, tolerances);
      if (!preDirty) {
        expect(afterReport.warnings.filter((w) => w.includes("gitDirty"))).toEqual([]);
      }
      expect(clean.summary.provenance.datasetsTreeSha).toBe(
        dirty.summary.provenance.datasetsTreeSha,
      );
    } finally {
      removeStrays(created);
    }
  }, 60_000);

  it.fails(
    "a runner that finds a competing report should not leave BOTH files behind (gap)",
    async () => {
      const before = new Set(strays());
      const created: string[] = [];
      try {
        const outDir = join(scratch, "conc-cleanup");
        const runs = ["A", "B"].map((tag) =>
          startRunner(["--out-dir", outDir, "--run-id", tag, "--only", "completion_bench"]),
        );
        await Promise.all(runs.map((run) => run.done));
        created.push(...strays().filter((path) => !before.has(path)));
        // Either the race did not manifest (fine) or nothing was left behind.
        expect(created).toEqual([]);
      } finally {
        removeStrays(created);
      }
    },
    60_000,
  );
});

describe("S3 — untracked datasets/gold file flips gitDirty true→false; datasetsTreeSha is stable", () => {
  it("in the real checkout (guarded: datasets/gold must not pre-exist)", () => {
    const goldDir = join(REPO_ROOT, "datasets/gold");
    expect(existsSync(goldDir)).toBe(false);
    const preDirty = isTreeDirty(REPO_ROOT);
    const shaBefore = datasetsInputTreeSha(REPO_ROOT);
    mkdirSync(goldDir);
    const stray = join(goldDir, "stray.json");
    try {
      writeFileSync(stray, '{"attack":"s3","seed":20260904}\n');
      expect(
        spawnSync("git", ["check-ignore", "-q", "datasets/gold/stray.json"], { cwd: REPO_ROOT })
          .status,
      ).toBe(1);
      expect(untrackedDatasetInputs(REPO_ROOT)).toContain("datasets/gold/stray.json");
      const withStray = runRegression({
        outDir: join(scratch, "s3"),
        only: ["coach_gates"],
        runId: "with-stray",
        log: quiet,
      });
      expect(withStray.summary.provenance.gitDirty).toBe(true);
      expect(withStray.summary.provenance.datasetsTreeSha).toBe(shaBefore);

      unlinkSync(stray);
      rmSync(goldDir, { recursive: true });
      const without = runRegression({
        outDir: join(scratch, "s3"),
        only: ["coach_gates"],
        runId: "no-stray",
        log: quiet,
      });
      expect(without.summary.provenance.gitDirty).toBe(preDirty);
      expect(without.summary.provenance.datasetsTreeSha).toBe(shaBefore);
    } finally {
      if (existsSync(stray)) unlinkSync(stray);
      if (existsSync(goldDir)) rmSync(goldDir, { recursive: true });
    }
  }, 30_000);

  it("in an isolated repo: dirty flag follows the untracked input, the tree sha never moves", () => {
    const repo = join(scratch, "gold-repo");
    const git = (...args: string[]): string =>
      spawnSync("git", args, {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      }).stdout.trim();
    mkdirSync(join(repo, "datasets/gold"), { recursive: true });
    writeFileSync(join(repo, "datasets/gold/a.json"), "1");
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "inputs");
    const sha = datasetsInputTreeSha(repo);
    expect(isTreeDirty(repo)).toBe(false);
    // Rapid repeats: create/remove 20 times, sha must never move, flag must track.
    for (let i = 0; i < 20; i += 1) {
      const stray = join(repo, `datasets/gold/stray-${i}.json`);
      writeFileSync(stray, String(i));
      expect(isTreeDirty(repo)).toBe(true);
      expect(datasetsInputTreeSha(repo)).toBe(sha);
      unlinkSync(stray);
      expect(isTreeDirty(repo)).toBe(false);
      expect(datasetsInputTreeSha(repo)).toBe(sha);
    }
    // Unicode / space / leading-dot names count too.
    for (const name of ["ünï.json", "with space.json", ".hidden.json", "\u202e.json"]) {
      const stray = join(repo, "datasets/gold", name);
      writeFileSync(stray, "x");
      expect(isTreeDirty(repo)).toBe(true);
      unlinkSync(stray);
    }
    expect(isTreeDirty(repo)).toBe(false);
    // Untracked files outside datasets/ are out of scope by design.
    mkdirSync(join(repo, "elsewhere"));
    writeFileSync(join(repo, "elsewhere/x.json"), "x");
    expect(isTreeDirty(repo)).toBe(false);
  });
});

describe("extra — run-id collision guard and cancellation", () => {
  it.fails(
    "two concurrent runs with the same --run-id: at most one may succeed (TOCTOU gap)",
    async () => {
      const outDir = join(scratch, "same-id");
      const runs = [0, 1].map(() =>
        startRunner(["--out-dir", outDir, "--run-id", "same", "--only", "coach_gates"]),
      );
      const finished = await Promise.all(runs.map((run) => run.done));
      const refusals = finished.filter((run) => /refusing to overwrite/.test(run.stderr));
      expect(finished.filter((run) => run.status === 0)).toHaveLength(1);
      expect(refusals).toHaveLength(1);
    },
    60_000,
  );

  it.fails(
    "SIGTERM during a file-capturing bench leaves no orphaned report in datasets/ (gap)",
    async () => {
      const before = new Set(strays());
      const created: string[] = [];
      try {
        const { child, done } = startRunner([
          "--out-dir",
          join(scratch, "cancel"),
          "--run-id",
          "cancel",
          "--only",
          "event_recall",
        ]);
        // Wait for the bench subprocess to exist, then kill the parent runner.
        let seen = false;
        for (let i = 0; i < 500 && !seen; i += 1) {
          seen = pgrep("eventRecallBench").length > 0;
          if (!seen) await sleep(10);
        }
        expect(seen).toBe(true);
        child.kill("SIGTERM");
        const finished = await done;
        expect(finished.signal ?? finished.status).not.toBe(0);
        // Give the orphaned tsx child time to finish writing its report.
        for (let i = 0; i < 100 && pgrep("eventRecallBench").length > 0; i += 1) await sleep(50);
        created.push(...strays().filter((path) => !before.has(path)));
        process.stdout.write(
          `X19 runner ended signal=${finished.signal} status=${finished.status}; orphaned: ${created.join(", ") || "none"}\n`,
        );
        expect(created).toEqual([]);
      } finally {
        removeStrays(created);
      }
    },
    60_000,
  );

  it("--only ',' (an empty id list) runs the FULL suite and omits the partial-run caveat", () => {
    // cli.ts splits "," into [] and run.ts treats an empty list as 'all benches'.
    const result = runRegression({
      outDir: join(scratch, "only-empty"),
      only: [],
      runId: "only-empty",
      log: quiet,
    });
    expect(result.summary.benches).toHaveLength(9);
    expect(result.summary.caveats.some((line) => line.startsWith("Partial run"))).toBe(false);
  }, 60_000);

  it.fails(
    "gitDirty caveat text should not claim 'uncommitted tracked changes' when only an untracked input is present",
    () => {
      const goldDir = join(REPO_ROOT, "datasets/gold");
      expect(existsSync(goldDir)).toBe(false);
      mkdirSync(goldDir);
      try {
        writeFileSync(join(goldDir, "stray.json"), "{}");
        const result = runRegression({
          outDir: join(scratch, "caveat"),
          only: ["coach_gates"],
          runId: "caveat",
          log: quiet,
        });
        expect(result.summary.provenance.gitDirty).toBe(true);
        expect(result.summary.caveats.join("\n")).not.toContain("uncommitted tracked changes");
      } finally {
        rmSync(goldDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
