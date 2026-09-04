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
 * STRUCTURAL AUDIT #2 (pass 1) — SessionAnalysisScheduler reproducers.
 *
 * Every test here asserts the behaviour the module's own contract comments
 * promise (sessionScheduler.ts L10–L50, L351–L354). A failing test is a
 * finding; a passing test is a verified invariant. Real SessionEventEngine +
 * real scheduler; only the executor behind the seam is scripted (same
 * convention as sessionScheduler.test.ts).
 */

function speedBumps(
  bumps: Array<{ peakMs: number; height: number; halfWidthMs: number }>,
  fromMs = 0,
  toMs = 8200,
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
  return speedBumps([
    { peakMs: 1200, height: 2.0, halfWidthMs: 120 },
    { peakMs: 3600, height: 2.2, halfWidthMs: 120 },
    { peakMs: 6000, height: 1.8, halfWidthMs: 120 },
  ]);
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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "TIMED_OUT"> {
  return Promise.race([
    promise,
    new Promise<"TIMED_OUT">((resolve) => setTimeout(() => resolve("TIMED_OUT"), ms)),
  ]);
}

describe("AUDIT scheduler — malformed executor outcome must not poison the scheduler", () => {
  it("S2-A: 'ready' without an AnalysisRecord is an executor bug; the scheduler must record it and keep pumping", async () => {
    const engine = new SessionEventEngine({ sessionId: "audit-malformed-ready" });
    const executor = scriptedExecutor((task) =>
      task.eventId === "E1"
        ? // A misbehaving executor: claims ready but carries no record.
          ({ status: "ready", analysis: null } as unknown as SessionAnalysisTaskOutcome)
        : { status: "ready", analysis: fakeAnalysis },
    );
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
    const unhandled: string[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason instanceof Error ? reason.message : String(reason));
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      for (const sample of threeStrokeStream()) scheduler.pushSamples({ wrist: [sample] });
      scheduler.endOfStream();
      // Let the E1 settlement run with NO drained() observer attached — the
      // way a live consumer (UI) would drive the scheduler.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    console.log(
      JSON.stringify({
        audit: "S2-A after E1 settled without a drained() observer",
        unhandledRejections: unhandled,
        states: Object.fromEntries(
          engine.snapshot().events.map((event) => [event.eventId, event.state]),
        ),
        metrics: { ...scheduler.metrics(), tasks: undefined },
        executorCalls: executor.calls.map((task) => task.eventId),
      }),
    );
    expect(unhandled).toEqual([]);

    // Contract L351–L354: an executor misbehaving is "the same honest failure"
    // and must neither escape nor leak the dispatch slot.
    const drained = await withTimeout(
      scheduler.drained().then(
        () => "RESOLVED" as const,
        (error: unknown) => `REJECTED: ${error instanceof Error ? error.message : String(error)}`,
      ),
      1_000,
    );
    expect(drained).toBe("RESOLVED");

    const states = Object.fromEntries(
      engine.snapshot().events.map((event) => [event.eventId, event.state]),
    );
    // E1 must not be stuck in 'processing' forever, E2/E3 must have run.
    expect(states.E1).not.toBe("processing");
    expect(executor.calls.map((task) => task.eventId)).toEqual(["E1", "E2", "E3"]);
    const metrics = scheduler.metrics();
    expect(metrics.inFlight).toBe(0);
    expect(metrics.queueDepth).toBe(0);
    const e1 = metrics.tasks.find((task) => task.eventId === "E1")!;
    expect(e1.outcome).not.toBeNull();
    expect(e1.failures.length).toBeGreaterThan(0);
  });
});

