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
 * STRUCTURAL AUDIT #1 (pass 1/3) — SessionAnalysisScheduler lifecycle probes.
 *
 * Real engine + real scheduler; only the executor is scripted. Each test
 * states an EXPECTED resilience property. A failure is a reproduced finding
 * at the audited commit; production code is untouched.
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
  SessionStrokeEvent["analysis"]
>;

function scriptedExecutor(
  script: (
    task: SessionAnalysisTask,
  ) => SessionAnalysisTaskOutcome | Promise<SessionAnalysisTaskOutcome>,
): SessionAnalysisExecutor & { calls: SessionAnalysisTask[] } {
  const calls: SessionAnalysisTask[] = [];
  return {
    executorId: "audit-scripted-executor",
    calls,
    async execute(task) {
      calls.push(task);
      return script(task);
    },
  };
}

function withinMs<T>(promise: Promise<T>, ms: number): Promise<"settled" | "timed_out"> {
  return Promise.race([
    promise.then(() => "settled" as const),
    new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), ms)),
  ]);
}

describe("audit: outcome application is isolated from engine lifecycle throws", () => {
  it("an event marked terminal by another actor while in flight does not poison the scheduler", async () => {
    const engine = new SessionEventEngine({ sessionId: "audit-external-terminal" });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executor = scriptedExecutor(async (task) => {
      if (task.eventId === "E1") await gate;
      return { status: "ready", analysis: fakeAnalysis };
    });
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
    for (const sample of threeStrokeStream()) scheduler.pushSamples({ wrist: [sample] });
    scheduler.endOfStream();
    expect(scheduler.metrics().inFlight).toBe(1);
    // A second actor (e.g. a supervising flow's crash handler) closes E1 first.
    engine.markEvent("E1", "abstained", { abstainReason: "EXTERNAL_SUPERVISOR_ABORT" });
    release();
    // The scheduler must absorb the append-only refusal: E1's late outcome is
    // dropped and RECORDED, and E2/E3 must still be dispatched and complete.
    await expect(scheduler.drained()).resolves.toBeUndefined();
    const metrics = scheduler.metrics();
    expect(metrics.inFlight).toBe(0);
    expect(metrics.queueDepth).toBe(0);
    const states = Object.fromEntries(
      engine.snapshot().events.map((event) => [event.eventId, event.state]),
    );
    expect(states).toEqual({ E1: "abstained", E2: "ready", E3: "ready" });
    const e1 = metrics.tasks.find((task) => task.eventId === "E1")!;
    expect(e1.outcome).not.toBeNull();
  });

  it("a malformed 'ready' outcome (no AnalysisRecord at runtime) is recorded as a failure, not a hang", async () => {
    const engine = new SessionEventEngine({ sessionId: "audit-malformed-ready" });
    const executor = scriptedExecutor((task) =>
      task.eventId === "E1"
        ? ({ status: "ready", analysis: null } as unknown as SessionAnalysisTaskOutcome)
        : { status: "ready", analysis: fakeAnalysis },
    );
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
    for (const sample of threeStrokeStream()) scheduler.pushSamples({ wrist: [sample] });
    scheduler.endOfStream();
    await expect(scheduler.drained()).resolves.toBeUndefined();
    const metrics = scheduler.metrics();
    expect(metrics.ready).toBe(2);
    expect(metrics.failedFinal + metrics.executorThrows).toBeGreaterThanOrEqual(1);
    expect(engine.eventState("E1")).toBe("pending");
  });

  it("an already-terminal queued event is skipped at dispatch instead of throwing into resume()/pushSamples()", async () => {
    const engine = new SessionEventEngine({ sessionId: "audit-terminal-in-queue" });
    const executor = scriptedExecutor(() => ({ status: "ready", analysis: fakeAnalysis }));
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 3 });
    scheduler.suspend();
    for (const sample of threeStrokeStream()) scheduler.pushSamples({ wrist: [sample] });
    scheduler.endOfStream();
    expect(scheduler.metrics().queueDepth).toBe(3);
    engine.markEvent("E2", "abstained", { abstainReason: "EXTERNAL_SUPERVISOR_ABORT" });
    // Dispatch of E2 must not surface as an exception from the caller's
    // sample-feeding / resume path, and must not leak the in-flight slot.
    expect(() => scheduler.resume()).not.toThrow();
    await expect(scheduler.drained()).resolves.toBeUndefined();
    const metrics = scheduler.metrics();
    expect(metrics.inFlight).toBe(0);
    expect(engine.eventState("E1")).toBe("ready");
    expect(engine.eventState("E3")).toBe("ready");
  });
});

describe("audit: restart recovery and cancellation", () => {
  it("recoverPending() re-admits events orphaned in 'processing' by a crashed dispatcher", async () => {
    const engine = new SessionEventEngine({ sessionId: "audit-orphaned-processing" });
    const neverSettles = scriptedExecutor(() => new Promise<SessionAnalysisTaskOutcome>(() => {}));
    const crashed = new SessionAnalysisScheduler({
      engine,
      executor: neverSettles,
      concurrency: 3,
    });
    for (const sample of threeStrokeStream()) crashed.pushSamples({ wrist: [sample] });
    crashed.endOfStream();
    // Process "dies" here: three events are in 'processing' with no owner.
    for (const event of engine.snapshot().events) expect(event.state).toBe("processing");

    const working = scriptedExecutor(() => ({ status: "ready", analysis: fakeAnalysis }));
    const restarted = new SessionAnalysisScheduler({ engine, executor: working });
    const readmitted = restarted.recoverPending();
    expect(readmitted).toEqual(["E1", "E2", "E3"]);
    await restarted.drained();
    for (const event of engine.snapshot().events) expect(event.state).toBe("ready");
  });

  it("a never-settling executor cannot hold a slot forever: the scheduler offers a bounded wait or abort", async () => {
    const engine = new SessionEventEngine({ sessionId: "audit-never-settles" });
    const executor = scriptedExecutor((task) =>
      task.eventId === "E1"
        ? new Promise<SessionAnalysisTaskOutcome>(() => {})
        : { status: "ready", analysis: fakeAnalysis },
    );
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
    for (const sample of threeStrokeStream()) scheduler.pushSamples({ wrist: [sample] });
    scheduler.endOfStream();
    // Neither a timeout option nor an abort/cancel entry point exists on the
    // scheduler contract, so the only observable is whether drained() settles.
    const outcome = await withinMs(scheduler.drained(), 500);
    expect(outcome).toBe("settled");
  });
});
