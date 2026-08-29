import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  PaddleServeWorker,
  PaddleWorkerError,
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
const lines = createInterface({ input: process.stdin });
let requests = 0;
lines.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.op === "shutdown") { say({ id: req.id, ok: true, event: "shutdown" }); process.exit(0); }
  requests += 1;
  if (mode === "crash-on-request") process.exit(3);
  if (mode === "error-once" && requests === 1) { say({ id: req.id, ok: false, error: "boom" }); return; }
  if (mode === "silent") return; // never answers -> request timeout
  writeFileSync(req.out, JSON.stringify({ frames: [], echo: req }));
  say({ id: req.id, ok: true, out: req.out, framesProcessed: 0, paddleDetections: 0, extras: 0, timing: {}, requestWallSec: 0 });
});
lines.on("close", () => process.exit(0));
`,
  );
  return path;
}

function spawnFake(mode: string, options: { requestTimeoutMs?: number; readyTimeoutMs?: number } = {}) {
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
