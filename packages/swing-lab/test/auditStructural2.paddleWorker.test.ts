import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  PaddleServeWorker,
  PaddleWorkerSupervisor,
  detectPaddleWindow,
} from "../src/paddleWorker.js";

/**
 * Structural audit (pass 1, auditor #2) — paddle-serve-v1 client/supervisor
 * timing and trust assumptions not covered by test/paddleWorker.test.ts.
 * Fake workers speak the protocol on stdio (same technique as the existing
 * suite). A FAILING test is a reproduced finding on 4d812e1a; a passing one
 * refutes the corresponding mapper hint.
 */

const dir = mkdtempSync(join(tmpdir(), "audit-paddle-worker-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fake(mode: string): string {
  const path = join(dir, `fake-${mode}.mjs`);
  writeFileSync(
    path,
    `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const mode = ${JSON.stringify(mode)};
const say = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const protocol = mode === "wrong-protocol" ? "paddle-serve-v2" : "paddle-serve-v1";
say({ event: "ready", protocol, modelLoadSec: 0, warmupSec: 0, device: "test" });
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const req = JSON.parse(line);
  if (mode === "silent") return;
  if (mode === "ok-no-artifact") {
    say({ id: req.id, ok: true, out: req.out, framesProcessed: 0, paddleDetections: 0, extras: 0, timing: {}, requestWallSec: 0 });
    return;
  }
  writeFileSync(req.out, JSON.stringify({ frames: [], echo: req, pid: process.pid }));
  say({ id: req.id, ok: true, out: req.out, framesProcessed: 0, paddleDetections: 0, extras: 0, timing: {}, requestWallSec: 0 });
});
lines.on("close", () => process.exit(0));
`,
  );
  return path;
}

function spawnFake(mode: string, options: { requestTimeoutMs?: number } = {}) {
  return new PaddleServeWorker(process.execPath, [fake(mode)], { log: () => {}, ...options });
}

const request = (out: string) => ({ video: "clip.mp4", out, startMs: 0, endMs: 100 });

const waitForExit = (worker: PaddleServeWorker) =>
  new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      if (!worker.alive) {
        clearInterval(poll);
        resolve();
      }
    }, 10);
  });

describe("audit: request ids per worker instance (mapper hint: ids restart at r1)", () => {
  it("two live workers both issuing r1 are matched independently — refutes the hint", async () => {
    const a = spawnFake("ok");
    const b = spawnFake("ok");
    const outA = join(dir, "ids-a.json");
    const outB = join(dir, "ids-b.json");
    const [ra, rb] = await Promise.all([a.detect(request(outA)), b.detect(request(outB))]);
    expect(ra.out).toBe(outA);
    expect(rb.out).toBe(outB);
    const pidA = (JSON.parse(readFileSync(outA, "utf8")) as { pid: number }).pid;
    const pidB = (JSON.parse(readFileSync(outB, "utf8")) as { pid: number }).pid;
    expect(pidA).toBe(a.pid);
    expect(pidB).toBe(b.pid);
    a.dispose();
    b.dispose();
    await Promise.all([waitForExit(a), waitForExit(b)]);
  });
});

describe("audit: protocol handshake trust", () => {
  it("a worker announcing a different protocol version is rejected at ready()", async () => {
    const worker = spawnFake("wrong-protocol");
    await expect(worker.ready()).rejects.toThrow(/protocol/);
    worker.dispose();
    await waitForExit(worker);
  });

  it("an ok=true response without the promised artifact falls back to one-shot", async () => {
    const worker = spawnFake("ok-no-artifact");
    const out = join(dir, "no-artifact.json");
    let oneShotCalls = 0;
    const path = await detectPaddleWindow({
      worker,
      request: request(out),
      oneShot: () => {
        oneShotCalls += 1;
      },
      log: () => {},
    });
    expect(existsSync(out)).toBe(false);
    expect(path).toBe("one_shot");
    expect(oneShotCalls).toBe(1);
    worker.dispose();
    await waitForExit(worker);
  });
});

describe("audit: supervisor timing after a request timeout", () => {
  it("the request issued immediately after a timeout rides a fresh worker (no exit-event wait)", async () => {
    let spawns = 0;
    const supervisor = new PaddleWorkerSupervisor(() => {
      spawns += 1;
      return spawnFake(spawns === 1 ? "silent" : "ok", { requestTimeoutMs: 200 });
    });
    await expect(supervisor.detect(request(join(dir, "to-1.json")))).rejects.toThrow(/timed out/);
    // No settle wait: a sequential caller (analyzeVideo's detect loop) moves
    // straight to the next window.
    const out = join(dir, "to-2.json");
    const response = await supervisor.detect(request(out));
    expect(response.ok).toBe(true);
    expect(existsSync(out)).toBe(true);
    expect(spawns).toBe(2);
    supervisor.dispose();
  });
});
