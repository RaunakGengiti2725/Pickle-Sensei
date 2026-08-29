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
