/**
 * ATTACK S7 — point a fixture SubprocessSpec at a script that never exits and
 * confirm the runner hangs: `runSubprocess()` calls `spawnSync` WITHOUT a
 * `timeout`/`killSignal`, so a wedged bench script blocks the whole
 * regression run (and the CI job) until an external job-level timeout fires.
 *
 * The real `runSubprocess` is driven by `fixtures/hang-driver.ts` in its own
 * process group. The test proves: (1) the driver is still alive with the
 * grandchild running after HANG_OBSERVE_MS; (2) the code path has no timeout
 * (source inspection, asserted); (3) the attack cleans up by killing the
 * process group. Infinite hang cannot be observed in finite time — the
 * observation window is recorded in the evidence together with the source
 * fact so the claim stays honest.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVAL_DIR, EVAL_TSX_BIN, FIXTURES_DIR, sleep, writeEvidence } from "./attackUtil.js";

const HANG_OBSERVE_MS = Number(process.env.ATTACK_HANG_OBSERVE_MS ?? "10000");

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pgrep(pattern: string): string[] {
  const result = spawnSync("pgrep", ["-af", pattern], { encoding: "utf8" });
  return result.stdout.split("\n").filter((line) => line.length > 0 && !line.includes("pgrep"));
}

describe("S7: subprocess bench that never exits", () => {
  it("runSubprocess has no spawnSync timeout in source (the mechanism behind the hang)", () => {
    const source = readFileSync(join(EVAL_DIR, "src/regression/run.ts"), "utf8");
    const start = source.indexOf("export function runSubprocess");
    const end = source.indexOf("\n}", start);
    const body = source.slice(start, end);
    expect(body).toContain("spawnSync(TSX_BIN");
    expect(body).not.toMatch(/timeout\s*:/);
    expect(body).not.toMatch(/killSignal\s*:/);
  });

  it(`the runner is still blocked inside runSubprocess after ${HANG_OBSERVE_MS} ms and the child is still running`, async () => {
    const driver = spawn(EVAL_TSX_BIN, [join(FIXTURES_DIR, "hang-driver.ts")], {
      cwd: EVAL_DIR,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    driver.stdout.setEncoding("utf8");
    driver.stderr.setEncoding("utf8");
    driver.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    driver.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    driver.on("exit", (code, signal) => {
      exited = { code, signal };
    });
    const pid = driver.pid;
    if (pid === undefined) throw new Error("driver did not spawn");

    try {
      await sleep(HANG_OBSERVE_MS);
      const grandchildren = pgrep("never-exits.ts");
      const stillAlive = isAlive(pid) && exited === null;
      writeEvidence("s7-hang", {
        scenario: "S7",
        classification: stillAlive
          ? `BROKEN (runner blocked for the full ${HANG_OBSERVE_MS} ms observation window; no timeout exists in runSubprocess)`
          : "NOT REPRODUCED",
        observeMs: HANG_OBSERVE_MS,
        driverPid: pid,
        driverAlive: stillAlive,
        driverExited: exited,
        neverExitsProcesses: grandchildren,
        driverStdout: stdout,
        driverStderr: stderr,
      });
      expect(stdout).toContain("calling runSubprocess(never-exits.ts)");
      expect(stdout).not.toContain("runSubprocess returned");
      expect(stillAlive).toBe(true);
      expect(grandchildren.length).toBeGreaterThanOrEqual(1);
    } finally {
      // Kill the whole process group (driver + tsx + never-exits).
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      await sleep(500);
    }
    expect(isAlive(pid)).toBe(false);
    expect(pgrep("never-exits.ts")).toEqual([]);
  });
});
