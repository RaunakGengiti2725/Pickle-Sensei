import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SessionEventEngine,
  type SessionStrokeEvent,
  type SpeedSample,
} from "../../src/sessionEngine.js";
import {
  SessionAnalysisScheduler,
  type SessionAnalysisExecutor,
  type SessionAnalysisTask,
  type SessionAnalysisTaskOutcome,
} from "../../src/sessionScheduler.js";

/**
 * EXECUTION AUDIT HARNESS (pkg-analysis-pipeline, pass 2) — scheduler
 * settle-path faults. New file only. The shipped suites cover executor
 * throws/rejections. These cases fault the OUTCOME-APPLICATION step instead:
 * the executor resolves, but applying its outcome to the engine throws
 * (malformed outcome, or an event that reached a terminal state through
 * another writer while in flight). The documented contract is "never leak
 * the dispatch slot, never crash pushSamples, results never dropped".
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
    executorId: "audit-scripted-executor",
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

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
});
afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
});

const tick = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function raceDrained(scheduler: SessionAnalysisScheduler, timeoutMs: number) {
  return Promise.race([
    scheduler.drained().then(
      () => "drained" as const,
      (error: unknown) => ({ rejected: error }),
    ),
    tick(timeoutMs).then(() => "timeout" as const),
  ]);
}

describe("AUDIT scheduler — outcome application faults", () => {
  it("MALFORMED READY: executor resolves {status:'ready'} with no AnalysisRecord → recorded as failure, queue keeps flowing, no unhandled rejection", async () => {
    const engine = new SessionEventEngine({ sessionId: "audit-malformed-ready" });
    const executor = scriptedExecutor((task) => {
      if (task.eventId === "E1") {
        // A buggy bridge that reports success without a payload.
        return { status: "ready", analysis: undefined } as unknown as SessionAnalysisTaskOutcome;
      }
      return { status: "ready", analysis: fakeAnalysis };
    });
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
    for (const sample of threeStrokeStream()) scheduler.pushSamples({ wrist: [sample] });
    scheduler.endOfStream();

    const outcome = await raceDrained(scheduler, 500);
    const metrics = scheduler.metrics();
    const states = engine.snapshot().events.map((event) => `${event.eventId}:${event.state}`);

    // Contract: E1 stays honestly non-ready with the failure RECORDED, E2/E3
    // still get analyzed, drained() settles, nothing escapes as an unhandled
    // rejection.
    expect(unhandled, `unhandled rejections: ${unhandled.map(String).join(" | ")}`).toEqual([]);
    expect(outcome, `states=${states.join(",")} queueDepth=${metrics.queueDepth}`).toBe("drained");
    expect(metrics.ready).toBe(2);
    expect(metrics.queueDepth).toBe(0);
    expect(metrics.inFlight).toBe(0);
    const e1 = metrics.tasks.find((task) => task.eventId === "E1")!;
    expect(e1.outcome).not.toBeNull();
    expect(e1.failures.length).toBeGreaterThan(0);
  });

  it("EXTERNAL TERMINAL WRITE: event abstained by another writer while in flight → scheduler must not stall the rest of the queue", async () => {
    const engine = new SessionEventEngine({ sessionId: "audit-external-terminal" });
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
    expect(engine.snapshot().events[0]!.state).toBe("processing");

    // Another owner of the engine (e.g. a supervisor deciding the clip was
    // lost) finalizes E1 while the scheduler still has it in flight. The
    // engine permits processing → abstained.
    engine.markEvent("E1", "abstained", { abstainReason: "AUDIT_EXTERNAL_ABSTAIN" });
    releaseFirst();

    const outcome = await raceDrained(scheduler, 500);
    const metrics = scheduler.metrics();
    const states = engine.snapshot().events.map((event) => `${event.eventId}:${event.state}`);

    expect(unhandled, `unhandled rejections: ${unhandled.map(String).join(" | ")}`).toEqual([]);
    expect(outcome, `states=${states.join(",")} queueDepth=${metrics.queueDepth}`).toBe("drained");
    // E1's terminal state is append-only and must survive; E2/E3 must still
    // be analyzed rather than left queued forever.
    expect(engine.snapshot().events[0]!.state).toBe("abstained");
    expect(metrics.ready).toBe(2);
    expect(metrics.queueDepth).toBe(0);
  });
});

describe("AUDIT scheduler — settle fault with no drained() awaiter", () => {
  it("MALFORMED READY without drained(): the settle error must not surface as a process-level unhandled rejection", async () => {
    const engine = new SessionEventEngine({ sessionId: "audit-malformed-unawaited" });
    const executor = scriptedExecutor((task) => {
      if (task.eventId === "E1") {
        return { status: "ready", analysis: undefined } as unknown as SessionAnalysisTaskOutcome;
      }
      return { status: "ready", analysis: fakeAnalysis };
    });
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
    for (const sample of threeStrokeStream()) scheduler.pushSamples({ wrist: [sample] });
    scheduler.endOfStream();
    // Production-shaped usage: samples keep flowing, nobody awaits drained().
    await tick(50);
    const metrics = scheduler.metrics();
    expect(unhandled.map(String)).toEqual([]);
    expect(metrics.inFlight).toBe(0);
    expect(metrics.queueDepth).toBe(0);
  });
});

describe("AUDIT scheduler — hung executor (no cancellation seam)", () => {
  it("HUNG EXECUTOR: suspend() cannot reclaim a slot from an executor that never settles; drained() never resolves", async () => {
    const engine = new SessionEventEngine({ sessionId: "audit-hung" });
    const executor = scriptedExecutor((task) => {
      if (task.eventId === "E1") return new Promise<SessionAnalysisTaskOutcome>(() => {});
      return { status: "ready", analysis: fakeAnalysis };
    });
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
    for (const sample of threeStrokeStream()) scheduler.pushSamples({ wrist: [sample] });
    scheduler.endOfStream();
    scheduler.suspend();
    scheduler.resume();
    const outcome = await raceDrained(scheduler, 300);
    const metrics = scheduler.metrics();
    // Documents the observed behaviour: there is no timeout/cancel path, so a
    // single hung native bridge call blocks the only slot and E2/E3 wait
    // indefinitely. (Not asserted as a contract violation — the contract
    // does not promise cancellation — recorded here as a coverage gap.)
    expect(outcome).toBe("timeout");
    expect(metrics.inFlight).toBe(1);
    expect(metrics.queueDepth).toBe(2);
    expect(engine.snapshot().events[0]!.state).toBe("processing");
  });
});
