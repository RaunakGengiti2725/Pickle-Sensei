import { describe, expect, it } from "vitest";
import {
  SessionEventEngine,
  type SessionStrokeEvent,
  type SpeedSample,
} from "../src/sessionEngine.js";
import {
  SessionAnalysisScheduler,
  type SessionAnalysisExecutor,
  type SessionAnalysisTaskOutcome,
} from "../src/sessionScheduler.js";

/**
 * ADJUDICATION REPRO (area pkg-analysis-pipeline, baseline 4d812e1a).
 *
 * Real SessionEventEngine + real SessionAnalysisScheduler; only the analysis
 * execution behind the executor seam is a test double. Each `it` asserts the
 * EXPECTED behaviour; a failure at the baseline is the reproduction.
 */

function threeStrokes(): SpeedSample[] {
  const out: SpeedSample[] = [];
  for (let t = 0; t <= 8200; t += 40) {
    let value = 0.08;
    for (const peakMs of [1200, 3600, 6000]) {
      value += 2.0 * Math.exp(-0.5 * ((t - peakMs) / 120) ** 2);
    }
    out.push({ timestampMs: t, value });
  }
  return out;
}

const fakeAnalysis = { id: "synthetic-analysis" } as unknown as NonNullable<
  SessionStrokeEvent["analysis"]
>;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "TIMEOUT"> {
  return Promise.race([
    promise,
    new Promise<"TIMEOUT">((resolve) => setTimeout(() => resolve("TIMEOUT"), ms)),
  ]);
}

describe("ADJ-AP-002 applyOutcome must survive an engine transition rejection", () => {
  it("an event terminalized outside the scheduler while in flight yields a failed task record, not a wedged queue", async () => {
    const engine = new SessionEventEngine({ sessionId: "adj-sched-terminal-race" });
    const executor: SessionAnalysisExecutor = {
      executorId: "adj-terminal-race",
      async execute(task): Promise<SessionAnalysisTaskOutcome> {
        if (task.eventId === "E1") {
          // Another writer (e.g. a recovery path) settles the event first.
          engine.markEvent(task.eventId, "abstained", { abstainReason: "external_writer" });
        }
        return { status: "ready", analysis: fakeAnalysis };
      },
    };
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
    scheduler.pushSamples({ wrist: threeStrokes() });
    scheduler.endOfStream();
    expect(engine.snapshot().events.map((e) => e.eventId)).toEqual(["E1", "E2", "E3"]);

    const drained = await withTimeout(
      scheduler.drained().then(
        () => "resolved" as const,
        (error: unknown) => ({ rejected: String(error) }),
      ),
      2_000,
    );
    const metrics = scheduler.metrics();
    const outcomes = metrics.tasks.map((t) => `${t.eventId}:${t.outcome}`);
    console.log("ADJ-AP-002 drained:", JSON.stringify(drained), "tasks:", outcomes.join(","), {
      queueDepth: metrics.queueDepth,
      inFlight: metrics.inFlight,
      dispatched: metrics.dispatched,
    });

    expect(drained, "drained() must settle cleanly").toBe("resolved");
    expect(metrics.tasks.find((t) => t.eventId === "E1")?.outcome).toBe("failed_final");
    expect(metrics.dispatched, "E2/E3 must still be dispatched").toBe(3);
    expect(metrics.queueDepth).toBe(0);
  });
});

describe("ADJ-AP-003 a never-settling executor must not hold the concurrency slot forever", () => {
  it("scheduler exposes a task deadline: hung E1 fails with a timeout reason and E2/E3 still run", async () => {
    const engine = new SessionEventEngine({ sessionId: "adj-sched-hang" });
    const executor: SessionAnalysisExecutor = {
      executorId: "adj-hang",
      execute(task): Promise<SessionAnalysisTaskOutcome> {
        if (task.eventId === "E1") return new Promise<never>(() => {});
        return Promise.resolve({ status: "ready", analysis: fakeAnalysis });
      },
    };
    // Expected contract: a per-task deadline option (none exists at the
    // baseline — SessionSchedulerOptions has no timeout/deadline/signal
    // field), after which the hung task fails and the slot is released.
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
    scheduler.pushSamples({ wrist: threeStrokes() });
    scheduler.endOfStream();
    const drained = await withTimeout(
      scheduler.drained().then(() => "resolved" as const),
      1_500,
    );
    const metrics = scheduler.metrics();
    console.log("ADJ-AP-003 drained:", drained, {
      dispatched: metrics.dispatched,
      inFlight: metrics.inFlight,
      queueDepth: metrics.queueDepth,
      states: engine.snapshot().events.map((e) => `${e.eventId}:${e.state}`),
    });
    expect(drained).toBe("resolved");
    expect(metrics.dispatched).toBe(3);
  });
});

describe("ADJ-AP-004 recoverPending must readmit events abandoned in 'processing'", () => {
  it("a new scheduler over an engine whose E1 was left processing readmits E1", async () => {
    const engine = new SessionEventEngine({ sessionId: "adj-sched-recover" });
    engine.push({ wrist: threeStrokes() });
    engine.flush();
    // Simulate a crashed/abandoned in-flight dispatch: E1 is 'processing'
    // with no scheduler alive to settle it.
    engine.markEvent("E1", "processing");
    expect(engine.eventState("E1")).toBe("processing");

    const executor: SessionAnalysisExecutor = {
      executorId: "adj-recover",
      async execute(): Promise<SessionAnalysisTaskOutcome> {
        return { status: "ready", analysis: fakeAnalysis };
      },
    };
    const second = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
    const readmitted = second.recoverPending({ readmitExhausted: true });
    await second.drained();
    const states = engine.snapshot().events.map((e) => `${e.eventId}:${e.state}`);
    console.log("ADJ-AP-004 readmitted:", readmitted, "states:", states);
    expect(readmitted).toContain("E1");
    expect(engine.eventState("E1")).toBe("ready");
  });
});
