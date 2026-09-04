import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Adversarial pin for the SL-06 fix (oodGateRedTeam.test.ts per-test scratch
 * directory). The fix keeps the scratch path in a module-level `let dir` that a
 * top-level `beforeEach` overwrites. vitest runs `beforeEach` for every test in
 * a concurrency batch before the first test body executes, so under
 * `--sequence.concurrent` (or a future `describe.concurrent`) every case in the
 * batch writes into the LAST directory created and each `afterEach` removes
 * only that one. The other directories are never used and never removed.
 *
 * Observable contract this file pins, from OUTSIDE the red-team file, with a
 * private TMPDIR so the leak is attributable:
 *   - the red-team file still passes (fixture construction succeeded), and
 *   - it leaves NOTHING behind in TMPDIR.
 * The pre-fix file (single `mkdtempSync` + `afterAll`) satisfies both.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitestBin = createRequire(import.meta.url).resolve("vitest/vitest.mjs");

let scratch = "";
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function runRedTeamFile(extraArgs: string[]): { status: number | null; output: string } {
  scratch = mkdtempSync(join(tmpdir(), "ood-redteam-hygiene-"));
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch };
  for (const key of Object.keys(env)) {
    if (key.startsWith("VITEST")) delete env[key];
  }
  delete env.TEST;
  const result = spawnSync(
    process.execPath,
    [
      vitestBin,
      "run",
      "test/oodGateRedTeam.test.ts",
      // The fresh-candidate coverage floor takes minutes and creates no fixtures.
      "-t",
      "^(?!.*fresh-candidate)",
      ...extraArgs,
    ],
    { cwd: packageRoot, env, encoding: "utf8", timeout: 240_000 },
  );
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

describe("oodGateRedTeam scratch hygiene (SL-06 adversarial)", { timeout: 300_000 }, () => {
  it("leaves no scratch directories behind in the default sequential mode", () => {
    const { status, output } = runRedTeamFile([]);
    expect(status, output).toBe(0);
    expect(readdirSync(scratch)).toEqual([]);
  });

  it("leaves no scratch directories behind under --sequence.concurrent", () => {
    const { status, output } = runRedTeamFile(["--sequence.concurrent"]);
    expect(status, output).toBe(0);
    // Every `mkdtempSync` in a beforeEach must be matched by the rmSync of the
    // SAME path in that test's afterEach. A leaked, empty `ood-redteam-*` entry
    // means a test body ran against another test's directory.
    expect(readdirSync(scratch)).toEqual([]);
  });
});
