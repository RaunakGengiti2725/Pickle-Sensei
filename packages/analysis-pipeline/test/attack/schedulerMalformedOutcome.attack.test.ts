/**
 * Adversarial pass 3 / tester #4 — partial failures in the session scheduler.
 *
 * The scheduler documents that a THROWING executor is converted into an honest
 * failed outcome. This attacks the next layer: an executor that RESOLVES with a
 * contract-violating outcome (`{status:"ready", analysis:null}`, a non-object,
 * an unknown status) — exactly what a JS bridge / JSON boundary can hand back.
 * Expectation (scheduler contract): the dispatch slot is released, the event
 * is not stranded in "processing", queued siblings still run, and neither
 * `drained()` nor the process sees an unhandled rejection.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SessionEventEngine,
  type SessionStrokeEvent,
  type SpeedSample,
} from "../../src/sessionEngine.js";
import {
  SessionAnalysisScheduler,
  type SessionAnalysisExecutor,
  type SessionAnalysisTaskOutcome,
} from "../../src/sessionScheduler.js";

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

/** Executor whose FIRST task resolves with `malformed`; later tasks are healthy. */
function malformedFirstExecutor(malformed: unknown): SessionAnalysisExecutor & { calls: string[] } {
  const calls: string[] = [];
  return {
    executorId: "attack-malformed-executor",
    calls,
    execute(task) {
      calls.push(task.eventId);
      if (calls.length === 1) return Promise.resolve(malformed as SessionAnalysisTaskOutcome);
      return Promise.resolve({ status: "ready", analysis: fakeAnalysis });
    },
  };
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

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("[attack] SessionAnalysisScheduler — executor resolves a contract-violating outcome", () => {
  const cases: Array<{ label: string; outcome: unknown }> = [
    { label: "{status:'ready', analysis:null}", outcome: { status: "ready", analysis: null } },
    { label: "{status:'ready'} (analysis missing)", outcome: { status: "ready" } },
    { label: "undefined (executor resolved with nothing)", outcome: undefined },
    { label: "{status:'bogus'}", outcome: { status: "bogus" } },
  ];

  for (const { label, outcome } of cases) {
    it(`${label}: slot released, event not stranded in 'processing', siblings complete, no unhandled rejection`, async () => {
      const engine = new SessionEventEngine({ sessionId: `attack-malformed-${label.length}` });
      const executor = malformedFirstExecutor(outcome);
      const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
      for (const sample of threeStrokeStream()) scheduler.pushSamples({ wrist: [sample] });
      scheduler.endOfStream();

      let drainedError: unknown;
      try {
        await withTimeout(scheduler.drained(), 2_000, "drained()");
      } catch (error) {
        drainedError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));

      const metrics = scheduler.metrics();
      const states = engine.snapshot().events.map((e) => `${e.eventId}:${e.state}`);
      const detail = `drainedError=${String(drainedError)} metrics=${JSON.stringify(metrics)} states=${states.join(",")} unhandled=${unhandled.length}`;

      expect(drainedError, `drained() rejected — ${detail}`).toBeUndefined();
      expect(unhandled, `unhandled rejection escaped the scheduler — ${detail}`).toHaveLength(0);
      expect(metrics.inFlight, `dispatch slot leaked — ${detail}`).toBe(0);
      expect(
        engine.snapshot().events.filter((e) => e.state === "processing"),
        `event stranded in 'processing' — ${detail}`,
      ).toHaveLength(0);
      // The two healthy siblings must still have been analyzed.
      expect(metrics.ready, `siblings starved — ${detail}`).toBeGreaterThanOrEqual(2);
      expect(executor.calls.length, `siblings never dispatched — ${detail}`).toBeGreaterThanOrEqual(
        3,
      );
    });
  }

  it("control: a well-formed failed outcome on E1 keeps everything honest (baseline for the cases above)", async () => {
    const engine = new SessionEventEngine({ sessionId: "attack-malformed-control" });
    const executor = malformedFirstExecutor({
      status: "failed",
      reason: "control",
      retryable: false,
    });
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
    for (const sample of threeStrokeStream()) scheduler.pushSamples({ wrist: [sample] });
    scheduler.endOfStream();
    await withTimeout(scheduler.drained(), 2_000, "drained()");
    const metrics = scheduler.metrics();
    expect(metrics.inFlight).toBe(0);
    expect(metrics.ready).toBe(2);
    expect(metrics.failedFinal).toBe(1);
    expect(unhandled).toHaveLength(0);
  });
});
