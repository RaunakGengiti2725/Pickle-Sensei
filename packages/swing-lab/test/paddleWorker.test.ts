import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  PaddleServeWorker,
  PaddleWorkerError,
  PaddleWorkerSupervisor,
  detectPaddleWindow,
  startPaddleWorker,
} from "../src/paddleWorker.js";

/**
 * Protocol/fallback tests against a FAKE worker (a node script speaking
 * paddle-serve-v1 on stdio) — no python, no model. The real worker's
 * artifact equality is verified against footage in the C07 measurement runs
 * (datasets/experiments/wave-c/c07-summary.json), not here.
 */

const dir = mkdtempSync(join(tmpdir(), "paddle-worker-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Fake worker: `mode` picks the failure shape a test needs. */
function fakeWorkerScript(mode: string): string {
  const path = join(dir, `fake-${mode}.mjs`);
  writeFileSync(
    path,
    `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const mode = ${JSON.stringify(mode)};
const say = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
if (mode !== "never-ready") {
  say({ event: "ready", protocol: "paddle-serve-v1", modelLoadSec: 0, warmupSec: 0, device: "test" });
}
if (mode === "stdin-closed") {
  // closes its stdin but stays alive: a write must not become an uncaught EPIPE
  process.stdin.destroy();
  setTimeout(() => process.exit(0), 10000);
} else {
mainLoop();
}
function mainLoop() {
const lines = createInterface({ input: process.stdin });
let requests = 0;
const answer = (req) => {
  writeFileSync(req.out, JSON.stringify({ frames: [], echo: req }));
  say({ id: req.id, ok: true, out: req.out, framesProcessed: 0, paddleDetections: 0, extras: 0, timing: {}, requestWallSec: 0 });
};
let held = null;
lines.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.op === "shutdown") { say({ id: req.id, ok: true, event: "shutdown" }); process.exit(0); }
  requests += 1;
  if (mode === "crash-on-request") process.exit(3);
  if (mode === "error-once" && requests === 1) { say({ id: req.id, ok: false, error: "boom" }); return; }
  if (mode === "silent") return; // never answers -> request timeout
  if (mode === "out-of-order") {
    // hold the FIRST request and answer it after the second — responses
    // arrive in the reverse order of the requests.
    if (requests === 1) { held = req; return; }
    answer(req);
    if (held) { answer(held); held = null; }
    return;
  }
  answer(req);
});
lines.on("close", () => process.exit(0));
}
`,
  );
  return path;
}

function spawnFake(
  mode: string,
  options: { requestTimeoutMs?: number; readyTimeoutMs?: number } = {},
) {
  return new PaddleServeWorker(process.execPath, [fakeWorkerScript(mode)], {
    log: () => {},
    ...options,
  });
}

function request(out: string) {
  return { video: "clip.mp4", out, startMs: 100, endMs: 200 };
}

const waitForExit = (worker: PaddleServeWorker) =>
  new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      if (!worker.alive) {
        clearInterval(poll);
        resolve();
      }
    }, 10);
  });

