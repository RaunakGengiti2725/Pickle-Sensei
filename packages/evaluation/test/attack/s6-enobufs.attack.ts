/**
 * ATTACK S6 — point a fixture SubprocessSpec at a script that prints more
 * than 64 MiB to stdout and observe whether `spawnSync`'s ENOBUFS surfaces as
 * a failed bench record (caught by `executeBench`) or crashes the runner.
 *
 * `runSubprocess()` sets `maxBuffer: 64 * 1024 * 1024` and does
 * `if (result.error) throw result.error;` — so the question is whether the
 * throw is contained by `executeBench`'s try/catch, whether the child is
 * actually terminated, and where the boundary sits (63 / 64 / 65 MiB, and
 * stderr — a chatty bench that warns a lot dies the same way).
 */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { BenchDefinition, SubprocessSpec } from "../../src/regression/benches.js";
import { executeBench, runSubprocess } from "../../src/regression/run.js";
import { FIXTURES_DIR, writeEvidence } from "./attackUtil.js";

const MIB = 1024 * 1024;

function hugeSpec(mib: number): SubprocessSpec {
  return { script: "print-huge.ts", args: [String(mib)], cwd: FIXTURES_DIR };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function lingeringFixtureProcesses(): string[] {
  const result = spawnSync("pgrep", ["-af", "print-huge.ts"], { encoding: "utf8" });
  return result.stdout.split("\n").filter((line) => line.length > 0 && !line.includes("pgrep"));
}

describe("S6: subprocess bench printing >64 MiB to stdout", () => {
  it("runSubprocess THROWS ENOBUFS (not a SubprocessResult) for 65 MiB of stdout", () => {
    let thrown: unknown = null;
    try {
      runSubprocess(hugeSpec(65));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(errorCode(thrown)).toBe("ENOBUFS");
  });

  it("executeBench contains the throw: status=failed, exitCode=-1, error names ENOBUFS; the runner does not crash", () => {
    let lastExit: number | null = null;
    const definition: BenchDefinition = {
      id: "attack_huge_stdout",
      title: "attack: 65 MiB stdout",
      kind: "subprocess",
      command: "tsx print-huge.ts 65",
      cwd: FIXTURES_DIR,
      inputs: [],
      caveats: [],
      run: () => {
        const result = runSubprocess(hugeSpec(65));
        lastExit = result.exitCode;
        return { metrics: { bytes: result.stdout.length }, labels: {} };
      },
    };
    const record = executeBench(definition, () => lastExit);
    expect(record.status).toBe("failed");
    expect(record.exitCode).toBe(-1);
    expect(record.error).toContain("ENOBUFS");
    expect(record.metrics).toEqual({});
    writeEvidence("s6-enobufs-bench-record", {
      scenario: "S6",
      classification: "HELD (surfaces as a failed bench record, runner keeps going)",
      record: {
        status: record.status,
        exitCode: record.exitCode,
        wallClockMs: record.wallClockMs,
        error: record.error,
      },
    });
  });

  it("the oversized child is terminated (no lingering print-huge.ts process)", async () => {
    try {
      runSubprocess(hugeSpec(65));
    } catch {
      /* expected */
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    expect(lingeringFixtureProcesses()).toEqual([]);
  });

  it("boundary: 63 MiB succeeds, 64 MiB + 1 byte (the trailing newline) also trips ENOBUFS", () => {
    const ok = runSubprocess(hugeSpec(63));
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.length).toBe(63 * MIB + 1);
    let code: string | undefined;
    try {
      const at64 = runSubprocess(hugeSpec(64));
      code = `no error; stdout=${at64.stdout.length} bytes`;
    } catch (error) {
      code = errorCode(error);
    }
    writeEvidence("s6-enobufs-boundary", {
      scenario: "S6 boundary",
      mib63: { exitCode: ok.exitCode, stdoutBytes: ok.stdout.length },
      mib64plusNewline: code,
    });
    expect(code).toBe("ENOBUFS");
  });

  it("stderr flood is subject to the same 64 MiB cap (a warning-heavy bench dies identically)", () => {
    let thrown: unknown = null;
    try {
      runSubprocess({ script: "print-huge.ts", args: ["65", "stderr"], cwd: FIXTURES_DIR });
    } catch (error) {
      thrown = error;
    }
    expect(errorCode(thrown)).toBe("ENOBUFS");
  });
});
