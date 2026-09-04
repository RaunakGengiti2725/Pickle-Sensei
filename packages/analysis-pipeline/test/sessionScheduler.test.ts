import { describe, expect, it } from "vitest";
import {
  SessionEventEngine,
  type SessionStrokeEvent,
  type SpeedSample,
} from "../src/sessionEngine.js";
import {
  SessionAnalysisScheduler,
  type SessionAnalysisExecutor,
  type SessionAnalysisTask,
  type SessionAnalysisTaskOutcome,
} from "../src/sessionScheduler.js";

/**
 * Scheduler tests drive the REAL SessionEventEngine (synthetic wrist-speed
 * streams — clearly synthetic) and the REAL SessionAnalysisScheduler. Only
 * the ANALYSIS EXECUTION behind the executor seam is a test double: real
 * per-event analysis needs native clips + pose extraction that do not exist
 * on this box (NATIVE_CLIP_EXTRACTION gap, D-040). Scheduling decisions —
 * queueing, ordering, concurrency, retry, suspension, recovery — are all
 * production code under test.
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

const fakeAnalysis = { id: "synthetic-analysis" } as unknown as NonNullable<
  SessionStrokeEvent["analysis"]
>;

/** Deterministic executor: per-eventId scripted outcomes, optional async gate. */
function scriptedExecutor(
  script: (
    task: SessionAnalysisTask,
  ) => SessionAnalysisTaskOutcome | Promise<SessionAnalysisTaskOutcome>,
): SessionAnalysisExecutor & { calls: SessionAnalysisTask[] } {
  const calls: SessionAnalysisTask[] = [];
  return {
    executorId: "scripted-test-executor",
    calls,
    async execute(task) {
      calls.push(task);
      return script(task);
    },
  };
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

describe("SessionAnalysisScheduler — progressive dispatch while recording continues", () => {
  it("E1 dispatches while E2/E3 are still recording; all reach ready; FIFO order", async () => {
    const engine = new SessionEventEngine({ sessionId: "sched-progressive" });
    const dispatchStreamTimes: Array<{ eventId: string; lastPushedMs: number }> = [];
    let lastPushedMs = 0;
    const executor = scriptedExecutor((task) => {
      dispatchStreamTimes.push({ eventId: task.eventId, lastPushedMs });
      return { status: "ready", analysis: fakeAnalysis };
    });
    const scheduler = new SessionAnalysisScheduler({ engine, executor });
    for (const sample of threeStrokeStream()) {
      lastPushedMs = sample.timestampMs;
      scheduler.pushSamples({ wrist: [sample] });
      // Yield so in-flight executor promises can settle mid-stream —
      // the progressive property under test.
      await Promise.resolve();
    }
    scheduler.endOfStream();
    await scheduler.drained();
    const metrics = scheduler.metrics();
    expect(metrics.enqueued).toBe(3);
    expect(metrics.ready).toBe(3);
    expect(executor.calls.map((task) => task.eventId)).toEqual(["E1", "E2", "E3"]);
    // E1's analysis started while the stream was still mid-recording.
    const e1 = dispatchStreamTimes.find((entry) => entry.eventId === "E1")!;
    expect(e1.lastPushedMs).toBeLessThan(8200);
    for (const event of engine.snapshot().events) expect(event.state).toBe("ready");
  });

  it("bounded concurrency: backlog queues, maxInFlight never exceeds the budget", async () => {
    const engine = new SessionEventEngine({ sessionId: "sched-backlog" });
    let releaseAll: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    const executor = scriptedExecutor(async () => {
      await gate; // hold every dispatch until the full backlog is queued
      return { status: "ready", analysis: fakeAnalysis };
    });
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
    for (const sample of threeStrokeStream()) scheduler.pushSamples({ wrist: [sample] });
    scheduler.endOfStream();
    const mid = scheduler.metrics();
    expect(mid.inFlight).toBe(1);
    expect(mid.queueDepth).toBe(2); // real backlog while the slot is busy
    releaseAll();
    await scheduler.drained();
    const metrics = scheduler.metrics();
    expect(metrics.maxInFlight).toBe(1);
    expect(metrics.maxQueueDepth).toBeGreaterThanOrEqual(2);
    expect(metrics.ready).toBe(3);
  });

  it("retryable failure (failed extraction) retries at the BACK of the queue, then succeeds", async () => {
    const engine = new SessionEventEngine({ sessionId: "sched-retry" });
    const executor = scriptedExecutor((task) => {
      if (task.eventId === "E1" && task.attempt === 1) {
        return { status: "failed", reason: "CLIP_EXTRACTION_FAILED: transient", retryable: true };
      }
      return { status: "ready", analysis: fakeAnalysis };
    });
    const scheduler = new SessionAnalysisScheduler({ engine, executor, maxAttempts: 2 });
    for (const sample of threeStrokeStream()) scheduler.pushSamples({ wrist: [sample] });
    scheduler.endOfStream();
    await scheduler.drained();
    // E1 attempt 1 fails → E2, E3 run BEFORE E1's retry (no starvation).
    expect(executor.calls.map((task) => `${task.eventId}#${task.attempt}`)).toEqual([
      "E1#1",
      "E2#1",
      "E3#1",
      "E1#2",
    ]);
    const metrics = scheduler.metrics();
    expect(metrics.retries).toBe(1);
    expect(metrics.ready).toBe(3);
    const e1 = metrics.tasks.find((task) => task.eventId === "E1")!;
    expect(e1.attempts).toBe(2);
    expect(e1.failures).toEqual(["attempt 1: CLIP_EXTRACTION_FAILED: transient"]);
  });

  it("exhausted retries leave the event honestly 'pending' (never a fake abstain/ready)", async () => {
    const engine = new SessionEventEngine({ sessionId: "sched-exhaust" });
    const executor = scriptedExecutor((task) =>
      task.eventId === "E2"
        ? { status: "failed", reason: "CLIP_EXTRACTION_FAILED: persistent", retryable: true }
        : { status: "ready", analysis: fakeAnalysis },
    );
    const scheduler = new SessionAnalysisScheduler({ engine, executor, maxAttempts: 3 });
    for (const sample of threeStrokeStream()) scheduler.pushSamples({ wrist: [sample] });
    scheduler.endOfStream();
    await scheduler.drained();
    const metrics = scheduler.metrics();
    expect(metrics.ready).toBe(2);
    expect(metrics.retryExhausted).toBe(1);
    const e2 = engine.snapshot().events.find((event) => event.eventId === "E2")!;
    expect(e2.state).toBe("pending");
    expect(e2.analysis).toBeNull();
    const record = metrics.tasks.find((task) => task.eventId === "E2")!;
    expect(record.attempts).toBe(3);
    expect(record.failures).toHaveLength(3);
  });

  it("abstained analysis and non-retryable failure are recorded distinctly", async () => {
    const engine = new SessionEventEngine({ sessionId: "sched-abstain" });
    const executor = scriptedExecutor((task) => {
      if (task.eventId === "E1") {
        return { status: "abstained", abstainReason: "CONTACT_DISAGREEMENT: spread 380ms" };
      }
      if (task.eventId === "E2") {
        return { status: "failed", reason: "POSE_SIDECAR_CORRUPT", retryable: false };
      }
      return { status: "ready", analysis: fakeAnalysis };
    });
    const scheduler = new SessionAnalysisScheduler({ engine, executor });
    for (const sample of threeStrokeStream()) scheduler.pushSamples({ wrist: [sample] });
    scheduler.endOfStream();
    await scheduler.drained();
    const metrics = scheduler.metrics();
    expect(metrics.abstained).toBe(1);
    expect(metrics.failedFinal).toBe(1);
    expect(metrics.ready).toBe(1);
    expect(metrics.retries).toBe(0);
    const states = Object.fromEntries(
      engine.snapshot().events.map((event) => [event.eventId, event.state]),
    );
    expect(states).toEqual({ E1: "abstained", E2: "pending", E3: "ready" });
  });

  it("executor throws are counted, never silent, and the event stays pending", async () => {
    const engine = new SessionEventEngine({ sessionId: "sched-throw" });
    const executor = scriptedExecutor((task) => {
      if (task.eventId === "E1") throw new Error("bridge crashed");
      return { status: "ready", analysis: fakeAnalysis };
    });
    const scheduler = new SessionAnalysisScheduler({ engine, executor });
    for (const sample of threeStrokeStream()) scheduler.pushSamples({ wrist: [sample] });
    scheduler.endOfStream();
    await scheduler.drained();
    const metrics = scheduler.metrics();
    expect(metrics.executorThrows).toBe(1);
    expect(metrics.failedFinal).toBe(1);
    const e1 = metrics.tasks.find((task) => task.eventId === "E1")!;
    expect(e1.failures[0]).toContain("EXECUTOR_THREW: bridge crashed");
    expect(engine.snapshot().events[0]!.state).toBe("pending");
  });

  it("suspend() halts dispatch, in-flight outcomes still apply; resume() drains the backlog", async () => {
    const engine = new SessionEventEngine({ sessionId: "sched-suspend" });
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const executor = scriptedExecutor(async (task) => {
      if (task.eventId === "E1") await firstGate;
      return { status: "ready", analysis: fakeAnalysis };
    });
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
    for (const sample of threeStrokeStream()) scheduler.pushSamples({ wrist: [sample] });
    scheduler.endOfStream();
    scheduler.suspend(); // interruption with E1 in flight, E2/E3 queued
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const suspendedMetrics = scheduler.metrics();
    // The in-flight outcome was applied; nothing new dispatched.
    expect(suspendedMetrics.ready).toBe(1);
    expect(suspendedMetrics.inFlight).toBe(0);
    expect(suspendedMetrics.queueDepth).toBe(2);
    expect(executor.calls).toHaveLength(1);
    scheduler.resume();
    await scheduler.drained();
    expect(scheduler.metrics().ready).toBe(3);
  });

  it("recoverPending() re-enqueues honest-pending events after a lost queue (restart path)", async () => {
    const engine = new SessionEventEngine({ sessionId: "sched-recover" });
    // Phase 1: a scheduler whose executor cannot start (build without clips).
    const unavailable = scriptedExecutor(() => ({
      status: "failed",
      reason: "NATIVE_CLIP_EXTRACTION_NOT_BUILT",
      retryable: false,
    }));
    const first = new SessionAnalysisScheduler({ engine, executor: unavailable });
    for (const sample of threeStrokeStream()) first.pushSamples({ wrist: [sample] });
    first.endOfStream();
    await first.drained();
    expect(first.metrics().failedFinal).toBe(3);
    for (const event of engine.snapshot().events) expect(event.state).toBe("pending");
    // Phase 2: a NEW scheduler over the SAME engine (queue state lost);
    // recovery re-admits the pending events and analysis completes.
    const working = scriptedExecutor(() => ({ status: "ready", analysis: fakeAnalysis }));
    const second = new SessionAnalysisScheduler({ engine, executor: working });
    const readmitted = second.recoverPending();
    expect(readmitted).toEqual(["E1", "E2", "E3"]);
    await second.drained();
    expect(second.metrics().ready).toBe(3);
    for (const event of engine.snapshot().events) expect(event.state).toBe("ready");
    // Recovery never touches terminal events: a second recovery is a no-op.
    expect(second.recoverPending()).toEqual([]);
  });

  it("exactly-once enqueue: duplicate closures are refused and counted", async () => {
    const engine = new SessionEventEngine({ sessionId: "sched-dup" });
    const executor = scriptedExecutor(() => ({ status: "ready", analysis: fakeAnalysis }));
    const scheduler = new SessionAnalysisScheduler({ engine, executor });
    for (const sample of threeStrokeStream()) scheduler.pushSamples({ wrist: [sample] });
    const closed = scheduler.endOfStream();
    // Simulate a buggy caller re-feeding an already-closed event.
    const internalEnqueue = (
      scheduler as unknown as { enqueue(event: SessionStrokeEvent, attempt: number): void }
    ).enqueue.bind(scheduler);
    const known = closed[0] ?? engine.snapshot().events[0]!;
    internalEnqueue(known, 1);
    await scheduler.drained();
    const metrics = scheduler.metrics();
    expect(metrics.duplicatesRefused).toBeGreaterThanOrEqual(1);
    expect(metrics.ready).toBe(3);
  });

  it("latency accounting: queueWait + service ≤ total; virtual clock is honored", async () => {
    const engine = new SessionEventEngine({ sessionId: "sched-latency" });
    let virtualNow = 0;
    const executor = scriptedExecutor(async () => {
      // Yield first so the increment happens strictly after every enqueue in
      // the synchronous stream loop (all events enqueue at virtual t=0).
      await new Promise((resolve) => setTimeout(resolve, 0));
      virtualNow += 250; // each analysis costs 250 virtual ms
      return { status: "ready", analysis: fakeAnalysis };
    });
    const scheduler = new SessionAnalysisScheduler({
      engine,
      executor,
      concurrency: 1,
      now: () => virtualNow,
    });
    for (const sample of threeStrokeStream()) scheduler.pushSamples({ wrist: [sample] });
    scheduler.endOfStream();
    await scheduler.drained();
    const metrics = scheduler.metrics();
    expect(metrics.ready).toBe(3);
    for (const task of metrics.tasks) {
      expect(task.queueWaitMs).not.toBeNull();
      expect(task.totalLatencyMs).not.toBeNull();
      expect(task.serviceMs).toBeGreaterThan(0);
      expect(task.queueWaitMs! + task.serviceMs).toBeLessThanOrEqual(task.totalLatencyMs! + 1e-9);
    }
    // With one slot and 250ms service each, the third event waited ≥ 500ms.
    const waits = metrics.tasks.map((task) => task.queueWaitMs!).sort((a, b) => a - b);
    expect(waits[waits.length - 1]).toBeGreaterThanOrEqual(500);
  });
});

describe("SessionAnalysisScheduler — per-attempt deadline (taskTimeoutMs)", () => {
  it("a hung attempt fails with EXECUTOR_TIMEOUT, releases its slot, the queue continues and the event stays honestly pending", async () => {
    const engine = new SessionEventEngine({ sessionId: "sched-deadline" });
    let hungCalls = 0;
    const executor = scriptedExecutor((task) => {
      if (task.eventId === "E2") {
        hungCalls += 1;
        return new Promise<never>(() => {});
      }
      return { status: "ready", analysis: fakeAnalysis };
    });
    const scheduler = new SessionAnalysisScheduler({
      engine,
      executor,
      concurrency: 1,
      maxAttempts: 1,
      taskTimeoutMs: 50,
    });
    scheduler.pushSamples({ wrist: threeStrokeStream() });
    scheduler.endOfStream();
    await scheduler.drained();
    const metrics = scheduler.metrics();
    expect(hungCalls).toBe(1);
    expect(metrics.dispatched).toBe(3);
    expect(metrics.inFlight).toBe(0);
    expect(metrics.queueDepth).toBe(0);
    expect(metrics.timedOut).toBe(1);
    expect(metrics.taskTimeoutMs).toBe(50);
    const e2 = metrics.tasks.find((task) => task.eventId === "E2")!;
    expect(e2.outcome).toBe("retry_exhausted");
    expect(e2.failures).toEqual([
      "attempt 1: EXECUTOR_TIMEOUT: attempt did not settle within 50 ms",
    ]);
    expect(e2.finishedAt).not.toBeNull();
    // A timed-out analysis is not a result: E2 is neither 'ready' nor
    // 'abstained', and it is not left 'processing' with no worker attached.
    expect(engine.eventState("E2")).toBe("pending");
    expect(engine.snapshot().events.find((event) => event.eventId === "E2")!.analysis).toBeNull();
    expect(engine.eventState("E1")).toBe("ready");
    expect(engine.eventState("E3")).toBe("ready");
  });

  it("a timeout is retryable under maxAttempts; the retry goes to the BACK of the queue", async () => {
    const engine = new SessionEventEngine({ sessionId: "sched-deadline-retry" });
    const executor = scriptedExecutor((task) => {
      if (task.eventId === "E1" && task.attempt === 1) return new Promise<never>(() => {});
      return { status: "ready", analysis: fakeAnalysis };
    });
    const scheduler = new SessionAnalysisScheduler({
      engine,
      executor,
      concurrency: 1,
      maxAttempts: 2,
      taskTimeoutMs: 50,
    });
    scheduler.pushSamples({ wrist: threeStrokeStream() });
    scheduler.endOfStream();
    await scheduler.drained();
    expect(executor.calls.map((task) => `${task.eventId}#${task.attempt}`)).toEqual([
      "E1#1",
      "E2#1",
      "E3#1",
      "E1#2",
    ]);
    const metrics = scheduler.metrics();
    expect(metrics.ready).toBe(3);
    expect(metrics.retries).toBe(1);
    expect(metrics.timedOut).toBe(1);
    const e1 = metrics.tasks.find((task) => task.eventId === "E1")!;
    expect(e1.outcome).toBe("ready");
    expect(e1.attempts).toBe(2);
    expect(e1.failures).toHaveLength(1);
    expect(e1.failures[0]).toMatch(/^attempt 1: EXECUTOR_TIMEOUT/);
    expect(engine.eventState("E1")).toBe("ready");
  });

  it("a settlement (resolve or reject) arriving after the deadline is counted and ignored — never applied, never thrown", async () => {
    const engine = new SessionEventEngine({ sessionId: "sched-deadline-late" });
    const late = new Map<string, (outcome: SessionAnalysisTaskOutcome) => void>();
    const lateReject = new Map<string, (error: Error) => void>();
    const executor = scriptedExecutor((task) => {
      if (task.eventId === "E1" || task.eventId === "E2") {
        return new Promise<SessionAnalysisTaskOutcome>((resolve, reject) => {
          late.set(task.eventId, resolve);
          lateReject.set(task.eventId, reject);
        });
      }
      return { status: "ready", analysis: fakeAnalysis };
    });
    const scheduler = new SessionAnalysisScheduler({
      engine,
      executor,
      concurrency: 2,
      maxAttempts: 1,
      taskTimeoutMs: 50,
    });
    scheduler.pushSamples({ wrist: threeStrokeStream() });
    scheduler.endOfStream();
    await scheduler.drained();
    const before = scheduler.metrics();
    expect(before.timedOut).toBe(2);
    expect(before.lateSettlementsIgnored).toBe(0);
    expect(before.executorThrows).toBe(0);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      late.get("E1")!({ status: "ready", analysis: fakeAnalysis });
      lateReject.get("E2")!(new Error("late crash"));
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    const after = scheduler.metrics();
    expect(unhandled).toEqual([]);
    expect(after.lateSettlementsIgnored).toBe(2);
    // A late throw is not an executor failure of any attempt on record.
    expect(after.executorThrows).toBe(0);
    expect(after.tasks).toEqual(before.tasks);
    expect(engine.eventState("E1")).toBe("pending");
    expect(engine.eventState("E2")).toBe("pending");
    expect(engine.snapshot().events.find((event) => event.eventId === "E1")!.analysis).toBeNull();
  });

  it("the deadline fires while suspended (a deadline is not a dispatch); resume() continues the queue", async () => {
    const engine = new SessionEventEngine({ sessionId: "sched-deadline-suspended" });
    const executor = scriptedExecutor((task) => {
      if (task.eventId === "E1") return new Promise<never>(() => {});
      return { status: "ready", analysis: fakeAnalysis };
    });
    const scheduler = new SessionAnalysisScheduler({
      engine,
      executor,
      concurrency: 1,
      maxAttempts: 1,
      taskTimeoutMs: 50,
    });
    scheduler.pushSamples({ wrist: threeStrokeStream() });
    scheduler.endOfStream();
    scheduler.suspend();
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    const suspended = scheduler.metrics();
    expect(suspended.inFlight).toBe(0);
    expect(suspended.dispatched).toBe(1);
    expect(suspended.queueDepth).toBe(2);
    expect(suspended.timedOut).toBe(1);
    expect(engine.eventState("E1")).toBe("pending");
    scheduler.resume();
    await scheduler.drained();
    expect(scheduler.metrics().dispatched).toBe(3);
    expect(scheduler.metrics().ready).toBe(2);
  });

  it("the default deadline is finite; Infinity is an explicit opt-out; non-positive or NaN values are refused", () => {
    const engine = new SessionEventEngine({ sessionId: "sched-deadline-options" });
    const executor = scriptedExecutor(() => ({ status: "ready", analysis: fakeAnalysis }));
    const defaulted = new SessionAnalysisScheduler({ engine, executor });
    expect(Number.isFinite(defaulted.metrics().taskTimeoutMs)).toBe(true);
    expect(defaulted.metrics().taskTimeoutMs).toBeGreaterThan(0);
    const unbounded = new SessionAnalysisScheduler({
      engine,
      executor,
      taskTimeoutMs: Number.POSITIVE_INFINITY,
    });
    expect(unbounded.metrics().taskTimeoutMs).toBe(Number.POSITIVE_INFINITY);
    for (const bad of [0, -1, Number.NaN]) {
      expect(() => new SessionAnalysisScheduler({ engine, executor, taskTimeoutMs: bad })).toThrow(
        /taskTimeoutMs/,
      );
    }
  });
});

describe("SessionAnalysisScheduler — every engine transition is guarded", () => {
  it("dispatch lease refused (event settled by another writer while queued): failed_final with ENGINE_TRANSITION, no slot taken, no executor call", async () => {
    const engine = new SessionEventEngine({ sessionId: "sched-guard-dispatch" });
    const executor = scriptedExecutor(() => ({ status: "ready", analysis: fakeAnalysis }));
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
    scheduler.suspend();
    scheduler.pushSamples({ wrist: threeStrokeStream() });
    scheduler.endOfStream();
    engine.markEvent("E2", "abstained", { abstainReason: "external_writer" });
    expect(() => scheduler.resume()).not.toThrow();
    await scheduler.drained();
    const metrics = scheduler.metrics();
    expect(executor.calls.map((task) => task.eventId)).toEqual(["E1", "E3"]);
    expect(metrics.dispatched).toBe(3);
    expect(metrics.maxInFlight).toBe(1);
    expect(metrics.inFlight).toBe(0);
    expect(metrics.engineTransitionRefusals).toBe(1);
    const e2 = metrics.tasks.find((task) => task.eventId === "E2")!;
    expect(e2.outcome).toBe("failed_final");
    expect(e2.attempts).toBe(1);
    expect(e2.serviceMs).toBe(0);
    expect(e2.failures).toHaveLength(1);
    expect(e2.failures[0]).toMatch(/^attempt 1: ENGINE_TRANSITION\(processing\): /);
    expect(engine.eventState("E2")).toBe("abstained");
    expect(metrics.ready).toBe(2);
  });

  it("terminal outcome refused (event settled externally while in flight): the executor's result is not applied, record is failed_final", async () => {
    const engine = new SessionEventEngine({ sessionId: "sched-guard-terminal" });
    const executor = scriptedExecutor((task) => {
      if (task.eventId === "E1") {
        engine.markEvent("E1", "ready", { analysis: fakeAnalysis });
        return { status: "abstained", abstainReason: "late_abstain" };
      }
      return { status: "ready", analysis: fakeAnalysis };
    });
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
    scheduler.pushSamples({ wrist: threeStrokeStream() });
    scheduler.endOfStream();
    await scheduler.drained();
    const metrics = scheduler.metrics();
    const e1 = metrics.tasks.find((task) => task.eventId === "E1")!;
    expect(e1.outcome).toBe("failed_final");
    expect(e1.failures).toHaveLength(1);
    expect(e1.failures[0]).toMatch(/^attempt 1: ENGINE_TRANSITION\(abstained\): /);
    expect(metrics.abstained).toBe(0);
    expect(metrics.failedFinal).toBe(1);
    expect(metrics.ready).toBe(2);
    expect(metrics.dispatched).toBe(3);
    expect(engine.eventState("E1")).toBe("ready");
  });

  it("failure revert refused (event settled externally + retryable failure): no retry against a settled event, both reasons recorded", async () => {
    const engine = new SessionEventEngine({ sessionId: "sched-guard-revert" });
    const executor = scriptedExecutor((task) => {
      if (task.eventId === "E1") {
        engine.markEvent("E1", "abstained", { abstainReason: "external_writer" });
        return { status: "failed", reason: "transient", retryable: true };
      }
      return { status: "ready", analysis: fakeAnalysis };
    });
    const scheduler = new SessionAnalysisScheduler({
      engine,
      executor,
      concurrency: 1,
      maxAttempts: 3,
    });
    scheduler.pushSamples({ wrist: threeStrokeStream() });
    scheduler.endOfStream();
    await scheduler.drained();
    const metrics = scheduler.metrics();
    expect(executor.calls.map((task) => `${task.eventId}#${task.attempt}`)).toEqual([
      "E1#1",
      "E2#1",
      "E3#1",
    ]);
    const e1 = metrics.tasks.find((task) => task.eventId === "E1")!;
    expect(e1.outcome).toBe("failed_final");
    expect(e1.failures).toEqual([
      "attempt 1: transient",
      expect.stringMatching(/^attempt 1: ENGINE_TRANSITION\(pending\): /),
    ]);
    expect(metrics.retries).toBe(0);
    expect(metrics.queueDepth).toBe(0);
    expect(metrics.inFlight).toBe(0);
  });
});
