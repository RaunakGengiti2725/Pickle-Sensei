import { describe, expect, it } from "vitest";
import { SessionEventEngine, type SpeedSample } from "../src/sessionEngine.js";
import {
  SessionAnalysisScheduler,
  type SessionAnalysisExecutor,
  type SessionAnalysisTask,
  type SessionAnalysisTaskOutcome,
} from "../src/sessionScheduler.js";

/**
 * RED-TEAM SUITE (wave F, f21): adversarial scheduling conditions —
 * synchronous executor throws, clock skew, recovery attempt budgets,
 * event storms, duplicate re-admission attempts, suspend/resume races,
 * and concurrent drained() waiters. Same honesty boundary as
 * sessionScheduler.test.ts: the engine and scheduler are REAL; only the
 * analysis execution behind the executor seam is scripted.
 */

function speedBumps(
  bumps: Array<{ peakMs: number; height: number; halfWidthMs: number }>,
  fromMs = 0,
  toMs = 8000,
  stepMs = 40,
): SpeedSample[] {
  const series: SpeedSample[] = [];
  for (let t = fromMs; t <= toMs; t += stepMs) {
    let value = 0.08;
    for (const bump of bumps) {
      value += bump.height * Math.exp(-0.5 * ((t - bump.peakMs) / bump.halfWidthMs) ** 2);
    }
    series.push({ timestampMs: t, value });
  }
  return series;
}

function threeStrokeStream(): SpeedSample[] {
  return speedBumps(
    [
      { peakMs: 1200, height: 2.0, halfWidthMs: 120 },
      { peakMs: 3600, height: 2.2, halfWidthMs: 120 },
      { peakMs: 6000, height: 1.8, halfWidthMs: 120 },
    ],
    0,
    8200,
  );
}

const fakeAnalysis = { id: "synthetic-analysis" } as unknown as NonNullable<
  ReturnType<SessionEventEngine["snapshot"]>["events"][number]["analysis"]
>;

function scriptedExecutor(
  script: (
    task: SessionAnalysisTask,
  ) => SessionAnalysisTaskOutcome | Promise<SessionAnalysisTaskOutcome>,
): SessionAnalysisExecutor & { calls: SessionAnalysisTask[] } {
  const calls: SessionAnalysisTask[] = [];
  return {
    executorId: "red-team-executor",
    calls,
    async execute(task) {
      calls.push(task);
      return script(task);
    },
  };
}

