/**
 * Adversarial pass 3 over the Linux regression runner / compare CLI
 * (packages/evaluation/src/regression). Every test drives the REAL entry
 * points — `tsx src/regression/cli.ts` as a child process, or `main()` /
 * `runRegression()` / `benchDefinitions()` in-process — against committed
 * fixtures only. Nothing here writes into datasets/ or touches the baseline;
 * everything lands in a mkdtemp scratch that is removed afterwards.
 *
 * Each `it` pins the behaviour that was OBSERVED at 4d812e1a. Where that
 * behaviour is a finding (leaked scratch, TOCTOU overwrite, late writability
 * check) the assertion documents the current state so a fix flips the test
 * and the tolerance/docs can be updated together.
 */
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  REPO_ROOT,
  SWING_LAB_DIR,
  TSX_BIN,
  benchDefinitions,
  type SubprocessResult,
  type SubprocessSpec,
} from "../../src/regression/benches.js";
import { main } from "../../src/regression/cli.js";
import { RUN_ID_PATTERN, runRegression, runSubprocess } from "../../src/regression/run.js";
import { validateRegressionSummary } from "../../src/regression/summarySchema.js";

const CLI = join(REPO_ROOT, "packages/evaluation/src/regression/cli.ts");
const EVAL_DIR = join(REPO_ROOT, "packages/evaluation");
const BASELINE = join(REPO_ROOT, "datasets/reports/regression/baseline.json");
const D3_05 = join(REPO_ROOT, "datasets/experiments/wave-d3/d3-05-measure-gold.ts");