describe("PaddleServeWorker protocol", () => {
  it("serves a detect request and writes the artifact", async () => {
    const worker = spawnFake("ok");
    const out = join(dir, "ok-dets.json");
    const response = await worker.detect(request(out));
    expect(response.ok).toBe(true);
    expect(existsSync(out)).toBe(true);
    expect(JSON.parse(readFileSync(out, "utf8")).echo.startMs).toBe(100);
    worker.dispose();
    await waitForExit(worker);
    expect(worker.alive).toBe(false);
  });

  it("rejects on ok=false and keeps serving the next request", async () => {
    const worker = spawnFake("error-once");
    await expect(worker.detect(request(join(dir, "e1.json")))).rejects.toThrow(PaddleWorkerError);
    const out = join(dir, "e2.json");
    const response = await worker.detect(request(out));
    expect(response.ok).toBe(true);
    expect(existsSync(out)).toBe(true);
    worker.dispose();
  });

  it("rejects pending and future requests when the worker crashes", async () => {
    const worker = spawnFake("crash-on-request");
    await expect(worker.detect(request(join(dir, "c1.json")))).rejects.toThrow(/exited/);
    expect(worker.alive).toBe(false);
    await expect(worker.detect(request(join(dir, "c2.json")))).rejects.toThrow(/exited/);
  });

  it("times out and kills the worker when a request never answers", async () => {
    const worker = spawnFake("silent", { requestTimeoutMs: 200 });
    await expect(worker.detect(request(join(dir, "s1.json")))).rejects.toThrow(/timed out/);
    await waitForExit(worker);
    expect(worker.alive).toBe(false);
  });

  it("fails ready (and detect) when the worker never reports ready", async () => {
    const worker = spawnFake("never-ready", { readyTimeoutMs: 200 });
    await expect(worker.detect(request(join(dir, "n1.json")))).rejects.toThrow(PaddleWorkerError);
    await waitForExit(worker);
    expect(worker.alive).toBe(false);
  });

  it("dispose ends the worker process (no leak) and is idempotent", async () => {
    const worker = spawnFake("ok");
    await worker.ready();
    worker.dispose();
    worker.dispose();
    await waitForExit(worker);
    expect(worker.alive).toBe(false);
  });
});

describe("PaddleServeWorker concurrency", () => {
  it("matches concurrent responses by id even when they arrive out of order", async () => {
    const worker = spawnFake("out-of-order");
    const out1 = join(dir, "oo1.json");
    const out2 = join(dir, "oo2.json");
    const [r1, r2] = await Promise.all([
      worker.detect({ video: "clip.mp4", out: out1, startMs: 100, endMs: 200 }),
      worker.detect({ video: "clip.mp4", out: out2, startMs: 300, endMs: 400 }),
    ]);
    expect(r1.out).toBe(out1);
    expect(r2.out).toBe(out2);
    expect(JSON.parse(readFileSync(out1, "utf8")).echo.startMs).toBe(100);
    expect(JSON.parse(readFileSync(out2, "utf8")).echo.startMs).toBe(300);
    worker.dispose();
  });

  it("rejects (not crashes) when the worker's stdin closes while it stays alive", async () => {
    const worker = spawnFake("stdin-closed", { requestTimeoutMs: 1000 });
    await worker.ready();
    // Give the fake time to destroy its stdin end of the pipe.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(worker.detect(request(join(dir, "sc1.json")))).rejects.toThrow(PaddleWorkerError);
    worker.dispose();
    await waitForExit(worker);
  });

  it("dispose with a request in flight rejects the pending request", async () => {
    const worker = spawnFake("silent");
    await worker.ready();
    const pending = worker.detect(request(join(dir, "dp1.json")));
    worker.dispose();
    await expect(pending).rejects.toThrow(PaddleWorkerError);
    await waitForExit(worker);
  });
});

