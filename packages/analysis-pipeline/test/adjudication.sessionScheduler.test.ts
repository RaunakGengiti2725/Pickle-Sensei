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
 * Adjudicated scheduler defects. Each test is the exact reproduction an
 * adjudicator confirmed against the unfixed code; the real SessionEventEngine
 * and SessionAnalysisScheduler are under test, only the analysis executor is
 * a scripted double (native clip extraction does not exist on this box).
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

function scriptedExecutor(
  script: (
    task: SessionAnalysisTask,
  ) => SessionAnalysisTaskOutcome | Promise<SessionAnalysisTaskOutcome>,
): SessionAnalysisExecutor & { calls: SessionAnalysisTask[] } {
  const calls: SessionAnalysisTask[] = [];
  return {
    executorId: "scripted-adjudication-executor",
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

describe("ADJ-AP-004 — recoverPending() must not strand events abandoned in 'processing'", () => {
  it("ADJ-AP-004 readmits a 'processing' event with no in-flight owner (crashed dispatch) and it ends 'ready'", async () => {
    const engine = new SessionEventEngine({ sessionId: "adj-ap-004" });
    // Close three events with NO scheduler attached, then simulate a
    // scheduler that dispatched E1 (engine → 'processing') and died before
    // its outcome settled: the queue is gone, the engine still says
    // 'processing', nobody owns the lease.
    for (const sample of threeStrokeStream()) engine.push({ wrist: [sample] });
    engine.flush();
    expect(engine.snapshot().events.map((event) => event.eventId)).toEqual(["E1", "E2", "E3"]);
    engine.markEvent("E1", "processing");
    expect(engine.eventState("E1")).toBe("processing");

    // Restart path: a NEW scheduler over the surviving engine.
    const executor = scriptedExecutor(() => ({ status: "ready", analysis: fakeAnalysis }));
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
    const readmitted = scheduler.recoverPending({ readmitExhausted: true });
    expect(readmitted).toContain("E1");
    expect(readmitted).toEqual(["E1", "E2", "E3"]);
    await scheduler.drained();

    const states = Object.fromEntries(
      engine.snapshot().events.map((event) => [event.eventId, event.state]),
    );
    expect(states).toEqual({ E1: "ready", E2: "ready", E3: "ready" });
    expect(executor.calls.map((task) => `${task.eventId}#${task.attempt}`)).toEqual([
      "E1#1",
      "E2#1",
      "E3#1",
    ]);
    expect(scheduler.metrics().ready).toBe(3);
    expect(scheduler.metrics().duplicatesRefused).toBe(0);
    // Nothing is left to recover: a second recovery is a no-op.
    expect(scheduler.recoverPending({ readmitExhausted: true })).toEqual([]);
  });

  it("ADJ-AP-004 default recoverPending() (no readmitExhausted) also reclaims the stranded 'processing' lease", async () => {
    const engine = new SessionEventEngine({ sessionId: "adj-ap-004-default" });
    for (const sample of threeStrokeStream()) engine.push({ wrist: [sample] });
    engine.flush();
    engine.markEvent("E2", "processing");

    const executor = scriptedExecutor(() => ({ status: "ready", analysis: fakeAnalysis }));
    const scheduler = new SessionAnalysisScheduler({ engine, executor });
    expect(scheduler.recoverPending()).toEqual(["E1", "E2", "E3"]);
    await scheduler.drained();
    for (const event of engine.snapshot().events) expect(event.state).toBe("ready");
  });

  it("ADJ-AP-004 guard: an event 'processing' under THIS scheduler's live dispatch is never re-admitted", async () => {
    const engine = new SessionEventEngine({ sessionId: "adj-ap-004-live" });
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
    expect(engine.eventState("E1")).toBe("processing");
    expect(scheduler.recoverPending()).toEqual([]);
    expect(scheduler.recoverPending({ readmitExhausted: true })).toEqual([]);
    // The live lease was not reverted behind the executor's back.
    expect(engine.eventState("E1")).toBe("processing");
    release();
    await scheduler.drained();
    expect(scheduler.metrics().dispatched).toBe(3);
    expect(executor.calls).toHaveLength(3);
    for (const event of engine.snapshot().events) expect(event.state).toBe("ready");
  });
});
