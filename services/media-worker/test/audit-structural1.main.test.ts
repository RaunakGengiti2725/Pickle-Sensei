import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Structural audit #1 (storage-media-worker): the process entrypoint
 * (src/main.ts) had no tests. These spawn it with `tsx` and observe stderr.
 * Nothing here needs a database: an unreachable DATABASE_URL makes every poll
 * cycle fail fast and log `poll cycle failed`, which makes the loop cadence
 * observable.
 */

const workerDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = join(workerDir, "node_modules", ".bin", "tsx");
const unreachableDb = "postgres://nobody:nothing@127.0.0.1:1/nope";

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

async function runMain(env: Record<string, string>, killAfterMs: number): Promise<RunResult> {
  const child = spawn(tsxBin, ["src/main.ts"], {
    cwd: workerDir,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      AWS_ACCESS_KEY_ID: "x",
      AWS_SECRET_ACCESS_KEY: "x",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
    // tsx re-spawns node; kill the whole group so the grandchild releases stderr.
    detached: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const killGroup = () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  };
  const timer = setTimeout(killGroup, killAfterMs);
  try {
    // The stderr pipe closes once every process in the group is gone (this
    // package has no @types/node of its own, so ChildProcess events are not
    // typed here; the Readable's are).
    await once(child.stderr, "close");
    // 'exit' may trail the pipe close by a tick.
    for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return { code: child.exitCode, signal: child.signalCode, stderr };
  } finally {
    clearTimeout(timer);
  }
}

function crashLines(stderr: string): number {
  return stderr.split("\n").filter((l) => l.includes("poll cycle failed")).length;
}

describe("audit-structural1: media-worker entrypoint (src/main.ts)", () => {
  it("VERIFY exits 1 without DATABASE_URL_WORKER/DATABASE_URL", async () => {
    const result = await runMain({}, 15_000);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("DATABASE_URL_WORKER or DATABASE_URL required");
  }, 20_000);

  it("VERIFY a failing poll cycle is logged and the process keeps running (worker_crash, no exit)", async () => {
    const result = await runMain({ DATABASE_URL: unreachableDb, WORKER_INTERVAL_MS: "200" }, 6_000);
    expect(result.signal).toBe("SIGKILL"); // still alive when we killed it
    expect(crashLines(result.stderr)).toBeGreaterThanOrEqual(2);
    expect(result.stderr).toContain('"name":"worker_crash"');
    expect(result.stderr).toContain('"name":"worker_started"');
  }, 20_000);

  it("HOTSPOT WORKER_INTERVAL_MS: a non-numeric value must not collapse the poll interval to a busy loop", async () => {
    // `Number("abc")` is NaN; `setTimeout(fn, NaN)` fires after ~1ms, so a
    // typo in the env var turns a 5s poll into a tight loop hammering the DB
    // and the queue. Expected: fall back to the 5000ms default (or refuse to
    // start). Observed cadence with the default is at most 2 cycles in 6s.
    const result = await runMain({ DATABASE_URL: unreachableDb, WORKER_INTERVAL_MS: "abc" }, 6_000);
    expect(result.signal).toBe("SIGKILL");
    expect(crashLines(result.stderr)).toBeLessThanOrEqual(2);
  }, 20_000);

  it("HOTSPOT queue selection: starting without SQS_QUEUE_URL must be loud (volatile in-memory queue)", async () => {
    // Without SQS_QUEUE_URL the worker silently constructs an InMemoryJobQueue
    // that no producer can reach and that dies with the process; every
    // media.process/media.purge dispatched by the API is invisible to it.
    // Expected: refuse to start (exit != 0) or log the queue mode at startup.
    const result = await runMain({ DATABASE_URL: unreachableDb, WORKER_INTERVAL_MS: "200" }, 5_000);
    const exitedNonZero = result.code !== null && result.code !== 0;
    const announced = /in-?memory|InMemoryJobQueue|SQS_QUEUE_URL/i.test(result.stderr);
    expect(exitedNonZero || announced).toBe(true);
  }, 20_000);
});
