import { describe, expect, it } from "vitest";
import { SessionEventEngine } from "../../src/sessionEngine.js";
import {
  SessionAnalysisScheduler,
  type SessionAnalysisExecutor,
  type SessionAnalysisTask,
  type SessionAnalysisTaskOutcome,
} from "../../src/sessionScheduler.js";
import { fakeAnalysis, syntheticStream } from "./attackFixtures.js";

/**
 * ADVERSARIAL PASS 3 / TESTER #2 — scheduler clock + lifecycle races.
 * Engine and scheduler are REAL; only the executor seam is scripted.
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Three well-separated strokes (1.5 s, 4.5 s, 7.5 s) over a 10 s stream. */
function threeStrokes() {
  return syntheticStream({ durationMs: 10_000, strokeEveryMs: 3000, firstStrokeMs: 1500 });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

describe("S2 — scheduler with a now() clock that returns NaN", () => {
  it("never reports NaN in queueWaitMs / serviceMs / totalLatencyMs", async () => {
    const engine = new SessionEventEngine({ sessionId: "attack-nan-clock" });
    const executor: SessionAnalysisExecutor = {
      executorId: "nan-clock-exec",
      async execute(): Promise<SessionAnalysisTaskOutcome> {
        return { status: "ready", analysis: fakeAnalysis };
      },
    };
    const scheduler = new SessionAnalysisScheduler({
      engine,
      executor,
      now: () => Number.NaN,
    });
    const closed = scheduler.pushSamples({ wrist: threeStrokes() });
    closed.push(...scheduler.endOfStream());
    expect(closed.length).toBeGreaterThan(0);
    await withTimeout(scheduler.drained(), 5_000, "drained()");
    const metrics = scheduler.metrics();
    expect(metrics.ready).toBe(closed.length);
    const offenders = metrics.tasks.flatMap((task) =>
      (
        [
          ["enqueuedAt", task.enqueuedAt],
          ["startedAt", task.startedAt],
          ["finishedAt", task.finishedAt],
          ["queueWaitMs", task.queueWaitMs],
          ["serviceMs", task.serviceMs],
          ["totalLatencyMs", task.totalLatencyMs],
        ] as Array<[string, number | null]>
      )
        .filter(([, value]) => typeof value === "number" && Number.isNaN(value))
        .map(([field]) => `${task.eventId}.${field}`),
    );
    // Scenario contract: measured durations must never be NaN. A broken clock
    // may make them unknown (null) or clamp them, but NaN poisons every
    // downstream aggregate (sums, percentiles, SLO checks) silently.
    expect(offenders, `NaN metrics on 4d812e1a: ${offenders.join(", ")}`).toEqual([]);
  });

  it("(control) with a sane clock, the same feed has finite metrics", async () => {
    const engine = new SessionEventEngine({ sessionId: "attack-sane-clock" });
    let tick = 1_000;
    const executor: SessionAnalysisExecutor = {
      executorId: "sane-clock-exec",
      async execute(): Promise<SessionAnalysisTaskOutcome> {
        tick += 50;
        return { status: "ready", analysis: fakeAnalysis };
      },
    };
    const scheduler = new SessionAnalysisScheduler({ engine, executor, now: () => tick });
    scheduler.pushSamples({ wrist: threeStrokes() });
    scheduler.endOfStream();
    await scheduler.drained();
    for (const task of scheduler.metrics().tasks) {
      expect(Number.isFinite(task.queueWaitMs!)).toBe(true);
      expect(Number.isFinite(task.serviceMs)).toBe(true);
      expect(Number.isFinite(task.totalLatencyMs!)).toBe(true);
    }
  });
});

describe("S3 — event marked 'abstained' directly on the engine while the scheduler has it in flight", () => {
  it("applyOutcome must not throw when the executor then returns 'ready', and the remaining queue must still drain", async () => {
    const engine = new SessionEventEngine({ sessionId: "attack-abstain-race" });
    const gate = deferred<void>();
    const calls: string[] = [];
    const executor: SessionAnalysisExecutor = {
      executorId: "race-exec",
      async execute(task: SessionAnalysisTask): Promise<SessionAnalysisTaskOutcome> {
        calls.push(task.eventId);
        if (task.eventId === "E1") await gate.promise;
        return { status: "ready", analysis: fakeAnalysis };
      },
    };
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const closed = scheduler.pushSamples({ wrist: threeStrokes() });
      closed.push(...scheduler.endOfStream());
      expect(closed.map((event) => event.eventId)).toEqual(["E1", "E2", "E3"]);
      expect(scheduler.metrics().inFlight).toBe(1);
      expect(engine.eventState("E1")).toBe("processing");

      // Another owner (e.g. the mobile flow, or a user "skip this stroke"
      // action) records a terminal outcome behind the scheduler's back.
      engine.markEvent("E1", "abstained", { abstainReason: "operator skipped" });
      expect(engine.eventState("E1")).toBe("abstained");

      // The in-flight executor now finishes with a real result.
      gate.resolve();
      let drainError: unknown = null;
      try {
        await withTimeout(scheduler.drained(), 5_000, "drained() after abstain race");
      } catch (error) {
        drainError = error;
      }

      // Let any rejected settle promise surface.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const metrics = scheduler.metrics();
      const diagnostic = JSON.stringify(
        {
          drainError: drainError instanceof Error ? drainError.message : drainError,
          executorCalls: calls,
          queueDepth: metrics.queueDepth,
          inFlight: metrics.inFlight,
          states: ["E1", "E2", "E3"].map((id) => `${id}=${engine.eventState(id)}`),
          e1Record: metrics.tasks.find((task) => task.eventId === "E1"),
          unhandled: unhandled.map(String),
        },
        null,
        2,
      );
      expect(drainError, `drained() rejected — ${diagnostic}`).toBeNull();
      expect(unhandled, `unhandled rejections: ${unhandled.map(String).join(" | ")}`).toEqual([]);
      expect(calls).toEqual(["E1", "E2", "E3"]);
      expect(metrics.queueDepth).toBe(0);
      expect(metrics.inFlight).toBe(0);
      expect(engine.eventState("E2")).toBe("ready");
      expect(engine.eventState("E3")).toBe("ready");
      // E1's record must be terminal one way or another — never stuck.
      const e1 = metrics.tasks.find((task) => task.eventId === "E1")!;
      expect(e1.outcome).not.toBeNull();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("(variant) same race but the executor returns 'abstained' — second terminal write for the same event", async () => {
    const engine = new SessionEventEngine({ sessionId: "attack-abstain-race-2" });
    const gate = deferred<void>();
    const executor: SessionAnalysisExecutor = {
      executorId: "race-exec-2",
      async execute(task: SessionAnalysisTask): Promise<SessionAnalysisTaskOutcome> {
        if (task.eventId === "E1") await gate.promise;
        return { status: "abstained", abstainReason: "analysis abstained" };
      },
    };
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      scheduler.pushSamples({ wrist: threeStrokes() });
      scheduler.endOfStream();
      engine.markEvent("E1", "abstained", { abstainReason: "operator skipped" });
      gate.resolve();
      await withTimeout(scheduler.drained(), 5_000, "drained()");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
      expect(scheduler.metrics().queueDepth).toBe(0);
      expect(engine.eventState("E3")).toBe("abstained");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("(control) without the external abstain, the identical feed drains cleanly", async () => {
    const engine = new SessionEventEngine({ sessionId: "attack-abstain-control" });
    const executor: SessionAnalysisExecutor = {
      executorId: "control-exec",
      async execute(): Promise<SessionAnalysisTaskOutcome> {
        return { status: "ready", analysis: fakeAnalysis };
      },
    };
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
    scheduler.pushSamples({ wrist: threeStrokes() });
    scheduler.endOfStream();
    await scheduler.drained();
    expect(scheduler.metrics().ready).toBe(3);
  });
});
