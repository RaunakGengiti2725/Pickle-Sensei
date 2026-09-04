/**
 * Structural audit probes (pkg-evaluation-bench, pass 1) — runner lifecycle.
 *
 * Every `it.fails(...)` below states the behaviour the runner SHOULD have and
 * is known to fail on 4d812e1aa699014cc0521fd92fde66908043aaa8; vitest reports
 * it green while the defect exists and red once it is fixed (flip it to `it`
 * at that point). Plain `it(...)` blocks pin behaviour that was verified to
 * hold. No production code or existing test is touched by this file.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  REPO_ROOT,
  SWING_LAB_DIR,
  TSX_BIN,
  benchDefinitions,
  type SubprocessResult,
  type SubprocessSpec,
} from "../../src/regression/benches.js";
import { main } from "../../src/regression/cli.js";
import {
  RUN_ID_PATTERN,
  executeBench,
  runRegression,
  runSubprocess,
  untrackedDatasetInputs,
} from "../../src/regression/run.js";
import { validateRegressionSummary } from "../../src/index.js";

const scratch = mkdtempSync(join(tmpdir(), "pickle-regression-audit-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const gitUntracked = (dir: string): string[] =>
  execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", dir], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter((line) => line.length > 0);

/** Fake `runSubprocess` that mimics a wrapped script writing `files` into a
 *  tracked dataset dir (what two concurrent runs, or a script emitting a
 *  sidecar, look like to `runCapturingNewFile`). */
