/**
 * EXTRA ATTACKS (beyond the seven assigned) — CLI / schema / filesystem edges.
 *
 *   X1a  hostile run ids (path traversal, unicode, empty, 129 chars) must be
 *        rejected BEFORE any bench executes.
 *   X1b  non-finite metric values smuggled through JSON (1e999 → Infinity,
 *        "NaN" string) must be rejected by the candidate schema, exit 2.
 *   X1c  clock skew: a candidate whose generatedAtIso predates the baseline by
 *        years, on the same gitSha, compares clean with NO warning (recorded
 *        as an observation — the comparator does not claim to order runs).
 *   X1d  permission denial: an unwritable --out-dir is only discovered AFTER
 *        every bench has run — the whole run's work is discarded (exit 2).
 *   X1e  failed-bench `error` embeds a full stack trace with absolute host
 *        paths (from `errorText()` preferring `error.stack`), which then lands
 *        verbatim in the summary JSON.
 *   X1f  seeded fuzz of `parseArgs`: random flag/value interleavings never
 *        crash with anything other than the documented `--x requires a value`.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RegressionSummary } from "../../src/index.js";
import type { BenchDefinition } from "../../src/regression/benches.js";
import { parseArgs } from "../../src/regression/cli.js";
import { assertValidRunId, executeBench, RUN_ID_PATTERN } from "../../src/regression/run.js";
import {
  BASELINE_PATH,
  makeTempDir,
  REPO_ROOT,
  runCli,
  seededRandom,
  writeEvidence,
} from "./attackUtil.js";

const BENCH_LINE = /^\s+(ok\s+|FAILED\s+)[a-z_]+\s+\d+ms/m;

describe("X1a: hostile --run-id values", () => {
  const hostile = [
    "../../evil",
    "a/b",
    "..",
    ".hidden",
    "-dash-first",
    "résumé",
    "a".repeat(129),
    " ",
  ];
  it("every hostile run id is rejected with exit 2 before any bench runs", () => {
    const outDir = makeTempDir("attack-x1a");
    const results = hostile.map((runId) => {
      const result = runCli([
        "run",
        "--out-dir",
        outDir,
        "--run-id",
        runId,
        "--only",
        "contact_replay",
      ]);
      return {
        runId: JSON.stringify(runId),
        exitCode: result.exitCode,
        stderrFirstLine: result.stderr.split("\n")[0],
        benchRan: BENCH_LINE.test(result.stdout),
      };
    });
    writeEvidence("x1a-hostile-run-ids", {
      classification: "HELD",
      pattern: String(RUN_ID_PATTERN),
      results,
    });
    for (const result of results) {
      expect(result.exitCode).toBe(2);
      expect(result.benchRan).toBe(false);
      expect(result.stderrFirstLine).toMatch(/invalid run id|requires a value/);
    }
    expect(readdirSync(outDir)).toEqual([]);
  });

  it("a NUL byte cannot even reach the CLI; in-process the validator rejects it", () => {
    expect(() => assertValidRunId("run\u0000id")).toThrow(/invalid run id/);
  });

  it("the empty run id is a usage error (`--run-id` followed by `--only` reads as missing value)", () => {
    const result = runCli(["run", "--run-id", "--only", "contact_replay"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--run-id requires a value");
  });
});

describe("X1b: non-finite metric values smuggled through JSON", () => {
  const load = (): RegressionSummary =>
    JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as RegressionSummary;
  const compareWith = (
    name: string,
    mutate: (text: string) => string,
  ): { exitCode: number | null; stderr: string } => {
    const dir = makeTempDir("attack-x1b");
    const path = join(dir, `${name}.json`);
    const original = JSON.stringify(load());
    const mutated = mutate(original);
    if (mutated === original) throw new Error(`fixture mutation for ${name} did not apply`);
    writeFileSync(path, mutated);
    const result = runCli(["compare", BASELINE_PATH, path, "--json"]);
    return { exitCode: result.exitCode, stderr: result.stderr };
  };

  it("1e999 (parses to Infinity) in a bench metric → schema rejects, exit 2", () => {
    const result = compareWith("infinity", (text) =>
      text.replace(/"gold_events":\s*15/, '"gold_events":1e999'),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/finite|metric/i);
  });

  it('"NaN" string in a bench metric → schema rejects, exit 2', () => {
    const result = compareWith("nan", (text) =>
      text.replace(/"gold_events":\s*15/, '"gold_events":"NaN"'),
    );
    expect(result.exitCode).toBe(2);
  });

  it("flattened `metrics` disagreeing with bench metrics → schema rejects, exit 2 (no silent trust of the flat map)", () => {
    const result = compareWith("flat-mismatch", (text) =>
      text.replace(/"contact_replay\.gold_events":\s*15/, '"contact_replay.gold_events":99'),
    );
    writeEvidence("x1b-non-finite-and-flat-mismatch", {
      classification: "HELD",
      flatMismatch: result,
    });
    expect(result.exitCode).toBe(2);
  });
});

describe("X1c: clock skew between baseline and candidate", () => {
  it("candidate generatedAtIso 10 years BEFORE the baseline, same gitSha: exit 0, no warning (observation)", () => {
    const summary = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as RegressionSummary;
    summary.runId = "time-traveller";
    summary.generatedAtIso = "2016-09-04T03:28:55.202Z";
    const dir = makeTempDir("attack-x1c");
    const path = join(dir, "skewed.json");
    writeFileSync(path, JSON.stringify(summary));
    const result = runCli(["compare", BASELINE_PATH, path, "--json"]);
    const report = JSON.parse(result.stdout) as { warnings: string[]; identity: unknown[] };
    writeEvidence("x1c-clock-skew", {
      classification:
        "OBSERVATION: comparator has no run-ordering/time check (not documented as a gate)",
      exitCode: result.exitCode,
      warnings: report.warnings,
    });
    expect(result.exitCode).toBe(0);
    expect(report.warnings.filter((w) => /generatedAt|time|clock|older/i.test(w))).toEqual([]);
  });
});

describe("X1d: unwritable --out-dir", () => {
  it("benches run to completion, then the summary write fails with EACCES → exit 2 and the results are lost", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      throw new Error("attack requires a non-root user (root ignores directory permissions)");
    }
    const parent = makeTempDir("attack-x1d");
    const readOnly = join(parent, "ro");
    mkdirSync(readOnly);
    chmodSync(readOnly, 0o555);
    try {
      const result = runCli([
        "run",
        "--out-dir",
        readOnly,
        "--run-id",
        "denied",
        "--only",
        "contact_replay",
      ]);
      const benchLine = result.stdout.match(/^\s+ok\s+contact_replay.*$/m)?.[0] ?? null;
      writeEvidence("x1d-unwritable-out-dir", {
        classification: "BROKEN (P3): writability is checked only after all benches ran",
        exitCode: result.exitCode,
        benchLineBeforeFailure: benchLine,
        stderrFirstLine: result.stderr.split("\n")[0],
        summaryWritten: existsSync(join(readOnly, "denied.json")),
      });
      expect(result.exitCode).toBe(2);
      expect(benchLine).not.toBeNull();
      expect(result.stderr).toMatch(/EACCES|permission denied/i);
      expect(existsSync(join(readOnly, "denied.json"))).toBe(false);
    } finally {
      chmodSync(readOnly, 0o755);
    }
  });
});

describe("X1e: failed-bench error text", () => {
  it("embeds a multi-line stack trace with absolute host paths into the summary record", () => {
    const definition: BenchDefinition = {
      id: "attack_thrower",
      title: "attack: throwing bench",
      kind: "in_process",
      command: "n/a",
      cwd: REPO_ROOT,
      inputs: [],
      caveats: [],
      run: () => {
        throw new Error("synthetic bench failure");
      },
    };
    const record = executeBench(definition, () => null);
    const lines = record.error?.split("\n") ?? [];
    writeEvidence("x1e-error-text-host-paths", {
      classification:
        "BROKEN (P3): error.stack (not error.message) is persisted; host paths leak into summaries",
      status: record.status,
      errorLineCount: lines.length,
      containsAbsolutePath: lines.some((line) => line.includes(REPO_ROOT)),
      firstLines: lines.slice(0, 3),
    });
    expect(record.status).toBe("failed");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.some((line) => line.includes(REPO_ROOT))).toBe(true);
  });
});

describe("X1f: seeded fuzz of parseArgs", () => {
  it("1000 random argv interleavings (seed 20260904) only ever throw the documented `requires a value` error", () => {
    const seed = 20260904;
    const random = seededRandom(seed);
    const tokens = [
      "run",
      "compare",
      "--json",
      "--only",
      "--out-dir",
      "--run-id",
      "--tolerances",
      "a,b",
      "/tmp/x",
      "",
      "--",
      "---x",
      "--json=1",
      "résumé",
      "../x",
    ];
    let throws = 0;
    for (let iteration = 0; iteration < 1000; iteration += 1) {
      const length = Math.floor(random() * 7);
      const argv = Array.from({ length }, () => tokens[Math.floor(random() * tokens.length)]!);
      try {
        const parsed = parseArgs(argv);
        expect(Array.isArray(parsed.positional)).toBe(true);
      } catch (error) {
        throws += 1;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/^--.* requires a value$/);
      }
    }
    writeEvidence("x1f-parseargs-fuzz", { classification: "HELD", seed, iterations: 1000, throws });
  });
});
