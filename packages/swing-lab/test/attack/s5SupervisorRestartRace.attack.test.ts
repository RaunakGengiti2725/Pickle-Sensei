import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  PaddleServeWorker,
  PaddleWorkerError,
  PaddleWorkerSupervisor,
  detectPaddleWindow,
} from "../../src/paddleWorker.js";

/**
 * ADVERSARIAL S5 — supervisor restart race.
 *
 * Existing supervisor tests wait 50 ms after a crash before touching the
 * replacement. Real callers do not: detectPaddleWindow issues the next window
 * the instant the previous one rejects. This attack removes every artificial
 * delay:
 *
 *   1. worker #1 crashes on its first request;
 *   2. detect() is called in the SAME microtask the rejection is observed —
 *      this must spawn worker #2 and park on its ready event;
 *   3. detect() is called AGAIN synchronously, before worker #2 (which takes
 *      `slowReadyMs` to report ready) has said anything.
 *
 * Both parked requests must resolve on worker #2 — neither may reject with
 * "worker is not running"/"not running", and the restart budget must be
 * consumed exactly once (one respawn, not one per parked request).
 */

const dir = mkdtempSync(join(tmpdir(), "attack-s5-supervisor-"));
/** Kept after the run (evidence); the fixture dir above is removed. */
const artifacts = mkdtempSync(join(tmpdir(), "attack-s5-artifacts-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  console.log(`S5 evidence: ${artifacts}`);
});

/** Fake worker: `crash-on-request`, `slow-ready:<ms>`, `exit-after-first:<ms>`. */
function fakeWorkerScript(mode: string): string {
  const path = join(dir, `fake-${mode.replace(/[^a-z0-9-]/gi, "_")}.mjs`);
  writeFileSync(
    path,
    `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const mode = ${JSON.stringify(mode)};
const [kind, arg] = mode.split(":");
const say = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const ready = () => say({ event: "ready", protocol: "paddle-serve-v1", modelLoadSec: 0, warmupSec: 0, device: "test", pid: process.pid });
if (kind === "slow-ready") setTimeout(ready, Number(arg)); else ready();
const lines = createInterface({ input: process.stdin });
let requests = 0;
lines.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.op === "shutdown") { say({ id: req.id, ok: true, event: "shutdown" }); process.exit(0); }
  requests += 1;
  if (kind === "crash-on-request") process.exit(3);
  writeFileSync(req.out, JSON.stringify({ frames: [], echo: req, pid: process.pid }));
  say({ id: req.id, ok: true, out: req.out, framesProcessed: 0, paddleDetections: 0, extras: 0, timing: {}, requestWallSec: 0, pid: process.pid });
  if (kind === "exit-after-first" && requests === 1) setTimeout(() => process.exit(4), Number(arg));
});
lines.on("close", () => process.exit(0));
`,
  );
  return path;
}

function spawnFake(mode: string, options: { readyTimeoutMs?: number } = {}) {
  return new PaddleServeWorker(process.execPath, [fakeWorkerScript(mode)], {
    log: () => {},
    requestTimeoutMs: 5_000,
    ...options,
  });
}

const request = (out: string) => ({ video: "clip.mp4", out, startMs: 100, endMs: 200 });

interface Timeline {
  spawns: Array<{ index: number; mode: string; atMs: number }>;
  readyAtMs: number[];
  events: string[];
}

function timelineFactory(modes: string[], readyTimeoutMs = 2_000) {
  const timeline: Timeline = { spawns: [], readyAtMs: [], events: [] };
  const t0 = performance.now();
  const workers: PaddleServeWorker[] = [];
  const factory = () => {
    const index = workers.length;
    const mode = modes[Math.min(index, modes.length - 1)]!;
    timeline.spawns.push({ index, mode, atMs: Math.round(performance.now() - t0) });
    const worker = spawnFake(mode, { readyTimeoutMs });
    worker.ready().then(
      () => {
        timeline.readyAtMs[index] = Math.round(performance.now() - t0);
        timeline.events.push(`worker#${index} ready @${timeline.readyAtMs[index]}ms`);
      },
      (error: Error) => timeline.events.push(`worker#${index} never ready: ${error.message}`),
    );
    workers.push(worker);
    return worker;
  };
  const stamp = (label: string) =>
    timeline.events.push(`${label} @${Math.round(performance.now() - t0)}ms`);
  return { factory, timeline, workers, stamp };
}