const scratch = mkdtempSync(join(tmpdir(), "pickle-regression-attack-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

interface CliRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Real CLI through the same tsx binary the runner uses for its benches. */
function cli(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): CliRun {
  const result: SpawnSyncReturns<string> = spawnSync(TSX_BIN, [CLI, ...args], {
    cwd: options.cwd ?? EVAL_DIR,
    encoding: "utf8",
    env: options.env ?? { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function envWithout(...names: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" };
  for (const name of names) delete env[name];
  return env;
}

/** Scratch dirs the runner's own mkdtempSync produced inside `tmp`. */
function scratchDirsNow(tmp: string): Set<string> {
  return new Set(
    readdirSync(tmp).filter((name) => /^pickle-regression-[A-Za-z0-9]{6}$/.test(name)),
  );
}

/** A private TMPDIR per attack so parallel test files cannot pollute the count. */
function privateTmp(name: string): string {
  const dir = join(scratch, `${name}-tmp`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function untrackedDatasets(): string[] {
  const result = spawnSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "--", "datasets"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  expect(result.status).toBe(0);
  return result.stdout.split("\n").filter((line) => line.length > 0);
}

/** Capture stderr/stdout written by in-process `main()` without leaking it. */
function captureMain(argv: string[]): { code: number; stderr: string; stdout: string } {
  const errChunks: string[] = [];
  const outChunks: string[] = [];
  const origError = console.error;
  const origWrite = process.stdout.write.bind(process.stdout);
  console.error = (...args: unknown[]) => {
    errChunks.push(args.map(String).join(" "));
  };
  process.stdout.write = ((chunk: string | Uint8Array) => {
    outChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = main(argv);
    return { code, stderr: errChunks.join("\n"), stdout: outChunks.join("") };
  } finally {
    console.error = origError;
    process.stdout.write = origWrite;
  }
}

describe("S1 — phase_gold_d3_05 last-line parsing", () => {
  it("a d3-05 copy that prints one extra line after the JSON fails the bench — with a bare JSON.parse SyntaxError, not BenchDataError", () => {
    const original = readFileSync(D3_05, "utf8");
    expect(original).toContain('from "../../../packages/swing-lab/src/phaseTemporal.js"');
    expect(original).toContain('const ROOT = join(import.meta.dirname ?? ".", "..", "..", "..");');
    const copyDir = join(scratch, "s1");
    mkdirSync(copyDir, { recursive: true });
    const copyPath = join(copyDir, "d3-05-measure-gold-extra-line.ts");
    const rewritten =
      original
        .replace(
          '"../../../packages/swing-lab/src/phaseTemporal.js"',
          JSON.stringify(join(SWING_LAB_DIR, "src/phaseTemporal.ts")),
        )
        .replace(
          'const ROOT = join(import.meta.dirname ?? ".", "..", "..", "..");',
          `const ROOT = ${JSON.stringify(REPO_ROOT)};`,
        ) + '\nconsole.log("trailing diagnostic line after the JSON summary");\n';
    writeFileSync(copyPath, rewritten);

    // Sanity: the copy itself runs green and its LAST stdout line is not JSON.
    const direct = runSubprocess({
      script: relative(SWING_LAB_DIR, copyPath),
      args: [],
      cwd: SWING_LAB_DIR,
    });
    expect(direct.exitCode).toBe(0);
    const lines = direct.stdout.trim().split("\n");
    expect(lines.at(-1)).toBe("trailing diagnostic line after the JSON summary");
    expect(() => JSON.parse(lines.at(-2) ?? "")).not.toThrow();

    // Route the bench's own spec at the copy: only the script path is swapped.
    const seen: SubprocessSpec[] = [];
    const redirect = (spec: SubprocessSpec): SubprocessResult => {
      seen.push(spec);
      const script = spec.script.endsWith("d3-05-measure-gold.ts")
        ? relative(SWING_LAB_DIR, copyPath)
        : spec.script;
      return runSubprocess({ ...spec, script });
    };
    const bench = benchDefinitions(redirect, join(scratch, "s1-scratch")).find(
      (definition) => definition.id === "phase_gold_d3_05",
    );
    expect(bench).toBeDefined();
    let thrown: unknown;
    try {
      bench!.run();
    } catch (error) {
      thrown = error;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]!.script).toMatch(/d3-05-measure-gold\.ts$/);
    // OBSERVED: the failure is a raw JSON.parse SyntaxError from the runner's
    // `JSON.parse(last)`, NOT a BenchDataError — the bench still records
    // `failed`, but the error class the scenario expected does not surface.
    expect(thrown).toBeInstanceOf(SyntaxError);
    expect((thrown as Error).constructor.name).toBe("SyntaxError");
    expect((thrown as Error).message).toMatch(/Unexpected token|is not valid JSON/);
  });
});

describe("S2 — --out-dir on a read-only (chmod 555) directory", () => {
  it.skipIf(isRoot)(
    "runs every bench first and only then dies with EACCES → exit 2, summary lost, scratch removed",
    () => {
      const outDir = join(scratch, "s2-ro");
      mkdirSync(outDir);
      chmodSync(outDir, 0o555);
      const tmp = privateTmp("s2");
      const before = scratchDirsNow(tmp);
      try {
        const run = cli(
          ["run", "--out-dir", outDir, "--run-id", "s2", "--only", "coach_gates,stroke_heuristic"],
          {
            env: { ...process.env, TMPDIR: tmp, FORCE_COLOR: "0", NO_COLOR: "1" },
          },
        );
        expect(run.status).toBe(2);
        // Benches already executed before the write is attempted.
        expect(run.stdout).toMatch(/ok\s+stroke_heuristic/);
        expect(run.stdout).toMatch(/ok\s+coach_gates/);
        expect(run.stderr).toMatch(/EACCES: permission denied, open '.*s2\.json'/);
        expect(run.stderr).toMatch(/at writeFileSync/);
        expect(existsSync(join(outDir, "s2.json"))).toBe(false);
        // finally{} did run: no scratch leaked on this path.
        const after = scratchDirsNow(tmp);
        expect([...after].filter((name) => !before.has(name))).toEqual([]);
      } finally {
        chmodSync(outDir, 0o755);
      }
    },
  );
});

describe("S3 — TMPDIR pointing at a non-existent directory", () => {
  it("runRegression: mkdtempSync throws ENOENT before any bench runs; main() maps it to exit 2 with no summary", () => {
    const saved = process.env.TMPDIR;
    const bogus = join(scratch, "s3-no-such-tmp");
    const outDir = join(scratch, "s3-out");
    const logs: string[] = [];
    process.env.TMPDIR = bogus;
    try {
      expect(tmpdir()).toBe(bogus);
      let thrown: unknown;
      try {
        runRegression({
          outDir,
          runId: "s3",
          only: ["coach_gates"],
          log: (line) => logs.push(line),
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as NodeJS.ErrnoException).code).toBe("ENOENT");
      expect((thrown as NodeJS.ErrnoException).syscall).toBe("mkdtemp");
      // No "regression run …" banner, no bench lines: nothing ran.
      expect(logs).toEqual([]);
      expect(existsSync(outDir)).toBe(false);

      const viaMain = captureMain([
        "run",
        "--out-dir",
        outDir,
        "--run-id",
        "s3",
        "--only",
        "coach_gates",
      ]);
      expect(viaMain.code).toBe(2);
      expect(viaMain.stderr).toMatch(/ENOENT: no such file or directory, mkdtemp/);
      expect(viaMain.stdout).toBe("");
      expect(existsSync(outDir)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });

  it("through the tsx CLI the launcher creates a missing TMPDIR itself, so the run SUCCEEDS (the runner never sees ENOENT)", () => {
    const bogus = join(scratch, "s3-cli-missing-tmp");
    const outDir = join(scratch, "s3-cli-out");
    expect(existsSync(bogus)).toBe(false);
    const run = cli(["run", "--out-dir", outDir, "--run-id", "s3cli", "--only", "coach_gates"], {
      env: { ...process.env, TMPDIR: bogus, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    expect(run.status).toBe(0);
    expect(existsSync(join(outDir, "s3cli.json"))).toBe(true);
    // tsx's cache dir is what materialised TMPDIR before cli.ts loaded.
    expect(readdirSync(bogus).some((name) => name.startsWith("tsx-"))).toBe(true);
  });

  it("through the tsx CLI an UNUSABLE TMPDIR (regular file) fails inside tsx with exit 1 — colliding with 'a bench failed', and no summary", () => {
    const file = join(scratch, "s3-tmp-is-a-file");
    writeFileSync(file, "not a directory\n");
    const outDir = join(scratch, "s3-file-out");
    const run = cli(["run", "--out-dir", outDir, "--run-id", "s3file", "--only", "coach_gates"], {
      env: { ...process.env, TMPDIR: file, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/ENOTDIR: not a directory, mkdir/);
    expect(run.stderr).toMatch(/tsx\/dist\/cli\.mjs/);
    expect(run.stdout).toBe("");
    expect(existsSync(outDir)).toBe(false);
  });
});

describe("S4 — --run-id length boundary through the real CLI", () => {
  const id128 = `a${"b".repeat(127)}`;
  const id129 = `a${"b".repeat(128)}`;

  it("128 chars is accepted (exit 0, file named <id>.json)", () => {
    expect(id128).toHaveLength(128);
    expect(RUN_ID_PATTERN.test(id128)).toBe(true);
    const outDir = join(scratch, "s4-128");
    const run = cli(["run", "--out-dir", outDir, "--run-id", id128, "--only", "coach_gates"]);
    expect(run.status).toBe(0);
    expect(readdirSync(outDir)).toEqual([`${id128}.json`]);
  });

  it("129 chars is rejected before anything runs (exit 2, no out-dir created)", () => {
    expect(id129).toHaveLength(129);
    expect(RUN_ID_PATTERN.test(id129)).toBe(false);
    const outDir = join(scratch, "s4-129");
    const run = cli(["run", "--out-dir", outDir, "--run-id", id129, "--only", "coach_gates"]);
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/invalid run id/);
    expect(run.stdout).toBe("");
    expect(existsSync(outDir)).toBe(false);
  });

  it("unicode / separator / leading-dot ids are all rejected with exit 2", () => {
    for (const bad of ["ünïcödé", "日本", "a/b", "a\\b", ".hidden", "..", "a b"]) {
      const outDir = join(scratch, "s4-bad");
      const run = cli(["run", "--out-dir", outDir, "--run-id", bad, "--only", "coach_gates"]);
      expect(run.status, `run id ${JSON.stringify(bad)}`).toBe(2);
      expect(existsSync(outDir)).toBe(false);
    }
  });

  it("an EMPTY --run-id is silently replaced by the timestamp default instead of being rejected", () => {
    const outDir = join(scratch, "s4-empty");
    const run = cli(["run", "--out-dir", outDir, "--run-id", "", "--only", "coach_gates"]);
    // OBSERVED: `flagString` yields "" and `runId ? {runId} : {}` drops it, so
    // the CLI accepts the argument and names the file after the clock.
    expect(run.status).toBe(0);
    const written = readdirSync(outDir);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.json$/);
  });
});

describe("S5 — relative --out-dir resolution", () => {
  it("INIT_CWD unset: lands under process.cwd() — the package dir when invoked there, any other cwd otherwise", () => {
    const other = join(scratch, "s5-other-cwd");
    mkdirSync(other);
    const fromOther = cli(
      ["run", "--out-dir", "rel-out", "--run-id", "s5b", "--only", "coach_gates"],
      {
        cwd: other,
        env: envWithout("INIT_CWD"),
      },
    );
    expect(fromOther.status).toBe(0);
    expect(existsSync(join(other, "rel-out/s5b.json"))).toBe(true);
    expect(fromOther.stdout).toContain(`wrote ${join(other, "rel-out/s5b.json")}`);
    // Never resolved against REPO_ROOT despite runRegression's own fallback.
    expect(existsSync(join(REPO_ROOT, "rel-out"))).toBe(false);
    expect(existsSync(join(EVAL_DIR, "rel-out"))).toBe(false);
  });

  it("INIT_CWD set: wins over cwd even when it points somewhere unrelated", () => {
    const initCwd = join(scratch, "s5-init-cwd");
    mkdirSync(initCwd);
    const run = cli(["run", "--out-dir", "rel-out", "--run-id", "s5f", "--only", "coach_gates"], {
      cwd: EVAL_DIR,
      env: { ...envWithout("INIT_CWD"), INIT_CWD: initCwd },
    });
    expect(run.status).toBe(0);
    expect(existsSync(join(initCwd, "rel-out/s5f.json"))).toBe(true);
    expect(existsSync(join(EVAL_DIR, "rel-out"))).toBe(false);
  });
});

describe("S6 — contractVersion mismatch is non-comparable (direct exit 3)", () => {
  it("compare exits 3 in-process and via the tsx CLI; the pnpm-9 remap to exit 1 is pinned by attack-pnpm-exit-codes.mjs", () => {
    const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as { contractVersion: number };
    expect(baseline.contractVersion).toBe(1);
    const candidatePath = join(scratch, "s6-contract2.json");
    writeFileSync(
      candidatePath,
      `${JSON.stringify({ ...baseline, contractVersion: 2, runId: "s6" }, null, 2)}\n`,
    );
    const validated = validateRegressionSummary(JSON.parse(readFileSync(candidatePath, "utf8")));
    expect(validated.ok).toBe(true);

    const inProcess = captureMain(["compare", BASELINE, candidatePath, "--json"]);
    expect(inProcess.code).toBe(3);
    const report = JSON.parse(inProcess.stdout) as {
      exitCode: number;
      comparable: boolean;
      identityDifferences: Array<{ field: string; severity: string }>;
    };
    expect(report.exitCode).toBe(3);
    expect(report.comparable).toBe(false);
    expect(
      report.identityDifferences.some(
        (diff) => diff.field === "contractVersion" && diff.severity === "non_comparable",
      ),
    ).toBe(true);

    const viaCli = cli(["compare", BASELINE, candidatePath]);
    expect(viaCli.status).toBe(3);
  });
});

describe("S7 — SIGINT while a subprocess bench is running", () => {
  const leaked: string[] = [];
  afterEach(() => {
    for (const path of leaked) rmSync(path, { recursive: true, force: true });
    leaked.length = 0;
  });

  async function interruptAfter(
    marker: RegExp,
    outDir: string,
  ): Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    newScratch: string[];
    newDatasetFiles: string[];
  }> {
    const tmp = privateTmp(`s7-${outDir.split("/").at(-1)}`);
    const scratchBefore = scratchDirsNow(tmp);
    const datasetsBefore = new Set(untrackedDatasets());
    const child = spawn(TSX_BIN, [CLI, "run", "--out-dir", outDir, "--run-id", "s7"], {
      cwd: EVAL_DIR,
      env: { ...process.env, TMPDIR: tmp, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let sent = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (!sent && marker.test(stdout)) {
        sent = true;
        // Give the next bench time to spawn its tsx subprocess, then interrupt
        // the runner the way a terminal Ctrl-C does (SIGINT to the process).
        setTimeout(() => child.kill("SIGINT"), 150);
      }
    });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit) => {
        child.on("exit", (code, signal) => resolveExit({ code, signal }));
      },
    );
    expect(sent, "marker never appeared — bench order changed?").toBe(true);
    // Orphaned bench subprocesses finish on their own; wait for them.
    await new Promise((resolveWait) => setTimeout(resolveWait, 4000));
    const newScratch = [...scratchDirsNow(tmp)]
      .filter((name) => !scratchBefore.has(name))
      .map((name) => join(tmp, name));
    const newDatasetFiles = untrackedDatasets()
      .filter((path) => !datasetsBefore.has(path))
      .map((path) => join(REPO_ROOT, path));
    leaked.push(...newScratch, ...newDatasetFiles);
    return { ...exit, stdout, newScratch, newDatasetFiles };
  }

  it("during ball_hard_slice: exit 130, scratch /tmp/pickle-regression-* LEAKS with the orphan's ball-hard-slice.json, no summary", async () => {
    const outDir = join(scratch, "s7-slice");
    const result = await interruptAfter(/ok\s+ownership_dual_frame/, outDir);
    expect(result.code === 130 || result.signal === "SIGINT").toBe(true);
    expect(existsSync(outDir)).toBe(false);
    // finally{} never ran: the scratch directory survives the interrupted run.
    expect(result.newScratch).toHaveLength(1);
    const contents = readdirSync(result.newScratch[0]!);
    // The orphaned tsx child kept running and completed its write into scratch.
    expect(contents).toEqual(["ball-hard-slice.json"]);
    expect(statSync(join(result.newScratch[0]!, "ball-hard-slice.json")).size).toBeGreaterThan(0);
    expect(result.stdout).not.toMatch(/ball_hard_slice/);
  }, 60_000);

  it("during completion_bench: the orphan writes a timestamped JSON into datasets/completion-bench that nothing removes — and it flips gitDirty for every later run", async () => {
    const outDir = join(scratch, "s7-completion");
    const result = await interruptAfter(/ok\s+event_recall/, outDir);
    expect(result.code === 130 || result.signal === "SIGINT").toBe(true);
    expect(existsSync(outDir)).toBe(false);
    expect(result.newScratch).toHaveLength(1);
    expect(result.newDatasetFiles).toHaveLength(1);
    expect(result.newDatasetFiles[0]).toMatch(/datasets\/completion-bench\/completion-\d+\.json$/);
    // It is a complete, parseable file (the child finished after the parent died).
    expect(() => JSON.parse(readFileSync(result.newDatasetFiles[0]!, "utf8"))).not.toThrow();

    // Poisoned provenance: a clean-tree run now reports gitDirty with a caveat
    // that talks about "tracked changes" although only this orphan exists.
    const follow = cli([
      "run",
      "--out-dir",
      join(scratch, "s7-follow"),
      "--run-id",
      "after",
      "--only",
      "coach_gates",
    ]);
    expect(follow.status).toBe(0);
    expect(follow.stdout).toMatch(/\(dirty tree\)/);
    const summary = JSON.parse(readFileSync(join(scratch, "s7-follow/after.json"), "utf8")) as {
      provenance: { gitDirty: boolean };
      caveats: string[];
    };
    expect(summary.provenance.gitDirty).toBe(true);
    expect(summary.caveats.some((caveat) => caveat.includes("uncommitted tracked changes"))).toBe(
      true,
    );
  }, 60_000);
});

describe("S8 — candidate truncated mid-string", () => {
  it("compare reports the JSON parse error and exits 2 (in-process and direct CLI); pnpm-9's exit 1 is pinned by attack-pnpm-exit-codes.mjs", () => {
    const text = readFileSync(BASELINE, "utf8");
    const cut = text.indexOf('"runId"') + 12;
    expect(cut).toBeGreaterThan(12);
    const truncated = join(scratch, "s8-truncated.json");
    writeFileSync(truncated, text.slice(0, cut));

    const inProcess = captureMain(["compare", BASELINE, truncated]);
    expect(inProcess.code).toBe(2);
    expect(inProcess.stderr).toMatch(/in JSON at position \d+|Unterminated string in JSON/);
    // The message names neither the file nor the argument that failed.
    expect(inProcess.stderr).not.toContain("s8-truncated.json");

    const viaCli = cli(["compare", BASELINE, truncated]);
    expect(viaCli.status).toBe(2);
    expect(viaCli.stdout).toBe("");
  });

  it("an empty candidate and a candidate that is a directory both exit 2", () => {
    const empty = join(scratch, "s8-empty.json");
    writeFileSync(empty, "");
    expect(captureMain(["compare", BASELINE, empty]).code).toBe(2);
    const dir = join(scratch, "s8-dir.json");
    mkdirSync(dir);
    const asDir = captureMain(["compare", BASELINE, dir]);
    expect(asDir.code).toBe(2);
    expect(asDir.stderr).toMatch(/EISDIR/);
  });
});

describe("extra — concurrent runs with the same --run-id (TOCTOU on the overwrite guard)", () => {
  it("existsSync-then-writeFileSync lets several parallel runs 'write' the same summary; only late starters are refused", async () => {
    const outDir = join(scratch, "race");
    const runs = await Promise.all(
      [1, 2, 3, 4].map(
        (n) =>
          new Promise<{ n: number; code: number | null; stdout: string; stderr: string }>(
            (resolveRun) => {
              const child = spawn(
                TSX_BIN,
                [CLI, "run", "--out-dir", outDir, "--run-id", "same", "--only", "coach_gates"],
                {
                  cwd: EVAL_DIR,
                  env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
                  stdio: ["ignore", "pipe", "pipe"],
                },
              );
              let stdout = "";
              let stderr = "";
              child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
              child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
              child.on("exit", (code) => resolveRun({ n, code, stdout, stderr }));
            },
          ),
      ),
    );
    const wrote = runs.filter(
      (run) => run.code === 0 && run.stdout.includes(`wrote ${join(outDir, "same.json")}`),
    );
    const refused = runs.filter(
      (run) => run.code === 2 && run.stderr.includes("refusing to overwrite"),
    );
    expect(wrote.length + refused.length).toBe(4);
    expect(readdirSync(outDir)).toEqual(["same.json"]);
    // OBSERVED at 4d812e1a: more than one process claims the write (the guard
    // is not atomic). A `wx` open flag would make exactly one succeed.
    expect(wrote.length).toBeGreaterThan(1);
  }, 60_000);
});

describe("extra — summary tampering that compare must not accept", () => {
  interface EditableSummary {
    runId: string;
    metrics: Record<string, unknown>;
    benches: Array<{ id: string; metrics: Record<string, unknown> }>;
  }

  it("editing only the flattened `metrics` view (even to a valid number) is rejected by the benches↔metrics cross-check → exit 2", () => {
    const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as EditableSummary;
    const firstMetric = Object.keys(baseline.metrics)[0]!;
    for (const poison of ["NaN", "Infinity", "1e999", true, [], {}, null, 12345]) {
      const candidate = {
        ...baseline,
        runId: "poison",
        metrics: { ...baseline.metrics, [firstMetric]: poison },
      };
      const path = join(scratch, "poison.json");
      writeFileSync(path, JSON.stringify(candidate));
      const result = captureMain(["compare", BASELINE, path]);
      expect(result.code, `metric = ${JSON.stringify(poison)}`).toBe(2);
      expect(result.stderr).toMatch(
        /must equal the flattened|expected a finite number|number or null/,
      );
    }
  });

  it("a CONSISTENT null (bench + flattened) is a valid abstention, never treated as zero, and stays comparable", () => {
    const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as EditableSummary;
    const firstKey = Object.keys(baseline.metrics)[0]!;
    const [benchId, ...rest] = firstKey.split(".");
    const metricName = rest.join(".");
    const bench = baseline.benches.find((entry) => entry.id === benchId);
    expect(bench).toBeDefined();
    expect(typeof bench!.metrics[metricName]).toBe("number");
    const candidate: EditableSummary = {
      ...baseline,
      runId: "nulled",
      metrics: { ...baseline.metrics, [firstKey]: null },
      benches: baseline.benches.map((entry) =>
        entry.id === benchId
          ? { ...entry, metrics: { ...entry.metrics, [metricName]: null } }
          : entry,
      ),
    };
    const path = join(scratch, "nulled.json");
    writeFileSync(path, JSON.stringify(candidate));
    const result = captureMain(["compare", BASELINE, path, "--json"]);
    expect(result.code).not.toBe(2);
    const report = JSON.parse(result.stdout) as {
      metrics: Array<{ metric: string; status: string }>;
    };
    const row = report.metrics.find((entry) => entry.metric === firstKey);
    expect(row).toBeDefined();
    expect(row!.status).not.toBe("unchanged");
    expect(result.stdout).not.toMatch(
      new RegExp(`"metric": "${firstKey}"[^}]*"candidate": 0[,\\n]`),
    );
  });
});

beforeAll(() => {
  // These attacks assume the committed baseline is the contract-1 document
  // the compare tests are built on. Never modified here.
  expect(existsSync(BASELINE)).toBe(true);
});