describe("PaddleWorkerSupervisor restart", () => {
  it("serves subsequent requests from a restarted worker after a crash", async () => {
    let spawns = 0;
    const supervisor = new PaddleWorkerSupervisor(() => {
      spawns += 1;
      return spawnFake(spawns === 1 ? "crash-on-request" : "ok");
    });
    await expect(supervisor.detect(request(join(dir, "sv1.json")))).rejects.toThrow(/exited/);
    // wait for the crash to be observed
    await new Promise((resolve) => setTimeout(resolve, 50));
    const out = join(dir, "sv2.json");
    const response = await supervisor.detect(request(out));
    expect(response.ok).toBe(true);
    expect(existsSync(out)).toBe(true);
    expect(spawns).toBe(2);
    expect(supervisor.restarts).toBe(1);
    supervisor.dispose();
  });

  it("stops restarting once the budget is exhausted", async () => {
    let spawns = 0;
    const supervisor = new PaddleWorkerSupervisor(
      () => {
        spawns += 1;
        return spawnFake("crash-on-request");
      },
      { maxRestarts: 1 },
    );
    await expect(supervisor.detect(request(join(dir, "sb1.json")))).rejects.toThrow(/exited/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(supervisor.detect(request(join(dir, "sb2.json")))).rejects.toThrow(/exited/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(supervisor.detect(request(join(dir, "sb3.json")))).rejects.toThrow(
      /restart budget/,
    );
    expect(spawns).toBe(2);
    supervisor.dispose();
  });

  it("exposes the current worker pid and changes it across a restart", async () => {
    let spawns = 0;
    const supervisor = new PaddleWorkerSupervisor(() => {
      spawns += 1;
      return spawnFake(spawns === 1 ? "crash-on-request" : "ok");
    });
    await supervisor.ready();
    const firstPid = supervisor.pid;
    expect(firstPid).toBeGreaterThan(0);
    await expect(supervisor.detect(request(join(dir, "pid1.json")))).rejects.toThrow(/exited/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await supervisor.detect(request(join(dir, "pid2.json")));
    expect(supervisor.pid).toBeGreaterThan(0);
    expect(supervisor.pid).not.toBe(firstPid);
    supervisor.dispose();
  });

  it("does not restart after dispose", async () => {
    const supervisor = new PaddleWorkerSupervisor(() => spawnFake("ok"));
    supervisor.dispose();
    await expect(supervisor.detect(request(join(dir, "sd1.json")))).rejects.toThrow(/disposed/);
  });

  it("falls back for the crashed window, then rides the restarted worker", async () => {
    let spawns = 0;
    const supervisor = new PaddleWorkerSupervisor(() => {
      spawns += 1;
      return spawnFake(spawns === 1 ? "crash-on-request" : "ok");
    });
    let oneShotCalls = 0;
    const first = await detectPaddleWindow({
      worker: supervisor,
      request: request(join(dir, "sw1.json")),
      oneShot: () => {
        oneShotCalls += 1;
      },
      log: () => {},
    });
    expect(first).toBe("one_shot");
    expect(oneShotCalls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await detectPaddleWindow({
      worker: supervisor,
      request: request(join(dir, "sw2.json")),
      oneShot: () => {
        oneShotCalls += 1;
      },
      log: () => {},
    });
    expect(second).toBe("worker");
    expect(oneShotCalls).toBe(1);
    supervisor.dispose();
  });
});

describe("startPaddleWorker", () => {
  it("returns null when the detector environment is absent", () => {
    expect(startPaddleWorker(join(dir, "missing-python"), join(dir, "missing-script"))).toBeNull();
  });
});

describe("detectPaddleWindow fallback", () => {
  it("uses the worker and never invokes one-shot on success", async () => {
    const worker = spawnFake("ok");
    let oneShotCalls = 0;
    const path = await detectPaddleWindow({
      worker,
      request: request(join(dir, "f1.json")),
      oneShot: () => {
        oneShotCalls += 1;
      },
      log: () => {},
    });
    expect(path).toBe("worker");
    expect(oneShotCalls).toBe(0);
    worker.dispose();
  });

  it("falls back to one-shot on worker error response", async () => {
    const worker = spawnFake("error-once");
    let oneShotCalls = 0;
    const path = await detectPaddleWindow({
      worker,
      request: request(join(dir, "f2.json")),
      oneShot: () => {
        oneShotCalls += 1;
      },
      log: () => {},
    });
    expect(path).toBe("one_shot");
    expect(oneShotCalls).toBe(1);
    worker.dispose();
  });

  it("falls back to one-shot on worker crash", async () => {
    const worker = spawnFake("crash-on-request");
    let oneShotCalls = 0;
    const path = await detectPaddleWindow({
      worker,
      request: request(join(dir, "f3.json")),
      oneShot: () => {
        oneShotCalls += 1;
      },
      log: () => {},
    });
    expect(path).toBe("one_shot");
    expect(oneShotCalls).toBe(1);
  });

  it("goes straight to one-shot when no worker exists", async () => {
    let oneShotCalls = 0;
    const path = await detectPaddleWindow({
      worker: null,
      request: request(join(dir, "f4.json")),
      oneShot: () => {
        oneShotCalls += 1;
      },
      log: () => {},
    });
    expect(path).toBe("one_shot");
    expect(oneShotCalls).toBe(1);
  });
});