describe("ADVERSARIAL S5: detect() immediately after a crash, again before the replacement is ready", () => {
  it("both parked requests ride worker #2 once it reports ready; neither throws 'not running'", async () => {
    const slowReadyMs = 400;
    const { factory, timeline, workers, stamp } = timelineFactory([
      "crash-on-request",
      `slow-ready:${slowReadyMs}`,
    ]);
    const supervisor = new PaddleWorkerSupervisor(factory, { maxRestarts: 2 });
    try {
      await supervisor.ready();
      stamp("worker#0 ready; issuing request that will crash it");
      const crashed = supervisor.detect(request(join(dir, "race-r1.json")));
      await expect(crashed).rejects.toThrow(/exited/);
      stamp("request#1 rejected (worker#0 crashed)");
      expect(supervisor.alive).toBe(false);

      // No delay. Two requests in the same tick, before worker #2 is ready.
      const outA = join(dir, "race-r2.json");
      const outB = join(dir, "race-r3.json");
      const parkedA = supervisor.detect(request(outA));
      stamp("request#2 issued (spawns replacement)");
      const parkedB = supervisor.detect(request(outB));
      stamp("request#3 issued (replacement not yet ready)");
      expect(workers).toHaveLength(2);
      expect(supervisor.restarts).toBe(1);
      expect(timeline.readyAtMs[1]).toBeUndefined();

      const settled = await Promise.allSettled([parkedA, parkedB]);
      stamp("requests #2/#3 settled");
      writeFileSync(
        join(artifacts, "s5-timeline.json"),
        JSON.stringify({ timeline, settled }, null, 2),
      );

      for (const [index, result] of settled.entries()) {
        expect(
          result.status,
          `request#${index + 2}: ${result.status === "rejected" ? String(result.reason) : "ok"}\n${timeline.events.join("\n")}`,
        ).toBe("fulfilled");
      }
      expect(existsSync(outA)).toBe(true);
      expect(existsSync(outB)).toBe(true);
      // Exactly one respawn for two parked requests, and the replacement
      // really was slow: it reported ready no earlier than slowReadyMs after
      // it was spawned.
      expect(workers).toHaveLength(2);
      expect(supervisor.restarts).toBe(1);
      expect(timeline.readyAtMs[1]! - timeline.spawns[1]!.atMs).toBeGreaterThanOrEqual(
        slowReadyMs - 20,
      );
      for (const result of settled) {
        if (result.status === "fulfilled") expect(result.value.ok).toBe(true);
      }
    } finally {
      supervisor.dispose();
    }
  });

  it("50 concurrent detects fired the instant after a crash all resolve on the single replacement", async () => {
    const { factory, workers, timeline } = timelineFactory(["crash-on-request", "slow-ready:200"]);
    const supervisor = new PaddleWorkerSupervisor(factory, { maxRestarts: 1 });
    try {
      await supervisor.ready();
      await expect(supervisor.detect(request(join(dir, "burst-r0.json")))).rejects.toThrow(
        /exited/,
      );
      const burst = Array.from({ length: 50 }, (_, index) =>
        supervisor.detect(request(join(dir, `burst-${index}.json`))),
      );
      const settled = await Promise.allSettled(burst);
      const rejected = settled.filter((result) => result.status === "rejected");
      expect(
        rejected.map((result) => String((result as PromiseRejectedResult).reason)),
        timeline.events.join("\n"),
      ).toEqual([]);
      expect(workers).toHaveLength(2);
      expect(supervisor.restarts).toBe(1);
    } finally {
      supervisor.dispose();
    }
  });

  it("replacement that never reports ready: parked requests reject with the ready-timeout reason, not 'not running'; the budget then allows one more respawn", async () => {
    const { factory, workers } = timelineFactory(
      ["crash-on-request", "slow-ready:60000", "slow-ready:50"],
      300,
    );
    const supervisor = new PaddleWorkerSupervisor(factory, { maxRestarts: 2 });
    try {
      await supervisor.ready();
      await expect(supervisor.detect(request(join(dir, "nr-r0.json")))).rejects.toThrow(/exited/);
      const parked = [
        supervisor.detect(request(join(dir, "nr-r1.json"))),
        supervisor.detect(request(join(dir, "nr-r2.json"))),
      ];
      const settled = await Promise.allSettled(parked);
      for (const result of settled) {
        expect(result.status).toBe("rejected");
        const reason = (result as PromiseRejectedResult).reason as Error;
        expect(reason).toBeInstanceOf(PaddleWorkerError);
        expect(reason.message).toMatch(/did not report ready in time/);
        expect(reason.message).not.toMatch(/not running/);
      }
      // The ready-timeout handler SIGKILLs worker #1. The very next request —
      // issued the instant the parked ones rejected, exactly as
      // detectPaddleWindow's caller does — must ride a fresh worker #2 (budget
      // has one respawn left), not be answered from the corpse of worker #1.
      const out = join(dir, "nr-r3.json");
      const next = await Promise.allSettled([supervisor.detect(request(out))]);
      writeFileSync(
        join(artifacts, "s5-never-ready-next.json"),
        JSON.stringify(
          {
            next,
            aliveWhenIssued: workers[1]!.alive,
            workersSpawned: workers.length,
            restarts: supervisor.restarts,
          },
          null,
          2,
        ),
      );
      expect(
        next[0]!.status,
        `request after ready-timeout: ${next[0]!.status === "rejected" ? String(next[0]!.reason) : "ok"}; workers=${workers.length} restarts=${supervisor.restarts}`,
      ).toBe("fulfilled");
      expect(existsSync(out)).toBe(true);
      expect(workers).toHaveLength(3);
      expect(supervisor.restarts).toBe(2);
    } finally {
      supervisor.dispose();
    }
  });

  it("control: after the ready-timeout, WAITING for the SIGKILL exit to be observed lets the supervisor respawn", async () => {
    const { factory, workers } = timelineFactory(
      ["crash-on-request", "slow-ready:60000", "slow-ready:50"],
      300,
    );
    const supervisor = new PaddleWorkerSupervisor(factory, { maxRestarts: 2 });
    try {
      await supervisor.ready();
      await expect(supervisor.detect(request(join(dir, "ctl-r0.json")))).rejects.toThrow(/exited/);
      await expect(supervisor.detect(request(join(dir, "ctl-r1.json")))).rejects.toThrow(
        /did not report ready in time/,
      );
      // Worker #1 is still reported alive right after the timeout rejection…
      const aliveRightAfter = supervisor.alive;
      expect(aliveRightAfter).toBe(true);
      // …until its SIGKILL exit is observed.
      await new Promise<void>((resolve) => {
        const poll = setInterval(() => {
          if (!supervisor.alive) {
            clearInterval(poll);
            resolve();
          }
        }, 5);
      });
      const out = join(dir, "ctl-r2.json");
      const response = await supervisor.detect(request(out));
      expect(response.ok).toBe(true);
      expect(existsSync(out)).toBe(true);
      expect(workers).toHaveLength(3);
      expect(supervisor.restarts).toBe(2);
      // Documented for the finding: the window in which the dead-on-arrival
      // worker still counts as alive.
      writeFileSync(
        join(artifacts, "s5-control.json"),
        JSON.stringify({ aliveRightAfterReadyTimeout: aliveRightAfter }, null, 2),
      );
      // Budget exhausted: a further crash is terminal.
      workers[2]!.dispose();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await expect(supervisor.detect(request(join(dir, "ctl-r3.json")))).rejects.toThrow(
        /restart budget/,
      );
    } finally {
      supervisor.dispose();
    }
  });

  it("crash BETWEEN requests: a request written into the dying worker is lost (documented design), the next one rides the replacement", async () => {
    const { factory, workers } = timelineFactory(["exit-after-first:30", "slow-ready:50"]);
    const supervisor = new PaddleWorkerSupervisor(factory, { maxRestarts: 2 });
    try {
      const first = await supervisor.detect(request(join(dir, "between-r1.json")));
      expect(first.ok).toBe(true);
      // Worker #0 will exit ~30 ms from now. Issue a request right into that
      // window (the supervisor still sees it alive).
      await new Promise((resolve) => setTimeout(resolve, 25));
      const paths: Array<"worker" | "one_shot"> = [];
      const oneShots: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        const out = join(dir, `between-r${index + 2}.json`);
        paths.push(
          await detectPaddleWindow({
            worker: supervisor,
            request: request(out),
            oneShot: () => oneShots.push(out),
            log: () => {},
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      // Every window produced SOME artifact path decision; at most the
      // window(s) issued into the dying worker fell back to one-shot, and
      // the supervisor recovered onto worker #1 for the rest.
      expect(paths.at(-1)).toBe("worker");
      expect(workers.length).toBeLessThanOrEqual(2);
      expect(supervisor.restarts).toBeLessThanOrEqual(1);
      expect(paths.filter((path) => path === "one_shot").length).toBe(oneShots.length);
    } finally {
      supervisor.dispose();
    }
  });
});
