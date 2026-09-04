/**
 * Adjudicated defects in the regression bench tooling. Each `describe` block
 * carries the finding id so `vitest -t EVAL-BENCH-NN` runs exactly that guard.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/regression/benches.js";
import { main } from "../src/regression/cli.js";
import { DEFAULT_REPORT_DIR } from "../src/regression/run.js";
import { validateRegressionSummary, type BenchRecord } from "../src/index.js";
import { bench, summary } from "./regressionFixtures.js";

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(REPO_ROOT, "datasets/reports/regression/baseline.json");
const COMMITTED_REPORT_DIR = join(REPO_ROOT, DEFAULT_REPORT_DIR);

const scratch = mkdtempSync(join(tmpdir(), "pickle-adjudication-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Capture stdout + stderr while `main` runs so assertions can read them. */
function captured(run: () => number): { exit: number; stdout: string; stderr: string } {
  const write = process.stdout.write.bind(process.stdout);
  const error = console.error;
  let stdout = "";
  let stderr = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  console.error = (...args: unknown[]) => {
    stderr += `${args.map(String).join(" ")}\n`;
  };
  try {
    return { exit: run(), stdout, stderr };
  } finally {
    process.stdout.write = write;
    console.error = error;
  }
}

describe("EVAL-BENCH-04: the CLI rejects unknown flags and empty values instead of falling back", () => {
  const runIds = [
    "adj04-typo",
    "adj04-empty-only",
    "adj04-empty-run-id",
    "adj04-dup",
    "adj04-json",
  ];
  const leaked = (): string[] =>
    runIds.map((id) => join(COMMITTED_REPORT_DIR, `${id}.json`)).filter((path) => existsSync(path));
  beforeEach(() => {
    for (const path of leaked()) rmSync(path);
  });
  afterEach(() => {
    for (const path of leaked()) rmSync(path);
  });

  it("EVAL-BENCH-04 compare: --tolerance (sic) is a usage error, not the default tolerances", () => {
    const result = captured(() =>
      main(["compare", BASELINE, BASELINE, "--tolerance", "/nonexistent.json"]),
    );
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("--tolerance");
    expect(result.stderr).toContain("usage:");
    expect(result.stdout).toBe("");
    expect(captured(() => main(["compare", BASELINE, BASELINE, "--json", "--json"])).exit).toBe(2);
    expect(captured(() => main(["compare", BASELINE, BASELINE, "--only", "x"])).exit).toBe(2);
    expect(captured(() => main(["compare", BASELINE, BASELINE, "--out-dir", scratch])).exit).toBe(
      2,
    );
    // The correctly spelled flag still drives the comparison.
    expect(
      captured(() => main(["compare", BASELINE, BASELINE, "--tolerances", "/nope.json"])).stderr,
    ).toContain("ENOENT");
  });

  it("EVAL-BENCH-04 run: --out-dirr never writes into the committed report directory", () => {
    const outDir = join(scratch, "typo");
    const result = captured(() =>
      main(["run", "--only", "coach_gates", "--out-dirr", outDir, "--run-id", "adj04-typo"]),
    );
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("--out-dirr");
    expect(result.stderr).toContain("usage:");
    expect(leaked()).toEqual([]);
    expect(existsSync(outDir)).toBe(false);
    expect(
      captured(() =>
        main([
          "run",
          "--only",
          "coach_gates",
          "--out-dir",
          join(scratch, "json"),
          "--run-id",
          "adj04-json",
          "--json",
        ]),
      ).exit,
    ).toBe(2);
    expect(existsSync(join(scratch, "json"))).toBe(false);
  });

  it("EVAL-BENCH-04 run: an explicitly empty --only, --run-id or --out-dir is a usage error", () => {
    const outDir = join(scratch, "empty");
    const emptyOnly = captured(() =>
      main(["run", "--only", "", "--out-dir", outDir, "--run-id", "adj04-empty-only"]),
    );
    expect(emptyOnly.exit).toBe(2);
    expect(emptyOnly.stderr).toContain("--only");
    const blankOnly = captured(() =>
      main(["run", "--only", " , ", "--out-dir", outDir, "--run-id", "adj04-empty-only"]),
    );
    expect(blankOnly.exit).toBe(2);
    const emptyRunId = captured(() =>
      main(["run", "--only", "coach_gates", "--out-dir", outDir, "--run-id", ""]),
    );
    expect(emptyRunId.exit).toBe(2);
    expect(emptyRunId.stderr).toContain("--run-id");
    const emptyOutDir = captured(() =>
      main(["run", "--only", "coach_gates", "--out-dir", "", "--run-id", "adj04-empty-run-id"]),
    );
    expect(emptyOutDir.exit).toBe(2);
    expect(emptyOutDir.stderr).toContain("--out-dir");
    expect(existsSync(outDir)).toBe(false);
    expect(leaked()).toEqual([]);
  });

  it("EVAL-BENCH-04 run: a repeated flag is rejected rather than silently taking the last value", () => {
    const outDir = join(scratch, "dup");
    const result = captured(() =>
      main([
        "run",
        "--only",
        "coach_gates",
        "--only",
        "contact_replay",
        "--out-dir",
        outDir,
        "--run-id",
        "adj04-dup",
      ]),
    );
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("--only");
    expect(existsSync(outDir)).toBe(false);
    expect(leaked()).toEqual([]);
  });

  it("EVAL-BENCH-04 run: the allow-listed flags still drive a real run", () => {
    const outDir = join(scratch, "good");
    const result = captured(() =>
      main(["run", "--only", "coach_gates", "--out-dir", outDir, "--run-id", "adj04-good"]),
    );
    expect(result.exit).toBe(0);
    expect(readdirSync(outDir)).toEqual(["adj04-good.json"]);
    expect(leaked()).toEqual([]);
  });
});