describe("AUDIT scheduler — externally-terminal event in the queue", () => {
  it("S2-B: resume() must not throw out of the dispatch path nor leak the in-flight slot when a queued event was already closed by another owner", async () => {
    const engine = new SessionEventEngine({ sessionId: "audit-external-terminal" });
    const executor = scriptedExecutor(() => ({ status: "ready", analysis: fakeAnalysis }));
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
    scheduler.suspend();
    for (const sample of threeStrokeStream()) scheduler.pushSamples({ wrist: [sample] });
    scheduler.endOfStream();
    expect(scheduler.metrics().queueDepth).toBe(3);

    // Another owner (e.g. the UI) records an honest abstain for E1 while it
    // is still queued. Terminal states are append-only — the scheduler must
    // skip it, not crash on it.
    engine.markEvent("E1", "abstained", { abstainReason: "USER_DISMISSED" });

    let resumeError: unknown = null;
    try {
      scheduler.resume();
    } catch (error) {
      resumeError = error;
    }
    console.log(
      JSON.stringify({
        audit: "S2-B after resume()",
        resumeError: resumeError instanceof Error ? resumeError.message : resumeError,
        metrics: { ...scheduler.metrics(), tasks: undefined },
        executorCalls: executor.calls.map((task) => task.eventId),
      }),
    );
    expect(resumeError).toBeNull();

    const drained = await withTimeout(
      scheduler.drained().then(
        () => "RESOLVED" as const,
        (error: unknown) => `REJECTED: ${error instanceof Error ? error.message : String(error)}`,
      ),
      1_000,
    );
    expect(drained).toBe("RESOLVED");
    expect(scheduler.metrics().inFlight).toBe(0);
    expect(executor.calls.map((task) => task.eventId)).toEqual(["E2", "E3"]);
    const states = Object.fromEntries(
      engine.snapshot().events.map((event) => [event.eventId, event.state]),
    );
    expect(states).toEqual({ E1: "abstained", E2: "ready", E3: "ready" });
  });
});

describe("AUDIT scheduler — restart-path recovery", () => {
  it("S2-C: recoverPending() re-admits an event left in 'processing' by a crashed dispatch (contract: 'non-terminal and not already tracked')", async () => {
    const engine = new SessionEventEngine({ sessionId: "audit-recover-processing" });
    // First scheduler instance: dispatches E1, then the process dies before
    // the executor ever settles (simulated by a never-settling promise).
    const crashed = scriptedExecutor(() => new Promise<SessionAnalysisTaskOutcome>(() => {}));
    const first = new SessionAnalysisScheduler({ engine, executor: crashed, concurrency: 1 });
    for (const sample of threeStrokeStream()) first.pushSamples({ wrist: [sample] });
    first.endOfStream();
    expect(engine.eventState("E1")).toBe("processing");
    expect(engine.eventState("E2")).toBe("pending");
    expect(engine.eventState("E3")).toBe("pending");

    // Restart: queue state lost, engine session survived (contract 4).
    const healthy = scriptedExecutor(() => ({ status: "ready", analysis: fakeAnalysis }));
    const second = new SessionAnalysisScheduler({ engine, executor: healthy, concurrency: 1 });
    const readmitted = second.recoverPending();
    expect(readmitted).toEqual(["E1", "E2", "E3"]);
    await second.drained();
    for (const event of engine.snapshot().events) expect(event.state).toBe("ready");
  });
});

describe("AUDIT scheduler — liveness", () => {
  it("S2-D: a never-settling executor must not hang drained() forever (no timeout/cancellation seam exists)", async () => {
    const engine = new SessionEventEngine({ sessionId: "audit-hang" });
    const executor = scriptedExecutor(() => new Promise<SessionAnalysisTaskOutcome>(() => {}));
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
    for (const sample of threeStrokeStream()) scheduler.pushSamples({ wrist: [sample] });
    scheduler.endOfStream();
    const drained = await withTimeout(
      scheduler.drained().then(() => "RESOLVED" as const),
      500,
    );
    // Documented expectation (REVIEW.md: async analysis must not block
    // indefinitely — time out or report progress). Either drained() settles
    // or the scheduler exposes a way to bound an attempt.
    expect(drained).toBe("RESOLVED");
  });
});