describe("SessionAnalysisScheduler — red team", () => {
  it("SYNC THROW: an executor that throws synchronously must not poison the dispatch slot or crash pushSamples", async () => {
    const engine = new SessionEventEngine({ sessionId: "rt-sync-throw" });
    const calls: SessionAnalysisTask[] = [];
    // Deliberately NOT an async function: a JS implementation behind the
    // seam can throw before returning a promise.
    const executor = {
      executorId: "sync-thrower",
      execute(task: SessionAnalysisTask): Promise<SessionAnalysisTaskOutcome> {
        calls.push(task);
        if (task.eventId === "E1") throw new Error("bridge init crashed synchronously");
        return Promise.resolve({ status: "ready", analysis: fakeAnalysis });
      },
    } satisfies SessionAnalysisExecutor;
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
    // Must not throw out of the sample-feeding path (recording never stops).
    expect(() => {
      for (const sample of threeStrokeStream()) scheduler.pushSamples({ wrist: [sample] });
      scheduler.endOfStream();
    }).not.toThrow();
    await scheduler.drained();
    const metrics = scheduler.metrics();
    expect(metrics.executorThrows).toBe(1);
    expect(metrics.failedFinal).toBe(1);
    expect(metrics.ready).toBe(2);
    expect(metrics.inFlight).toBe(0); // the slot is not leaked
    const e1 = metrics.tasks.find((task) => task.eventId === "E1")!;
    expect(e1.failures[0]).toContain("EXECUTOR_THREW: bridge init crashed synchronously");
    const states = Object.fromEntries(
      engine.snapshot().events.map((event) => [event.eventId, event.state]),
    );
    expect(states).toEqual({ E1: "pending", E2: "ready", E3: "ready" });
  });

  it("CLOCK SKEW: a clock stepping backwards must never yield negative latency measurements", async () => {
    const engine = new SessionEventEngine({ sessionId: "rt-clock-skew" });
    // Virtual clock that jumps BACKWARDS (NTP step / device clock reset)
    // between enqueue, dispatch, and settle.
    const clockValues = [10_000, 9_000, 8_500, 8_000, 7_500, 7_000, 6_500, 6_000, 5_500, 5_000];
    let clockIndex = 0;
    const now = () => clockValues[Math.min(clockIndex++, clockValues.length - 1)]!;
    const executor = scriptedExecutor(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { status: "ready", analysis: fakeAnalysis };
    });
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1, now });
    for (const sample of threeStrokeStream()) scheduler.pushSamples({ wrist: [sample] });
    scheduler.endOfStream();
    await scheduler.drained();
    const metrics = scheduler.metrics();
    expect(metrics.ready).toBe(3);
    for (const task of metrics.tasks) {
      expect(task.queueWaitMs).not.toBeNull();
      expect(task.totalLatencyMs).not.toBeNull();
      expect(task.queueWaitMs!).toBeGreaterThanOrEqual(0);
      expect(task.serviceMs).toBeGreaterThanOrEqual(0);
      expect(task.totalLatencyMs!).toBeGreaterThanOrEqual(0);
    }
  });

  it("RECOVERY BUDGET: readmitExhausted grants a FRESH attempt budget (documented recovery lease), not a single doomed try", async () => {
    const engine = new SessionEventEngine({ sessionId: "rt-readmit-budget" });
    let failuresRemaining = 3; // attempts 1..3 fail retryably, attempt 4 succeeds
    const executor = scriptedExecutor(() => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        return { status: "failed", reason: "CLIP_EXTRACTION_FAILED: transient", retryable: true };
      }
      return { status: "ready", analysis: fakeAnalysis };
    });
    const scheduler = new SessionAnalysisScheduler({ engine, executor, maxAttempts: 2 });
    for (const sample of speedBumps([{ peakMs: 1200, height: 2.0, halfWidthMs: 120 }], 0, 3000)) {
      scheduler.pushSamples({ wrist: [sample] });
    }
    scheduler.endOfStream();
    await scheduler.drained();
    expect(scheduler.metrics().retryExhausted).toBe(1); // attempts 1+2 spent
    // Explicit operator re-admission: the doc contract promises a fresh
    // attempt budget. Attempt 3 fails retryably — the recovery lease must
    // allow attempt 4 (its own maxAttempts=2 budget), which succeeds.
    const readmitted = scheduler.recoverPending({ readmitExhausted: true });
    expect(readmitted).toEqual(["E1"]);
    await scheduler.drained();
    const metrics = scheduler.metrics();
    expect(metrics.ready).toBe(1);
    const e1 = metrics.tasks.find((task) => task.eventId === "E1")!;
    expect(e1.attempts).toBe(4);
    expect(e1.outcome).toBe("ready");
    expect(engine.snapshot().events[0]!.state).toBe("ready");
  });

  it("STORM: 40 rapid events — exactly-once, strict FIFO first attempts, bounded in-flight, all terminal", async () => {
    const engine = new SessionEventEngine({ sessionId: "rt-storm" });
    const bumps = Array.from({ length: 40 }, (_, index) => ({
      peakMs: 1200 + index * 2400,
      height: 2.0,
      halfWidthMs: 120,
    }));
    const stream = speedBumps(bumps, 0, 1200 + 39 * 2400 + 2000);
    const executor = scriptedExecutor(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { status: "ready", analysis: fakeAnalysis };
    });
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 2 });
    let fed = 0;
    for (const sample of stream) {
      scheduler.pushSamples({ wrist: [sample] });
      fed += 1;
      // Long synchronous loops must yield the event loop periodically.
      if (fed % 500 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    scheduler.endOfStream();
    await scheduler.drained();
    const metrics = scheduler.metrics();
    expect(metrics.enqueued).toBe(40);
    expect(metrics.ready).toBe(40);
    expect(metrics.maxInFlight).toBeLessThanOrEqual(2);
    expect(metrics.inFlight).toBe(0);
    expect(metrics.queueDepth).toBe(0);
    const firstAttempts = executor.calls.filter((call) => call.attempt === 1);
    expect(firstAttempts.map((call) => call.eventId)).toEqual(
      Array.from({ length: 40 }, (_, index) => `E${index + 1}`),
    );
  });

  it("DUPLICATE RE-ADMISSION: repeated recoverPending() while tasks are queued/in-flight never double-dispatches", async () => {
    const engine = new SessionEventEngine({ sessionId: "rt-dup-recover" });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executor = scriptedExecutor(async () => {
      await gate;
      return { status: "ready", analysis: fakeAnalysis };
    });
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
    for (const sample of threeStrokeStream()) scheduler.pushSamples({ wrist: [sample] });
    scheduler.endOfStream();
    // E1 in flight (marked 'processing'), E2/E3 queued: recovery storms
    // must be no-ops for all of them.
    expect(scheduler.recoverPending()).toEqual([]);
    expect(scheduler.recoverPending({ readmitExhausted: true })).toEqual([]);
    release();
    await scheduler.drained();
    const metrics = scheduler.metrics();
    expect(metrics.ready).toBe(3);
    expect(metrics.dispatched).toBe(3); // one dispatch per event, ever
    expect(executor.calls).toHaveLength(3);
  });

  it("SUSPEND/RESUME RACE: retryable failure settling while suspended re-queues without dispatching until resume", async () => {
    const engine = new SessionEventEngine({ sessionId: "rt-suspend-retry" });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executor = scriptedExecutor(async (task) => {
      if (task.eventId === "E1" && task.attempt === 1) {
        await gate;
        return { status: "failed", reason: "CLIP_EXTRACTION_FAILED: transient", retryable: true };
      }
      return { status: "ready", analysis: fakeAnalysis };
    });
    const scheduler = new SessionAnalysisScheduler({
      engine,
      executor,
      concurrency: 1,
      maxAttempts: 2,
    });
    for (const sample of threeStrokeStream()) scheduler.pushSamples({ wrist: [sample] });
    scheduler.endOfStream();
    scheduler.suspend(); // E1 in flight, E2/E3 queued
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const suspended = scheduler.metrics();
    expect(suspended.inFlight).toBe(0);
    expect(suspended.queueDepth).toBe(3); // E2, E3, and E1's retry — none dispatched
    expect(executor.calls).toHaveLength(1);
    expect(engine.snapshot().events[0]!.state).toBe("pending"); // honest revert applied
    scheduler.resume();
    await scheduler.drained();
    const metrics = scheduler.metrics();
    expect(metrics.ready).toBe(3);
    expect(executor.calls.map((call) => `${call.eventId}#${call.attempt}`)).toEqual([
      "E1#1",
      "E2#1",
      "E3#1",
      "E1#2",
    ]);
  });

  it("CONCURRENT WAITERS: multiple drained() callers across a suspend/resume cycle all resolve", async () => {
    const engine = new SessionEventEngine({ sessionId: "rt-drained-waiters" });
    const executor = scriptedExecutor(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { status: "ready", analysis: fakeAnalysis };
    });
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
    for (const sample of threeStrokeStream()) scheduler.pushSamples({ wrist: [sample] });
    scheduler.endOfStream();
    scheduler.suspend();
    const waiters = [scheduler.drained(), scheduler.drained(), scheduler.drained()];
    setTimeout(() => scheduler.resume(), 15);
    await Promise.all(waiters);
    expect(scheduler.metrics().ready).toBe(3);
    expect(scheduler.metrics().suspended).toBe(false);
  });

  it("MEMORY GROWTH: dispatch must not take a full engine snapshot per task (O(events²) copying over long sessions)", async () => {
    const engine = new SessionEventEngine({ sessionId: "rt-snapshot-cost" });
    let snapshotCalls = 0;
    const countingEngine = new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop === "snapshot") {
          return () => {
            snapshotCalls += 1;
            return target.snapshot();
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const executor = scriptedExecutor(() => ({ status: "ready", analysis: fakeAnalysis }));
    const scheduler = new SessionAnalysisScheduler({ engine: countingEngine, executor });
    const bumps = Array.from({ length: 12 }, (_, index) => ({
      peakMs: 1200 + index * 2400,
      height: 2.0,
      halfWidthMs: 120,
    }));
    for (const sample of speedBumps(bumps, 0, 1200 + 11 * 2400 + 2000)) {
      scheduler.pushSamples({ wrist: [sample] });
    }
    scheduler.endOfStream();
    await scheduler.drained();
    expect(scheduler.metrics().ready).toBe(12);
    // Each snapshot copies EVERY event; per-dispatch snapshots are O(n²)
    // allocation over a session. Dispatch needs only the immutable sessionId.
    expect(snapshotCalls).toBeLessThanOrEqual(2);
  });

  it("SUSTAINED FAILURE: every event exhausting retries stays honestly pending; counters reconcile exactly", async () => {
    const engine = new SessionEventEngine({ sessionId: "rt-sustained-failure" });
    const executor = scriptedExecutor(() => ({
      status: "failed",
      reason: "CLIP_EXTRACTION_FAILED: sustained outage",
      retryable: true,
    }));
    const scheduler = new SessionAnalysisScheduler({ engine, executor, maxAttempts: 3 });
    for (const sample of threeStrokeStream()) scheduler.pushSamples({ wrist: [sample] });
    scheduler.endOfStream();
    await scheduler.drained();
    const metrics = scheduler.metrics();
    expect(metrics.enqueued).toBe(3);
    expect(metrics.retryExhausted).toBe(3);
    expect(metrics.ready).toBe(0);
    expect(metrics.dispatched).toBe(9); // 3 events × 3 attempts
    expect(metrics.retries).toBe(6);
    for (const event of engine.snapshot().events) {
      expect(event.state).toBe("pending");
      expect(event.analysis).toBeNull();
    }
    for (const task of metrics.tasks) {
      expect(task.attempts).toBe(3);
      expect(task.failures).toHaveLength(3);
      expect(task.outcome).toBe("retry_exhausted");
    }
  });
});