function fakeSubprocess(files: Record<string, string>): (spec: SubprocessSpec) => SubprocessResult {
  return () => {
    for (const [path, body] of Object.entries(files)) writeFileSync(path, body);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

describe("runCapturingNewFile (benches.ts:264-278) leaves the tracked dataset dir as it found it", () => {
  const waveE = join(REPO_ROOT, "datasets/experiments/wave-e");
  const tag = `audit-probe-${process.pid}`;
  const strayA = join(waveE, `${tag}-a.json`);
  const strayB = join(waveE, `${tag}-b.json`);
  const strayC = join(waveE, `${tag}-c.json`);
  afterAll(() => {
    for (const path of [strayA, strayB, strayC]) if (existsSync(path)) unlinkSync(path);
  });

  it.fails("removes every file the wrapped script created when it created more than one", () => {
    expect(gitUntracked("datasets/experiments/wave-e")).toEqual([]);
    const definitions = benchDefinitions(
      fakeSubprocess({ [strayA]: "{}", [strayB]: "{}" }),
      scratch,
    );
    const eventRecall = definitions.find((definition) => definition.id === "event_recall")!;
    const record = executeBench(eventRecall, () => 0);
    expect(record.status).toBe("failed");
    expect(record.error).toMatch(/expected exactly one new file/);
    // Expected: the runner's own contract ("the working tree is left as it was
    // found", docs/EVALUATION.md §1.1) — observed on 4d812e1a: both files stay
    // behind as untracked dataset inputs and flip gitDirty for later runs.
    expect(gitUntracked("datasets/experiments/wave-e")).toEqual([]);
  });

  it.fails("removes the captured file when it is not valid JSON", () => {
    const definitions = benchDefinitions(fakeSubprocess({ [strayC]: "not json" }), scratch);
    const eventRecall = definitions.find((definition) => definition.id === "event_recall")!;
    const record = executeBench(eventRecall, () => 0);
    expect(record.status).toBe("failed");
    expect(existsSync(strayC)).toBe(false);
  });

  it("marks the tree dirty for the NEXT run once a stray survives (consequence of the above)", () => {
    writeFileSync(strayA, "{}");
    try {
      expect(untrackedDatasetInputs()).toContain(`datasets/experiments/wave-e/${tag}-a.json`);
    } finally {
      unlinkSync(strayA);
    }
  });
});

describe("runRegression dirty-tree caveat (run.ts:302-306)", () => {
  it.fails(
    "words the dirty-tree caveat truthfully when only an untracked dataset input exists",
    () => {
      const trackedChanges = execFileSync(
        "git",
        ["status", "--porcelain", "--untracked-files=no", "--", "datasets", "packages"],
        { cwd: REPO_ROOT, encoding: "utf8" },
      ).trim();
      expect(trackedChanges).toBe("");
      const stray = join(
        REPO_ROOT,
        "datasets/completion-bench",
        `audit-caveat-${process.pid}.json`,
      );
      const outDir = join(scratch, "caveat");
      writeFileSync(stray, "{}");
      try {
        const result = runRegression({
          outDir,
          only: ["coach_gates"],
          runId: "caveat-probe",
          log: () => {},
        });
        expect(result.summary.provenance.gitDirty).toBe(true);
        const caveat = result.summary.caveats.find((line) => line.includes("Working tree")) ?? "";
        // Observed on 4d812e1a: "Working tree had uncommitted tracked changes"
        // although no tracked file changed — the dirtiness came from an
        // untracked bench input (run.ts:136-141 vs run.ts:304).
        expect(caveat).not.toMatch(/uncommitted tracked changes/);
      } finally {
        unlinkSync(stray);
      }
    },
  );
});

describe("CLI flag handling (cli.ts:54-75)", () => {
  it.fails("rejects a misspelled --run-id instead of silently writing a timestamped file", () => {
    const outDir = join(scratch, "typo-run");
    const code = main(["run", "--only", "coach_gates", "--out-dir", outDir, "--runid", "wanted"]);
    const written = existsSync(outDir) ? readdirSync(outDir) : [];
    // Expected: usage error (exit 2) or the requested file name. Observed on
    // 4d812e1a: exit 0 and `<timestamp>.json` — the unknown flag is dropped.
    expect([code, written]).toEqual([2, []]);
  });

  it.fails(
    "rejects a misspelled --tolerances instead of silently comparing with the defaults",
    () => {
      const baseline = join(REPO_ROOT, "datasets/reports/regression/baseline.json");
      const strict = join(scratch, "strict-tolerances.json");
      // A tolerance file that is INVALID: honoured, it must yield exit 2.
      writeFileSync(strict, JSON.stringify({ configVersion: 999 }));
      const code = main(["compare", baseline, baseline, "--tolerance", strict]);
      expect(code).toBe(2);
    },
  );

  it("documents the accepted run-id grammar", () => {
    expect(RUN_ID_PATTERN.test("2026-09-04T02-24-36.147Z")).toBe(true);
    expect(RUN_ID_PATTERN.test(".hidden")).toBe(false);
    expect(RUN_ID_PATTERN.test("a/b")).toBe(false);
    expect(RUN_ID_PATTERN.test("a".repeat(129))).toBe(false);
  });
});

describe("runSubprocess (run.ts:156-169)", () => {
  const scriptsDir = join(scratch, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  const script = (name: string, body: string): SubprocessSpec => {
    writeFileSync(join(scriptsDir, name), body);
    return { script: name, args: [], cwd: scriptsDir };
  };

  it("uses the swing-lab tsx binary, which is installed", () => {
    expect(TSX_BIN.startsWith(SWING_LAB_DIR)).toBe(true);
    expect(existsSync(TSX_BIN)).toBe(true);
  });

  it("records a signal-killed script as a failed bench (tsx shim exits 128+signal), not a crash", () => {
    const spec = script("die.ts", 'process.kill(process.pid, "SIGKILL");');
    const result = runSubprocess(spec);
    // The tsx shim survives its child and exits 137; `status ?? -1` only
    // applies when the shim itself is signalled.
    expect(result.exitCode).toBe(137);
    // Route a real subprocess bench through the dying script.
    let lastExit: number | null = null;
    const definitions = benchDefinitions(() => {
      const outcome = runSubprocess(spec);
      lastExit = outcome.exitCode;
      return outcome;
    }, scratch);
    const hardSlice = definitions.find((definition) => definition.id === "ball_hard_slice")!;
    const record = executeBench(hardSlice, () => lastExit);
    expect(record.status).toBe("failed");
    expect(record.exitCode).toBe(137);
    expect(record.metrics).toEqual({});
  });

  it("turns a maxBuffer overflow (>64 MiB stdout) into a thrown error, i.e. a failed bench", () => {
    const spec = script(
      "flood.ts",
      'const chunk = "x".repeat(1 << 20); for (let i = 0; i < 70; i += 1) process.stdout.write(chunk);',
    );
    expect(() => runSubprocess(spec)).toThrow(/ENOBUFS|maxBuffer/);
  });

  it.fails("bounds a hung subprocess (no timeout is configured)", () => {
    const spec = script("hang.ts", "setTimeout(() => {}, 2500);");
    const started = Date.now();
    runSubprocess(spec);
    // Expected: some upper bound. Observed on 4d812e1a: spawnSync has no
    // `timeout`, so the runner blocks for as long as the script does.
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("summary written by a partial run", () => {
  it("validates and is rejected by compare as missing benches (fail-closed)", () => {
    const outDir = join(scratch, "partial");
    const result = runRegression({
      outDir,
      only: ["coach_gates"],
      runId: "partial",
      log: () => {},
    });
    const doc: unknown = JSON.parse(readFileSync(result.outPath, "utf8"));
    expect(validateRegressionSummary(doc).ok).toBe(true);
    const baseline = join(REPO_ROOT, "datasets/reports/regression/baseline.json");
    expect(main(["compare", baseline, result.outPath])).toBe(1);
  });
});
