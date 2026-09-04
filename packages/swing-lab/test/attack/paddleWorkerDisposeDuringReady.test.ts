import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PaddleServeWorker, PaddleWorkerError } from "../../src/paddleWorker.js";

/**
 * Adversarial pass 3 (tester #4) — S9: dispose() a PaddleServeWorker while
 * ready() is still pending. Contract: ready() REJECTS within a bounded time
 * (never hangs), and no worker process survives (checked with pgrep on a
 * unique per-test marker, never by trusting the JS-side `alive` flag).
 *
 * Workers used here are throwaway processes — a node fake speaking the
 * protocol, and real `python3` processes that deliberately ignore stdin EOF
 * / SIGTERM the way a worker stuck in model load would (the real
 * detect_paddle.py --serve only notices EOF once it reaches its stdin loop
 * AFTER loading + warm-up). No model, no venv, no dataset.
 */

const dir = mkdtempSync(join(tmpdir(), "attack-s9-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PYTHON = "python3";

function pgrepMarker(marker: string): string[] {
  const result = spawnSync("pgrep", ["-f", marker], { encoding: "utf8" });
  // pgrep exit 1 = no match; anything else than 0/1 is a harness error.
  expect([0, 1], `pgrep exit ${result.status}: ${result.stderr}`).toContain(result.status);
  return result.stdout.split("\n").filter((line) => line.trim().length > 0);
}

function waitForExit(worker: PaddleServeWorker, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (!worker.alive) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("worker did not exit"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

/** ready() must settle (reject) within `timeoutMs`; a hang is a failure. */
async function expectReadyRejectsWithin(worker: PaddleServeWorker, timeoutMs: number) {
  const startedAt = Date.now();
  const outcome = await Promise.race([
    worker.ready().then(
      () => "resolved" as const,
      (error: unknown) => (error instanceof PaddleWorkerError ? "rejected" : "rejected-untyped"),
    ),
    new Promise<"hang">((resolve) => setTimeout(() => resolve("hang"), timeoutMs)),
  ]);
  expect(outcome, `ready() after dispose() settled as '${outcome}'`).toBe("rejected");
  return Date.now() - startedAt;
}

/** Python worker that never reports ready and ignores stdin EOF + SIGTERM. */
function stubbornPython(marker: string): string[] {
  return [
    "-c",
    [
      "import signal, time, sys",
      "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
      "signal.signal(signal.SIGPIPE, signal.SIG_IGN) if hasattr(signal, 'SIGPIPE') else None",
      `marker = ${JSON.stringify(marker)}`,
      "time.sleep(600)",
    ].join("\n"),
  ];
}

/** Node fake that never reports ready and exits when stdin closes. */
function neverReadyNode(): string {
  const path = join(dir, "never-ready.mjs");
  writeFileSync(
    path,
    `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
lines.on("line", () => {});
lines.on("close", () => process.exit(0));
setTimeout(() => {}, 600000);
`,
  );
  return path;
}

describe("S9 — dispose() while ready() is pending", () => {
  it("node fake (exits on EOF): ready() rejects promptly, process gone", async () => {
    const worker = new PaddleServeWorker(process.execPath, [neverReadyNode()], {
      log: () => {},
      readyTimeoutMs: 60_000,
    });
    const pid = worker.pid;
    expect(pid).toBeDefined();
    worker.dispose();
    const ms = await expectReadyRejectsWithin(worker, 5_000);
    expect(ms).toBeLessThan(5_000);
    await waitForExit(worker, 5_000);
    expect(spawnSync("kill", ["-0", String(pid)]).status, `pid ${pid} still exists`).not.toBe(0);
  });

  it("python ignoring EOF+SIGTERM: ready() rejects (force-kill path) and pgrep finds nothing", async () => {
    const marker = `attack-s9-stubborn-${process.pid}-${Date.now()}`;
    const worker = new PaddleServeWorker(PYTHON, stubbornPython(marker), {
      log: () => {},
      readyTimeoutMs: 60_000,
    });
    // Let python actually start and install its handlers.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(pgrepMarker(marker), "precondition: python worker is running").toHaveLength(1);

    worker.dispose();
    const ms = await expectReadyRejectsWithin(worker, 10_000);
    // dispose() arms a 3s SIGKILL; rejection must arrive within that budget + slack.
    expect(ms).toBeLessThan(6_000);
    await waitForExit(worker, 5_000);
    expect(pgrepMarker(marker), "python worker survived dispose()").toEqual([]);
  }, 20_000);

  it("dispose() synchronously right after construction (before any tick)", async () => {
    const marker = `attack-s9-immediate-${process.pid}-${Date.now()}`;
    const worker = new PaddleServeWorker(PYTHON, stubbornPython(marker), {
      log: () => {},
      readyTimeoutMs: 60_000,
    });
    worker.dispose();
    await expectReadyRejectsWithin(worker, 10_000);
    await waitForExit(worker, 5_000);
    expect(pgrepMarker(marker)).toEqual([]);
  }, 20_000);

  it("rapid repeat: 12 construct+dispose cycles leave no python behind", async () => {
    const marker = `attack-s9-rapid-${process.pid}-${Date.now()}`;
    const workers: PaddleServeWorker[] = [];
    for (let i = 0; i < 12; i += 1) {
      const worker = new PaddleServeWorker(PYTHON, stubbornPython(`${marker}-${i}`), {
        log: () => {},
        readyTimeoutMs: 60_000,
      });
      workers.push(worker);
      if (i % 2 === 0) worker.dispose(); // half disposed before the loop yields
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const worker of workers) {
      worker.dispose();
      worker.dispose(); // idempotent
    }
    await Promise.all(workers.map((worker) => expectReadyRejectsWithin(worker, 10_000)));
    await Promise.all(workers.map((worker) => waitForExit(worker, 5_000)));
    expect(pgrepMarker(marker)).toEqual([]);
  }, 30_000);

  it("python worker whose ready() timed out is also gone (control for the kill path)", async () => {
    const marker = `attack-s9-timeout-${process.pid}-${Date.now()}`;
    const worker = new PaddleServeWorker(PYTHON, stubbornPython(marker), {
      log: () => {},
      readyTimeoutMs: 300,
    });
    await expect(worker.ready()).rejects.toThrow(/did not report ready/);
    await waitForExit(worker, 5_000);
    expect(pgrepMarker(marker)).toEqual([]);
  }, 20_000);

  it("extra: a worker that forked a helper — the helper must not outlive dispose()", async () => {
    // detect_paddle.py --serve forks ffmpeg helpers; a SIGKILL on the worker
    // alone reaches only the direct child. Attack: python forks a stubborn
    // grandchild before ever reporting ready.
    const marker = `attack-s9-grandchild-${process.pid}-${Date.now()}`;
    // The grandchild carries the marker as a trailing argv entry; the parent's
    // cmdline also contains it (inside the -c source) but not at the end, so
    // the anchored pattern below matches the grandchild only.
    const grandchildPattern = `${marker}-helper$`;
    const worker = new PaddleServeWorker(
      PYTHON,
      [
        "-c",
        [
          "import subprocess, sys, time",
          `child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)", ${JSON.stringify(`${marker}-helper`)}])`,
          "time.sleep(600)",
        ].join("\n"),
      ],
      { log: () => {}, readyTimeoutMs: 60_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    const before = pgrepMarker(grandchildPattern);
    expect(before.length, "precondition: grandchild running").toBeGreaterThanOrEqual(1);
    worker.dispose();
    await expectReadyRejectsWithin(worker, 10_000);
    await waitForExit(worker, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = pgrepMarker(grandchildPattern);
    for (const pid of after) spawnSync("kill", ["-9", pid]); // never leak from the test itself
    expect(after, `grandchild python survived dispose(): pids ${after.join(",")}`).toEqual([]);
  }, 20_000);
});
