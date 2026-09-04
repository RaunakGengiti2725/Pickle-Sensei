import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  PaddleServeWorker,
  PaddleWorkerError,
  PaddleWorkerSupervisor,
  detectPaddleWindow,
} from "../src/paddleWorker.js";
import type { RawPaddleDetectionFile } from "../src/paddleTracker.js";

/**
 * Adversarial pass #2 over the paddle-serve-v1 stdio protocol (attack branch
 * devin/attack-pkg-swing-lab-2). Every test drives a HOSTILE fake worker (a
 * node script) against the unmodified PaddleServeWorker at 4d812e1a and pins
 * the behaviour that was MEASURED there:
 *
 *   S1 duplicate response for r1 cannot resolve a later request      HELD
 *   S2 worker ignores stdin EOF → dispose() SIGKILLs after 3 s,
 *      the next detectPaddleWindow falls back to one-shot             HELD
 *   S3 5 MB non-JSON stdout line then valid JSON → still resolves     HELD
 *   S4 half of paddle-dets.json written, then exit → the request
 *      rejects, the half artifact is unparsable (fail-closed)         HELD
 *   extras: forged id for a not-yet-issued request, duplicate ready,
 *      rapid detect/dispose interleaving, unicode/huge payloads, a
 *      response that lies about `out`.
 *
 * A test that documents a BROKEN result says so in its name and pins the
 * MEASURED (broken) behaviour, the same way the OOD red-team suite pins its
 * "KNOWN OPEN GAP" cases: it goes red the moment the behaviour is fixed, so
 * the fix must flip the assertion deliberately.
 */