describe("EVAL-BENCH-05: a subprocess bench's status and exitCode must agree", () => {
  const sub = (overrides: Partial<BenchRecord> = {}): BenchRecord =>
    bench({ kind: "subprocess", command: "tsx x.ts", exitCode: 0, ...overrides });
  const failedSub = (exitCode: number): BenchRecord =>
    sub({ status: "failed", error: "killed", metrics: {}, exitCode });

  function expectInvalid(doc: unknown, code: string): void {
    const result = validateRegressionSummary(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe(code);
  }

  it("EVAL-BENCH-05 rejects status ok with a non-zero exitCode, so a killed bench never compares clean", () => {
    for (const exitCode of [137, 1, -1]) {
      expectInvalid(summary({}, [sub({ exitCode })]), "bench_exit_code_status");
    }
    const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as {
      benches: { id: string; exitCode: number | null }[];
    };
    for (const record of baseline.benches) if (record.id === "event_recall") record.exitCode = 137;
    const killed = join(scratch, "killed.json");
    writeFileSync(killed, JSON.stringify(baseline));
    expectInvalid(baseline, "bench_exit_code_status");
    const compared = captured(() => main(["compare", BASELINE, killed]));
    expect(compared.exit).toBe(2);
    expect(compared.stderr).toContain("exitCode");
  });

  it("EVAL-BENCH-05 rejects status failed with exitCode 0", () => {
    expectInvalid(summary({}, [failedSub(0)]), "bench_exit_code_status");
  });

  it("EVAL-BENCH-05 keeps consistent pairs valid and mirrors the rule in the JSON schema", () => {
    expect(validateRegressionSummary(summary({}, [sub()])).ok).toBe(true);
    expect(validateRegressionSummary(summary({}, [failedSub(1)])).ok).toBe(true);
    expect(validateRegressionSummary(summary({}, [failedSub(137)])).ok).toBe(true);
    expect(validateRegressionSummary(summary({}, [failedSub(-1)])).ok).toBe(true);
    expect(validateRegressionSummary(summary({}, [bench()])).ok).toBe(true);
    expect(
      validateRegressionSummary(
        summary({}, [bench({ status: "failed", error: "gold missing", metrics: {} })]),
      ).ok,
    ).toBe(true);
    expect(validateRegressionSummary(JSON.parse(readFileSync(BASELINE, "utf8"))).ok).toBe(true);

    const schema = JSON.parse(
      readFileSync(join(PACKAGE_DIR, "regression.summary.schema.json"), "utf8"),
    ) as { properties: { benches: { items: { allOf?: unknown[] } } } };
    const clauses = schema.properties.benches.items.allOf ?? [];
    expect(clauses).toContainEqual({
      if: { properties: { kind: { const: "subprocess" }, status: { const: "ok" } } },
      then: { properties: { exitCode: { const: 0 } } },
    });
    expect(clauses).toContainEqual({
      if: { properties: { kind: { const: "subprocess" }, status: { const: "failed" } } },
      then: { properties: { exitCode: { type: "integer", not: { const: 0 } } } },
    });
  });
});