const dir = mkdtempSync(join(tmpdir(), "paddle-worker-attack2-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A realistic (schema-complete) detection artifact the fake can half-write. */
function realisticArtifact(out: string, req: { startMs: number; endMs: number }): string {
  const frames: RawPaddleDetectionFile["frames"] = [];
  for (let tMs = req.startMs; tMs <= req.endMs; tMs += 20) {
    frames.push({
      tMs,
      detections: [{ box: [400, 400, 100, 100], score: 0.61, label: "tennis racket" }],
      extras: [],
    });
  }
  const file: RawPaddleDetectionFile = {
    schemaVersion: 1,
    detector: {
      modelId: "fake",
      version: "fake",
      license: "Apache-2.0",
      device: "cpu",
      proxyLabels: ["tennis racket"],
      proxyNote: "",
      scoreFloor: 0.08,
    },
    video: { path: out, width: 1000, height: 1000, fps: 50, durationMs: 4000 },
    window: { startMs: req.startMs, endMs: req.endMs },
    timing: {
      modelLoadSec: 0,
      framesProcessed: frames.length,
      inferenceSecTotal: 1,
      inferenceMsPerFrame: 10,
      wallSecTotal: 1,
    },
    frames,
  };
  return JSON.stringify(file);
}

/** Hostile fake worker: `mode` picks the attack. */
function fakeWorkerScript(mode: string): string {
  const path = join(dir, `fake-${mode}.mjs`);
  writeFileSync(
    path,
    `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const mode = ${JSON.stringify(mode)};
const say = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const ready = { event: "ready", protocol: "paddle-serve-v1", modelLoadSec: 0, warmupSec: 0, device: "test" };
say(ready);
if (mode === "double-ready") say(ready);
if (mode === "ignore-eof" || mode === "silent-ignore-eof") {
  // Hostile: never exits on stdin EOF, ignores SIGTERM/SIGINT, stays busy.
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
  setInterval(() => {}, 1000);
}
const lines = createInterface({ input: process.stdin });
let requests = 0;
const artifact = (req) => JSON.stringify({ frames: [], echo: req });
const answer = (req, extra = {}) => {
  say({ id: req.id, ok: true, out: req.out, framesProcessed: 0, paddleDetections: 0, extras: 0, timing: {}, requestWallSec: 0, ...extra });
};
lines.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.op === "shutdown") { say({ id: req.id, ok: true, event: "shutdown" }); process.exit(0); }
  requests += 1;
  if (mode === "dup-r1") {
    writeFileSync(req.out, artifact(req));
    answer(req);
    if (req.id === "r1") {
      // duplicate, then a THIRD copy delayed so it lands while r2 is pending
      answer(req);
      setTimeout(() => answer(req), 50);
    }
    return;
  }
  if (mode === "dup-r1-then-error") {
    writeFileSync(req.out, artifact(req));
    answer(req);
    if (req.id === "r1") say({ id: "r1", ok: false, error: "late duplicate failure" });
    return;
  }
  if (mode === "forge-next-id") {
    // Answers the request it has NOT received yet (ids are predictable) with
    // ok=true and no artifact, then answers its own request honestly.
    if (requests === 1) {
      const forged = { id: "r2", out: "/nonexistent/forged-r2.json" };
      say({ id: "r2", ok: true, out: forged.out, framesProcessed: 0, paddleDetections: 0, extras: 0, timing: {}, requestWallSec: 0 });
      writeFileSync(req.out, artifact(req));
      answer(req);
      return;
    }
    // The REAL r2 work lands 300 ms later — after the forged line already
    // resolved the caller.
    setTimeout(() => { writeFileSync(req.out, artifact(req)); answer(req); }, 300);
    return;
  }
  if (mode === "ignore-eof" || mode === "double-ready") {
    writeFileSync(req.out, artifact(req));
    answer(req);
    return;
  }
  if (mode === "silent-ignore-eof") return;
  if (mode === "big-line") {
    // 5 MiB of non-JSON on ONE stdout line, then the real response.
    process.stdout.write("x".repeat(5 * 1024 * 1024) + "\\n");
    writeFileSync(req.out, artifact(req));
    answer(req);
    return;
  }
  if (mode === "big-json-line") {
    // The response itself is ~5 MiB (valid JSON, huge padding field).
    writeFileSync(req.out, artifact(req));
    answer(req, { pad: "y".repeat(5 * 1024 * 1024) });
    return;
  }
  if (mode === "big-line-no-newline") {
    // 5 MiB without a terminating newline, then the JSON on the SAME line:
    // the protocol line is never delimited — a protocol violation.
    process.stdout.write("x".repeat(5 * 1024 * 1024));
    writeFileSync(req.out, artifact(req));
    answer(req);
    return;
  }
  if (mode === "half-artifact-exit") {
    writeFileSync(req.out, req.__full.slice(0, Math.floor(req.__full.length / 2)));
    process.exit(0);
  }
  if (mode === "half-artifact-ok") {
    writeFileSync(req.out, req.__full.slice(0, Math.floor(req.__full.length / 2)));
    answer(req);
    return;
  }
  if (mode === "unicode") {
    writeFileSync(req.out, artifact(req));
    answer(req, { note: "パドル 🏓 \\u0000 \\ud83d" , out: req.out });
    return;
  }
  if (mode === "lie-out") {
    writeFileSync(req.out, artifact(req));
    answer(req, { out: "/somewhere/else.json" });
    return;
  }
  writeFileSync(req.out, artifact(req));
  answer(req);
});
lines.on("close", () => { if (mode !== "ignore-eof" && mode !== "silent-ignore-eof") process.exit(0); });
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

function request(out: string, extra: Record<string, unknown> = {}) {
  return { video: "clip.mp4", out, startMs: 100, endMs: 200, ...extra };
}

/** The request carries the full artifact so the fake can write HALF of it. */
function halfArtifactRequest(out: string) {
  const req = request(out, { startMs: 0, endMs: 3000 });
  return { ...req, __full: realisticArtifact(out, req) } as typeof req;
}

const waitForExit = (worker: { alive: boolean }, timeoutMs = 10_000) =>
  new Promise<number>((resolve, reject) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (!worker.alive) {
        clearInterval(poll);
        resolve(Date.now() - started);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(poll);
        reject(new Error(`worker still alive after ${timeoutMs}ms`));
      }
    }, 10);
  });

const isAlivePid = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Mirrors analyzeVideo.ts:1170/1188 — the ONLY way artifacts are consumed. */
function loadArtifact(path: string): RawPaddleDetectionFile {
  return JSON.parse(readFileSync(path, "utf8")) as RawPaddleDetectionFile;
}

describe("attack2 S1: duplicate responses", () => {
  it("HELD: r1 answered three times (one copy while r2 is pending) never resolves r2", async () => {
    const worker = spawnFake("dup-r1");
    const out1 = join(dir, "dup-1.json");
    const out2 = join(dir, "dup-2.json");
    const r1 = await worker.detect(request(out1));
    expect(r1.out).toBe(out1);
    // r2 is issued while r1's THIRD copy (50 ms later) is still in flight.
    // If a duplicate could satisfy r2, r2 would resolve with out === out1.
    const r2 = await worker.detect(request(out2, { startMs: 500, endMs: 600 }));
    expect(r2.out).toBe(out2);
    expect(JSON.parse(readFileSync(out2, "utf8")).echo.startMs).toBe(500);
    // Give the late duplicate time to arrive, then prove the worker is still
    // a healthy conversation partner (a stray resolve would have corrupted
    // `pending` and stalled or mis-resolved this request).
    await new Promise((resolve) => setTimeout(resolve, 120));
    const out3 = join(dir, "dup-3.json");
    const r3 = await worker.detect(request(out3, { startMs: 900, endMs: 950 }));
    expect(r3.out).toBe(out3);
    worker.dispose();
    await waitForExit(worker);
  });

  it("HELD: a late ok=false duplicate for an already-resolved r1 does not reject anything", async () => {
    const worker = spawnFake("dup-r1-then-error");
    const out1 = join(dir, "duperr-1.json");
    const r1 = await worker.detect(request(out1));
    expect(r1.ok).toBe(true);
    const out2 = join(dir, "duperr-2.json");
    await expect(worker.detect(request(out2))).resolves.toMatchObject({ ok: true, out: out2 });
    worker.dispose();
    await waitForExit(worker);
  });

  it("HELD: a second `ready` event is harmless", async () => {
    const worker = spawnFake("double-ready");
    const out = join(dir, "double-ready.json");
    await expect(worker.detect(request(out))).resolves.toMatchObject({ ok: true, out });
    worker.dispose();
    await waitForExit(worker);
  });
});

describe("attack2 S2: worker ignores stdin EOF", () => {
  it("HELD: dispose() SIGKILLs the lingering worker after ~3 s; the next window falls back to one-shot", async () => {
    const worker = spawnFake("ignore-eof");
    const out = join(dir, "eof-1.json");
    await expect(worker.detect(request(out))).resolves.toMatchObject({ ok: true });
    const pid = worker.pid!;
    expect(isAlivePid(pid)).toBe(true);

    const disposedAt = Date.now();
    worker.dispose();
    // Graceful window: the hostile worker is still alive well after EOF.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(worker.alive).toBe(true);
    expect(isAlivePid(pid)).toBe(true);

    await waitForExit(worker, 8000);
    const elapsed = Date.now() - disposedAt;
    expect(elapsed).toBeGreaterThanOrEqual(2900);
    expect(elapsed).toBeLessThan(6000);
    // Let the OS reap the process so the pid probe is meaningful.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(isAlivePid(pid)).toBe(false);

    let oneShot = 0;
    const path = await detectPaddleWindow({
      worker,
      request: request(join(dir, "eof-2.json")),
      oneShot: () => {
        oneShot += 1;
      },
      log: () => {},
    });
    expect(path).toBe("one_shot");
    expect(oneShot).toBe(1);
  }, 15_000);

  it("HELD: a detect() issued AFTER dispose() (worker still alive, stdin ended) rejects immediately → one-shot", async () => {
    const worker = spawnFake("ignore-eof");
    await worker.ready();
    worker.dispose();
    let oneShot = 0;
    const started = Date.now();
    const path = await detectPaddleWindow({
      worker,
      request: request(join(dir, "eof-after-dispose.json")),
      oneShot: () => {
        oneShot += 1;
      },
      log: () => {},
    });
    expect(path).toBe("one_shot");
    expect(oneShot).toBe(1);
    // Must not wait for the 3 s killer or the request timeout.
    expect(Date.now() - started).toBeLessThan(1000);
    await waitForExit(worker, 8000);
  }, 15_000);

  it("HELD: supervisor.dispose() over an EOF-ignoring worker kills it and refuses further detects", async () => {
    const supervisor = new PaddleWorkerSupervisor(() => spawnFake("ignore-eof"), {
      maxRestarts: 2,
    });
    await supervisor.ready();
    const pid = supervisor.pid!;
    supervisor.dispose();
    await expect(supervisor.detect(request(join(dir, "sup-eof.json")))).rejects.toThrow(/disposed/);
    expect(supervisor.restarts).toBe(0);
    await waitForExit(supervisor, 8000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(isAlivePid(pid)).toBe(false);
  }, 15_000);
});

describe("attack2 S3: huge stdout lines", () => {
  it("HELD: a 5 MiB non-JSON line followed by the JSON response does not stall readline", async () => {
    const worker = spawnFake("big-line", { requestTimeoutMs: 20_000 });
    const out = join(dir, "big-line.json");
    const started = Date.now();
    await expect(worker.detect(request(out))).resolves.toMatchObject({ ok: true, out });
    expect(Date.now() - started).toBeLessThan(15_000);
    // still healthy afterwards
    const out2 = join(dir, "big-line-2.json");
    await expect(worker.detect(request(out2))).resolves.toMatchObject({ ok: true, out: out2 });
    worker.dispose();
    await waitForExit(worker);
  }, 30_000);

  it("HELD: a 5 MiB VALID JSON response line is parsed and resolves", async () => {
    const worker = spawnFake("big-json-line", { requestTimeoutMs: 20_000 });
    const out = join(dir, "big-json.json");
    const response = await worker.detect(request(out));
    expect(response.out).toBe(out);
    expect((response as unknown as { pad: string }).pad.length).toBe(5 * 1024 * 1024);
    worker.dispose();
    await waitForExit(worker);
  }, 30_000);

  it("HELD: 5 MiB WITHOUT a newline glued to the JSON never delimits → request times out and the worker is killed (fail-closed)", async () => {
    const worker = spawnFake("big-line-no-newline", { requestTimeoutMs: 1500 });
    const out = join(dir, "big-line-nonl.json");
    await expect(worker.detect(request(out))).rejects.toThrow(/timed out/);
    await waitForExit(worker);
    expect(worker.alive).toBe(false);
  }, 15_000);
});

describe("attack2 S4: half-written paddle-dets.json", () => {
  it("HELD: worker writes half the artifact then exits → request rejects, window falls back, half file is unparsable", async () => {
    const worker = spawnFake("half-artifact-exit");
    const out = join(dir, "half-exit.json");
    let oneShot = 0;
    const path = await detectPaddleWindow({
      worker,
      request: halfArtifactRequest(out),
      oneShot: () => {
        oneShot += 1;
      },
      log: () => {},
    });
    expect(path).toBe("one_shot");
    expect(oneShot).toBe(1);
    expect(worker.alive).toBe(false);
    // The half artifact is on disk and looks like a detection file …
    expect(existsSync(out)).toBe(true);
    const half = readFileSync(out, "utf8");
    expect(half.startsWith('{"schemaVersion":1')).toBe(true);
    expect(half).toContain('"frames":[');
    // … but the only consumer path (JSON.parse at analyzeVideo.ts:1170/1188/1254)
    // throws instead of yielding partial frames.
    expect(() => loadArtifact(out)).toThrow(SyntaxError);
  });

  it("HELD: worker writes half the artifact and LIES ok=true → detect resolves but the artifact still cannot be loaded", async () => {
    const worker = spawnFake("half-artifact-ok");
    const out = join(dir, "half-ok.json");
    const response = await worker.detect(halfArtifactRequest(out));
    expect(response.ok).toBe(true);
    expect(() => loadArtifact(out)).toThrow(SyntaxError);
    worker.dispose();
    await waitForExit(worker);
  });
});

describe("attack2 extras: protocol abuse", () => {
  it("BROKEN(P3): a forged response for a not-yet-issued id resolves that request once issued — response.out is never cross-checked", async () => {
    // Ids are predictable (r1, r2, …). A worker that mislabels a response
    // resolves the WRONG request; nothing compares response.out with the
    // request's `out`. Consequence is bounded: analyzeVideo reads its own
    // `out` path afterwards and ENOENT → status "failed" (fail-closed), so
    // this is a robustness gap, not partial tracking.
    const worker = spawnFake("forge-next-id");
    const out1 = join(dir, "forge-1.json");
    const out2 = join(dir, "forge-2.json");
    const [r1, r2] = await Promise.all([
      worker.detect(request(out1)),
      worker.detect(request(out2, { startMs: 500, endMs: 600 })),
    ]);
    expect(r1.out).toBe(out1);
    // MEASURED on 4d812e1a: r2 resolved from the forged line, BEFORE the
    // worker did any work for r2 (its artifact is not on disk yet).
    expect(r2.out).toBe("/nonexistent/forged-r2.json");
    expect(existsSync(out2)).toBe(false);
    // The forged response is accepted, but the request's own artifact does
    // not exist — the consumer path fails closed rather than tracking.
    expect(() => loadArtifact(out2)).toThrow(/ENOENT/);
    // The worker's real (late) r2 answer is then an unknown id → ignored,
    // and the worker keeps serving.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const out3 = join(dir, "forge-3.json");
    await expect(worker.detect(request(out3))).resolves.toMatchObject({ ok: true, out: out3 });
    worker.dispose();
    await waitForExit(worker);
  });

  it("HELD: a response that lies about `out` resolves; consumers read the REQUEST path (artifact present)", async () => {
    const worker = spawnFake("lie-out");
    const out = join(dir, "lie-out.json");
    const response = await worker.detect(request(out));
    expect(response.out).toBe("/somewhere/else.json");
    expect(existsSync(out)).toBe(true);
    worker.dispose();
    await waitForExit(worker);
  });

  it("HELD: unicode / lone surrogate / NUL in a response line are parsed, not fatal", async () => {
    const worker = spawnFake("unicode");
    const out = join(dir, "unicode-\u30d1\u30c9\u30eb.json");
    const response = await worker.detect(request(out));
    expect(response.out).toBe(out);
    expect(existsSync(out)).toBe(true);
    worker.dispose();
    await waitForExit(worker);
  });

  it("HELD: 20 rapid detects then an immediate dispose — every request settles (resolve or PaddleWorkerError), nothing hangs", async () => {
    const worker = spawnFake("ok", { requestTimeoutMs: 5000 });
    const promises: Promise<unknown>[] = [];
    for (let index = 0; index < 20; index += 1) {
      promises.push(worker.detect(request(join(dir, `rapid-${index}.json`))));
    }
    worker.dispose();
    const settled = await Promise.allSettled(promises);
    for (const entry of settled) {
      if (entry.status === "rejected") expect(entry.reason).toBeInstanceOf(PaddleWorkerError);
    }
    await waitForExit(worker);
    expect(worker.alive).toBe(false);
  }, 15_000);

  it("HELD: dispose() racing a request timeout on a silent EOF-ignoring worker — request rejects once, the timeout kill wins (no 3 s wait)", async () => {
    const worker = spawnFake("silent-ignore-eof", { requestTimeoutMs: 300 });
    await worker.ready();
    const started = Date.now();
    const pending = worker.detect(request(join(dir, "race.json")));
    // detect() awaits readyPromise before writing; let the write happen so
    // the request is genuinely in flight when dispose() closes stdin.
    await new Promise((resolve) => setImmediate(resolve));
    worker.dispose();
    await expect(pending).rejects.toThrow(/timed out after 300ms/);
    await waitForExit(worker, 8000);
    expect(Date.now() - started).toBeLessThan(2500);
    expect(worker.alive).toBe(false);
  }, 15_000);
});
